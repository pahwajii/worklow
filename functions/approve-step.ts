import type { Request, Response } from "./_lib/http";
import { isTrustedWebhookSecret, actionInput, actionSession, adminGql } from "./_lib/hasura";

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });
  if (!isTrustedWebhookSecret(req.headers["nhost-webhook-secret"])) {
    return res.status(401).json({ message: "Unauthorized webhook" });
  }
  try {
    const { userId } = actionSession(req.body);
    const input = actionInput<{ step_run_id: string }>(req.body);
    if (!userId) return res.status(401).json({ message: "Missing x-hasura-user-id" });
    if (!input.step_run_id) return res.status(400).json({ message: "step_run_id is required" });

    // Layer 2: authorization is checked here, during the state-machine transition.
    const check = await adminGql<{
      step_runs_by_pk: null | {
        id: string;
        status: string;
        workflow_step: { type: string };
        workflow_run: { id: string; status: string; organization: { memberships: Array<{ role: string }> } };
      };
    }>(
      `query ApprovalCheck($stepRunId: uuid!, $userId: uuid!) {
        step_runs_by_pk(id: $stepRunId) {
          id status
          workflow_step { type }
          workflow_run {
            id status
            organization { memberships(where: {user_id: {_eq: $userId}}) { role } }
          }
        }
      }`,
      { stepRunId: input.step_run_id, userId },
    );

    const stepRun = check.step_runs_by_pk;
    const membership = stepRun?.workflow_run.organization.memberships[0];
    if (!membership || !["owner", "editor"].includes(membership.role)) {
      // Cross-org and nonexistent IDs deliberately look the same.
      return res.status(403).json({ message: "Not authorized to approve this step" });
    }
    if (stepRun.workflow_step.type !== "approval_gate" || stepRun.status !== "awaiting_approval") {
      return res.status(409).json({ message: "Step is not awaiting approval" });
    }

    // The SQL function repeats the same check under row locks to prevent double approvals.
    const data = await adminGql<{ approve_step_and_enqueue: Array<{ id: string; status: string }> }>(
      `mutation Approve($stepRunId: uuid!, $userId: uuid!) {
        approve_step_and_enqueue(args: {p_step_run_id: $stepRunId, p_user_id: $userId}) { id status }
      }`,
      { stepRunId: input.step_run_id, userId },
    );
    const run = data.approve_step_and_enqueue[0];
    if (!run) throw new Error("Approval transition failed");
    return res.status(200).json({ workflow_run_id: run.id, status: run.status, message: "resume queued" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(/authorized/i.test(message) ? 403 : 400).json({ message });
  }
}
