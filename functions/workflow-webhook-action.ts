import type { Request, Response } from "./_lib/http";
import { isTrustedWebhookSecret, actionInput, adminGql } from "./_lib/hasura";
import { startWorkflowRun } from "./_lib/start-run";

async function sha256Hex(value: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqualHex(a: string, b: string) {
  const max = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });
  if (!isTrustedWebhookSecret(req.headers["nhost-webhook-secret"])) {
    return res.status(401).json({ message: "Unauthorized webhook" });
  }
  try {
    const input = actionInput<{ trigger_id: string; secret: string; payload?: unknown }>(req.body);
    if (!input.trigger_id || !input.secret) return res.status(400).json({ message: "trigger_id and secret are required" });

    const data = await adminGql<{
      workflow_triggers_by_pk: null | { id: string; type: string; enabled: boolean; archived: boolean; config: any; workflow: { id: string; enabled: boolean } };
    }>(
      `query WebhookTrigger($id: uuid!) {
        workflow_triggers_by_pk(id: $id) { id type enabled archived config workflow { id enabled } }
      }`,
      { id: input.trigger_id },
    );
    const trigger = data.workflow_triggers_by_pk;
    if (!trigger || trigger.archived || trigger.type !== "webhook" || !trigger.enabled || !trigger.workflow.enabled) {
      return res.status(404).json({ message: "Webhook trigger not found" });
    }
    const suppliedHash = await sha256Hex(input.secret);
    if (!safeEqualHex(suppliedHash, String(trigger.config?.secret_sha256 ?? ""))) {
      return res.status(404).json({ message: "Webhook trigger not found" });
    }

    const result = await startWorkflowRun({
      workflowId: trigger.workflow.id,
      triggerType: "webhook",
      input: { trigger_id: trigger.id, payload: input.payload ?? {} },
      dedupeKey: (input.payload as any)?.id ? `webhook:${trigger.id}:${(input.payload as any).id}` : null,
    });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
  }
}
