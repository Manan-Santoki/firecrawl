# Firecrawl Community distribution

This directory defines the provider-neutral, self-hosted distribution maintained by this fork. It supplements upstream Firecrawl; it does not claim that private Firecrawl Cloud infrastructure has been published.

## Repository boundaries

- Public here: source changes, portable services, container builds, generic Compose examples, migrations, compatibility tests, release notes and the capability manifest.
- Private operations repository: concrete Dokploy application IDs, domains, resource sizing, encrypted secret references, backup destinations, deployment locks and promotion history.
- Never private: material required to build, install, run or modify the community distribution under AGPL-3.0.

## Release contract

- `upstream` mirrors `firecrawl/firecrawl` without community commits.
- `main` is the supported community line.
- `sync/upstream-vX.Y.Z` branches carry automated upstream merges for review.
- `community-vX.Y.Z.N` tags identify community releases, where `X.Y.Z` is the upstream release and `N` is the community revision.
- Patch updates may auto-promote only after CI and staging compatibility checks. Minor, major and high-risk changes require approval.

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

## Browser service preview

The provider-neutral browser service lives in [`apps/browser-service-community`](../apps/browser-service-community). Its lifecycle and real Chromium Node/Bash paths are tested, but `/interact` remains **Planned** until portable application-database migrations and container/Python qualification are complete.

For a fresh community installation, enable the portable application database and browser service together with:

```bash
docker compose \
  -f docker-compose.yaml \
  -f community/docker-compose.auth.yaml \
  -f community/docker-compose.browser.yaml \
  up --build
```

Set a strong `BROWSER_SERVICE_API_KEY`. If live view or external CDP access is needed, set `BROWSER_PUBLIC_URL` to the TLS endpoint that routes to browser service port `3006`; do not expose its container directly without network policy.

The authenticated overlay also requires strong `APP_POSTGRES_PASSWORD` and stable UUID values for `FIRECRAWL_ORG_ID`, `FIRECRAWL_TEAM_ID`, and `FIRECRAWL_API_KEY_UUID`. See [`migrations/README.md`](migrations/README.md) before applying it to an existing database.

## Security boundary

Compatibility tests must not call Firecrawl Cloud, copy private responses, or depend on a paid account. They may use public source, documentation, OpenAPI descriptions and official SDK behavior. Secrets belong in environment-scoped secret stores and must never be committed.
