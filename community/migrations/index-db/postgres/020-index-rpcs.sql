\set ON_ERROR_STOP on

-- SQL functions the API calls on the index database (apps/api/src/db/rpc.ts,
-- "Index database RPCs"). Upstream publishes the call sites but not these
-- definitions. Each function below is reconstructed from its call site: the
-- named arguments, the casts the caller applies, and the result columns the
-- caller reads. community/migrations/index-db/README.md lists the call sites
-- and marks which semantics are confirmed by upstream code and which are
-- community choices.
--
-- Each name has exactly one signature so the API's named-argument calls with
-- untyped parameters resolve without ambiguity.

-- index_get_recent_5: newest (max 5) entries for one URL variant.
-- Callers: scrapeURLWithIndex (engines/index/index.ts) and the search
-- highlights lookup (search/highlights.ts). The filters mirror the
-- client-side replica in services/index-cache.ts (deriveIndexVariantKey +
-- filterIndexEntries), which upstream documents as "keep in sync with the
-- SQL function".
CREATE OR REPLACE FUNCTION public.index_get_recent_5(
  p_url_hash bytea,
  p_max_age_ms bigint,
  p_is_mobile boolean,
  p_block_ads boolean,
  p_feature_screenshot boolean,
  p_feature_screenshot_fullscreen boolean,
  p_location_country text,
  p_location_languages text[],
  p_wait_time_ms bigint,
  p_is_stealth boolean,
  p_min_age_ms bigint
)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  status integer,
  has_screenshot boolean,
  has_screenshot_fullscreen boolean,
  wait_time_ms bigint
)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT i.id, i.created_at, i.status, i.has_screenshot, i.has_screenshot_fullscreen, i.wait_time_ms
  FROM public.index AS i
  WHERE i.url_hash = p_url_hash
    AND i.invalidated_at IS NULL
    -- Age window. Values beyond ~95 years are treated as "any age" so that
    -- very large client maxAge values cannot overflow interval arithmetic.
    AND (
      p_max_age_ms >= 3000000000000
      OR i.created_at >= now() - (GREATEST(p_max_age_ms, 0) * interval '1 millisecond')
    )
    AND (
      p_min_age_ms IS NULL
      OR p_min_age_ms <= 0
      OR (p_min_age_ms < 3000000000000 AND i.created_at <= now() - (p_min_age_ms * interval '1 millisecond'))
    )
    -- Exact-match variant dimensions.
    AND i.is_mobile = p_is_mobile
    AND i.block_ads = p_block_ads
    AND i.is_stealth = COALESCE(p_is_stealth, false)
    AND i.location_country IS NOT DISTINCT FROM p_location_country
    -- NULL matches only NULL; arrays compare with set semantics.
    AND (
      (p_location_languages IS NULL AND i.location_languages IS NULL)
      OR (
        p_location_languages IS NOT NULL
        AND i.location_languages IS NOT NULL
        AND i.location_languages @> p_location_languages
        AND i.location_languages <@ p_location_languages
      )
    )
    -- Capabilities: a request that needs a screenshot requires one; a request
    -- that does not can be served by any entry.
    AND (p_feature_screenshot IS NOT TRUE OR i.has_screenshot)
    AND (p_feature_screenshot_fullscreen IS NOT TRUE OR i.has_screenshot_fullscreen)
    AND COALESCE(i.wait_time_ms, 0) >= COALESCE(p_wait_time_ms, 0)
  ORDER BY i.created_at DESC
  LIMIT 5
$function$;

-- Shared body for the URL-split / domain-split discovery queries.
CREATE OR REPLACE FUNCTION public.community_index_split_rows(
  p_column_prefix text,
  p_max_level integer,
  p_level integer,
  p_hash bytea,
  p_newer_than timestamptz
)
RETURNS TABLE (
  url text,
  resolved_url text,
  title text,
  description text,
  status integer,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  IF p_column_prefix NOT IN ('url_split_', 'domain_splits_') THEN
    RAISE EXCEPTION 'unsupported split column prefix %', p_column_prefix;
  END IF;
  -- Only levels 0..p_max_level are stored (url_split_0..9, domain_splits_0..4).
  IF p_level IS NULL OR p_hash IS NULL OR p_level < 0 OR p_level > p_max_level THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT DISTINCT ON (i.resolved_url)
            i.url, i.resolved_url, i.title, i.description, i.status, i.created_at
       FROM public.index AS i
      WHERE i.%I = $1
        AND i.created_at >= $2
        AND i.invalidated_at IS NULL
        AND i.status >= 200 AND i.status < 300
      ORDER BY i.resolved_url, i.created_at DESC',
    p_column_prefix || p_level || '_hash'
  ) USING p_hash, COALESCE(p_newer_than, '-infinity'::timestamptz);
END
$function$;

-- Callers: queryIndexAtSplitLevel (services/index.ts) for crawl discovery
-- (scrape-worker.ts kickoff) — reads resolved_url.
CREATE OR REPLACE FUNCTION public.query_index_at_split_level(
  i_level integer,
  i_url_hash bytea,
  i_newer_than timestamptz
)
RETURNS TABLE (resolved_url text)
LANGUAGE sql
STABLE
AS $function$
  SELECT r.resolved_url
  FROM public.community_index_split_rows('url_split_', 9, i_level, i_url_hash, i_newer_than) AS r
  ORDER BY r.created_at DESC
$function$;

-- Callers: queryIndexAtSplitLevelWithMeta (services/index.ts) for /map —
-- reads resolved_url, title, description.
CREATE OR REPLACE FUNCTION public.query_index_at_split_level_with_meta(
  i_level integer,
  i_url_hash bytea,
  i_newer_than timestamptz
)
RETURNS TABLE (resolved_url text, title text, description text)
LANGUAGE sql
STABLE
AS $function$
  SELECT r.resolved_url, r.title, r.description
  FROM public.community_index_split_rows('url_split_', 9, i_level, i_url_hash, i_newer_than) AS r
  ORDER BY r.created_at DESC
$function$;

-- Callers: queryIndexAtDomainSplitLevel (services/index.ts, present on this
-- fork's v2.11.289 base, removed upstream by v2.11.739) — reads resolved_url.
CREATE OR REPLACE FUNCTION public.query_index_at_domain_split_level(
  i_level integer,
  i_domain_hash bytea,
  i_newer_than timestamptz
)
RETURNS TABLE (resolved_url text)
LANGUAGE sql
STABLE
AS $function$
  SELECT r.resolved_url
  FROM public.community_index_split_rows('domain_splits_', 4, i_level, i_domain_hash, i_newer_than) AS r
  ORDER BY r.created_at DESC
$function$;

-- Callers: queryIndexAtDomainSplitLevelWithMeta (services/index.ts) for /map
-- with includeSubdomains — reads resolved_url, title, description.
CREATE OR REPLACE FUNCTION public.query_index_at_domain_split_level_with_meta(
  i_level integer,
  i_domain_hash bytea,
  i_newer_than timestamptz
)
RETURNS TABLE (resolved_url text, title text, description text)
LANGUAGE sql
STABLE
AS $function$
  SELECT r.resolved_url, r.title, r.description
  FROM public.community_index_split_rows('domain_splits_', 4, i_level, i_domain_hash, i_newer_than) AS r
  ORDER BY r.created_at DESC
$function$;

-- Callers: processEngpickerJob (lib/engpicker.ts), with a trailing LIMIT —
-- reads url.
CREATE OR REPLACE FUNCTION public.query_index_at_domain_split_level_omce(
  i_level integer,
  i_domain_hash bytea,
  i_newer_than timestamptz
)
RETURNS TABLE (url text, resolved_url text, status integer, created_at timestamptz)
LANGUAGE sql
STABLE
AS $function$
  SELECT r.url, r.resolved_url, r.status, r.created_at
  FROM public.community_index_split_rows('domain_splits_', 4, i_level, i_domain_hash, i_newer_than) AS r
  ORDER BY r.created_at DESC
$function$;

-- Callers: queryOMCESignatures (services/index.ts) from htmlTransform when
-- __experimental_omce is set — reads data[0].signatures (string[]).
-- Zero rows when there are no signatures.
CREATE OR REPLACE FUNCTION public.query_omce_signatures(
  i_domain_hash bytea,
  i_newer_than timestamptz
)
RETURNS TABLE (signatures text[])
LANGUAGE sql
STABLE
AS $function$
  SELECT array_agg(DISTINCT s.signature ORDER BY s.signature)
  FROM public.community_omce_signatures AS s
  WHERE s.domain_hash = i_domain_hash
    AND s.created_at >= COALESCE(i_newer_than, '-infinity'::timestamptz)
  HAVING count(*) > 0
$function$;

-- Callers: queryEngpickerVerdict (services/index.ts) from engine selection —
-- reads data[0].verdict. Newest verdict for the domain, zero rows if none.
CREATE OR REPLACE FUNCTION public.query_engpicker_verdict(
  i_domain_hash bytea
)
RETURNS TABLE (verdict text)
LANGUAGE sql
STABLE
AS $function$
  SELECT v.verdict::text
  FROM public.engpicker_verdicts AS v
  WHERE v.domain_hash = i_domain_hash
  ORDER BY v.created_at DESC
  LIMIT 1
$function$;

-- Callers: processOMCEJobs (services/index.ts, index worker) for every
-- domain that receives a new index entry. The (domain_level, domain_hash)
-- arguments are exactly the engpicker_queue columns that processEngpickerJob
-- later consumes, so this enqueues an engine-picker evaluation for the
-- domain unless one was queued or decided in the last 7 days.
CREATE OR REPLACE FUNCTION public.insert_omce_job_if_needed(
  i_domain_level integer,
  i_domain_hash bytea
)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF i_domain_hash IS NULL OR i_domain_level IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('engpicker:' || encode(i_domain_hash, 'hex'), 0));
  IF EXISTS (
    SELECT 1 FROM public.engpicker_queue AS q
    WHERE q.domain_hash = i_domain_hash
      AND q.created_at > now() - interval '7 days'
  ) OR EXISTS (
    SELECT 1 FROM public.engpicker_verdicts AS v
    WHERE v.domain_hash = i_domain_hash
      AND v.created_at > now() - interval '7 days'
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.engpicker_queue (domain_hash, domain_level)
  VALUES (i_domain_hash, i_domain_level);
END
$function$;

-- Callers: scrapeURLWithIndex dynamic maxAge (only when the request has no
-- explicit maxAge and USE_DB_AUTHENTICATION=true) — reads data[0].max_age and
-- falls back to 2 days on zero rows or NULL. Returned as double precision so
-- node-postgres yields a JS number (bigint would arrive as a string).
CREATE OR REPLACE FUNCTION public.query_max_age(
  i_domain_hash bytea
)
RETURNS TABLE (max_age double precision)
LANGUAGE sql
STABLE
AS $function$
  SELECT m.max_age::double precision
  FROM public.community_domain_max_age AS m
  WHERE m.domain_hash = i_domain_hash
$function$;

-- Callers: queryDomainsForPrecrawl (services/index.ts) in the precrawl job
-- (index-worker.ts, only when PRECRAWL_TEAM_ID is set) — reads domain_hash and
-- priority. Community heuristic: demand for a registrable domain
-- (domain_splits_0_hash) is the number of non-precrawl index entries in the
-- 8 days before p_time; priority is that demand per day.
CREATE OR REPLACE FUNCTION public.query_domain_priority(
  p_min_total integer,
  p_min_priority double precision,
  p_lim integer,
  p_time timestamptz
)
RETURNS TABLE (domain_hash bytea, priority double precision)
LANGUAGE sql
STABLE
AS $function$
  SELECT d.domain_hash, d.priority
  FROM (
    SELECT i.domain_splits_0_hash AS domain_hash,
           count(*) AS total,
           count(*)::double precision / 8.0 AS priority
    FROM public.index AS i
    WHERE i.domain_splits_0_hash IS NOT NULL
      AND i.is_precrawl IS NOT TRUE
      AND i.created_at >= p_time - interval '8 days'
      AND i.created_at < p_time
    GROUP BY i.domain_splits_0_hash
  ) AS d
  WHERE d.total >= COALESCE(p_min_total, 0)
    AND d.priority >= COALESCE(p_min_priority, 0)
  ORDER BY d.priority DESC
  LIMIT GREATEST(COALESCE(p_lim, 0), 0)
$function$;

-- Callers: processPrecrawlJob (index-worker.ts) — reads url, domain_hash,
-- event_count, rank. Most-requested normalized URLs of a registrable domain.
CREATE OR REPLACE FUNCTION public.query_top_urls_for_domain(
  p_domain_hash bytea,
  p_time_window interval,
  p_top_n integer
)
RETURNS TABLE (url text, domain_hash bytea, event_count integer, rank integer)
LANGUAGE sql
STABLE
AS $function$
  SELECT t.url, p_domain_hash, t.event_count, t.rank
  FROM (
    SELECT i.url,
           count(*)::integer AS event_count,
           (row_number() OVER (ORDER BY count(*) DESC, i.url))::integer AS rank
    FROM public.index AS i
    WHERE i.domain_splits_0_hash = p_domain_hash
      AND i.is_precrawl IS NOT TRUE
      AND i.invalidated_at IS NULL
      AND i.created_at >= now() - COALESCE(p_time_window, interval '8 days')
    GROUP BY i.url
  ) AS t
  WHERE t.rank <= GREATEST(COALESCE(p_top_n, 0), 0)
  ORDER BY t.rank
$function$;

-- Operator retention helper (community only; the API never calls it).
-- Deletes up to p_batch index rows created before now() - p_older_than and
-- returns their ids so the matching "<id>.json" objects can be removed from
-- the index bucket. Rows go first: a row without an object is a recoverable
-- index miss, an object without a row is unreachable garbage.
CREATE OR REPLACE FUNCTION public.community_index_prune(
  p_older_than interval,
  p_batch integer DEFAULT 1000
)
RETURNS TABLE (id uuid)
LANGUAGE sql
AS $function$
  DELETE FROM public.index AS i
  WHERE i.id IN (
    SELECT c.id FROM public.index AS c
    WHERE c.created_at < now() - p_older_than
    ORDER BY c.created_at
    LIMIT GREATEST(COALESCE(p_batch, 0), 0)
  )
  RETURNING i.id
$function$;
