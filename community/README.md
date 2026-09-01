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

The provider-neutral browser service lives in [`apps/browser-service-community`](../apps/browser-service-community). Release evidence now covers lifecycle, Node/Python/Bash execution, CDP, Live View and scrape-bound interact/stop against an isolated staging deployment. Replay, long-running soak qualification and AI-prompt execution have separate prerequisites recorded in the capability matrix.

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

## Security boundary

Compatibility tests must not call Firecrawl Cloud, copy private responses, or depend on a paid account. They may use public source, documentation, OpenAPI descriptions and official SDK behavior. Secrets belong in environment-scoped secret stores and must never be committed.

## Hosted contract drift

The scheduled compatibility workflow treats Firecrawl's hosted v2 OpenAPI as the contract source of truth and compares it with a deployed community `/openapi.json`. Operators configure that endpoint through the `COMMUNITY_OPENAPI_URL` repository variable so deployment domains remain outside this public repository. Missing hosted operations produce a retained JSON artifact and a blocking GitHub issue; additional community-only operations are reported but do not fail compatibility.
