# Community agent service

A self-hostable backend for Firecrawl's `/v2/agent` API. The Firecrawl API
proxies every agent call to `EXTRACT_V3_BETA_URL`; on Firecrawl Cloud that is a
private service. This service implements the same internal contract so a
self-hosted stack can answer `POST /v2/agent` instead of failing with
`Agent beta is not enabled.`

- Research loop on any **OpenAI-compatible** Chat Completions endpoint
  (OpenAI, LiteLLM, vLLM, Ollama, llama.cpp server, ...) using tool calling.
- Tools call **your own Firecrawl API** (`/v2/search`, `/v2/scrape`, `/v2/map`,
  optionally `/v2/scrape/:id/interact`). There is no default URL, and Firecrawl
  Cloud URLs are refused at startup.
- Skills and prompt from [firecrawl/web-agent](https://github.com/firecrawl/web-agent)
  (MIT, pinned commit; see [`NOTICE`](NOTICE)).
- JSON Schema output: the final step requests `response_format` `json_schema`
  (falling back to `json_object` when a provider rejects it) and validates the
  result with Ajv, retrying with the validation errors.
- Job state, traces, threads and the queue in **Redis** (the stack already runs
  it). Runs are bounded by steps, wall-clock time, model tokens and credits.

The contract was transcribed from upstream Firecrawl `v2.11.739`
(`apps/api/src/controllers/v2/agent*.ts`, `apps/api/src/lib/extract-v3-status.ts`).

## Running

```bash
export AGENT_INTEROP_SECRET="$(openssl rand -hex 24)"
export AGENT_MODEL=gpt-4.1-mini            # or COMMUNITY_MODEL_NAME
export OPENAI_BASE_URL=http://litellm:4000/v1
export OPENAI_API_KEY=...

docker compose \
  -f docker-compose.yaml \
  -f community/docker-compose.agent.yaml \
  up --build
```

Add `community/docker-compose.auth.yaml` (and the browser overlay for
`AGENT_ENABLE_INTERACT=true`) as needed. The overlay sets `EXTRACT_V3_BETA_URL`
and `AGENT_INTEROP_SECRET` on the `api` service; keep the secret internal, it
authenticates the API to this service.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_INTEROP_SECRET` | required (16+ chars) | Shared bearer secret; must equal the API's `AGENT_INTEROP_SECRET`. |
| `PORT` / `HOST` | `3010` / `0.0.0.0` | Listen address. |
| `REDIS_URL` | unset | Redis for durable state and the run queue. Without it an in-memory store is used (runs lost on restart). |
| `AGENT_STORE` | `redis` if `REDIS_URL` else `memory` | Force a store. |
| `AGENT_REDIS_PREFIX` | `agent-community` | Key prefix in a shared Redis. |
| `OPENAI_BASE_URL` | required for `openai-compatible` | Chat Completions base URL (ending in `/v1`). |
| `OPENAI_API_KEY` | unset | Bearer key for the model endpoint. |
| `AGENT_MODEL` | `COMMUNITY_MODEL_NAME`, then `MODEL_NAME` | Model id. |
| `COMMUNITY_MODEL_PROVIDER` | `openai-compatible` | `openai-compatible`, `openai` (defaults the base URL to OpenAI) or `ollama` (defaults to `OLLAMA_BASE_URL` + `/v1`). |
| `COMMUNITY_MODEL_NAME` | unset | Community contract name for the model. |
| `AGENT_STRUCTURED_OUTPUT` | `json_schema` | `json_schema`, `json_object` or `prompt` (no `response_format`). |
| `AGENT_LLM_TIMEOUT_MS` / `AGENT_LLM_TEMPERATURE` | `120000` / `0.2` | Per model call. |
| `FIRECRAWL_API_URL` | required | Your Firecrawl API, e.g. `http://api:3002`. |
| `FIRECRAWL_API_KEY` | unset | Fallback key for tool calls when the gateway forwards none (`USE_DB_AUTHENTICATION=false` forwards `bypass`). With DB auth the caller's key is used, so tool usage lands on the caller's team. |
| `AGENT_FIRECRAWL_INTEROP` | `false` | Send `__agentInterop` (secret, run id, `shouldBill`) on scrape/search so the API attributes them to the agent run. Requires the API to have the same `AGENT_INTEROP_SECRET`. |
| `AGENT_ENABLE_INTERACT` | `false` | Offer the `interact` tool (needs the browser overlay; prompt mode needs its AI prerequisites). |
| `AGENT_ALLOW_FIRECRAWL_CLOUD` | `false` | Escape hatch; the service refuses `*.firecrawl.dev` otherwise. |
| `AGENT_MAX_CONCURRENT_RUNS` | `2` | Runs executing at once per replica; the rest queue in Redis. |
| `AGENT_MAX_STEPS` | `0` (effort: low 8, medium 16, high 30) | Model/tool rounds per run. |
| `AGENT_MAX_RUNTIME_SECONDS` | `600` | Wall-clock limit per run. |
| `AGENT_MAX_TOTAL_TOKENS` | `400000` | Model token budget per run. |
| `AGENT_DEFAULT_MAX_CREDITS` | `2500` | Credit cap when the request has no `maxCredits`. |
| `AGENT_CREDITS_PER_1K_TOKENS` | `0` | Optional model-token charge added to `creditsUsed`. |
| `AGENT_MAP_CREDITS` | `1` | Credits counted per map call (the map response carries none). |
| `AGENT_MAX_TOOL_RESULT_CHARS` | `12000` | Truncation of each tool result fed to the model. |
| `AGENT_RESULT_TTL_SECONDS` | `86400` | Lifetime of runs, traces and snapshots (matches the API's 24h job window). |
| `AGENT_THREAD_TTL_SECONDS` | `604800` | Lifetime of threads. |
| `AGENT_WEBHOOK_SECRET` | unset | Signs webhooks with `X-Firecrawl-Signature: sha256=<hmac>`. |
| `AGENT_ALLOW_LOCAL_WEBHOOKS` | `false` | Allow webhook targets on private/loopback addresses. |
| `AGENT_SKILLS_DIR` | unset | Extra directory of `SKILL.md` playbooks. |
| `LOG_LEVEL` | `info` | JSON logs to stdout. |

## Endpoints (all but health require `Authorization: Bearer $AGENT_INTEROP_SECRET`)

| Endpoint | Called by (upstream v2.11.739) |
| --- | --- |
| `POST /internal/extracts` | `POST /v2/agent` |
| `GET /internal/extracts/:id` | `GET /v2/agent/:id` |
| `DELETE /internal/extracts/:id` | `DELETE /v2/agent/:id` |
| `GET /internal/extracts/:id/trace` | `GET /v2/agent/:id/trace` |
| `GET /internal/extracts/:id/skill[?refresh=1]` | `GET /v2/agent/:id/skill` |
| `GET /internal/extracts/:id/snapshots/:snapshotId` (`x-team-id`) | `GET /v2/agent/:id/snapshots/:snapshotId` |
| `GET /internal/threads/:threadId?teamId=&includeData=` | `GET /v2/agent/threads/:threadId`, follow-up `POST /v2/agent` |
| `GET /internal/recent-agents-for-team?teamId=` | `GET /v2/agent` |
| `GET /v2/extract/:id/options` | status fallback of the pre-v2.11.739 gateway |
| `GET /health/liveness`, `GET /health/readiness` | container health |

Status responses also carry `teamId` and `createdAt` so a gateway without
Firecrawl's hosted job-access store can authorize reads from this service.

## Behavior and limits

- **Lifecycle**: `POST` validates and queues (returns `threadId`, `threadTurn`);
  workers pull from the Redis queue; status is `processing` until `success` or
  `failed`. Cancel, credit cap (`stopReason: credit_limit_reached`), time and
  token limits end the run as `failed`, with a best-effort `partial` JSON (and
  `partialSchemaValid` when a schema was given).
- **Credits**: `creditsUsed` is the sum of credits reported by the Firecrawl
  API for the run's search/scrape/interact calls, `AGENT_MAP_CREDITS` per map,
  plus the optional token charge. The service does not bill anyone; with
  `AGENT_FIRECRAWL_INTEROP=true` the API attributes (and, unless the request
  was free, bills) the underlying scrapes and searches.
- **Threads**: follow-up turns get up to five previous successful turns as
  context; one run per thread at a time (409 with `runId`).
- **Zero data retention**: traces hold only content-free lifecycle events, no
  snapshots are kept, results expire after `zeroDataRetentionMinutes`, then
  status answers 410 `zdr_expired`. The model provider's own retention is
  outside this service's control.
- **Not supported**: Exchange (paid third-party toolkits and approvals) is
  reported as `exchange.enabled: false`; follow-up `suggestions` are not
  generated; live browser view relies on the API's own browser sessions.
- **Restart safety**: workers heartbeat each run; a run whose worker stops
  heart-beating for 60s is failed with a clear error instead of hanging.

## Tests

```bash
pnpm install
pnpm test                         # unit + contract tests (mock model + mock Firecrawl)
AGENT_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test   # also the Redis store tests
AGENT_LIVE_OPENAI_BASE_URL=... AGENT_LIVE_MODEL=... \
AGENT_LIVE_FIRECRAWL_API_URL=http://localhost:3002 pnpm test:live
```

The contract tests drive the service with request shapes copied from the
upstream gateway (`test/gateway.ts`).
