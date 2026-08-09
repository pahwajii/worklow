import type { Request, Response } from "./_lib/http";
import { isTrustedWebhookSecret, adminGql } from "./_lib/hasura";
import { startWorkflowRun } from "./_lib/start-run";

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });
  if (!isTrustedWebhookSecret(req.headers["nhost-webhook-secret"])) {
    return res.status(401).json({ message: "Unauthorized webhook" });
  }
  try {
    const data = await adminGql<{
      workflow_triggers: Array<{ id: string; config: any; workflow: { id: string; enabled: boolean } }>;
    }>(`query ScheduledTriggers {
      workflow_triggers(where: {type: {_eq: "scheduled"}, enabled: {_eq: true}, archived: {_eq: false}}) {
        id config workflow { id enabled }
      }
    }`);

    const minute = Math.floor(Date.now() / 60000);
    const started: Array<{ triggerId: string; runId: string }> = [];
    const errors: Array<{ triggerId: string; message: string }> = [];
    for (const trigger of data.workflow_triggers) {
      if (!trigger.workflow.enabled) continue;
      const everyMinutes = Math.max(1, Number(trigger.config?.every_minutes ?? 5));
      if (minute % everyMinutes !== 0) continue;
      const dedupeKey = `scheduled:${trigger.id}:${minute}`;
      try {
        const result = await startWorkflowRun({
          workflowId: trigger.workflow.id,
          triggerType: "scheduled",
          input: { trigger_id: trigger.id, scheduled_minute: minute },
          dedupeKey,
        });
        started.push({ triggerId: trigger.id, runId: result.workflow_run_id });
      } catch (error) {
        errors.push({ triggerId: trigger.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return res.status(200).json({ started, errors });
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
  }
}
