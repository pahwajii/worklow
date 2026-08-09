export const DASHBOARD_QUERY = `
query Dashboard {
  organizations(order_by: {created_at: asc}) {
    id name quota_limit quota_used quota_reserved
    memberships { id user_id role }
    workflows(order_by: {updated_at: desc}) {
      id org_id name description enabled
      steps(where: {archived: {_eq: false}}, order_by: [{position: asc}, {id: asc}]) { id position name type config }
      triggers(where: {archived: {_eq: false}}, order_by: {created_at: asc}) { id type config enabled }
      runs(limit: 1, order_by: {created_at: desc}) { id status trigger_type created_at }
    }
  }
}`;

export const CREATE_WORKFLOW = `
mutation CreateWorkflow($object: workflows_insert_input!) {
  insert_workflows_one(object: $object) { id name }
}`;

export const SAVE_WORKFLOW = `
mutation SaveWorkflow(
  $workflowId: uuid!, $patch: workflows_set_input!,
  $keepStepIds: [uuid!]!, $keepTriggerIds: [uuid!]!,
  $steps: [workflow_steps_insert_input!]!, $triggers: [workflow_triggers_insert_input!]!
) {
  update_workflows_by_pk(pk_columns: {id: $workflowId}, _set: $patch) { id }
  archiveRemovedSteps: update_workflow_steps(
    where: {workflow_id: {_eq: $workflowId}, archived: {_eq: false}, id: {_nin: $keepStepIds}},
    _set: {archived: true}
  ) { affected_rows }
  saveSteps: insert_workflow_steps(
    objects: $steps,
    on_conflict: {constraint: workflow_steps_pkey, update_columns: [position, name, type, config]}
  ) { affected_rows }
  archiveRemovedTriggers: update_workflow_triggers(
    where: {workflow_id: {_eq: $workflowId}, archived: {_eq: false}, id: {_nin: $keepTriggerIds}},
    _set: {archived: true}
  ) { affected_rows }
  saveTriggers: insert_workflow_triggers(
    objects: $triggers,
    on_conflict: {constraint: workflow_triggers_pkey, update_columns: [type, config, enabled]}
  ) { affected_rows }
}`;

export const TRIGGER_WORKFLOW = `
mutation TriggerWorkflowRun($workflowId: uuid!, $input: jsonb) {
  triggerWorkflowRun(workflow_id: $workflowId, input: $input) { workflow_run_id status message }
}`;

export const APPROVE_STEP = `
mutation ApproveStep($stepRunId: uuid!) {
  approveStep(step_run_id: $stepRunId) { workflow_run_id status message }
}`;

export const RUN_PROGRESS_SUBSCRIPTION = `
subscription RunProgress($runId: uuid!) {
  workflow_runs_by_pk(id: $runId) {
    id status error cursor_position started_at completed_at
    step_runs(order_by: {created_at: asc}) {
      id status attempt_count input output error approved_by approved_at
      workflow_step { id position name type }
    }
  }
}`;
