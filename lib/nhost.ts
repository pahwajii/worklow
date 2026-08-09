import { createClient } from "@nhost/nhost-js";

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || "xtohbhbdmlegmskonuxm";
const region = process.env.NEXT_PUBLIC_NHOST_REGION || "ap-south-1";
const defaultGraphqlUrl = `https://${subdomain}.hasura.${region}.nhost.run/v1/graphql`;
const graphqlUrl = normalizeGraphqlUrl(process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL || defaultGraphqlUrl);

function normalizeGraphqlUrl(value: string) {
  const url = value.replace(".graphql.", ".hasura.").replace(/\/$/, "");
  return url.endsWith("/graphql") ? url : `${url}/graphql`;
}

export const nhost = createClient({
  subdomain,
  region,
  authUrl: process.env.NEXT_PUBLIC_NHOST_AUTH_URL || undefined,
  graphqlUrl,
  functionsUrl: process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL || undefined,
});

export function graphqlWsUrl() {
  const http = graphqlUrl;
  const base = http.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return base;
}
