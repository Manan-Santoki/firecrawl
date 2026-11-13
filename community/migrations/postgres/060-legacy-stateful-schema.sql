\set ON_ERROR_STOP on

-- Expand the original self-host schema before upgrading stateful API routes.
-- Existing rows and authentication keys remain in place. Fresh installations
-- already have these objects; IF NOT EXISTS makes this migration repeatable.
CREATE TABLE IF NOT EXISTS public.agent_session_settings (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  team_id uuid NOT NULL,
  hidden boolean DEFAULT false,
  starred boolean DEFAULT false,
  label text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  share_id uuid
);

ALTER TABLE public.monitor_checks
  ADD COLUMN IF NOT EXISTS partner_run_token text;
ALTER TABLE public.monitors
  ADD COLUMN IF NOT EXISTS partner_job_token text;

DO $firecrawl$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_session_settings'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.agent_session_settings
      ADD CONSTRAINT agent_session_settings_pkey PRIMARY KEY (id);
  END IF;
END
$firecrawl$;

-- Refuse an incompatible legacy column rather than silently keeping its type.
DO $firecrawl$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE (attrelid, attname) IN (
      ('public.monitor_checks'::regclass, 'partner_run_token'),
      ('public.monitors'::regclass, 'partner_job_token')
    ) AND NOT attisdropped AND atttypid <> 'text'::regtype
  ) THEN
    RAISE EXCEPTION 'Legacy monitor token columns must have type text';
  END IF;
END
$firecrawl$;
