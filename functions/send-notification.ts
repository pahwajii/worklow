import type { Request, Response } from "./_lib/http";
import { isTrustedWebhookSecret, adminGql, eventNewRow } from "./_lib/hasura";
import { env } from "./_lib/env";

type Outbox = { id: string; channel: string; destination: string | null; payload: any; status: string };

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });
  if (!isTrustedWebhookSecret(req.headers["nhost-webhook-secret"])) {
    return res.status(401).json({ message: "Unauthorized webhook" });
  }
  const eventRow = eventNewRow<Outbox>(req.body);
  if (!eventRow?.id) return res.status(400).json({ message: "Missing notification outbox row" });

  try {
    const current = await adminGql<{ notification_outbox_by_pk: Outbox | null }>(
      `query NotificationState($id: uuid!) {
        notification_outbox_by_pk(id: $id) { id channel destination payload status }
      }`,
      { id: eventRow.id },
    );
    const row = current.notification_outbox_by_pk;
    if (!row || row.status === "sent") return res.status(200).json({ message: "already handled" });

    if (row.channel === "slack") {
      const url = row.destination || env.SLACK_WEBHOOK_URL;
      if (!url) throw new Error("Slack webhook URL is not configured");
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row.payload?.text ? row.payload : { text: JSON.stringify(row.payload) }),
      });
      if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
    } else if (row.channel === "email") {
      // Deliberately explicit stub: replace with Resend/Postmark/etc. for a real email demo.
      console.log("EMAIL_NOTIFICATION_STUB", { destination: row.destination, payload: row.payload });
    } else {
      console.log("WORKFLOW_NOTIFICATION", row.payload);
    }

    await adminGql(
      `mutation Sent($id: uuid!, $at: timestamptz!) {
        update_notification_outbox_by_pk(pk_columns: {id: $id}, _set: {status: "sent", sent_at: $at}) { id }
      }`,
      { id: row.id, at: new Date().toISOString() },
    );
    return res.status(200).json({ status: "sent" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await adminGql(
      `mutation Failed($id: uuid!, $error: String!) {
        update_notification_outbox_by_pk(pk_columns: {id: $id}, _set: {status: "failed", error: $error}) { id }
      }`,
      { id: eventRow.id, error: message },
    ).catch(() => undefined);
    return res.status(500).json({ message });
  }
}
