import type { Request, Response } from "./_lib/http";
import { isTrustedWebhookSecret, actionInput, actionSession } from "./_lib/hasura";
import { startWorkflowRun } from "./_lib/start-run";

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });
  if (!isTrustedWebhookSecret(req.headers["nhost-webhook-secret"])) {
    return res.status(401).json({ message: "Unauthorized webhook" });
  }
  try {
    const { userId } = actionSession(req.body);
    const input = actionInput<{ workflow_id: string; input?: unknown }>(req.body);
    if (!userId) return res.status(401).json({ message: "Missing x-hasura-user-id" });
    if (!input.workflow_id) return res.status(400).json({ message: "workflow_id is required" });

    const result = await startWorkflowRun({
      workflowId: input.workflow_id,
      triggerType: "manual",
      input: input.input ?? {},
      startedBy: userId,
      requireUserId: userId,
    });
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not authorized/i.test(message) ? 403 : /quota/i.test(message) ? 429 : 400;
    return res.status(status).json({ message });
  }
}
