import type { Request, Response } from "./_lib/http";
import { isTrustedWebhookSecret, adminGql, eventNewRow } from "./_lib/hasura";
import { withRetry } from "./_lib/retry";
import {
  executeConditional,
  executeDbWrite,
  executeHttp,
  executeLlm,
  executeNotify,
  type StepExecutionContext,
  type WorkflowStep,
} from "./_lib/steps";

type Job = { id: string; workflow_run_id: string; status: string };

async function updateStepRun(id: string, patch: Record<string, unknown>) {
  await adminGql(
    `mutation UpdateStepRun($id: uuid!, $patch: step_runs_set_input!) {
      update_step_runs_by_pk(pk_columns: {id: $id}, _set: $patch) { id }
    }`,
    { id, patch },
  );
}

async function createStepRun(runId: string, step: WorkflowStep, status = "pending", input: unknown = null) {
  const data = await adminGql<{ insert_step_runs_one: { id: string; status: string } }>(
    `mutation CreateStepRun($object: step_runs_insert_input!) {
      insert_step_runs_one(
        object: $object,
        on_conflict: {constraint: step_runs_workflow_run_id_workflow_step_id_key, update_columns: []}
      ) { id status }
    }`,
    { object: { workflow_run_id: runId, workflow_step_id: step.id, status, input } },
  );
  return data.insert_step_runs_one;
}

async function advanceRun(runId: string, position: number, executionContext: unknown) {
  await adminGql(
    `mutation Advance($id: uuid!, $position: Int!, $context: jsonb!) {
      update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {cursor_position: $position, execution_context: $context}) { id }
    }`,
    { id: runId, position, context: executionContext },
  );
}

async function failRun(runId: string, orgId: string, message: string) {
  await adminGql(
    `mutation FailRun($runId: uuid!, $orgId: uuid!, $error: String!, $at: timestamptz!) {
      release_org_quota(args: {p_org_id: $orgId}) { id }
      update_workflow_runs_by_pk(
        pk_columns: {id: $runId},
        _set: {status: "failed", error: $error, quota_reserved: false, completed_at: $at}
      ) { id }
    }`,
    { runId, orgId, error: message, at: new Date().toISOString() },
  );
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });
  if (!isTrustedWebhookSecret(req.headers["nhost-webhook-secret"])) {
    return res.status(401).json({ message: "Unauthorized webhook" });
  }
  const eventJob = eventNewRow<Job>(req.body);
  if (!eventJob?.id) return res.status(400).json({ message: "Missing run_job event row" });

  try {
    const claimed = await adminGql<{ update_run_jobs: { returning: Array<{ id: string }> } }>(
      `mutation Claim($id: uuid!) {
        update_run_jobs(where: {id: {_eq: $id}, status: {_eq: "queued"}}, _set: {status: "processing"}) { returning { id } }
      }`,
      { id: eventJob.id },
    );
    if (!claimed.update_run_jobs.returning.length) return res.status(200).json({ message: "job already processed" });

    const data = await adminGql<{
      run_jobs_by_pk: null | {
        id: string;
        workflow_run: {
          id: string; org_id: string; status: string; cursor_position: number; trigger_input: any;
          execution_context: any; started_at: string | null;
          workflow: { id: string; enabled: boolean; steps: WorkflowStep[] };
          step_runs: Array<{ id: string; workflow_step_id: string; status: string; output: any }>;
        };
      };
    }>(
      `query JobRun($id: uuid!) {
        run_jobs_by_pk(id: $id) {
          id
          workflow_run {
            id org_id status cursor_position trigger_input execution_context started_at
            workflow { id enabled steps(where: {archived: {_eq: false}}, order_by: [{position: asc}, {id: asc}]) { id workflow_id position name type config } }
            step_runs { id workflow_step_id status output }
          }
        }
      }`,
      { id: eventJob.id },
    );

    const run = data.run_jobs_by_pk?.workflow_run;
    if (!run || !["queued", "running"].includes(run.status) || !run.workflow.enabled) {
      await adminGql(`mutation Done($id: uuid!, $at: timestamptz!) { update_run_jobs_by_pk(pk_columns: {id: $id}, _set: {status: "done", processed_at: $at}) { id } }`, { id: eventJob.id, at: new Date().toISOString() });
      return res.status(200).json({ message: "run no longer queued" });
    }

    const now = new Date().toISOString();
    await adminGql(
      `mutation Running($id: uuid!, $startedAt: timestamptz!) {
        update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "running", started_at: $startedAt, error: null}) { id }
      }`,
      { id: run.id, startedAt: run.started_at ?? now },
    );

    const executionContext: StepExecutionContext = {
      runId: run.id,
      orgId: run.org_id,
      triggerInput: run.execution_context?.triggerInput ?? run.trigger_input,
      previousOutput: run.execution_context?.previousOutput ?? null,
      activeBranch: run.execution_context?.activeBranch ?? null,
    };

    const existingByStep = new Map(run.step_runs.map((sr) => [sr.workflow_step_id, sr]));
    const steps = run.workflow.steps.filter((step) => step.position >= run.cursor_position);

    for (const step of steps) {
      const existing = existingByStep.get(step.id);
      if (existing?.status === "succeeded" || existing?.status === "skipped") {
        executionContext.previousOutput = existing.output;
        await advanceRun(run.id, step.position + 1, executionContext);
        continue;
      }
      if (existing?.status === "awaiting_approval") {
        await adminGql(`mutation Pause($id: uuid!) { update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "paused"}) { id } }`, { id: run.id });
        break;
      }

      const branchTag = step.config?.branch as string | undefined;
      if (branchTag && executionContext.activeBranch && branchTag !== executionContext.activeBranch) {
        const sr = existing ?? await createStepRun(run.id, step, "skipped", { previousOutput: executionContext.previousOutput });
        await updateStepRun(sr.id, { status: "skipped", output: { skipped_for_branch: executionContext.activeBranch }, completed_at: new Date().toISOString() });
        await advanceRun(run.id, step.position + 1, executionContext);
        continue;
      }

      const stepRun = existing ?? await createStepRun(run.id, step, "pending", { triggerInput: executionContext.triggerInput, previousOutput: executionContext.previousOutput });
      await updateStepRun(stepRun.id, { status: "running", started_at: new Date().toISOString(), error: null });

      if (step.type === "approval_gate") {
        await updateStepRun(stepRun.id, { status: "awaiting_approval" });
        await adminGql(
          `mutation Pause($id: uuid!, $cursor: Int!, $context: jsonb!) {
            update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "paused", cursor_position: $cursor, execution_context: $context}) { id }
          }`,
          { id: run.id, cursor: step.position + 1, context: executionContext },
        );
        await adminGql(`mutation JobDone($id: uuid!, $at: timestamptz!) { update_run_jobs_by_pk(pk_columns: {id: $id}, _set: {status: "done", processed_at: $at}) { id } }`, { id: eventJob.id, at: new Date().toISOString() });
        return res.status(200).json({ status: "paused", workflow_run_id: run.id, step_run_id: stepRun.id });
      }

      try {
        let output: any;
        if (step.type === "llm_call") {
          output = await withRetry(() => executeLlm(step, executionContext), 2, async (attempt) => updateStepRun(stepRun.id, { attempt_count: attempt }));
        } else if (step.type === "http_request") {
          output = await withRetry(() => executeHttp(step, executionContext), 2, async (attempt) => updateStepRun(stepRun.id, { attempt_count: attempt }));
        } else if (step.type === "conditional_branch") {
          await updateStepRun(stepRun.id, { attempt_count: 1 });
          output = executeConditional(step, executionContext);
          executionContext.activeBranch = output.branch;
        } else if (step.type === "db_write") {
          await updateStepRun(stepRun.id, { attempt_count: 1 });
          output = await executeDbWrite(step, executionContext);
        } else if (step.type === "notify") {
          await updateStepRun(stepRun.id, { attempt_count: 1 });
          output = await executeNotify(step, executionContext);
        } else {
          throw new Error(`Unsupported step type: ${step.type}`);
        }

        executionContext.previousOutput = output;
        await updateStepRun(stepRun.id, { status: "succeeded", output, completed_at: new Date().toISOString() });
        await advanceRun(run.id, step.position + 1, executionContext);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await updateStepRun(stepRun.id, { status: "failed", error: message, completed_at: new Date().toISOString() });
        await failRun(run.id, run.org_id, message);
        await adminGql(`mutation JobFailed($id: uuid!, $error: String!, $at: timestamptz!) { update_run_jobs_by_pk(pk_columns: {id: $id}, _set: {status: "failed", error: $error, processed_at: $at}) { id } }`, { id: eventJob.id, error: message, at: new Date().toISOString() });
        return res.status(200).json({ status: "failed", message });
      }
    }

    const completedAt = new Date().toISOString();
    await adminGql(
      `mutation Complete($runId: uuid!, $orgId: uuid!, $at: timestamptz!) {
        finalize_org_quota(args: {p_org_id: $orgId}) { id }
        update_workflow_runs_by_pk(pk_columns: {id: $runId}, _set: {status: "completed", quota_reserved: false, completed_at: $at}) { id }
      }`,
      { runId: run.id, orgId: run.org_id, at: completedAt },
    );
    await adminGql(`mutation JobDone($id: uuid!, $at: timestamptz!) { update_run_jobs_by_pk(pk_columns: {id: $id}, _set: {status: "done", processed_at: $at}) { id } }`, { id: eventJob.id, at: completedAt });
    return res.status(200).json({ status: "completed", workflow_run_id: run.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Infrastructure failure: put the job back so Hasura's Event Trigger retry can
    // resume from workflow_runs.cursor_position. Step-level failures are handled
    // above and intentionally return 200 after marking the run failed.
    await adminGql(
      `mutation RequeueJob($id: uuid!, $error: String!) {
        update_run_jobs_by_pk(pk_columns: {id: $id}, _set: {status: "queued", error: $error, processed_at: null}) { id }
      }`,
      { id: eventJob.id, error: message },
    ).catch(() => undefined);
    return res.status(500).json({ message });
  }
}
