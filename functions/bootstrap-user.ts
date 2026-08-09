import type { Request, Response } from "./_lib/http";
import { env } from "./_lib/env";
import { adminGql } from "./_lib/hasura";

function authEndpoint() {
  const authUrl = env.NHOST_AUTH_URL;
  return authUrl ? `${authUrl.replace(/\/$/, "")}/user` : null;
}

function authHeader(req: Request) {
  const value = req.headers.authorization ?? req.headers.Authorization;
  return Array.isArray(value) ? value[0] : value;
}

async function currentUser(req: Request) {
  const endpoint = authEndpoint();
  const authorization = authHeader(req);
  if (!endpoint || !authorization) return null;

  const response = await fetch(endpoint, { headers: { authorization } });
  if (!response.ok) return null;
  return (await response.json()) as { id: string; email?: string | null; displayName?: string | null };
}

function orgNameFor(user: { email?: string | null; displayName?: string | null }) {
  if (user.displayName) return `${user.displayName}'s Org`;
  const local = user.email?.split("@")[0]?.trim();
  return local ? `${local}'s Org` : "My Org";
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });

  try {
    const user = await currentUser(req);
    if (!user?.id) return res.status(401).json({ message: "Sign in required" });

    const existing = await adminGql<{ org_members: Array<{ organization: { id: string; name: string } }> }>(
      `query ExistingMembership($userId: uuid!) {
        org_members(where: {user_id: {_eq: $userId}}, limit: 1) {
          organization { id name }
        }
      }`,
      { userId: user.id },
    );

    const currentOrg = existing.org_members[0]?.organization;
    if (currentOrg) return res.status(200).json({ organization: currentOrg, created: false });

    const created = await adminGql<{ insert_organizations_one: { id: string; name: string } }>(
      `mutation BootstrapOrg($object: organizations_insert_input!) {
        insert_organizations_one(object: $object) { id name }
      }`,
      {
        object: {
          name: orgNameFor(user),
          quota_limit: 25,
          memberships: { data: [{ user_id: user.id, role: "owner" }] },
        },
      },
    );

    return res.status(200).json({ organization: created.insert_organizations_one, created: true });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
  }
}
