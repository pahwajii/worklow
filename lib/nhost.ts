import { createClient } from "@nhost/nhost-js";

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || "xtohbhbdmlegmskonuxm";
const region = process.env.NEXT_PUBLIC_NHOST_REGION || "ap-south-1";

export const nhost = createClient({
  subdomain,
  region,
  authUrl: process.env.NEXT_PUBLIC_NHOST_AUTH_URL || undefined,
  graphqlUrl: process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL || undefined,
  functionsUrl: process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL || undefined,
});

export function graphqlWsUrl() {
  const explicit = process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL;
  const http = explicit || (subdomain && region ? `https://${subdomain}.graphql.${region}.nhost.run/v1` : "");
  if (!http) throw new Error("Nhost GraphQL URL is not configured");
  const base = http.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return base.endsWith("/graphql") ? base : `${base.replace(/\/$/, "")}/graphql`;
}
