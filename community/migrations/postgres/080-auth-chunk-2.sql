\set ON_ERROR_STOP on

-- Upstream v2.11.739 authenticates through auth_chunk_2 / auth_chunk_2_from_team
-- (upstream commit ce8ed1233). They return the same shape as the _1 versions and
-- additionally merge per-team flag overrides over organization flags. The
-- community distribution has no per-team flag overrides, so the _2 functions
-- delegate to the existing self-host _1 functions.

CREATE OR REPLACE FUNCTION public.auth_chunk_2(
  input_key text,
  input_credential_purpose text DEFAULT 'general'
)
RETURNS TABLE (
  api_key text,
  api_key_id bigint,
  team_id uuid,
  org_id uuid,
  flags jsonb,
  is_banned boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT * FROM public.auth_chunk_1(input_key, input_credential_purpose)
$function$;

CREATE OR REPLACE FUNCTION public.auth_chunk_2_from_team(input_team text)
RETURNS TABLE (
  api_key text,
  api_key_id bigint,
  team_id uuid,
  org_id uuid,
  flags jsonb,
  is_banned boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT * FROM public.auth_chunk_1_from_team(input_team)
$function$;

REVOKE EXECUTE ON FUNCTION public.auth_chunk_2(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_chunk_2_from_team(text) FROM PUBLIC;
