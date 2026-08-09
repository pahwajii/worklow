import { adminGql } from "./hasura";
import { env } from "./env";

export type WorkflowStep = {
  id: string;
  workflow_id: string;
  position: number;
  name: string;
  type: "llm_call" | "http_request" | "db_write" | "notify" | "conditional_branch" | "approval_gate";
  config: Record<string, any>;
};

export type StepExecutionContext = {
  runId: string;
  orgId: string;
  triggerInput: unknown;
  previousOutput: unknown;
  activeBranch?: string | null;
};

function getByPath(value: any, path: string) {
  return path.split(".").filter(Boolean).reduce((acc, key) => (acc == null ? undefined : acc[key]), value);
}

function renderTemplate(value: unknown, context: StepExecutionContext): unknown {
  if (typeof value !== "string") return value;
  const replacements: Record<string, unknown> = {
    "triggerInput": context.triggerInput,
    "previousOutput": context.previousOutput,
  };
  const exact = value.match(/^\{\{\s*(triggerInput|previousOutput)(?:\.([^}]+))?\s*\}\}$/);
  if (exact) {
    const base = replacements[exact[1]];
    return exact[2] ? getByPath(base, exact[2].trim()) : base;
  }
  return value.replace(/\{\{\s*(triggerInput|previousOutput)(?:\.([^}]+))?\s*\}\}/g, (_m, root, path) => {
    const base = replacements[root];
    const result = path ? getByPath(base, path.trim()) : base;
    return typeof result === "string" ? result : JSON.stringify(result ?? "");
  });
}

function renderDeep(value: any, context: StepExecutionContext): any {
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, context)]));
  }
  return renderTemplate(value, context);
}

function parsePossibleJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return { text };
  }
}

export async function executeLlm(step: WorkflowStep, context: StepExecutionContext) {
  const prompt = String(renderTemplate(step.config.prompt ?? "Classify the input as urgent or normal and return JSON with classification and reason. Input: {{triggerInput}}", context));
  const apiKey = env.GROQ_API_KEY;

  if (!apiKey) {
    const delay = Number(env.LLM_STUB_DELAY_MS ?? 900);
    await new Promise((resolve) => setTimeout(resolve, delay));
    const haystack = `${prompt} ${JSON.stringify(context.triggerInput)}`.toLowerCase();
    const urgent = /urgent|critical|outage|down|sev[ -]?1|emergency/.test(haystack);
    return { classification: urgent ? "urgent" : "normal", reason: "stubbed classifier", stubbed: true };
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: step.config.model ?? env.GROQ_MODEL ?? "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: step.config.system ?? "Return concise valid JSON when the user requests structured output." },
        { role: "user", content: prompt },
      ],
      temperature: step.config.temperature ?? 0.1,
      response_format: step.config.json === false ? undefined : { type: "json_object" },
    }),
  });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(`Groq ${response.status}: ${JSON.stringify(body)}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned no message content");
  return parsePossibleJson(content);
}

function isPrivateHost(hostname: string) {
  const h = hostname.toLowerCase();
  if (["localhost", "metadata.google.internal"].includes(h)) return true;
  if (h === "169.254.169.254" || h === "100.100.100.200") return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export async function executeHttp(step: WorkflowStep, context: StepExecutionContext) {
  const url = new URL(String(renderTemplate(step.config.url, context)));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https URLs are allowed");

  const allowUnsafe = env.ALLOW_UNSAFE_HTTP_REQUESTS === "true";
  const allowHosts = (env.HTTP_REQUEST_ALLOWED_HOSTS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!allowUnsafe) {
    if (isPrivateHost(url.hostname)) throw new Error("Private/link-local HTTP targets are blocked");
    if (allowHosts.length && !allowHosts.includes(url.hostname)) {
      throw new Error(`Host ${url.hostname} is not in HTTP_REQUEST_ALLOWED_HOSTS`);
    }
  }

  const method = String(step.config.method ?? "POST").toUpperCase();
  const renderedHeaders = renderDeep(step.config.headers ?? { "content-type": "application/json" }, context);
  const headers = new Headers(renderedHeaders as HeadersInit);
  if (!["GET", "HEAD"].includes(method) && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", `${context.runId}:${step.id}`);
  }
  const renderedBody = renderDeep(step.config.body ?? { previous: "{{previousOutput}}", trigger: "{{triggerInput}}" }, context);
  const response = await fetch(url, {
    method,
    headers,
    body: ["GET", "HEAD"].includes(method) ? undefined : (typeof renderedBody === "string" ? renderedBody : JSON.stringify(renderedBody)),
    signal: AbortSignal.timeout(Number(step.config.timeout_ms ?? 10000)),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? parsePossibleJson(text) : { status: response.status, text };
}

export function executeConditional(step: WorkflowStep, context: StepExecutionContext) {
  const condition = step.config.condition ?? {};
  const source = condition.source === "triggerInput" ? context.triggerInput : context.previousOutput;
  const actual = getByPath(source, String(condition.path ?? "classification"));
  const expected = condition.value ?? "urgent";
  const operator = condition.operator ?? "eq";
  const matched = operator === "contains"
    ? String(actual ?? "").includes(String(expected))
    : operator === "neq"
      ? actual !== expected
      : actual === expected;
  return {
    matched,
    branch: matched ? (step.config.if_true ?? "urgent") : (step.config.if_false ?? "normal"),
    actual,
    expected,
  };
}

export async function executeDbWrite(step: WorkflowStep, context: StepExecutionContext) {
  const key = String(renderTemplate(step.config.key ?? `run-${context.runId}`, context));
  const value = renderDeep(step.config.value ?? "{{previousOutput}}", context);
  const data = await adminGql<{ insert_workflow_data_one: { id: string; key: string } }>(
    `mutation WriteData($object: workflow_data_insert_input!) {
      insert_workflow_data_one(
        object: $object,
        on_conflict: {constraint: workflow_data_workflow_run_id_workflow_step_id_key, update_columns: [key, value]}
      ) { id key }
    }`,
    { object: { org_id: context.orgId, workflow_run_id: context.runId, workflow_step_id: step.id, key, value } },
  );
  return { saved: true, ...data.insert_workflow_data_one };
}

export async function executeNotify(step: WorkflowStep, context: StepExecutionContext) {
  const payload = renderDeep(step.config.payload ?? { message: "Workflow notification", previous: "{{previousOutput}}" }, context);
  const data = await adminGql<{ insert_notification_outbox_one: { id: string; status: string } }>(
    `mutation QueueNotification($object: notification_outbox_insert_input!) {
      insert_notification_outbox_one(
        object: $object,
        on_conflict: {constraint: notification_outbox_workflow_run_id_workflow_step_id_key, update_columns: [channel, destination, payload]}
      ) { id status }
    }`,
    {
      object: {
        org_id: context.orgId,
        workflow_run_id: context.runId,
        workflow_step_id: step.id,
        channel: step.config.channel ?? "log",
        destination: step.config.destination ?? null,
        payload,
      },
    },
  );
  return { queued: true, ...data.insert_notification_outbox_one };
}
