/**
 * Seed two organizations after creating demo users in Nhost Auth.
 * Required env:
 *   GRAPHQL_URL, HASURA_ADMIN_SECRET,
 *   ORG_A_OWNER_ID, ORG_A_EDITOR_ID, ORG_A_VIEWER_ID, ORG_B_OWNER_ID
 */
const required = ["GRAPHQL_URL", "HASURA_ADMIN_SECRET", "ORG_A_OWNER_ID", "ORG_A_EDITOR_ID", "ORG_A_VIEWER_ID", "ORG_B_OWNER_ID"];
for (const key of required) {
  if (!process.env[key]) { console.error(`Missing ${key}`); process.exit(1); }
}
async function gql(query, variables = {}) {
  const response = await fetch(process.env.GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": process.env.HASURA_ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}
const data = await gql(`mutation Seed($objects: [organizations_insert_input!]!) {
  insert_organizations(objects: $objects) { returning { id name } }
}`, { objects: [{ name: "Org A", quota_limit: 25 }, { name: "Org B", quota_limit: 25 }] });
const [orgA, orgB] = data.insert_organizations.returning;
await gql(`mutation Members($objects: [org_members_insert_input!]!) {
  insert_org_members(objects: $objects) { affected_rows }
}`, { objects: [
  { org_id: orgA.id, user_id: process.env.ORG_A_OWNER_ID, role: "owner" },
  { org_id: orgA.id, user_id: process.env.ORG_A_EDITOR_ID, role: "editor" },
  { org_id: orgA.id, user_id: process.env.ORG_A_VIEWER_ID, role: "viewer" },
  { org_id: orgB.id, user_id: process.env.ORG_B_OWNER_ID, role: "owner" },
] });
console.log(JSON.stringify({ orgA, orgB }, null, 2));
