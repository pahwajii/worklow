import type { Request, Response } from "./_lib/http";
import { isTrustedWebhookSecret, adminGql, eventNewRow } from "./_lib/hasura";
import { startWorkflowRun } from "./_lib/start-run";

type WatchedEvent = { id: string; org_id: string; event_type: string; payload: any };

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });
  if (!isTrustedWebhookSecret(req.headers["nhost-webhook-secret"])) {
    return res.status(401).json({ message: "Unauthorized webhook" });
  }
  const event = eventNewRow<WatchedEvent>(req.body);
  if (!event?.id) return res.status(400).json({ message: "Missing watched event row" });
  try {
    const data = await adminGql<{
      workflow_triggers: Array<{ id: string; config: any; workflow: { id: string; org_id: string; enabled: boolean } }>;
    }>(
      `query DatabaseEventTriggers($orgId: uuid!) {
        workflow_triggers(where: {
          type: {_eq: "database_event"}, enabled: {_eq: true}, archived: {_eq: false}, workflow: {org_id: {_eq: $orgId}}
        }) { id config workflow { id org_id enabled } }
      }`,
      { orgId: event.org_id },
    );

    const matches = data.workflow_triggers.filter((trigger) =>
      trigger.workflow.enabled && String(trigger.config?.event_type ?? "*") === event.event_type,
    );
    const results = [];
    for (const trigger of matches) {
      results.push(await startWorkflowRun({
        workflowId: trigger.workflow.id,
        triggerType: "database_event",
        input: { trigger_id: trigger.id, event_id: event.id, event_type: event.event_type, payload: event.payload },
        dedupeKey: `database-event:${trigger.id}:${event.id}`,
      }));
    }
    return res.status(200).json({ started: results.length, results });
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
  }
}
