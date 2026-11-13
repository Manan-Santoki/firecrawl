\set ON_ERROR_STOP on

-- Expand-only schema update for upstream v2.11.739 (from v2.11.289).
-- Upstream also removed the per-request job-log tables (scrapes, crawls,
-- requests, searches, ...) from the Drizzle schema because the job log moved
-- to Pub/Sub. Under the expand-only policy those tables are kept; the API no
-- longer writes them.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "credit_limit" integer;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "credit_limit_interval" text;

ALTER TABLE "browser_sessions"
  ADD COLUMN IF NOT EXISTS "zero_data_retention" boolean DEFAULT false NOT NULL;
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "profile_name" text;

CREATE TABLE IF NOT EXISTS "browser_profiles" (
  "team_id" uuid NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "saved_at" timestamp with time zone NOT NULL,
  "size_bytes" bigint,
  CONSTRAINT "browser_profiles_team_id_name_pk" PRIMARY KEY ("team_id", "name")
);

CREATE TABLE IF NOT EXISTS "vercel_marketplace_installations" (
  "installation_id" text PRIMARY KEY NOT NULL,
  "team_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "vercel_marketplace_resources" (
  "installation_id" text NOT NULL
    REFERENCES "vercel_marketplace_installations" ("installation_id") ON DELETE CASCADE,
  "resource_id" text NOT NULL,
  "api_key_id" bigint REFERENCES "api_keys" ("id") ON DELETE SET NULL,
  "team_id" uuid,
  "resource_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vercel_marketplace_resources_installation_id_resource_id_pk"
    PRIMARY KEY ("installation_id", "resource_id")
);

CREATE TABLE IF NOT EXISTS "alexandria_feedback" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "team_id" uuid NOT NULL,
  "api_key_id" bigint,
  "api_version" text DEFAULT 'v2' NOT NULL,
  "rating" text NOT NULL,
  "requested_url" text NOT NULL,
  "requested_host" text GENERATED ALWAYS AS (
    lower(substring("requested_url" from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/?#:]+)'))
  ) STORED,
  "requested_functionality" text NOT NULL,
  "rationale" text NOT NULL,
  "objective" text,
  "origin" text,
  "integration" text,
  "schema_version" integer DEFAULT 2 NOT NULL,
  "credits_refunded" integer DEFAULT 0 NOT NULL,
  "refund_policy" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "alexandria_feedback_credits_refunded_check" CHECK ("credits_refunded" >= 0),
  CONSTRAINT "alexandria_feedback_rating_check" CHECK ("rating" IN ('good', 'partial', 'bad')),
  CONSTRAINT "alexandria_feedback_requested_url_check" CHECK (char_length("requested_url") <= 2048)
);

CREATE TABLE IF NOT EXISTS "alexandria_feedback_providers" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "feedback_id" uuid NOT NULL REFERENCES "alexandria_feedback" ("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL,
  "position" smallint NOT NULL,
  "name" text NOT NULL,
  "issue" text NOT NULL,
  "why" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "alexandria_feedback_providers_feedback_id_position_key" UNIQUE ("feedback_id", "position"),
  CONSTRAINT "alexandria_feedback_providers_issue_check" CHECK (
    "issue" IN ('missing_provider', 'insufficient_coverage', 'provider_unavailable', 'other')
  )
);

CREATE TABLE IF NOT EXISTS "alexandria_feedback_capabilities" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "feedback_id" uuid NOT NULL REFERENCES "alexandria_feedback" ("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL,
  "position" smallint NOT NULL,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "issue" text NOT NULL,
  "why" text NOT NULL,
  "requested_functionality" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "alexandria_feedback_capabilities_feedback_id_position_key" UNIQUE ("feedback_id", "position"),
  CONSTRAINT "alexandria_feedback_capabilities_issue_check" CHECK (
    "issue" IN ('new_capability_request', 'missing_capability', 'insufficient_functionality', 'incorrect_result', 'execution_error', 'other')
  ),
  CONSTRAINT "alexandria_feedback_capabilities_requested_functionality_check" CHECK (
    "issue" <> 'new_capability_request' OR "requested_functionality" IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS "alexandria_feedback_calls" (
  "feedback_id" uuid NOT NULL REFERENCES "alexandria_feedback" ("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL,
  "position" smallint NOT NULL,
  "request_id" text NOT NULL,
  "provider" text,
  "capability" text,
  "rating" text,
  "attribution" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "alexandria_feedback_calls_feedback_id_position_pk" PRIMARY KEY ("feedback_id", "position"),
  CONSTRAINT "alexandria_feedback_calls_attribution_check" CHECK ("attribution" IN ('token', 'window')),
  CONSTRAINT "alexandria_feedback_calls_rating_check" CHECK ("rating" IN ('good', 'partial', 'bad'))
);

CREATE INDEX IF NOT EXISTS "alexandria_feedback_calls_request_id_idx"
  ON "alexandria_feedback_calls" ("request_id");
