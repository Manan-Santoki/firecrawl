# Firecrawl Community dashboard

A small multi-user web app for a self-hosted Firecrawl Community deployment. The owner (admin) invites a few people; each person gets their own Firecrawl team, API keys, request history and usage, and the admin sets their limits.

- Next.js (App Router) + TypeScript, built as a standalone container.
- UI: [coss ui](https://coss.com/ui) only (Base UI + Tailwind CSS v4, installed with the shadcn CLI). Charts use Recharts, styled only with the coss CSS variables. See `NOTICE`.
- Auth: [Better Auth](https://better-auth.com) on PostgreSQL: email and password, optional TOTP 2FA, database-backed rate limiting, CSRF/origin checks, secure cookies on HTTPS.
- Data: tables in the `dashboard` and `community` schemas of the existing application database, created by the versioned community migrations (`100-community-metering`, `110-dashboard-schema`).

## Pages

| Page | Who | What |
| --- | --- | --- |
| Overview | everyone | Requests today/7d, success rate, latency, credits, active jobs, queue depth, open browser sessions, 14-day chart; admins also see per-user totals. |
| API keys | everyone | Create (shown once), rename, revoke, per-key credit limit/interval and concurrency. Admins see and manage every key. |
| Request log | everyone | Filter by time range, endpoint, status, key and (admins) user; full-text search; detail drawer; CSV export. |
| Jobs | everyone | Crawls and batch scrapes with live progress, cancel through the API, results page. |
| Usage | everyone | Daily requests and credits by endpoint and by user (admins) or key. |
| Playground | everyone | Scrape, search, map, crawl, batch scrape, extract and agent with every documented v2 option (formats incl. screenshot/branding/audio/summary/json/highlights, actions builder, location, mobile, proxy, maxAge, lockdown, redactPII, include/exclude tags, waitFor), JSON Schema builder or raw JSON, rendered results (markdown, JSON, screenshot, audio/video, branding swatches, links), copy as curl / Python / JavaScript, private saved history. Runs with a chosen key or the user's internal `Dashboard (internal)` key, so it counts in their usage and limits. |
| Browser sessions | everyone (admins: all) | List, create, Live View and interactive Live View in an embedded panel, run Node/Python/Bash code, close; saved browser profiles. |
| Monitors | everyone (admins: all) | List, create, edit, pause/resume, delete, run now, check history and a per-page diff viewer. |
| Agent runs | everyone (admins: all) | Start, list, live status with steps and Live View, result JSON, cancel, skill export. Shows "Agent backend not available" when the API answers 404/501 for the agent endpoints. |
| Job detail | everyone | Per-page list with status, view each page's result, download a page or the whole job as JSON. |
| Service health | everyone | API, workers/queues, RabbitMQ, Redis, both PostgreSQL databases, Playwright, browser service, SearXNG, LLM endpoint and model, embedding model, optional community services. No secrets are shown. |
| Users | admin | Invite (single-use expiring links), disable/enable, role, limits, new password, per-user usage. |
| Profile | everyone | Name, password, TOTP 2FA with backup codes, sessions. |

## How it fits together

- **Accounts and teams.** The first account is created at `/bootstrap` with `DASHBOARD_BOOTSTRAP_TOKEN`; it becomes `admin` and adopts the seeded team (`FIRECRAWL_TEAM_ID`) so existing keys keep working. After that, public sign-up is closed (the HTTP route answers 404 and a Better Auth hook refuses it); accounts are only created by redeeming an invite. Every invited user gets a new `public.organizations` + `public.teams` row. That is all API-key authentication needs: `auth_chunk_2` joins `api_keys -> teams` and returns `org_id`, `banned` and the community flags; the global blocklist row comes from `090-seed.sql`.
- **Keys** are rows in `public.api_keys`, stored exactly as the Firecrawl schema stores them; the full `fc-…` key is shown once. Revoking deletes the row and drops the API's cached auth entry in Redis so it stops working immediately.
- **Authorization** is checked on the server in every page, server action and route handler (`src/lib/server/authz.ts`): members can only read or change their own team; asking for another team is an error, not a silent fallback. Tests cover the cross-user denials.
- **Request log** rows are written by the API's community request-log middleware (`apps/api/src/lib/community/request-log.ts`) into `community.request_log`; credits come from the `community.credit_usage` ledger that the API fills on every charge.
- **Limits**: team limits live in `community.team_limits`, key limits on `public.api_keys`. The API enforces them (see `community/README.md` and the API code in `apps/api/src/lib/community/metering.ts`).
- **Disabling a user** bans their dashboard account, ends their sessions and sets `teams.banned`, so the API rejects all of their keys with 403.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DASHBOARD_URL` | yes | Public origin of the dashboard (`https://dashboard.example.org`). Cookies are `Secure` when it is HTTPS. |
| `BETTER_AUTH_SECRET` | yes | 32+ random characters; signs sessions. |
| `DASHBOARD_BOOTSTRAP_TOKEN` | first run | One-time token for creating the admin. Remove it after setup. |
| `DATABASE_URL` | yes | Application database (same as the API's). |
| `NUQ_DATABASE_URL` | recommended | Queue database, for queue depth and worker health. |
| `REDIS_URL` / `REDIS_RATE_LIMIT_URL` / `REDIS_EVICT_URL` | recommended | Same Redis as the API: cache invalidation and live crawl progress. |
| `FIRECRAWL_API_URL` | yes | Internal API URL (`http://api:3002`), used to cancel jobs and read results. Never Firecrawl Cloud. |
| `FIRECRAWL_PUBLIC_API_URL` | no | Public API origin shown in snippets and onboarding (defaults to `FIRECRAWL_API_URL`). |
| `DASHBOARD_ADMIN_TEAM_ID` | no | Team the bootstrap admin adopts (the overlay passes `FIRECRAWL_TEAM_ID`). |
| `DASHBOARD_INVITE_TTL_HOURS` | no | Default invite lifetime (72). |
| `DASHBOARD_TRUSTED_ORIGINS` | no | Extra allowed origins, comma separated. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | no | Email invite links. Without SMTP the admin copies the link. |
| `COMMUNITY_REQUEST_LOG_RETENTION_DAYS` | no | Displayed retention (the API enforces it; default 30). |
| Health probes | no | `NUQ_RABBITMQ_URL`, `PLAYWRIGHT_MICROSERVICE_URL`, `BROWSER_SERVICE_URL`, `SEARXNG_ENDPOINT`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `MODEL_NAME`, `MODEL_EMBEDDING_NAME`, `EMBEDDING_SERVICE_URL`, `FIRE_ENGINE_BETA_URL`, `HIGHLIGHT_SERVICE_URL`, `AVGRAB_SERVICE_URL`, `FIRE_PRIVACY_URL`, `AGENT_SERVICE_URL`, `INDEX_SERVICE_URL`. |

API-side variables (set by the overlay on the `api` service):

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMUNITY_REQUEST_LOG_ENABLED` | `true` | Write `community.request_log`. |
| `COMMUNITY_REQUEST_LOG_RETENTION_DAYS` | `30` | Hourly purge of older rows (the credit ledger keeps at least 62 days). |
| `SELF_HOSTED_BILLING_MODE` | `metered` | `metered` records every charge and enforces credit limits; `disabled` keeps self-host unlimited. |
| `COMMUNITY_DEFAULT_CONCURRENCY_LIMIT` | unset | Team concurrency when no per-user value is set (unset keeps upstream's default of 2). |

## Running it

```bash
# .env: the variables above plus the authenticated-overlay ones (APP_POSTGRES_PASSWORD, FIRECRAWL_*_ID ...)
docker compose \
  -f docker-compose.yaml \
  -f community/docker-compose.auth.yaml \
  -f community/docker-compose.dashboard.yaml \
  up -d --build
```

The migrator from the authenticated overlay applies every migration before the API and the dashboard start. Open `DASHBOARD_URL`, follow the redirect to `/bootstrap`, enter the bootstrap token and create the admin, then remove `DASHBOARD_BOOTSTRAP_TOKEN`.

### Serving it on its own hostname

The container listens on port 3000 on the backend network (and on `127.0.0.1:${DASHBOARD_PORT:-3100}` for local access). Put it behind TLS on its own hostname; set `DASHBOARD_URL` to that origin. Do not serve it under a path of the API hostname.

Through the existing nginx gateway (add a server block; the gateway must be on the backend network):

```nginx
server {
  listen 443 ssl;
  server_name dashboard.example.org;
  # ssl_certificate ... ;
  location / {
    proxy_pass http://dashboard:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Directly through Traefik (labels on the `dashboard` service, plus the Traefik network):

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.fc-dashboard.rule=Host(`dashboard.example.org`)
  - traefik.http.routers.fc-dashboard.entrypoints=websecure
  - traefik.http.routers.fc-dashboard.tls.certresolver=letsencrypt
  - traefik.http.services.fc-dashboard.loadbalancer.server.port=3000
```

The login endpoint is rate limited (5 attempts per minute per IP); make sure the proxy sets `X-Forwarded-For`.

## Development and tests

```bash
pnpm install
pnpm dev                      # needs .env.local with the variables above
pnpm lint && pnpm typecheck
pnpm test                     # unit tests; set DASHBOARD_TEST_DATABASE_URL for the PostgreSQL suite
e2e/stack.sh up               # Compose stack on ports 3392 (API) and 3393 (dashboard)
pnpm test:e2e                 # Playwright: bootstrap, invite, keys, /v2/scrape, isolation, limits, disable
e2e/stack.sh reset            # fresh database before re-running the e2e suite
```

`DASHBOARD_TEST_DATABASE_URL` must point to a throwaway database migrated with `node community/migrations/migrate.mjs apply` and seeded with `090-seed.sql`. Screenshots of every page in light and dark mode are written to `docs/screenshots/` by `e2e/99-screenshots.spec.ts`.
