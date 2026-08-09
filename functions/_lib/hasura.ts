import { env } from "./env";

const graphqlUrl = env.NHOST_GRAPHQL_URL;
const adminSecret = env.NHOST_ADMIN_SECRET;

function graphqlEndpoint() {
  if (!graphqlUrl) return null;
  return graphqlUrl.endsWith("/graphql") ? graphqlUrl : `${graphqlUrl.replace(/\/$/, "")}/graphql`;
}

export class HasuraError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "HasuraError";
  }
}

export async function adminGql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const endpoint = graphqlEndpoint();
  if (!endpoint || !adminSecret) {
    throw new HasuraError("NHOST_GRAPHQL_URL/NHOST_ADMIN_SECRET are not configured");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": adminSecret,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string; extensions?: unknown }> };
  if (!response.ok || body.errors?.length || !body.data) {
    throw new HasuraError(body.errors?.map((e) => e.message).join("; ") || `Hasura HTTP ${response.status}`, body.errors);
  }
  return body.data;
}

function constantTimeStringEqual(a: string, b: string) {
  const max = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

export function isTrustedWebhookSecret(headerValue: unknown) {
  const supplied = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const expected = env.NHOST_WEBHOOK_SECRET;
  if (typeof supplied !== "string" || !expected) return false;
  return constantTimeStringEqual(supplied, expected);
}

export function actionSession(body: any) {
  const vars = body?.session_variables ?? body?.sessionVariables ?? {};
  return {
    userId: vars["x-hasura-user-id"] ?? vars["X-Hasura-User-Id"] ?? null,
    role: vars["x-hasura-role"] ?? vars["X-Hasura-Role"] ?? null,
  };
}

export function actionInput<T = any>(body: any): T {
  return (body?.input ?? {}) as T;
}

export function eventNewRow<T = any>(body: any): T | null {
  return (body?.event?.data?.new ?? body?.event?.data?.old ?? null) as T | null;
}
