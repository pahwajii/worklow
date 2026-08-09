import { adminGql } from "./hasura";

export type TriggerType = "manual" | "webhook" | "scheduled" | "database_event";

type StartArgs = {
  workflowId: string;
  triggerType: TriggerType;
  input?: unknown;
  startedBy?: string | null;
  requireUserId?: string | null;
  dedupeKey?: string | null;
};

export async function startWorkflowRun(args: StartArgs) {
  const workflowData = await adminGql<{
    workflows_by_pk: null | {
      id: string;
      org_id: string;
      enabled: boolean;
      organization: { id: string; memberships: Array<{ user_id: string; role: string }> };
    };
  }>(
    `query WorkflowForStart($id: uuid!, $userId: uuid) {
      workflows_by_pk(id: $id) {
        id org_id enabled
        organization {
          id
          memberships(where: {user_id: {_eq: $userId}}) { user_id role }
        }
      }
    }`,
    { id: args.workflowId, userId: args.requireUserId ?? null },
  );

  const workflow = workflowData.workflows_by_pk;
  if (args.requireUserId) {
    const membership = workflow?.organization.memberships[0];
    if (!workflow?.enabled || !membership || !["owner", "editor"].includes(membership.role)) {
      // Same response for missing, disabled and cross-org IDs: do not expose an existence oracle.
      throw new Error("Not authorized to trigger this workflow");
    }
  } else if (!workflow || !workflow.enabled) {
    throw new Error("Workflow not found or disabled");
  }

  if (!workflow) throw new Error("Workflow not found or disabled");

  if (args.dedupeKey) {
    const existing = await adminGql<{ workflow_runs: Array<{ id: string; status: string }> }>(
      `query ExistingRun($workflowId: uuid!, $dedupe: jsonb!) {
        workflow_runs(
          where: {
            workflow_id: {_eq: $workflowId},
            trigger_input: {_contains: $dedupe}
          },
          limit: 1
        ) { id status }
      }`,
      { workflowId: workflow.id, dedupe: { _dedupe_key: args.dedupeKey } },
    );
    if (existing.workflow_runs[0]) {
      return { workflow_run_id: existing.workflow_runs[0].id, status: existing.workflow_runs[0].status, message: "deduplicated" };
    }
  }

  const quota = await adminGql<{ reserve_org_quota: Array<{ id: string }> }>(
    `mutation Reserve($orgId: uuid!) {
      reserve_org_quota(args: {p_org_id: $orgId}) { id }
    }`,
    { orgId: workflow.org_id },
  );
  if (!quota.reserve_org_quota.length) throw new Error("Organization quota exhausted");

  const triggerInput = {
    ...(args.input && typeof args.input === "object" ? (args.input as Record<string, unknown>) : { value: args.input ?? null }),
    ...(args.dedupeKey ? { _dedupe_key: args.dedupeKey } : {}),
  };

  try {
    const inserted = await adminGql<{
      insert_workflow_runs_one: { id: string; status: string };
    }>(
      `mutation StartRun($object: workflow_runs_insert_input!) {
        insert_workflow_runs_one(object: $object) { id status }
      }`,
      {
        object: {
          workflow_id: workflow.id,
          org_id: workflow.org_id,
          status: "queued",
          trigger_type: args.triggerType,
          trigger_input: triggerInput,
          execution_context: { triggerInput },
          started_by: args.startedBy ?? null,
          run_jobs: { data: [{ reason: "start" }] },
        },
      },
    );
    return {
      workflow_run_id: inserted.insert_workflow_runs_one.id,
      status: inserted.insert_workflow_runs_one.status,
      message: "queued",
    };
  } catch (error) {
    await adminGql(
      `mutation Release($orgId: uuid!) { release_org_quota(args: {p_org_id: $orgId}) { id } }`,
      { orgId: workflow.org_id },
    ).catch(() => undefined);
    throw error;
  }
}
