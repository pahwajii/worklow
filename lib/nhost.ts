import { createClient } from "@nhost/nhost-js";

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || "xtohbhbdmlegmskonuxm";
const region = process.env.NEXT_PUBLIC_NHOST_REGION || "ap-south-1";
const defaultGraphqlUrl = `https://${subdomain}.hasura.${region}.nhost.run/v1`;
const graphqlUrl = (process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL || defaultGraphqlUrl).replace(".graphql.", ".hasura.");

export const nhost = createClient({
  subdomain,
  region,
  authUrl: process.env.NEXT_PUBLIC_NHOST_AUTH_URL || undefined,
  graphqlUrl,
  functionsUrl: process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL || undefined,
});

export function graphqlWsUrl() {
  const http = graphqlUrl;
  if (!http) throw new Error("Nhost GraphQL URL is not configured");
  const base = http.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return base.endsWith("/graphql") ? base : `${base.replace(/\/$/, "")}/graphql`;
}
