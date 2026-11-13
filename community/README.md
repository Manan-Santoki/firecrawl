# Firecrawl Community distribution

This directory defines the provider-neutral, self-hosted distribution maintained by this fork. It supplements upstream Firecrawl; it does not claim that private Firecrawl Cloud infrastructure has been published.

## Repository boundaries

- Public here: source changes, portable services, container builds, generic Compose examples, migrations, compatibility tests, release notes and the capability manifest.
- Private operations repository: concrete Dokploy application IDs, domains, resource sizing, encrypted secret references, backup destinations, deployment locks and promotion history.
- Never private: material required to build, install, run or modify the community distribution under AGPL-3.0.

## Release contract

- `upstream` mirrors the exact commit of the latest semantic `firecrawl/firecrawl` release tag without community commits; moving upstream `main` is never mislabeled as a release.
- `main` is the supported community line.
- `sync/upstream-vX.Y.Z` branches carry automated upstream merges for review.
- `community-vX.Y.Z.N` tags identify community releases, where `X.Y.Z` is the upstream release and `N` is the community revision.
- Patch updates may deploy automatically to isolated staging after CI. Every production promotion remains an explicit, audited manual action; minor, major and high-risk changes additionally require release review before staging.

## Configuration contract

The community distribution will standardize these variables as their implementations land:

| Variable | Purpose |
| --- | --- |
| `FIRECRAWL_DISTRIBUTION=community` | Identifies the distribution in diagnostics and release metadata. |
| `SELF_HOSTED_BILLING_MODE=disabled\|metered` | Selects no-billing or operator metering behavior. |
| `SELF_HOSTED_RATE_LIMIT_MODE=disabled\|redis` | Selects unlimited operator access or Redis-backed policies. |
| `SOURCE_CODE_URL` | Publishes the corresponding source location for an AGPL network deployment. |
| `COMMUNITY_MODEL_PROVIDER` | Selects an OpenAI-compatible or local model adapter. |
| `COMMUNITY_MODEL_NAME` | Selects the model used by AI-backed features. |
| `COMMUNITY_OBJECT_STORAGE_URL` | Configures durable artifacts using an S3-compatible service. |

Until a variable is implemented and tested, it is documentation of the intended contract rather than a production switch. See [`COMMUNITY_FEATURES.md`](../COMMUNITY_FEATURES.md) for current evidence.

## Browser service

The provider-neutral browser service lives in [`apps/browser-service-community`](../apps/browser-service-community). Release evidence covers lifecycle, Node/Python/Bash execution, CDP, Live View and scrape-bound interact/stop against an isolated staging deployment. Release `community-v2.11.267.4` also passed a 30-minute concurrency-2 lifecycle soak: 112 sessions were created and closed with no transient close failures or leaked sessions. Replay and AI-prompt execution have separate prerequisites recorded in the capability matrix.

For a fresh community installation, enable the portable application database and browser service together with:

```bash
docker compose \
  -f docker-compose.yaml \
  -f community/docker-compose.auth.yaml \
  -f community/docker-compose.browser.yaml \
  up --build
```

Set a strong `BROWSER_SERVICE_API_KEY`. The portable overlay exposes port `3006` only to the Compose network. If Live View or external CDP access is needed, attach an authenticated TLS reverse proxy to that network and set `BROWSER_PUBLIC_URL` to its public endpoint; do not publish the browser container port directly.

The authenticated overlay also requires strong `APP_POSTGRES_PASSWORD`, its RFC 3986 percent-encoded equivalent in `APP_POSTGRES_PASSWORD_URLENCODED`, and stable UUID values for `FIRECRAWL_ORG_ID`, `FIRECRAWL_TEAM_ID`, and `FIRECRAWL_API_KEY_UUID`. For URL-safe generated passwords (`A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, `-`) the two password variables are identical. See [`migrations/README.md`](migrations/README.md) before applying it to an existing database.

The overlay applies versioned, checksummed database migrations before seeding or starting the API. Existing authenticated volumes created before the migration ledger require the one-time reviewed baseline procedure documented there; the migrator will not infer or overwrite an untracked schema.

## Highlight service

[`apps/highlight-service-community`](../apps/highlight-service-community) replaces the private service behind upstream's `HIGHLIGHT_MODEL_URL`. It implements `/batch_highlight_indexed`, `/batch_highlight` and `/highlight` with BM25 ranking. It adds an optional OpenAI-compatible embeddings endpoint (`EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY`) for hybrid ranking. Enable it with `-f community/docker-compose.highlight.yaml` and a strong `HIGHLIGHT_SERVICE_TOKEN`.

The API only calls the service for `/v2/search` excerpts when it also has `INDEX_DATABASE_URL` and `GCS_INDEX_BUCKET_NAME`. Both come from the scrape index overlay below. See the service README for details.

## Scrape index

[`community/docker-compose.index.yaml`](docker-compose.index.yaml) adds the scrape index that upstream keeps in a private database and bucket. It provides:

- a separate index PostgreSQL (`INDEX_DATABASE_URL`) migrated from [`migrations/index-db`](migrations/index-db/README.md);
- the reconstructed SQL functions the API calls, such as `index_get_recent_5`;
- a GCS-compatible object store (`fsouza/fake-gcs-server` on a persistent volume, reached through `STORAGE_EMULATOR_HOST`) for the `<id>.json` page objects.

It enables `maxAge` cache reuse, lockdown mode, index-backed map and crawl discovery, and, together with the highlight overlay, search excerpts.

To use it:

- Set strong `INDEX_POSTGRES_PASSWORD` and `INDEX_POSTGRES_PASSWORD_URLENCODED` values.
- Include the authenticated overlay. The index worker only runs with `USE_DB_AUTHENTICATION=true`.
- List the index overlay last.

The emulator is a single-node store. The index README documents its durability limits and how to switch to Google Cloud Storage instead.
## PII redaction service

`redactPII` on scrape and parse calls a redaction service at `FIRE_PRIVACY_URL`. Firecrawl Cloud's service is private. The community replacement in [`apps/fire-privacy-community`](../apps/fire-privacy-community) implements the same `POST /redact` contract using Microsoft Presidio and a CPU spaCy model. Enable it with:
## Audio and video service

The provider-neutral replacement for Firecrawl's private `AVGRAB_SERVICE_URL` service lives in [`apps/avgrab-community`](../apps/avgrab-community). It implements the upstream contract used by the `audio` and `video` scrape formats, generic video discovery, YouTube metadata/transcripts and YouTube channel/playlist expansion in `/v2/map`, using yt-dlp and ffmpeg. Enable it with:
## Rendering service (fire-engine replacement)

[`apps/fire-engine-community`](../apps/fire-engine-community) implements the HTTP contract the API uses for `FIRE_ENGINE_BETA_URL`, enabling screenshots, branding, scrape actions, mobile/location emulation and `proxy: "stealth" | "enhanced"` with open-source components (Patchright Chromium, optional operator proxies). Enable it with:

```bash
docker compose \
  -f docker-compose.yaml \
  -f community/docker-compose.privacy.yaml \
  up --build
```

The overlay sets `FIRE_PRIVACY_URL` and raises `FIRE_PRIVACY_TIMEOUT_MS` to 30000 on the `api` service, which also runs the workers. The service stays on the Compose network because the stock API client sends no credentials. Detection quality differs from Cloud's hosted model. The capability remains `verification-needed` until an end-to-end scrape with `redactPII` is release-qualified. See the service README for entity coverage and configuration.
  -f community/docker-compose.avgrab.yaml \
  up --build
```

Set a URL-safe `AVGRAB_API_KEY` (the API sends no auth header, so the overlay embeds the key as a path prefix in `AVGRAB_SERVICE_URL`), a stable `AVGRAB_SIGNING_KEY`, and `AVGRAB_PUBLIC_URL` to an address where clients can download the signed, expiring media links (or configure the S3-compatible backend). The capability stays **Verification needed** until a staging release run qualifies it.
  -f community/docker-compose.fire-engine.yaml \
  up --build
```

Setting `FIRE_ENGINE_BETA_URL` is a global switch: chrome-cdp becomes the primary engine, `fetch` leaves the default waterfall, file URLs are fetched through the browser, and search/map discovery is sent to the service (configure `SEARXNG_ENDPOINT` there). Read the service README's "What changes in the API" section before enabling it on an existing deployment. Its capability rows remain **Verification needed** until a release qualifies them.

## Security boundary

Compatibility tests must not call Firecrawl Cloud, copy private responses, or depend on a paid account. They may use public source, documentation, OpenAPI descriptions and official SDK behavior. Secrets belong in environment-scoped secret stores and must never be committed.

## Hosted contract drift

The scheduled compatibility workflow treats Firecrawl's hosted v2 OpenAPI as the contract source of truth and compares it with a deployed community `/openapi.json`. Operators configure that endpoint through the `COMMUNITY_OPENAPI_URL` repository variable so deployment domains remain outside this public repository. Missing hosted operations produce a retained JSON artifact and a blocking GitHub issue; additional community-only operations are reported but do not fail compatibility.

## Current verified release

`community-v2.11.267.4` is the current staging-verified community release. It resolves to source commit `3313474d2f6d597c963a45e1a9d43ad80ebb3876`; all five published container digests have GitHub build-provenance attestations. The release gate verified liveness, the 146-path OpenAPI document, Swagger UI, scrape, map, crawl, batch scrape and browser execution before recording the immutable staging lock.

`community-v2.11.267.3` remains immutable as a failed candidate: its browser stability soak exposed process-reaping and teardown behavior that was fixed and re-qualified in `.4`. It was never promoted. Production promotion remains a separate manual operation in the private operations repository.
