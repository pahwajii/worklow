CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  quota_limit integer NOT NULL DEFAULT 100 CHECK (quota_limit >= 0),
  quota_used integer NOT NULL DEFAULT 0 CHECK (quota_used >= 0),
  quota_reserved integer NOT NULL DEFAULT 0 CHECK (quota_reserved >= 0),
  quota_period_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organizations_set_updated_at
BEFORE UPDATE ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.org_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX org_members_user_id_idx ON public.org_members(user_id);
CREATE INDEX org_members_org_role_idx ON public.org_members(org_id, role);

CREATE TABLE public.workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_org_id_idx ON public.workflows(org_id);
CREATE TRIGGER workflows_set_updated_at
BEFORE UPDATE ON public.workflows
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN (
    'llm_call', 'http_request', 'db_write', 'notify',
    'conditional_branch', 'approval_gate'
  )),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Position is intentionally not unique: preserving step IDs across edits keeps historical
-- step_runs valid, while the application normalizes the active definition to 0..N-1.
CREATE INDEX workflow_steps_workflow_position_idx ON public.workflow_steps(workflow_id, archived, position);
CREATE TRIGGER workflow_steps_set_updated_at
BEFORE UPDATE ON public.workflow_steps
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workflow_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('manual', 'webhook', 'scheduled', 'database_event')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_triggers_workflow_id_idx ON public.workflow_triggers(workflow_id);
CREATE TRIGGER workflow_triggers_set_updated_at
BEFORE UPDATE ON public.workflow_triggers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'paused', 'completed', 'failed', 'cancelled'
  )),
  trigger_type text NOT NULL CHECK (trigger_type IN (
    'manual', 'webhook', 'scheduled', 'database_event'
  )),
  trigger_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor_position integer NOT NULL DEFAULT 0 CHECK (cursor_position >= 0),
  quota_reserved boolean NOT NULL DEFAULT true,
  started_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_workflow_created_idx ON public.workflow_runs(workflow_id, created_at DESC);
CREATE INDEX workflow_runs_org_created_idx ON public.workflow_runs(org_id, created_at DESC);
CREATE TRIGGER workflow_runs_set_updated_at
BEFORE UPDATE ON public.workflow_runs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.step_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES public.workflow_steps(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'succeeded', 'failed', 'skipped', 'awaiting_approval'
  )),
  input jsonb NULL,
  output jsonb NULL,
  error text NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  approved_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, workflow_step_id)
);
CREATE INDEX step_runs_run_id_idx ON public.step_runs(workflow_run_id, created_at);
CREATE TRIGGER step_runs_set_updated_at
BEFORE UPDATE ON public.step_runs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Durable execution queue. Hasura Event Trigger `run_jobs_inserted` invokes the executor.
CREATE TABLE public.run_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('start', 'resume')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'failed')),
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NULL
);
CREATE INDEX run_jobs_run_id_idx ON public.run_jobs(workflow_run_id, created_at DESC);

-- `db_write` step target owned by this app.
CREATE TABLE public.workflow_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES public.workflow_steps(id) ON DELETE RESTRICT,
  key text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, workflow_step_id)
);
CREATE INDEX workflow_data_org_idx ON public.workflow_data(org_id, created_at DESC);

-- `notify` does not send directly from the executor. It emits an outbox row and a
-- Hasura Event Trigger invokes the notification function.
CREATE TABLE public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES public.workflow_steps(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('slack', 'email', 'log')),
  destination text NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NULL,
  UNIQUE (workflow_run_id, workflow_step_id)
);
CREATE INDEX notification_outbox_status_idx ON public.notification_outbox(status, created_at);

-- Optional watched table for demonstrating a database-event trigger.
CREATE TABLE public.watched_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Org-level aggregation required by the assignment.
CREATE VIEW public.organization_usage_current_period AS
SELECT
  o.id AS org_id,
  o.quota_period_start,
  o.quota_limit,
  o.quota_used,
  o.quota_reserved,
  GREATEST(o.quota_limit - o.quota_used - o.quota_reserved, 0) AS quota_remaining,
  CASE WHEN o.quota_limit = 0 THEN 1.0
       ELSE o.quota_used::numeric / o.quota_limit::numeric
  END AS usage_ratio
FROM public.organizations o;

-- Atomically reset the monthly window if needed and reserve one execution slot.
-- Returning zero rows means the quota is exhausted.
CREATE OR REPLACE FUNCTION public.reserve_org_quota(p_org_id uuid)
RETURNS SETOF public.organizations
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.organizations
  SET quota_used = 0,
      quota_reserved = 0,
      quota_period_start = date_trunc('month', now())
  WHERE id = p_org_id
    AND quota_period_start < date_trunc('month', now());

  RETURN QUERY
  UPDATE public.organizations
  SET quota_reserved = quota_reserved + 1
  WHERE id = p_org_id
    AND quota_used + quota_reserved < quota_limit
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_org_quota(p_org_id uuid)
RETURNS SETOF public.organizations
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.organizations
  SET quota_reserved = GREATEST(quota_reserved - 1, 0),
      quota_used = quota_used + 1
  WHERE id = p_org_id
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION public.release_org_quota(p_org_id uuid)
RETURNS SETOF public.organizations
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.organizations
  SET quota_reserved = GREATEST(quota_reserved - 1, 0)
  WHERE id = p_org_id
  RETURNING *;
$$;

-- Race-safe approval transition. The HTTP Action handler checks membership first;
-- this DB function repeats the check inside the transaction and enqueues continuation.
CREATE OR REPLACE FUNCTION public.approve_step_and_enqueue(
  p_step_run_id uuid,
  p_user_id uuid
)
RETURNS SETOF public.workflow_runs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_org_id uuid;
  v_step_type text;
BEGIN
  SELECT sr.workflow_run_id, wr.org_id, ws.type
  INTO v_run_id, v_org_id, v_step_type
  FROM public.step_runs sr
  JOIN public.workflow_runs wr ON wr.id = sr.workflow_run_id
  JOIN public.workflow_steps ws ON ws.id = sr.workflow_step_id
  WHERE sr.id = p_step_run_id
    AND sr.status = 'awaiting_approval'
  FOR UPDATE OF sr, wr;

  IF v_run_id IS NULL OR v_step_type <> 'approval_gate' THEN
    RAISE EXCEPTION 'step is not awaiting approval';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.org_members m
    WHERE m.org_id = v_org_id
      AND m.user_id = p_user_id
      AND m.role IN ('owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'not authorized to approve this step';
  END IF;

  UPDATE public.step_runs
  SET status = 'succeeded', approved_by = p_user_id, approved_at = now(), completed_at = now()
  WHERE id = p_step_run_id
    AND status = 'awaiting_approval';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'step was already approved';
  END IF;

  UPDATE public.workflow_runs
  SET status = 'queued', error = NULL
  WHERE id = v_run_id AND status = 'paused';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow run is not paused';
  END IF;

  INSERT INTO public.run_jobs(workflow_run_id, reason) VALUES (v_run_id, 'resume');

  RETURN QUERY SELECT * FROM public.workflow_runs WHERE id = v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_org_quota(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_org_quota(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_org_quota(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_step_and_enqueue(uuid, uuid) FROM PUBLIC;
