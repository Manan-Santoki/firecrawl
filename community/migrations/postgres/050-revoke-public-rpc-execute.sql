\set ON_ERROR_STOP on

-- PostgreSQL grants EXECUTE on newly-created functions to PUBLIC by default.
-- These routines expose authentication material or mutate billing/monitoring
-- state, and are intended to be called only by the owning application role.
REVOKE EXECUTE ON FUNCTION public.selfhost_unlimited_rate_limit_flags() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_chunk_1(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auth_chunk_1_from_team(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bill_team_7(uuid, text, numeric, bigint, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credits_billed_by_crawl_id_2(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.change_tracking_insert_scrape(uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.diff_get_last_scrape_v7(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_zdr_cleanup_batch_2(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.monitoring_claim_due_monitors(text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_agent_free_requests_left(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.agent_consume_free_request_if_left(uuid) FROM PUBLIC;
