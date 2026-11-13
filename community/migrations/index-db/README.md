# Portable scrape index

Upstream Firecrawl caches every eligible scrape in an index:

- a PostgreSQL database at `INDEX_DATABASE_URL` holds one row per scrape;
- a bucket at `GCS_INDEX_BUCKET_NAME` holds the page as `<row id>.json`.

The API uses the index for `maxAge` cache reuse, lockdown mode (`lockdown: true`, which serves only cached pages), index-backed map and crawl discovery, and search result excerpts (through the highlight service).

Upstream publishes the Drizzle table definitions in [`apps/api/src/db/schema/index-db.ts`](../../../apps/api/src/db/schema/index-db.ts). It does not publish:

- the SQL functions the API calls on the index database;
- any migrations for that database;
- any storage setup.

This directory supplies those three things. The contract source is upstream tag `v2.11.739`. The index call sites are unchanged between that tag and this fork's `v2.11.289` base, except that the base also calls `query_index_at_domain_split_level`, which is included here.

## Layout decision: a separate index database

The index is a separate PostgreSQL database with its own manifest, ledger and advisory lock. It is not a second schema inside the application database. The API's connection code assumes this layout:

- `apps/api/src/db/connection.ts` opens a dedicated pool, `firecrawl-index`, from `INDEX_DATABASE_URL`. Upstream sizes that pool on its own and calls it the "separate index project".
- The pool is created even when `USE_DB_AUTHENTICATION` is off.
- Every index query uses unqualified names (`index`, `index_get_recent_5`, …), so the tables and functions must be on the connection's default `search_path`, which is `public`.
- The index has a different lifecycle from the application data. It grows with every scrape, can be rebuilt by scraping again, and needs its own retention, backup policy and sizing.

`community/docker-compose.index.yaml` therefore runs its own `postgres:17-alpine` service, `firecrawl-index-db`, with its own volume.

If you would rather host the index in the same PostgreSQL server, point `INDEX_DATABASE_URL` at a second database on that server. Sharing one database also works:

- The index manifest records its versions in `public.index_schema_migrations` under the lock `firecrawl-community-index-schema-migrations-v1`.
- The application manifest uses `public.schema_migrations` and its own lock.
- The table and function names do not overlap. CI applies both manifests to one database to prove this.

## Migrations

`migrate.mjs` serves both manifests. Pass this one with `--manifest`:

```bash
DATABASE_URL=postgresql://postgres:…@index-db:5432/firecrawl_index \
  node community/migrations/migrate.mjs status --manifest community/migrations/index-db/manifest.json
node community/migrations/migrate.mjs apply  --manifest community/migrations/index-db/manifest.json
```

The policy is the same as for the application database:

- Migrations are checksummed and ordered.
- They are expand-only: no `DROP`, `TRUNCATE`, renames or type changes.
- Each one runs in a transaction.
- The source schema is fingerprinted. CI fails when upstream changes `index-db.ts` until a reviewed migration and a new fingerprint land.

The manifest adds two fields that the migrator now honours for any manifest:

- `ledgerTable`
- `untrackedSchemaRelation`, which is `public.index`

If the migrator finds an index table with no ledger, `apply` fails closed. To adopt an index database you created by hand, review it and then run:

```bash
node community/migrations/migrate.mjs baseline --confirm-existing \
  --baseline-through 010-index-schema --manifest community/migrations/index-db/manifest.json
```

Then run `apply`. `020` and `030` use `CREATE OR REPLACE` and are safe to apply on top of a reviewed `010` baseline.

| Version | Contents |
| --- | --- |
| `010-index-schema` | `index`, `engpicker_queue` and `engpicker_verdicts`, column-for-column with `index-db.ts`. Lookup indexes on `url_hash`, on each `url_split_N_hash` and `domain_splits_N_hash`, and on `created_at`. Two empty community input tables, `community_domain_max_age` and `community_omce_signatures`. |
| `020-index-rpcs` | The reconstructed functions below, plus `community_index_prune`. |
| `030-revoke-public-rpc-execute` | Revokes `EXECUTE` on all of them from `PUBLIC`. |

## Reconstructed functions

Each function has exactly one signature, so the API's calls resolve. Those calls use named arguments and untyped node-postgres parameters. All call sites are in `apps/api/src/db/rpc.ts` and their callers.

Semantics are labelled as follows:

- **confirmed**: upstream code states or mirrors the behaviour.
- **inferred**: deduced from argument and column names.
- **community**: upstream's data source is private, so this is a documented substitute.

| Function → result columns read | Caller | Semantics |
| --- | --- | --- |
| `index_get_recent_5(p_url_hash, p_max_age_ms, p_is_mobile, p_block_ads, p_feature_screenshot, p_feature_screenshot_fullscreen, p_location_country, p_location_languages text[], p_wait_time_ms, p_is_stealth, p_min_age_ms)` → `id, created_at, status, has_screenshot, has_screenshot_fullscreen, wait_time_ms` | `scrapeURLWithIndex` (`scraper/scrapeURL/engines/index/index.ts`), `getIndexObjectForURL` (`search/highlights.ts`) | **Confirmed** by upstream's client-side replica in `services/index-cache.ts` (`deriveIndexVariantKey`, `filterIndexEntries`, "keep in sync with the SQL function"). The function exact-matches `url_hash`, `is_mobile`, `block_ads`, `is_stealth` and `location_country`. Languages: `NULL` matches only `NULL`; otherwise set equality (`@>` and `<@`). `created_at` must be within `max_age`, and older than `min_age` when one is given. If a screenshot or full-page screenshot is requested, the row must have one. `COALESCE(wait_time_ms, 0) >= p_wait_time_ms`. Newest first, `LIMIT 5`. **Inferred:** skips `invalidated_at IS NOT NULL` rows (the cache comment calls invalidation a manual ops action). **Community:** clamps very large ages so they cannot overflow interval arithmetic. |
| `query_max_age(i_domain_hash)` → `max_age` | dynamic `maxAge` in `scrapeURLWithIndex`, only when the request has no `maxAge` and `USE_DB_AUTHENTICATION=true` | **Community.** Reads `community_domain_max_age`, which is empty by default. Zero rows gives the API's own 2-day default. Returns `double precision`, so the driver yields a JS number. |
| `query_index_at_split_level(i_level, i_url_hash, i_newer_than)` → `resolved_url` | `queryIndexAtSplitLevel` (crawl kickoff in `scrape-worker.ts`) | **Confirmed:** matches rows on `url_split_<level>_hash` newer than `i_newer_than`. Levels above 9 return nothing because only 10 split columns exist. **Inferred:** excludes invalidated rows and non-2xx statuses, and deduplicates `resolved_url`. |
| `query_index_at_split_level_with_meta(…)` → `resolved_url, title, description` | `queryIndexAtSplitLevelWithMeta` (`/map`) | As above. |
| `query_index_at_domain_split_level(i_level, i_domain_hash, i_newer_than)` → `resolved_url` | `queryIndexAtDomainSplitLevel` (fork base `v2.11.289`) | As above, on `domain_splits_<level>_hash` (levels 0–4). |
| `query_index_at_domain_split_level_with_meta(…)` → `resolved_url, title, description` | `queryIndexAtDomainSplitLevelWithMeta` (`/map` with subdomains) | As above. |
| `query_index_at_domain_split_level_omce(…)` → `url` (the caller appends `LIMIT`) | `processEngpickerJob` (`lib/engpicker.ts`) | As above. Also returns `resolved_url, status, created_at`. |
| `query_omce_signatures(i_domain_hash, i_newer_than)` → `signatures text[]` | `queryOMCESignatures` → `htmlTransform` (only with `__experimental_omce`) | **Community.** Aggregates `community_omce_signatures` (empty by default). Returns zero rows when there are none, which the caller treats as "no signatures". |
| `query_engpicker_verdict(i_domain_hash)` → `verdict` | `queryEngpickerVerdict` (engine selection, 250 ms budget) | **Confirmed:** returns the newest `engpicker_verdicts.verdict` for the domain; zero rows means `Unknown`. |
| `insert_omce_job_if_needed(i_domain_level, i_domain_hash)` → `void` | `processOMCEJobs` (index worker), once per newly indexed domain | **Inferred.** Its arguments are exactly the `engpicker_queue` columns that `processEngpickerJob` consumes. It enqueues an evaluation unless the domain was queued or received a verdict in the last 7 days. An advisory lock serialises callers for the same domain. |
| `query_domain_priority(p_min_total, p_min_priority, p_lim, p_time)` → `domain_hash, priority` | `queryDomainsForPrecrawl` (only with `PRECRAWL_TEAM_ID`) | **Community heuristic.** Demand for a registrable domain (`domain_splits_0_hash`) is the count of non-precrawl rows in the 8 days before `p_time`. `priority` is that count per day. |
| `query_top_urls_for_domain(p_domain_hash, p_time_window, p_top_n)` → `url, domain_hash, event_count, rank` | precrawl job (`index-worker.ts`) | **Community heuristic.** Returns the most frequently indexed normalized URLs of the domain within the window. |
| `community_index_prune(p_older_than, p_batch)` → `id` | operators only | Deletes old rows in batches and returns their ids, so you can delete the matching `<id>.json` objects. Rows are deleted before objects, so a failure leaves a harmless index miss, never an unreachable row. |

The upstream engine picker (`engpicker_*`) runs fire-engine and an LLM against sample URLs. The overlay sets `DISABLE_ENGPICKER=true`. The queue table still fills and stays harmless; drop that default only when both dependencies exist.

## Object storage

The API stores index objects with `@google-cloud/storage`, through `saveIndexToGCS` and `getIndexFromGCS`. The highlight service reads the same objects through the GCS JSON API. The overlay runs [`fsouza/fake-gcs-server`](https://github.com/fsouza/fake-gcs-server) (BSD-2-Clause), pinned to `1.52.2`, as follows:

- It runs as the service `firecrawl-index-storage-backend`, using the filesystem backend on the named volume `firecrawl-index-storage-data`.
- The API and the highlight service reach it through `STORAGE_EMULATOR_HOST=http://firecrawl-index-storage:4443`, which `@google-cloud/storage` honours natively by sending unauthenticated JSON-API requests to that host. Both endpoints are reachable only on the Compose network.
- `firecrawl-index-storage` is a small stateless gateway, [`community/index-storage/gcs-json-gateway.mjs`](../../index-storage/gcs-json-gateway.mjs), running on `node:22-alpine`. It exists because of a client quirk. With `STORAGE_EMULATOR_HOST` set, `@google-cloud/storage` 7.x uses the variable verbatim as its JSON-API base URL. Object reads therefore arrive as `/b/{bucket}/o/{object}`, while uploads arrive as `/upload/storage/v1/...`. fake-gcs-server only routes the `/storage/v1/b/...` form, so without the gateway writes succeed but every read returns 404 and nothing is ever served from the index. (This was observed end to end.) The gateway adds the missing prefix and streams everything else through unchanged, so no API source change is needed. It is not needed with real Google Cloud Storage.
- A one-shot job, `firecrawl-index-storage-init`, creates `GCS_INDEX_BUCKET_NAME` (default `firecrawl-index`) if it is missing.

Each object is `<index row id>.json`, containing `{url, html, statusCode, error?, screenshot?, pdfMetadata?, contentType?, postprocessorsUsed?, proxyUsed?}`. This is the layout that `apps/highlight-service-community` expects.

**Durability limits.** fake-gcs-server describes itself as an emulator for tests. Know what that means before you rely on it:

- It is a single process on a single volume, with no replication, erasure coding or background integrity checking.
- Durability is that of the Docker volume and its host disk.
- Writes go to plain files. There is no documented fsync or atomic-rename guarantee across crashes, so a host crash during a write can leave a truncated object. The API treats an unreadable object as a miss and scrapes again.
- It has no authentication. Never publish port 4443; the overlay only `expose`s it on the Compose network.
- It has no lifecycle rules or versioning. Prune with `community_index_prune` and delete the returned objects yourself.
- Because the index is a cache, losing it costs re-scrapes, not correctness. Even so, back up `firecrawl-index-db-data` and `firecrawl-index-storage-data` together, so that rows and objects stay consistent.

For durable production storage, point the same variables at Google Cloud Storage:

1. Unset `STORAGE_EMULATOR_HOST` by setting it to an empty string.
2. Set `GCS_CREDENTIALS` to a base64 service-account JSON, on both the API and the highlight service.

**Note:** in emulator mode, `STORAGE_EMULATOR_HOST` redirects every GCS client in the API process. That includes `GCS_BUCKET_NAME` and `GCS_MEDIA_BUCKET_NAME`, if you set them.

**MinIO is not a drop-in alternative.** MinIO implements the S3 API. It has never implemented the GCS JSON API that `@google-cloud/storage` uses (`/storage/v1/b/{bucket}/o`, `/upload/storage/v1/...`), and its old GCS gateway worked in the opposite direction and has been removed. Google's S3-compatible "XML API" interoperability exists on the Google side, not in the Node GCS client. Using MinIO, SeaweedFS or another S3 store would require an S3 adapter in `services/index.ts` and in the highlight service. That would be a source change, not configuration. A gateway that serves the GCS JSON API on top of S3 would also work, but no maintained open-source one was identified.

## Enabling it

Add these to `.env`. The highlight service reads the storage variables from the environment too.

```bash
INDEX_POSTGRES_PASSWORD=…                 # strong secret
INDEX_POSTGRES_PASSWORD_URLENCODED=…      # RFC 3986 encoded; identical for URL-safe passwords
GCS_INDEX_BUCKET_NAME=firecrawl-index
STORAGE_EMULATOR_HOST=http://firecrawl-index-storage:4443
```

Then start the stack:

```bash
docker compose -f docker-compose.yaml \
  -f community/docker-compose.auth.yaml \
  -f community/docker-compose.highlight.yaml \
  -f community/docker-compose.index.yaml up --build
```

Requirements and caveats:

- **The authenticated overlay is required.** The API harness starts the index worker only when `USE_DB_AUTHENTICATION=true`. That worker moves queued rows from Redis into PostgreSQL. Without it, objects are written but rows never appear, so nothing is ever served from the index.
- **Put the index overlay last.** Other overlays default `INDEX_DATABASE_URL` and the storage variables to empty strings.
- **Optional:** set `INDEX_CACHE_REDIS_URL` to a Redis or Dragonfly instance configured as an LRU cache, to shield `index_get_recent_5` and `query_max_age`.
- **Not every scrape is indexed.** Upstream does not index pages fetched by the plain `fetch` or `tlsclient` engines, scrapes with actions, custom headers, custom screenshot viewports, or zero-data-retention requests. In the community stack, the Playwright engine is the usual winner, and its pages are indexed.

## Tests

- `node --test community/scripts/migrate.test.mjs` covers:
  - manifest checksums and the source fingerprint;
  - the separate ledger and lock;
  - Drizzle column parity.
- `psql -f community/scripts/index-db-functions.test.sql`, against a migrated database, covers:
  - `index_get_recent_5` filters, ordering and limit;
  - untyped named-parameter resolution;
  - split and domain discovery;
  - the engine-picker queue;
  - verdicts, signatures and dynamic `maxAge`;
  - precrawl helpers and pruning;
  - the `EXECUTE` revocation.
- `node community/tests/index-e2e/run.mjs` uses Docker Compose with the base, auth, highlight and index overlays plus a fixture origin. Set `INDEX_E2E_HIGHLIGHT_COMPOSE=community/docker-compose.highlight.yaml` to include the search check. It verifies:
  - a `maxAge` miss followed by a hit that never reaches the origin;
  - the row and its `<id>.json` object;
  - `maxAge: 0` bypassing the index;
  - lockdown serving the cached page and refusing an uncached one without touching the origin;
  - persistence across restarts of the database and storage;
  - with the highlight check enabled, `/v2/search` excerpts read from the indexed object by the highlight service.
