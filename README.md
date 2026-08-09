# AgentFlow — AI Agent Workflow Builder

A deliberately compact mini-n8n built for the full-stack Nhost + Hasura + PostgreSQL assignment. It includes a Next.js workflow builder, Nhost Auth, Hasura row permissions, Hasura Actions, Event/Cron Triggers, durable workflow execution, live GraphQL subscriptions, approval pause/resume, atomic quota reservation, and four trigger types.

## What is implemented

- **Data model:** organizations, org membership/roles, workflows, ordered steps, triggers, runs, step runs, durable run jobs, workflow data, notification outbox, watched database events.
- **Step types:** `llm_call`, `http_request`, `db_write`, `notify`, `conditional_branch`, `approval_gate`.
- **Trigger types:** manual Action, public webhook Action with secret validation, scheduled dispatcher, and database event trigger.
- **Layer 1 permissions:** one Hasura `user` role, every resource scoped through `org_members` and `x-hasura-user-id`.
- **Layer 2 permissions:** only owners may add/edit/delete `db_write`, `notify`, or `webhook` definitions. Approval is checked inside the Action handler and again inside a locked Postgres transition.
- **Live status:** the initial Action returns a run ID immediately; a Hasura Event Trigger executes the queued run while the browser subscribes to `workflow_runs_by_pk.step_runs`.
- **Quota:** admission uses `quota_reserved` to prevent concurrent overbooking; successful completion converts one reservation to `quota_used`, failures release it.
- **LLM:** real Groq Chat Completions when `GROQ_API_KEY` exists. Without it, a disclosed delayed classifier stub is used.
- **HTTP step:** one retry, timeout, a stable `Idempotency-Key`, protocol validation, obvious private/link-local SSRF blocking, and optional host allow-list.
- **Notify:** executor idempotently inserts `notification_outbox`; Hasura Event Trigger performs Slack/email/log delivery.

The architecture rationale is in [`docs/architecture-writeup.md`](docs/architecture-writeup.md), and the recording-ready final walkthrough is in [`docs/demo-script.md`](docs/demo-script.md).

## Repository map

```text
app/                         Next.js App Router
components/WorkflowApp.tsx   Auth + builder + live run UI
lib/                         Nhost client + GraphQL documents
functions/                   Nhost TypeScript functions
  _lib/                      executor helpers, retries, step implementations
nhost/
  migrations/                PostgreSQL schema/functions/view
  metadata/                  Hasura tables, relationships, permissions, Actions, triggers
graphql/operations.graphql   requested queries/mutations/subscription
scripts/                     demo seeding + direct-ID permission smoke test
docs/architecture-writeup.md assignment write-up
```

## 1. Create / link an Nhost project

Use a normal Nhost project with PostgreSQL, Hasura GraphQL, Auth and Functions. The current Nhost CLI supports a full local stack with `nhost up` and tracks migrations/metadata under the `nhost` folder.

```bash
nhost init
# or link/pull your cloud project using the Nhost CLI
```

Keep this repo's `nhost/migrations` and `nhost/metadata` files. `nhost/nhost.toml` only pins Node 22 for Functions; merge it with your generated project config if `nhost init` creates a fuller file.

## 2. Configure Hasura webhook environment variables

Nhost exposes custom environment variables to all project services. Set these in **Nhost Dashboard → Settings → Environment Variables** (or as `[[global.environment]]` entries in `nhost.toml`). Replace the base URL with your project's Functions URL shown by Nhost.

```text
WORKFLOW_TRIGGER_ACTION_WEBHOOK=https://<subdomain>.functions.<region>.nhost.run/v1/trigger-workflow-run
WORKFLOW_APPROVAL_ACTION_WEBHOOK=https://<subdomain>.functions.<region>.nhost.run/v1/approve-step
WORKFLOW_INBOUND_ACTION_WEBHOOK=https://<subdomain>.functions.<region>.nhost.run/v1/workflow-webhook-action
WORKFLOW_EXECUTOR_WEBHOOK=https://<subdomain>.functions.<region>.nhost.run/v1/execute-workflow-run
NOTIFICATION_WEBHOOK=https://<subdomain>.functions.<region>.nhost.run/v1/send-notification
DATABASE_EVENT_WEBHOOK=https://<subdomain>.functions.<region>.nhost.run/v1/database-event-trigger
SCHEDULED_WORKFLOW_WEBHOOK=https://<subdomain>.functions.<region>.nhost.run/v1/scheduled-workflows
```

For local Nhost, use the local Functions host instead. Nhost's Functions URL already includes `/v1`; the file names above become the remaining route segment.

Optional execution settings:

```text
GROQ_API_KEY=...                         # omit to use the documented stub
GROQ_MODEL=openai/gpt-oss-20b            # configurable; choose any active Groq chat model
LLM_STUB_DELAY_MS=900
HTTP_REQUEST_ALLOWED_HOSTS=httpbin.org,jsonplaceholder.typicode.com
ALLOW_UNSAFE_HTTP_REQUESTS=false
SLACK_WEBHOOK_URL=...                    # only needed for Slack notify demo
```

The Functions folder contains its own zero-dependency lockfile, which is sufficient for Nhost's serverless runtime. The backend implementation only uses the built-in `fetch`, `crypto`, and Nhost-injected environment variables.

## 3. Apply migrations + metadata

Start the local stack or deploy the Nhost project from Git. With local development:

```bash
nhost up
```

Confirm in Hasura Console that these are present:

- all public tables + relationships;
- tracked functions: `reserve_org_quota`, `finalize_org_quota`, `release_org_quota`, `approve_step_and_enqueue`;
- Actions: `triggerWorkflowRun`, `approveStep`, `triggerWorkflowWebhook`;
- Event Triggers: `run_jobs_inserted`, `notification_outbox_inserted`, `watched_events_inserted`;
- Cron Trigger: `scheduled_workflow_dispatcher`;
- view: `organization_usage_current_period`.

If your existing Nhost project uses a differently named database source environment variable, adjust `nhost/metadata/databases/databases.yaml` to match the source generated by your project before applying metadata.

## 4. Create demo users and seed two organizations

Create four users through Nhost Auth / the Nhost Dashboard (do not insert directly into `auth.users`):

```text
owner-a@example.com    → Org A owner
editor-a@example.com   → Org A editor
viewer-a@example.com   → Org A viewer
owner-b@example.com    → Org B owner
```

Use any demo password you control. Copy their Nhost Auth UUIDs, then run:

```bash
GRAPHQL_URL='https://<subdomain>.graphql.<region>.nhost.run/v1/graphql' \
HASURA_ADMIN_SECRET='...' \
ORG_A_OWNER_ID='...' \
ORG_A_EDITOR_ID='...' \
ORG_A_VIEWER_ID='...' \
ORG_B_OWNER_ID='...' \
node scripts/seed-orgs.mjs
```

This creates **Org A** and **Org B** with separate memberships and quota 25.

## 5. Run the Next.js app

The web app uses the current `@nhost/nhost-js` client and `graphql-ws` for live subscriptions.

```bash
cp .env.example .env.local
# fill in NEXT_PUBLIC_NHOST_SUBDOMAIN / REGION
npm install
npm run dev
```

For a self-hosted/local endpoint, set the optional `NEXT_PUBLIC_NHOST_AUTH_URL`, `NEXT_PUBLIC_NHOST_GRAPHQL_URL`, and `NEXT_PUBLIC_NHOST_FUNCTIONS_URL` overrides.

## 6. Build the exact demo workflow

Sign in as the **Org A owner**, click **+ New**. The starter workflow is intentionally prefilled for the assignment:

1. `llm_call` classifies `triggerInput.message` as `urgent` or `normal`.
2. `conditional_branch` reads `previousOutput.classification`.
3. urgent `http_request`, tagged `{ "branch": "urgent" }`.
4. normal `http_request`, tagged `{ "branch": "normal" }`.
5. `approval_gate`.
6. a final `http_request` after approval, so the resume is visibly doing real work rather than immediately marking the run complete.

Only one conditional HTTP branch executes; the other becomes `skipped`, visibly proving that LLM output changed workflow behavior.

The owner starter also includes **manual + webhook** triggers. Its editable webhook config initially contains:

```json
{ "secret": "demo-webhook-secret" }
```

On save, the browser replaces `secret` with `secret_sha256`; the raw secret is not stored. Remember the raw value for the demo.

## 7. Trigger manually and watch the subscription

Use this run input:

```json
{"message":"URGENT: production checkout is down"}
```

Click **Run**. The Action checks Org A membership and quota, returns the run ID, and inserts a run job. The event-triggered executor updates `step_runs`, so the right-hand timeline should change without refresh. At the approval step it shows `awaiting_approval` and the run status becomes `paused`.

Click **Approve & resume** as Org A owner/editor. The `approveStep` Action verifies that exact org membership and role, performs the locked state transition, and queues continuation from the next cursor position.

## 8. Trigger via Hasura webhook Action

Find the saved webhook trigger UUID in the UI/GraphQL and call the same GraphQL endpoint without auth. Nhost unauthenticated requests use Hasura's `public` role, and only the `triggerWorkflowWebhook` Action is exposed to it.

```graphql
mutation Webhook($triggerId: uuid!, $secret: String!, $payload: jsonb) {
  triggerWorkflowWebhook(trigger_id: $triggerId, secret: $secret, payload: $payload) {
    workflow_run_id
    status
  }
}
```

Variables:

```json
{
  "triggerId": "<webhook-trigger-uuid>",
  "secret": "demo-webhook-secret",
  "payload": {"id":"demo-001","message":"URGENT: webhook started this run"}
}
```

The handler hashes the supplied secret and compares it with the owner-created trigger. The caller cannot supply an arbitrary workflow ID.

## 9. Scheduled and database-event triggers

They are implemented even though the final walkthrough only needs one non-manual path.

A `scheduled` trigger config can be:

```json
{"every_minutes": 5}
```

Hasura's cron trigger calls `scheduled-workflows` every minute; the function starts only trigger rows due on that minute and uses a dedupe key.

A `database_event` trigger config can be:

```json
{"event_type":"support.ticket.created"}
```

Insert a `watched_events` row as an Org A owner/editor. The Hasura Event Trigger invokes `database-event-trigger`, which starts matching workflows in the same organization. Viewers cannot insert watched events, so they cannot indirectly trigger runs.

## 10. Prove cross-org isolation by direct ID guessing

This is more important than hiding UI elements. While Org A has a paused run, copy:

- an Org A workflow UUID;
- its awaiting-approval `step_run` UUID.

Sign in as **Org B owner** and directly execute:

```graphql
query Guess($id: uuid!) {
  workflows_by_pk(id: $id) { id name }
}
```

Expected: `null`.

Then attempt the manual Action with the Org A workflow UUID. Expected: authorization error from the Action handler. Attempt `approveStep` with the Org A step-run UUID. Expected: authorization error.

There is also a repeatable script:

```bash
GRAPHQL_URL='...' \
ORG_B_TOKEN='...' \
ORG_A_WORKFLOW_ID='...' \
ORG_A_STEP_RUN_ID='...' \
npm run test:permissions
```

This demonstrates that a shared application role (`user`) never grants cross-tenant access: every decision still resolves membership against the resource's organization.

## Security notes

1. **Never expose `NHOST_ADMIN_SECRET` to Next.js.** It is only read inside Nhost Functions.
2. Hasura row permissions are the user-facing security boundary; hiding Run/Approve controls is UX only.
3. Every Hasura Action/Event/Cron call to a Function carries `nhost-webhook-secret` sourced from `NHOST_WEBHOOK_SECRET`; handlers reject direct spoofed calls before reading session/event data.
4. Privileged step/trigger restrictions exist in metadata and are not trusted to the builder.
5. Approval is authorized at execution time in the Action and repeated inside a database transaction to prevent race/double approval.
6. Generic HTTP steps are an SSRF surface. This implementation blocks obvious local/private/link-local addresses and supports `HTTP_REQUEST_ALLOWED_HOSTS`; production systems should additionally resolve DNS and enforce egress controls.
7. Public webhook Action calls require an unguessable secret and never accept a workflow ID directly.
8. Scheduled/database Event Triggers use dedupe keys because Hasura event delivery can retry.

## Deployment

### Nhost

Push the repository to the GitHub repo connected to your Nhost project. Nhost deploys migrations, metadata and Functions from the repository. Configure all webhook environment variables before/with the deployment.

### Vercel

Import the same repository into Vercel and set:

```text
NEXT_PUBLIC_NHOST_SUBDOMAIN
NEXT_PUBLIC_NHOST_REGION
```

If applicable, set the three explicit URL overrides too. Add the Vercel domain to Nhost Auth's allowed redirect/client URLs. Deploy and use the Vercel URL as the assignment's hosted frontend deliverable.

## Requested GraphQL operations

See [`graphql/operations.graphql`](graphql/operations.graphql) for:

- org workflows + steps + triggers + most recent run;
- create/save workflow mutations;
- `approveStep` Action mutation;
- `triggerWorkflowRun` Action mutation;
- public webhook Action mutation;
- run + `step_runs` subscription filtered by run ID.

## Known deliberate scope choices

- The UI is an ordered-list workflow builder, not a visual DAG editor. `conditional_branch` uses branch tags and marks the inactive path `skipped`, which is sufficient to prove conditional execution.
- Email notification delivery is a disclosed stub; Slack can be real by setting `SLACK_WEBHOOK_URL`. Notification dispatch itself is still a Hasura Event Trigger.
- Without `GROQ_API_KEY`, `llm_call` uses a 900 ms artificial-delay stub as allowed by the assignment. The stub classifies words such as `urgent`, `critical`, `outage`, or `down` as urgent.
- A paused run retains its quota reservation. A production service should add stale-run cancellation/expiry to release abandoned reservations.

## Current upstream references

- Nhost Next.js quickstart: https://docs.nhost.io/getting-started/quickstart/nextjs
- Nhost Functions: https://docs.nhost.io/products/functions
- Nhost environment variables: https://docs.nhost.io/platform/cloud/environment-variables
- Nhost permissions: https://docs.nhost.io/products/graphql/permissions
- Hasura row permissions: https://hasura.io/docs/2.0/auth/authorization/permissions/row-level-permissions/
- Hasura scheduled triggers: https://hasura.io/docs/2.0/scheduled-triggers/overview/
- Groq API reference: https://console.groq.com/docs/api-reference
