\set ON_ERROR_STOP on

-- The public Drizzle schema mirrors Firecrawl's managed database shape, where
-- several constraints are applied out-of-band. Recreate those constraints for
-- a standalone PostgreSQL database.
DO $firecrawl$
DECLARE
  table_record record;
BEGIN
  FOR table_record IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'id'
      AND c.is_nullable = 'NO'
      AND t.table_type = 'BASE TABLE'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint pc
        JOIN pg_class rel ON rel.oid = pc.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = 'public'
          AND rel.relname = c.table_name
          AND pc.contype = 'p'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (id)',
      table_record.table_name,
      table_record.table_name || '_pkey'
    );
  END LOOP;
END
$firecrawl$;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_unique
  ON public.api_keys (key);
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_key_unique
  ON public.idempotency_keys (key);
CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_team_id_unique
  ON public.slack_installations (team_id);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_pages_identity_unique
  ON public.monitor_pages (monitor_id, target_id, url_hash);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_email_recipients_identity_unique
  ON public.monitor_email_recipients (monitor_id, email);

CREATE INDEX IF NOT EXISTS api_keys_team_id_idx ON public.api_keys (team_id);
CREATE INDEX IF NOT EXISTS requests_team_id_idx ON public.requests (team_id);
CREATE INDEX IF NOT EXISTS requests_dr_clean_by_idx
  ON public.requests (dr_clean_by)
  WHERE dr_clean_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS monitors_due_idx
  ON public.monitors (next_run_at)
  WHERE status = 'active' AND deleted_at IS NULL;
