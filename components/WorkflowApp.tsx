"use client";

import { createClient as createWsClient, type Client as WsClient } from "graphql-ws";
import { useEffect, useMemo, useRef, useState } from "react";
import { APPROVE_STEP, CREATE_WORKFLOW, DASHBOARD_QUERY, RUN_PROGRESS_SUBSCRIPTION, SAVE_WORKFLOW, TRIGGER_WORKFLOW, DELETE_WORKFLOW } from "@/lib/graphql";
import { graphqlWsUrl, nhost } from "@/lib/nhost";


type Role = "owner" | "editor" | "viewer";
type StepType = "llm_call" | "http_request" | "db_write" | "notify" | "conditional_branch" | "approval_gate";
type TriggerType = "manual" | "webhook" | "scheduled" | "database_event";

type Membership = { id: string; user_id: string; role: Role };
type Step = { id?: string; position: number; name: string; type: StepType; config: any };
type Trigger = { id?: string; type: TriggerType; config: any; enabled: boolean };
type Workflow = {
  id: string; org_id: string; name: string; description: string; enabled: boolean;
  steps: Step[]; triggers: Trigger[]; runs: Array<{ id: string; status: string; trigger_type: string; created_at: string }>;
};
type Org = {
  id: string; name: string; quota_limit: number; quota_used: number; quota_reserved: number;
  memberships: Membership[]; workflows: Workflow[];
};
type RunProgress = {
  id: string; status: string; error?: string | null; cursor_position: number;
  step_runs: Array<{
    id: string; status: string; attempt_count: number; output: any; error?: string | null;
    approved_by?: string | null; approved_at?: string | null;
    workflow_step: { id: string; position: number; name: string; type: StepType };
  }>;
};

const STEP_TYPES: StepType[] = ["llm_call", "http_request", "conditional_branch", "approval_gate", "db_write", "notify"];
const OWNER_ONLY_STEPS = new Set<StepType>(["db_write", "notify"]);

function defaultSteps(): Step[] {
  return [
    {
      position: 0,
      name: "Classify request",
      type: "llm_call",
      config: {
        prompt: "Classify this support request as urgent or normal. Return JSON with classification and reason. Request: {{triggerInput.message}}",
        json: true,
      },
    },
    {
      position: 1,
      name: "Choose branch",
      type: "conditional_branch",
      config: { condition: { source: "previousOutput", path: "classification", operator: "eq", value: "urgent" }, if_true: "urgent", if_false: "normal" },
    },
    {
      position: 2,
      name: "Urgent API call",
      type: "http_request",
      config: { branch: "urgent", method: "POST", url: "https://httpbin.org/post", body: { priority: "urgent", llm: "{{previousOutput}}" } },
    },
    {
      position: 3,
      name: "Normal API call",
      type: "http_request",
      config: { branch: "normal", method: "POST", url: "https://httpbin.org/post", body: { priority: "normal", llm: "{{previousOutput}}" } },
    },
    { position: 4, name: "Human approval", type: "approval_gate", config: { message: "Approve before finalizing" } },
    {
      position: 5,
      name: "Post-approval finalize",
      type: "http_request",
      config: { method: "POST", url: "https://httpbin.org/post", body: { approved: true, result: "{{previousOutput}}" } },
    },
  ];
}

function defaultTriggers(role: Role): Trigger[] {
  return role === "owner"
    ? [{ type: "manual", config: {}, enabled: true }, { type: "webhook", config: { secret: "demo-webhook-secret" }, enabled: true }]
    : [{ type: "manual", config: {}, enabled: true }];
}

function getDiagramRows(steps: Step[]) {
  const rows: any[] = [];
  let currentBranches: { [key: string]: { step: Step; index: number }[] } | null = null;

  steps.forEach((step, index) => {
    const branch = step.config?.branch;
    if (branch) {
      if (!currentBranches) {
        currentBranches = {};
      }
      if (!currentBranches[branch]) {
        currentBranches[branch] = [];
      }
      currentBranches[branch].push({ step, index });
    } else {
      if (currentBranches) {
        rows.push({ type: "branches", branches: currentBranches });
        currentBranches = null;
      }
      rows.push({ type: "main", step, index });
    }
  });

  if (currentBranches) {
    rows.push({ type: "branches", branches: currentBranches });
  }

  return rows;
}

function WorkflowDiagram({ steps, run }: { steps: Step[]; run: RunProgress | null }) {
  const rows = getDiagramRows(steps);

  const getStepStatus = (stepIdOrIndex: string | number, position: number) => {
    if (!run) return "";
    const stepRun = run.step_runs.find((sr) => 
      sr.workflow_step.id === stepIdOrIndex || sr.workflow_step.position === position
    );
    return stepRun?.status ?? "";
  };

  return (
    <div className="diagram-container">
      {rows.length === 0 ? (
        <div className="diagram-empty">No steps in this workflow yet. Add steps below to build your flow.</div>
      ) : (
        <div className="diagram-flow">
          {rows.map((row, rIdx) => {
            const isLastRow = rIdx === rows.length - 1;
            if (row.type === "main") {
              const status = getStepStatus(row.step.id ?? "", row.step.position);
              return (
                <div key={`main-${row.step.id ?? "new"}-${rIdx}`} className="diagram-row-wrapper">
                  <div className={`diagram-node ${row.step.type} ${status}`}>
                    <div className="node-badge">{row.index + 1}</div>
                    <div className="node-content">
                      <span className="node-name">{row.step.name || "Untitled Step"}</span>
                      <span className="node-type">{row.step.type}</span>
                    </div>
                  </div>
                  {!isLastRow && <div className="diagram-connector">↓</div>}
                </div>
              );
            } else if (row.type === "branches") {
              const branchKeys = Object.keys(row.branches);
              return (
                <div key={`branches-${rIdx}`} className="diagram-row-wrapper">
                  <div className="diagram-branches">
                    {branchKeys.map((bName) => (
                      <div key={bName} className="diagram-branch-column">
                        <div className="branch-label">Branch: {bName}</div>
                        <div className="branch-nodes">
                          {row.branches[bName].map((bNode: any, nIdx: number) => {
                            const status = getStepStatus(bNode.step.id ?? "", bNode.step.position);
                            const isLastInBranch = nIdx === row.branches[bName].length - 1;
                            return (
                              <div key={`bNode-${bNode.step.id ?? "new"}-${nIdx}`} className="diagram-node-wrapper">
                                <div className={`diagram-node ${bNode.step.type} ${status}`}>
                                  <div className="node-badge">{bNode.index + 1}</div>
                                  <div className="node-content">
                                    <span className="node-name">{bNode.step.name || "Untitled Step"}</span>
                                    <span className="node-type">{bNode.step.type}</span>
                                  </div>
                                </div>
                                {!isLastInBranch && <div className="diagram-connector">↓</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  {!isLastRow && <div className="diagram-connector">↓</div>}
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}


async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await nhost.graphql.request({ query, variables });
  const errors = (response.body as any)?.errors;
  if (errors?.length) throw new Error(errors.map((e: any) => e.message).join("; "));
  if (!(response.body as any)?.data) throw new Error(`GraphQL request failed (${response.status})`);
  return (response.body as any).data as T;
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cloneWorkflow(workflow: Workflow) {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step, config: structuredClone(step.config) })),
    triggers: workflow.triggers.map((trigger) => ({ ...trigger, config: structuredClone(trigger.config) })),
  };
}

function JsonEditor({ value, disabled, onChange }: { value: any; disabled?: boolean; onChange: (value: any) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [valid, setValid] = useState(true);

  useEffect(() => {
    setText(JSON.stringify(value ?? {}, null, 2));
    setValid(true);
  }, [value]);

  return (
    <textarea
      className={`config ${valid ? "" : "invalid"}`}
      disabled={disabled}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        try {
          onChange(JSON.parse(next));
          setValid(true);
        } catch {
          setValid(false);
        }
      }}
      aria-invalid={!valid}
      title={valid ? "Valid JSON" : "JSON is not valid yet"}
    />
  );
}

export function WorkflowApp() {
  const [sessionReady, setSessionReady] = useState(false);
  const [session, setSession] = useState<any>(null);
  const [authMode, setAuthMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<RunProgress | null>(null);
  const [runInput, setRunInput] = useState('{"message":"URGENT: production checkout is down"}');
  const wsRef = useRef<WsClient | null>(null);
  const quotaRefreshedForRun = useRef("");

  const org = orgs.find((item) => item.id === orgId) ?? null;
  const role = useMemo<Role | null>(() => {
    const userId = session?.user?.id;
    return org?.memberships.find((m) => m.user_id === userId)?.role ?? null;
  }, [org, session]);

  function clearWorkspaceState() {
    setOrgId("");
    setWorkflowId("");
    setDraft(null);
    setRunId("");
    setRun(null);
    wsRef.current?.dispose();
    wsRef.current = null;
  }

  useEffect(() => {
    (async () => {
      try { await nhost.refreshSession(); } catch { /* no active session */ }
      setSession(nhost.getUserSession());
      setSessionReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    clearWorkspaceState();
    (async () => {
      try {
        await bootstrapUser(session.accessToken);
      } catch (e) {
        if (!cancelled) setError(`Signed in, but org setup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const data = await loadDashboard();
      if (!cancelled && !data.length) {
        setError("No organization membership found. Create an account again or ask an owner to add this user.");
      }
    })();
    return () => { cancelled = true; };
  }, [session?.accessToken]);

  useEffect(() => {
    if (!org) {
      setWorkflowId("");
      setDraft(null);
      setRunId("");
      setRun(null);
      return;
    }
    const selected = org.workflows.find((w) => w.id === workflowId) ?? org.workflows[0];
    if (selected) {
      setWorkflowId(selected.id);
      setDraft(cloneWorkflow(selected));
    } else {
      setWorkflowId("");
      setDraft(null);
    }
  }, [orgId, orgs]);

  useEffect(() => {
    if (!runId || !session?.accessToken) return;
    wsRef.current?.dispose();
    const client = createWsClient({
      url: graphqlWsUrl(),
      connectionParams: { headers: { Authorization: `Bearer ${session.accessToken}`, "x-hasura-role": "user" } },
      retryAttempts: 5,
    });
    wsRef.current = client;
    const dispose = client.subscribe(
      { query: RUN_PROGRESS_SUBSCRIPTION, variables: { runId } },
      {
        next: (message) => setRun((message.data as any)?.workflow_runs_by_pk ?? null),
        error: (err) => setError(`Subscription: ${JSON.stringify(err)}`),
        complete: () => undefined,
      },
    );
    return () => { dispose(); client.dispose(); };
  }, [runId, session?.accessToken]);

  useEffect(() => {
    if (!runId || !run || !orgId) return;
    if (!["completed", "failed", "cancelled"].includes(run.status)) return;
    if (quotaRefreshedForRun.current === runId) return;
    quotaRefreshedForRun.current = runId;
    void loadDashboard(orgId);
  }, [run?.status, runId, orgId]);

  async function bootstrapUser(accessToken?: string) {
    const options = accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined;
    await nhost.functions.post("/bootstrap-user", {}, options);
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await nhost.auth.signInEmailPassword({ email, password });
      const nextSession = response.body?.session ?? nhost.getUserSession();
      if (!nextSession) throw new Error("Sign in failed");
      setSession(nextSession);
      await bootstrapUser(nextSession.accessToken).catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await nhost.auth.signUpEmailPassword({
        email,
        password,
        options: { allowedRoles: ["user", "me"], defaultRole: "user" },
      });
      const nextSession = response.body?.session ?? nhost.getUserSession();
      if (!nextSession) throw new Error("Account created. Verify the email if required, then sign in.");
      setSession(nextSession);
      await bootstrapUser(nextSession.accessToken).catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function loadDashboard(preferredOrgId?: string) {
    setError("");
    try {
      const data = await gql<{ organizations: Org[] }>(DASHBOARD_QUERY);
      setOrgs(data.organizations);
      const nextOrgId = [preferredOrgId, orgId].find((id) => id && data.organizations.some((item) => item.id === id)) || data.organizations[0]?.id || "";
      setOrgId(nextOrgId);
      if (!nextOrgId) {
        setWorkflowId("");
        setDraft(null);
        setRunId("");
        setRun(null);
      }
      return data.organizations;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  async function createWorkflow() {
    if (!org || !role || role === "viewer") {
      setError(!org ? "No organization is available for this account." : "Your role cannot create workflows.");
      return;
    }
    setBusy(true); setError("");
    try {
      const created = await gql<{ insert_workflows_one: { id: string } }>(CREATE_WORKFLOW, {
        object: { org_id: org.id, name: "New Workflow", description: "My new workflow", enabled: true },
      });
      const id = created.insert_workflows_one.id;
      const steps: Step[] = [];
      const triggers = await serializeTriggers([{ type: "manual", config: {}, enabled: true }], id);
      await gql(SAVE_WORKFLOW, {
        workflowId: id,
        patch: { name: "New Workflow", description: "My new workflow", enabled: true },
        keepStepIds: [],
        keepTriggerIds: [],
        steps,
        triggers,
      });
      await loadDashboard(org.id);
      setWorkflowId(id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function deleteWorkflow() {
    if (!draft || !role || role === "viewer") return;
    if (!confirm(`Are you sure you want to delete the workflow "${draft.name}"?`)) return;
    setBusy(true); setError("");
    try {
      await gql(DELETE_WORKFLOW, { id: draft.id });
      const nextOrgs = await loadDashboard(orgId);
      const remainingWorkflows = nextOrgs.find((o) => o.id === orgId)?.workflows ?? [];
      if (remainingWorkflows.length > 0) {
        setWorkflowId(remainingWorkflows[0].id);
        setDraft(cloneWorkflow(remainingWorkflows[0]));
      } else {
        setWorkflowId("");
        setDraft(null);
      }
      setRunId("");
      setRun(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function serializeTriggers(triggers: Trigger[], targetWorkflowId: string) {
    return Promise.all(triggers.map(async (trigger) => {
      const config = structuredClone(trigger.config ?? {});
      if (trigger.type === "webhook" && config.secret) {
        config.secret_sha256 = await sha256Hex(String(config.secret));
        delete config.secret;
      }
      return { ...(trigger.id ? { id: trigger.id } : {}), workflow_id: targetWorkflowId, type: trigger.type, config, enabled: trigger.enabled };
    }));
  }

  async function saveWorkflow() {
    if (!draft || !role || role === "viewer") return;
    setBusy(true); setError("");
    try {
      const steps = draft.steps
        .filter((step) => role === "owner" || !OWNER_ONLY_STEPS.has(step.type))
        .map((step) => ({
          ...(step.id ? { id: step.id } : {}),
          workflow_id: draft.id,
          position: draft.steps.indexOf(step),
          name: step.name,
          type: step.type,
          config: step.config ?? {},
        }));
      const triggers = await serializeTriggers(
        draft.triggers.filter((trigger) => role === "owner" || trigger.type !== "webhook"),
        draft.id,
      );
      await gql(SAVE_WORKFLOW, {
        workflowId: draft.id,
        patch: { name: draft.name, description: draft.description, enabled: draft.enabled },
        keepStepIds: draft.steps.flatMap((step) => step.id ? [step.id] : []),
        keepTriggerIds: draft.triggers.flatMap((trigger) => trigger.id ? [trigger.id] : []),
        steps,
        triggers,
      });
      await loadDashboard(orgId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function triggerRun() {
    if (!draft || role === "viewer") return;
    setBusy(true); setError(""); setRun(null);
    try {
      const parsed = JSON.parse(runInput);
      const data = await gql<{ triggerWorkflowRun: { workflow_run_id: string } }>(TRIGGER_WORKFLOW, { workflowId: draft.id, input: parsed });
      setRunId(data.triggerWorkflowRun.workflow_run_id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function approve(stepRunId: string) {
    setBusy(true); setError("");
    try {
      await gql(APPROVE_STEP, { stepRunId });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function canEditStep(step: Step) {
    return role === "owner" || (role === "editor" && !OWNER_ONLY_STEPS.has(step.type));
  }

  function canEditTrigger(trigger: Trigger) {
    return role === "owner" || (role === "editor" && trigger.type !== "webhook");
  }

  function updateStep(index: number, patch: Partial<Step>) {
    if (!draft) return;
    const steps = draft.steps.map((step, i) => i === index ? { ...step, ...patch } : step);
    setDraft({ ...draft, steps });
  }

  function moveStep(index: number, direction: -1 | 1) {
    if (!draft) return;
    const next = index + direction;
    if (next < 0 || next >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[next]] = [steps[next], steps[index]];
    setDraft({ ...draft, steps: steps.map((step, position) => ({ ...step, position })) });
  }

  if (!sessionReady) return <main className="center"><div className="panel">Loading session…</div></main>;
  if (!session) {
    return (
      <main className="center">
        <form className="panel auth" onSubmit={authMode === "signIn" ? signIn : signUp}>
          <div className="eyebrow">NHOST + HASURA</div>
          <h1>AgentFlow</h1>
          <p className="muted">{authMode === "signIn" ? "Sign in with a demo or created account." : "Create an account and personal org."}</p>
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <div className="error">{error}</div>}
          <button disabled={busy}>{busy ? (authMode === "signIn" ? "Signing in..." : "Creating account...") : (authMode === "signIn" ? "Sign in" : "Create account")}</button>
          <button
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => { setAuthMode(authMode === "signIn" ? "signUp" : "signIn"); setError(""); }}
          >
            {authMode === "signIn" ? "Create an account" : "Use existing account"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="shell">
      <header>
        <div><div className="eyebrow">AI AGENT WORKFLOW BUILDER</div><h1>AgentFlow</h1></div>
        <div className="header-actions">
          <select value={orgId} onChange={(e) => { setOrgId(e.target.value); setRunId(""); setRun(null); }}>
            {orgs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <span className={`role ${role}`}>{role ?? "no membership"}</span>
          <button className="ghost" onClick={() => { nhost.clearSession(); setSession(null); setOrgs([]); clearWorkspaceState(); }}>Sign out</button>
        </div>
      </header>

      {error && <div className="error banner">{error}</div>}

      <section className="quota panel">
        <div><strong>Usage this period</strong><span>{org?.quota_used ?? 0} used · {org?.quota_reserved ?? 0} running</span></div>
        <div className="meter"><i style={{ width: `${Math.min(100, ((org?.quota_used ?? 0) / Math.max(1, org?.quota_limit ?? 1)) * 100)}%` }} /></div>
        <b>{org?.quota_used ?? 0} / {org?.quota_limit ?? 0}</b>
      </section>

      <div className="workspace">
        <aside className="panel sidebar">
          <div className="row between"><h2>Workflows</h2>{(role === "owner" || role === "editor") && <button className="small" onClick={createWorkflow}>+ New</button>}</div>
          {org?.workflows.map((workflow) => (
            <button key={workflow.id} className={`workflow-link ${workflow.id === workflowId ? "active" : ""}`} onClick={() => { setWorkflowId(workflow.id); setDraft(cloneWorkflow(workflow)); setRunId(""); setRun(null); }}>
              <span>{workflow.name}</span><small>{workflow.runs[0]?.status ?? "never run"}</small>
            </button>
          ))}
          {!org?.workflows.length && <p className="muted">No workflows yet.</p>}
        </aside>

        <section className="panel builder">
          {!draft ? <div className="empty">Create a workflow to begin.</div> : <>
            <div className="row between wrap">
              <div>
                <input className="title-input" value={draft.name} disabled={role === "viewer"} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <p className="muted">Ordered steps. Branch-tagged steps are skipped when their branch is inactive.</p>
              </div>
              <div className="row">
                {role !== "viewer" && <button className="secondary danger-btn" disabled={busy} onClick={deleteWorkflow}>Delete</button>}
                {role !== "viewer" && <button className="secondary" disabled={busy} onClick={saveWorkflow}>Save</button>}
                {role !== "viewer" && <button disabled={busy} onClick={triggerRun}>▶ Run</button>}
              </div>
            </div>

            <div className="run-input">
              <label>Manual run input JSON<textarea value={runInput} disabled={role === "viewer"} onChange={(e) => setRunInput(e.target.value)} /></label>
            </div>

            <h3>Workflow Diagram</h3>
            <WorkflowDiagram steps={draft.steps} run={run} />

            <h3>Steps</h3>
            <div className="steps">
              {draft.steps.map((step, index) => (
                <article className="step" key={`${step.id ?? "new"}-${index}`}>
                  <div className="step-index">{index + 1}</div>
                  <div className="step-body">
                    <div className="row wrap">
                      <input value={step.name} disabled={!canEditStep(step)} onChange={(e) => updateStep(index, { name: e.target.value })} />
                      <select value={step.type} disabled={!canEditStep(step)} onChange={(e) => updateStep(index, { type: e.target.value as StepType })}>
                        {STEP_TYPES.filter((type) => role === "owner" || !OWNER_ONLY_STEPS.has(type) || type === step.type).map((type) => <option key={type}>{type}</option>)}
                      </select>
                      {canEditStep(step) && <div className="row compact"><button className="icon" disabled={index === 0 || (role === "editor" && OWNER_ONLY_STEPS.has(draft.steps[index - 1]?.type))} onClick={() => moveStep(index, -1)}>↑</button><button className="icon" disabled={index === draft.steps.length - 1 || (role === "editor" && OWNER_ONLY_STEPS.has(draft.steps[index + 1]?.type))} onClick={() => moveStep(index, 1)}>↓</button><button className="icon danger" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}>×</button></div>}
                    </div>
                    <JsonEditor disabled={!canEditStep(step)} value={step.config} onChange={(config) => updateStep(index, { config })} />
                  </div>
                </article>
              ))}
            </div>
            {role !== "viewer" && <button className="secondary add" onClick={() => setDraft({ ...draft, steps: [...draft.steps, { position: draft.steps.length, name: "New step", type: "llm_call", config: {} }] })}>+ Add step</button>}

            <div className="row between"><h3>Triggers</h3></div>
            <div className="triggers">
              {draft.triggers.map((trigger, index) => (
                <article className="trigger" key={`${trigger.id ?? "new"}-${index}`}>
                  <select value={trigger.type} disabled={!canEditTrigger(trigger)} onChange={(e) => {
                    const type = e.target.value as TriggerType;
                    if (type === "webhook" && role !== "owner") return;
                    const triggers = draft.triggers.map((t, i) => i === index ? { ...t, type } : t);
                    setDraft({ ...draft, triggers });
                  }}>
                    {(["manual", "scheduled", "database_event", ...(role === "owner" || trigger.type === "webhook" ? ["webhook"] : [])] as TriggerType[]).map((type) => <option key={type}>{type}</option>)}
                  </select>
                  <JsonEditor disabled={!canEditTrigger(trigger)} value={trigger.config} onChange={(config) => setDraft({ ...draft, triggers: draft.triggers.map((t, i) => i === index ? { ...t, config } : t) })} />
                  {canEditTrigger(trigger) && <button className="icon danger" onClick={() => setDraft({ ...draft, triggers: draft.triggers.filter((_, i) => i !== index) })}>×</button>}
                </article>
              ))}
            </div>
            {role !== "viewer" && <button className="secondary add" onClick={() => setDraft({ ...draft, triggers: [...draft.triggers, { type: "manual", config: {}, enabled: true }] })}>+ Add trigger</button>}
          </>}
        </section>

        <aside className="panel run-panel">
          <div className="row between"><h2>Live run</h2>{runId && <code>{runId.slice(0, 8)}</code>}</div>
          {!run && <p className="muted">Start a run to stream step status here.</p>}
          {run && <>
            <div className={`run-status ${run.status}`}>{run.status}</div>
            {run.error && <div className="error">{run.error}</div>}
            <div className="timeline">
              {run.step_runs.map((sr) => (
                <div className="timeline-item" key={sr.id}>
                  <span className={`dot ${sr.status}`} />
                  <div>
                    <strong>{sr.workflow_step.position + 1}. {sr.workflow_step.name}</strong>
                    <small>{sr.workflow_step.type} · {sr.status}{sr.attempt_count ? ` · attempt ${sr.attempt_count}` : ""}</small>
                    {sr.status === "awaiting_approval" && role !== "viewer" && <button className="approve" disabled={busy} onClick={() => approve(sr.id)}>Approve & resume</button>}
                    {sr.error && <small className="error-text">{sr.error}</small>}
                  </div>
                </div>
              ))}
            </div>
          </>}
        </aside>
      </div>
    </main>
  );
}
