# Final walkthrough script

Use this sequence for the submission recording. Keep the GraphQL console open beside the app so the security proof is visible rather than inferred from hidden UI.

1. **Show tenant setup.** Sign in as `owner-a@example.com`, open Org A, then briefly show the org switcher and membership list/query. State that Org B has a separate owner account.
2. **Show the workflow definition.** Open the Org A demo workflow and show the `llm_call`, `conditional_branch`, urgent/normal `http_request` branches, `approval_gate`, and post-approval HTTP step. Show both manual and webhook triggers.
3. **Manual execution.** Run with `{"message":"URGENT: production checkout is down"}`. Keep the live run panel visible while statuses stream. Point out the inactive conditional path becoming `skipped`.
4. **Pause and approval.** When the approval step becomes `awaiting_approval`, show the overall run as `paused`. Approve as Org A owner or editor; show the post-approval HTTP step run and final `completed` state without refreshing.
5. **Webhook execution.** Invoke `triggerWorkflowWebhook` with the saved trigger UUID, raw demo secret, and a payload ID. Return to the app/run query and show a second run whose `trigger_type` is `webhook`.
6. **Direct-ID isolation proof.** Copy the Org A workflow UUID and paused/previous approval step-run UUID. Sign in as `owner-b@example.com` and deliberately use those exact IDs:
   - `workflows_by_pk(id: $orgAWorkflowId)` returns `null`;
   - `triggerWorkflowRun(workflow_id: $orgAWorkflowId)` is rejected;
   - `approveStep(step_run_id: $orgAStepRunId)` is rejected.
7. **Close on quota.** Return to Org A and show the usage indicator incremented after successful completion. Mention that paused runs reserve quota and failed runs release it.

For repeatable direct-ID checks, `npm run test:permissions` executes the three Org B probes and exits non-zero if any boundary is bypassed.
