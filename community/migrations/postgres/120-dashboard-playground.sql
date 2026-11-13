\set ON_ERROR_STOP on

-- Community operator dashboard v2: saved playground requests per user.
-- Responses are stored truncated (the API keeps full results for its own
-- retention window); retention is managed by the dashboard.

CREATE TABLE IF NOT EXISTS dashboard.playground_request (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL REFERENCES dashboard."user" ("id") ON DELETE CASCADE,
  team_id uuid NOT NULL,
  api_key_id bigint,
  kind text NOT NULL,
  title text,
  request jsonb NOT NULL,
  status_code integer,
  duration_ms integer,
  job_id text,
  response_preview jsonb,
  CONSTRAINT playground_request_kind_valid CHECK (
    kind IN ('scrape', 'search', 'map', 'crawl', 'batch_scrape', 'extract', 'agent')
  )
);

CREATE INDEX IF NOT EXISTS playground_request_user_created_idx
  ON dashboard.playground_request (user_id, created_at DESC);
