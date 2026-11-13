-- Behavioural tests for the reconstructed index database functions.
-- Run against a database migrated with community/migrations/index-db:
--   psql -v ON_ERROR_STOP=1 -f community/scripts/index-db-functions.test.sql
-- Every assertion raises on failure; the script runs in one transaction and
-- rolls back, so it leaves no rows behind.
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE h AS SELECT
  sha256('https://example.com/docs/page')::bytea AS url,
  sha256('https://example.com')::bytea AS split0,
  sha256('https://example.com/docs')::bytea AS split1,
  sha256('example.com')::bytea AS dom0,
  sha256('docs.example.com')::bytea AS dom1;

CREATE TEMP TABLE fixture (label text PRIMARY KEY, id uuid);

-- Rows written exactly as the index worker writes them (Drizzle insert).
WITH ins AS (
  INSERT INTO public.index (
    created_at, url, url_hash, original_url, resolved_url, has_screenshot, has_screenshot_fullscreen,
    is_mobile, block_ads, location_country, location_languages, status, title, description,
    is_precrawl, wait_time_ms, is_stealth, url_split_0_hash, url_split_1_hash, url_split_2_hash,
    domain_splits_0_hash
  )
  SELECT now() - v.age, 'https://example.com/docs/page', h.url, 'https://example.com/docs/page', v.resolved,
         v.shot, false, v.mobile, true, v.country, v.langs, v.status, v.label, 'd', false, v.wait, false,
         h.split0, h.split1, h.url, h.dom0
  FROM h, (VALUES
    ('fresh',      interval '1 minute', false, false, NULL::text, NULL::text[], 200, NULL::bigint, 'https://example.com/docs/page'),
    ('older',      interval '2 hours',  true,  false, NULL,       NULL,         200, 5000,          'https://example.com/docs/page'),
    ('stale',      interval '3 days',   false, false, NULL,       NULL,         200, NULL,          'https://example.com/docs/page'),
    ('mobile',     interval '1 minute', false, true,  NULL,       NULL,         200, NULL,          'https://example.com/docs/page'),
    ('located',    interval '1 minute', false, false, 'DE',       ARRAY['de','en'], 200, NULL,      'https://example.com/docs/page'),
    ('error',      interval '30 seconds', false, false, NULL,     NULL,         500, NULL,          'https://example.com/docs/page')
  ) AS v(label, age, shot, mobile, country, langs, status, wait, resolved)
  RETURNING id, title
)
INSERT INTO fixture SELECT title, id FROM ins;

-- Untyped parameters, named notation: the exact call shape of db/rpc.ts.
PREPARE recent AS SELECT * FROM public.index_get_recent_5(
  p_url_hash => $1, p_max_age_ms => $2, p_is_mobile => $3, p_block_ads => $4,
  p_feature_screenshot => $5, p_feature_screenshot_fullscreen => $6,
  p_location_country => $7, p_location_languages => $8::text[], p_wait_time_ms => $9,
  p_is_stealth => $10, p_min_age_ms => $11);

CREATE TEMP TABLE got (case_name text, ids uuid[]);
INSERT INTO got SELECT 'default', array_agg(id ORDER BY created_at DESC) FROM h, LATERAL (SELECT * FROM public.index_get_recent_5(h.url, 172800000, false, true, false, false, NULL, NULL, 0, false, NULL)) r;

DO $t$
DECLARE
  got uuid[];
  want uuid[];
  n integer;
BEGIN
  -- Default variant within 2 days: error (newest), fresh, older; not stale/mobile/located.
  SELECT ids INTO got FROM pg_temp.got WHERE case_name = 'default';
  SELECT ARRAY[(SELECT id FROM fixture WHERE label = 'error'), (SELECT id FROM fixture WHERE label = 'fresh'), (SELECT id FROM fixture WHERE label = 'older')] INTO want;
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'default variant: got %, want %', got, want; END IF;

  -- Screenshot needed: only the entry that has one.
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, false, true, true, false, NULL, NULL, 0, false, NULL) r
    WHERE r.id <> (SELECT id FROM fixture WHERE label = 'older');
  IF n <> 0 THEN RAISE EXCEPTION 'screenshot filter returned % non-screenshot rows', n; END IF;

  -- waitFor: entry must have waited at least as long.
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, false, true, false, false, NULL, NULL, 3000, false, NULL);
  IF n <> 1 THEN RAISE EXCEPTION 'waitFor filter: got % rows, want 1', n; END IF;

  -- maxAge widens to the 3-day-old entry; minAge excludes the fresh ones.
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 4 * 86400000::bigint, false, true, false, false, NULL, NULL, 0, false, NULL);
  IF n <> 4 THEN RAISE EXCEPTION 'maxAge 4d: got % rows, want 4', n; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 4 * 86400000::bigint, false, true, false, false, NULL, NULL, 0, false, 3600000);
  IF n <> 2 THEN RAISE EXCEPTION 'minAge 1h: got % rows, want 2', n; END IF;
  -- Huge maxAge must not overflow.
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 9007199254740991, false, true, false, false, NULL, NULL, 0, false, NULL);
  IF n <> 4 THEN RAISE EXCEPTION 'huge maxAge: got % rows, want 4', n; END IF;

  -- Exact-match dimensions.
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, true, true, false, false, NULL, NULL, 0, false, NULL);
  IF n <> 1 THEN RAISE EXCEPTION 'mobile variant: got % rows, want 1', n; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, false, false, false, false, NULL, NULL, 0, false, NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'blockAds=false variant: got % rows, want 0', n; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, false, true, false, false, NULL, NULL, 0, true, NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'stealth variant: got % rows, want 0', n; END IF;
  -- Languages compare as sets; NULL only matches NULL.
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, false, true, false, false, 'DE', ARRAY['en','de','en'], 0, false, NULL);
  IF n <> 1 THEN RAISE EXCEPTION 'language set match: got % rows, want 1', n; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, false, true, false, false, 'DE', NULL, 0, false, NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'NULL languages matched a located row (% rows)', n; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, false, true, false, false, 'DE', ARRAY['de'], 0, false, NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'language subset matched (% rows)', n; END IF;

  -- Invalidated entries are never served.
  UPDATE public.index SET invalidated_at = now() WHERE id = (SELECT id FROM fixture WHERE label = 'error');
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.index_get_recent_5(h.url, 172800000, false, true, false, false, NULL, NULL, 0, false, NULL);
  IF n <> 2 THEN RAISE EXCEPTION 'invalidated filter: got % rows, want 2', n; END IF;
END
$t$;

-- Untyped-parameter resolution (as sent by node-postgres).
CREATE TEMP TABLE untyped AS
  EXECUTE recent(sha256('https://example.com/docs/page'), '172800000', 'false', 'true', 'false', 'false', NULL, NULL, '0', 'false', NULL);
DEALLOCATE recent;
DO $t$
BEGIN
  IF (SELECT count(*) FROM pg_temp.untyped) <> 2 THEN
    RAISE EXCEPTION 'untyped-parameter call returned % rows, want 2', (SELECT count(*) FROM pg_temp.untyped);
  END IF;
END
$t$;

-- LIMIT 5, newest first.
INSERT INTO public.index (created_at, url, url_hash, original_url, resolved_url, has_screenshot, has_screenshot_fullscreen,
  is_mobile, block_ads, status, is_stealth, url_split_0_hash)
SELECT now() - make_interval(secs => g), 'u', sha256('limit-test'), 'u', 'u', false, false, false, true, 200, false, sha256('x')
FROM generate_series(1, 8) AS g;
DO $t$
DECLARE n integer; newest timestamptz;
BEGIN
  SELECT count(*), max(created_at) INTO n, newest FROM public.index_get_recent_5(sha256('limit-test'), 86400000, false, true, false, false, NULL, NULL, 0, false, NULL);
  IF n <> 5 THEN RAISE EXCEPTION 'limit: got %', n; END IF;
  IF (SELECT created_at FROM public.index_get_recent_5(sha256('limit-test'), 86400000, false, true, false, false, NULL, NULL, 0, false, NULL) LIMIT 1) <> newest THEN
    RAISE EXCEPTION 'not ordered newest first';
  END IF;
END
$t$;

-- Discovery by URL split / domain split (2xx only, deduplicated).
DO $t$
DECLARE n integer; r record;
BEGIN
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.query_index_at_split_level(1, h.split1, now() - interval '2 days');
  IF n <> 1 THEN RAISE EXCEPTION 'split level 1: got % rows, want 1 distinct resolved_url', n; END IF;
  SELECT m.* INTO r FROM pg_temp.h, LATERAL public.query_index_at_split_level_with_meta(0, h.split0, now() - interval '2 days') AS m;
  IF r.resolved_url <> 'https://example.com/docs/page' OR r.title IS NULL THEN RAISE EXCEPTION 'split meta row: %', r; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.query_index_at_split_level(12, h.split1, now() - interval '2 days');
  IF n <> 0 THEN RAISE EXCEPTION 'out-of-range level returned rows'; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.query_index_at_domain_split_level_with_meta(0, h.dom0, now() - interval '2 days');
  IF n <> 1 THEN RAISE EXCEPTION 'domain split meta: got %', n; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.query_index_at_domain_split_level(0, h.dom0, now() - interval '2 days');
  IF n <> 1 THEN RAISE EXCEPTION 'domain split: got %', n; END IF;
  SELECT count(*) INTO n FROM (SELECT o.url FROM pg_temp.h, LATERAL public.query_index_at_domain_split_level_omce(0, h.dom0, now() - interval '5 days') AS o LIMIT 100) q WHERE q.url IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'domain omce: got %', n; END IF;
  SELECT count(*) INTO n FROM pg_temp.h, LATERAL public.query_index_at_split_level(1, h.split1, now() - interval '1 second');
  IF n <> 0 THEN RAISE EXCEPTION 'newer_than not applied'; END IF;
END
$t$;

-- Engine picker queue, verdicts, OMCE signatures, dynamic maxAge.
DO $t$
DECLARE n integer; v text; sigs text[]; m double precision;
BEGIN
  PERFORM public.insert_omce_job_if_needed(i_domain_level => 1, i_domain_hash => sha256('docs.example.com'));
  PERFORM public.insert_omce_job_if_needed(i_domain_level => 1, i_domain_hash => sha256('docs.example.com'));
  SELECT count(*) INTO n FROM public.engpicker_queue WHERE domain_hash = sha256('docs.example.com');
  IF n <> 1 THEN RAISE EXCEPTION 'engpicker queue dedupe: got % rows', n; END IF;
  PERFORM public.insert_omce_job_if_needed(i_domain_level => 0, i_domain_hash => sha256('other.example'));
  SELECT count(*) INTO n FROM public.engpicker_queue WHERE domain_hash = sha256('other.example') AND domain_level = 0 AND NOT done;
  IF n <> 1 THEN RAISE EXCEPTION 'engpicker queue insert missing'; END IF;

  SELECT count(*) INTO n FROM public.query_engpicker_verdict(sha256('docs.example.com'));
  IF n <> 0 THEN RAISE EXCEPTION 'verdict without data'; END IF;
  INSERT INTO public.engpicker_verdicts (domain_hash, verdict, created_at) VALUES
    (sha256('docs.example.com'), 'Uncertain', now() - interval '1 day'),
    (sha256('docs.example.com'), 'TlsClientOk', now());
  SELECT verdict INTO v FROM public.query_engpicker_verdict(i_domain_hash => sha256('docs.example.com'));
  IF v <> 'TlsClientOk' THEN RAISE EXCEPTION 'newest verdict: got %', v; END IF;

  SELECT count(*) INTO n FROM public.query_omce_signatures(sha256('docs.example.com'), now() - interval '2 days');
  IF n <> 0 THEN RAISE EXCEPTION 'signatures without data'; END IF;
  INSERT INTO public.community_omce_signatures (domain_hash, signature) VALUES
    (sha256('docs.example.com'), 'b'), (sha256('docs.example.com'), 'a'), (sha256('docs.example.com'), 'a');
  SELECT signatures INTO sigs FROM public.query_omce_signatures(sha256('docs.example.com'), now() - interval '2 days');
  IF sigs IS DISTINCT FROM ARRAY['a','b'] THEN RAISE EXCEPTION 'signatures: %', sigs; END IF;

  SELECT count(*) INTO n FROM public.query_max_age(sha256('docs.example.com'));
  IF n <> 0 THEN RAISE EXCEPTION 'max age without data'; END IF;
  INSERT INTO public.community_domain_max_age (domain_hash, max_age) VALUES (sha256('docs.example.com'), 3600000);
  SELECT max_age INTO m FROM public.query_max_age(i_domain_hash => sha256('docs.example.com'));
  IF m <> 3600000 THEN RAISE EXCEPTION 'max age: %', m; END IF;
END
$t$;

-- Precrawl demand helpers and retention.
DO $t$
DECLARE n integer; r record;
BEGIN
  SELECT d.* INTO r FROM pg_temp.h, LATERAL public.query_domain_priority(1, 0, 10, now() + interval '1 hour') d WHERE d.domain_hash = h.dom0;
  IF r.priority IS NULL OR r.priority <= 0 THEN RAISE EXCEPTION 'domain priority: %', r; END IF;
  SELECT count(*) INTO n FROM public.query_domain_priority(1000000, 0, 10, now());
  IF n <> 0 THEN RAISE EXCEPTION 'min_total not applied'; END IF;
  SELECT t.* INTO r FROM pg_temp.h, LATERAL public.query_top_urls_for_domain(h.dom0, '8 days', 5) t;
  IF r.url <> 'https://example.com/docs/page' OR r.rank <> 1 OR r.event_count < 1 THEN RAISE EXCEPTION 'top urls: %', r; END IF;

  SELECT count(*) INTO n FROM public.community_index_prune('2 days', 100);
  IF n <> 1 THEN RAISE EXCEPTION 'prune removed % rows, want 1 (the 3-day-old entry)', n; END IF;
END
$t$;

-- EXECUTE on the functions is restricted to the owner.
DO $t$
BEGIN
  IF has_function_privilege('public', 'public.index_get_recent_5(bytea, bigint, boolean, boolean, boolean, boolean, text, text[], bigint, boolean, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute index_get_recent_5';
  END IF;
END
$t$;

\echo 'index-db function tests passed'
ROLLBACK;
