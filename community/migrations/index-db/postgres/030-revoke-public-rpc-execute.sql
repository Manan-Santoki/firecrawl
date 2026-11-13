\set ON_ERROR_STOP on

-- PostgreSQL grants EXECUTE on new functions to PUBLIC. The index functions
-- are for the owning application role only; insert_omce_job_if_needed and
-- community_index_prune write data.
REVOKE EXECUTE ON FUNCTION public.index_get_recent_5(bytea, bigint, boolean, boolean, boolean, boolean, text, text[], bigint, boolean, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.community_index_split_rows(text, integer, integer, bytea, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_index_at_split_level(integer, bytea, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_index_at_split_level_with_meta(integer, bytea, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_index_at_domain_split_level(integer, bytea, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_index_at_domain_split_level_with_meta(integer, bytea, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_index_at_domain_split_level_omce(integer, bytea, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_omce_signatures(bytea, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_engpicker_verdict(bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.insert_omce_job_if_needed(integer, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_max_age(bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_domain_priority(integer, double precision, integer, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.query_top_urls_for_domain(bytea, interval, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.community_index_prune(interval, integer) FROM PUBLIC;
