/**
 * Direct-ID tenant isolation smoke test.
 * Usage:
 *   GRAPHQL_URL=... ORG_B_TOKEN=... ORG_A_WORKFLOW_ID=... ORG_A_STEP_RUN_ID=... npm run test:permissions
 */
const { GRAPHQL_URL, ORG_B_TOKEN, ORG_A_WORKFLOW_ID, ORG_A_STEP_RUN_ID } = process.env;
if (!GRAPHQL_URL || !ORG_B_TOKEN || !ORG_A_WORKFLOW_ID) {
  console.error("Set GRAPHQL_URL, ORG_B_TOKEN and ORG_A_WORKFLOW_ID.");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ORG_B_TOKEN}`,
      "x-hasura-role": "user",
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

let failed = false;
function check(condition, message, payload) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    failed = true;
    console.error(`FAIL: ${message}\n${JSON.stringify(payload, null, 2)}`);
  }
}

const guessedRead = await gql(
  `query($id: uuid!) { workflows_by_pk(id: $id) { id name } }`,
  { id: ORG_A_WORKFLOW_ID },
);
check(guessedRead?.data?.workflows_by_pk == null, "Org B cannot read Org A workflow by guessed UUID", guessedRead);

const guessedTrigger = await gql(
  `mutation($id: uuid!) { triggerWorkflowRun(workflow_id: $id) { workflow_run_id status } }`,
  { id: ORG_A_WORKFLOW_ID },
);
check(Boolean(guessedTrigger?.errors?.length) || !guessedTrigger?.data?.triggerWorkflowRun, "Org B cannot trigger Org A workflow by guessed UUID", guessedTrigger);

if (ORG_A_STEP_RUN_ID) {
  const guessedApprove = await gql(
    `mutation($id: uuid!) { approveStep(step_run_id: $id) { workflow_run_id status } }`,
    { id: ORG_A_STEP_RUN_ID },
  );
  check(Boolean(guessedApprove?.errors?.length) || !guessedApprove?.data?.approveStep, "Org B cannot approve Org A step by guessed UUID", guessedApprove);
}

if (failed) process.exit(2);
