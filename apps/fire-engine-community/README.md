# Firecrawl Community fire-engine

A provider-neutral, self-hostable implementation of the HTTP contract the
Firecrawl API uses for its private rendering service (`FIRE_ENGINE_BETA_URL`).
Pointing the API at this service turns on the fire-engine code paths that are
otherwise dead in self-hosted deployments: the `screenshot` and `branding`
formats, scrape `actions`, `mobile`/`location` emulation, `waitFor` through
actions, and `proxy: "stealth" | "enhanced"`.

The contract was derived from the API client at upstream tag `v2.11.739`
(`apps/api/src/scraper/scrapeURL/engines/fire-engine/`). The service never
calls Firecrawl Cloud and stores nothing after a response is sent.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/scrape` | `engine: "chrome-cdp"` (Patchright Chromium), `"tlsclient"` (plain HTTP client) or `"playwright"` (alias of chrome-cdp). Answers synchronously with the success shape, or `{ "error" }` with HTTP 4xx/5xx. `instantReturn: true` returns `{ jobId, processing: true }` (202). |
| `GET` | `/scrape/:jobId` | Job status for `instantReturn` jobs: `active`, `completed` (success fields) or `failed`. Always HTTP 200. |
| `DELETE` | `/scrape/:jobId` | Cancels/forgets a job. Idempotent. |
| `POST` | `/search` | v1 search: `SearchResult[]`. |
| `POST` | `/v2/search` | v2 search: `{ web?, news?, images? }`, honours `includeDomains`/`excludeDomains`. |
| `POST` | `/map` | Map discovery (`site:` queries): `SearchResult[]`. |
| `GET` | `/health/liveness`, `/health/readiness` | Probes; readiness reports active/queued scrapes and browser generations. |

### Supported request fields (chrome-cdp)

| Field | Behaviour |
| --- | --- |
| `url`, `headers` | Navigation target and extra headers (`User-Agent` in `headers` overrides the UA). |
| `actions` | `wait` (ms or selector), `click` (`all`), `write`, `press`, `scroll` (`direction`, `selector`), `scrape`, `executeJavascript`, `screenshot` (`fullPage`, `quality` → JPEG, `viewport`), `pdf` (`format`, `landscape`, `scale`), `getCookies`. The API turns `waitFor`, the `screenshot` format and the `branding` format into actions. |
| `mobile` | Pixel 7 emulation (viewport, DPR, touch, UA aligned to the running Chrome version, `navigator.userAgentData` reporting Android/mobile). |
| `geolocation` | `{ country, languages }` → locale, `Accept-Language`, timezone. The egress IP only changes if a proxy with a `{country}` username placeholder is configured. |
| `mobileProxy` | The API sets this for `proxy: "stealth" | "enhanced"` (and after auto-escalation). Runs the hardened stealth browser through `STEALTH_PROXY_SERVER` (or `PROXY_SERVER`). `usedMobileProxy` in the response is `true` only when `STEALTH_PROXY_SERVER` was actually used. |
| `skipTlsVerification` | Ignores certificate errors. |
| `blockMedia` | Defaults to blocking images, fonts and media unless a screenshot or PDF action is present; `false` (sent for branding) loads everything. |
| `format: "rawBase64"` | Returns the original response body in `file.content`. |
| `timeout` | Overall budget, capped by `MAX_SCRAPE_TIMEOUT_MS`. |
| `behaviorOverrides` | Safe Mode: `useHeadlessUserAgent` keeps the HeadlessChrome UA; `disableSiteHandling`/`exposeWebdriver` disable the anti-bot retry. |
| `profile` | Not supported: the request fails rather than silently scraping anonymously. |
| `team_id`, `priority`, `maxAge`, `saveScrapeResultToGCS`, `zeroDataRetention`, `pdfMaxSize`, `forceNonRender`, `disableSmartWaitCache` | Accepted and ignored (no cloud storage, caching or render-tier routing here). |

Screenshots and PDF action results are returned as `data:` URLs.

Files (PDF, Office documents, images, `application/octet-stream`, attachment
downloads) are captured from the main document response through Chrome's own
network stack and returned as `file: { name, content }` (base64), which the API
hands to its PDF/document/image engines.

### Error vocabulary

The API classifies a failed scrape by substring, so these messages are part of
the contract:

| Message | API error |
| --- | --- |
| `Chrome error: net::ERR_…` | `SiteError` (`SSLError` for certificate codes) |
| `Dns resolution error for hostname: …` | `DNSResolutionError` |
| `Scrape failed to finish without timing out` | `FEPageLoadFailed` |
| `Element …` / `Javascript execution failed: …` | `ActionError` (returned to the user) |
| `File exceeds size limit …` | `UnsupportedFileError` |
| anything else (including `capacity exceeded`, HTTP 429) | `EngineError` → the API falls back to its next engine |

## Stealth path and anti-bot handling

Requests with `mobileProxy: true` use a separate Patchright (patched Playwright)
Chromium launched with stealth flags (WebGL kept available through SwiftShader),
a navigator overrider that only patches values that actually leak automation,
Chrome-reduced user agents derived from the running browser version, Sec-CH-UA
and `navigator.userAgentData` aligned with that UA via CDP, isolated-world
internal evaluations, and a short human-like mouse/scroll pass after load.

Basic requests stay fast (no client-hint override, no simulation). When a basic
response looks like a bot wall (Cloudflare/Akamai/PerimeterX/DataDome/Imperva/
Sucuri/Kasada markers, 403/503 HTML, 429), the service retries once on the
stealth path within the same time budget, through `STEALTH_PROXY_SERVER` if set.
The tlsclient engine retries only when a stealth proxy exists (a different
egress is the only thing a plain HTTP retry can change).

Several techniques are ported from Crawl4AI (Apache-2.0); see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). None of this defeats
interactive CAPTCHAs, and a datacenter IP remains a datacenter IP; for hard
targets supply a residential/mobile `STEALTH_PROXY_SERVER`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3010` / `0.0.0.0` | Listen address. |
| `FIRE_ENGINE_API_KEY` | unset | Optional shared secret. The API sends no credentials, so embed it in the URL: `FIRE_ENGINE_BETA_URL=http://fire-engine-community:3010/key/<secret>`. `Authorization: Bearer` and `X-Api-Key` are also accepted. The URL (and so the key) can appear in API debug logs; prefer network isolation. |
| `MAX_CONCURRENT_SCRAPES` | `4` | Concurrent browser/HTTP scrapes. |
| `MAX_QUEUED_SCRAPES` | `32` | Waiting requests beyond which the service answers HTTP 429 (API falls back). |
| `QUEUE_TIMEOUT_MS` | `30000` | Maximum queue wait. |
| `DEFAULT_SCRAPE_TIMEOUT_MS` / `MAX_SCRAPE_TIMEOUT_MS` | `60000` / `180000` | Budget when the request has none / hard cap. |
| `NAVIGATION_LOAD_CAP_MS` / `NETWORK_IDLE_CAP_MS` | `15000` / `2000` | Smart-wait caps after `DOMContentLoaded`. |
| `MAX_FILE_BYTES` | `52428800` | Largest file handed back (`File exceeds size limit` above it). |
| `BLOCK_PRIVATE_NETWORKS` | `true` | Refuse loopback/private/link-local/metadata targets, including redirects and sub-resources (SSRF guard). |
| `BLOCK_ADS` | `true` | Abort requests to a small built-in list of ad/analytics hosts. |
| `ANTIBOT_RETRY` / `ANTIBOT_RETRY_MIN_BUDGET_MS` | `true` / `8000` | Stealth retry on detected blocks, when at least this much budget remains. |
| `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD`, `PROXY_BYPASS` | unset | Upstream proxy for basic requests. `{country}` in the username/password is replaced with the requested ISO country. |
| `STEALTH_PROXY_SERVER`, `STEALTH_PROXY_USERNAME`, `STEALTH_PROXY_PASSWORD`, `STEALTH_PROXY_BYPASS` | unset | Proxy for stealth/enhanced requests and anti-bot retries (falls back to `PROXY_*`). |
| `SEARXNG_ENDPOINT`, `SEARXNG_ENGINES`, `SEARXNG_CATEGORIES` | unset | Search/map backend (same meaning as the API's variables). |
| `SEARCH_DUCKDUCKGO_FALLBACK` | `true` | Use DuckDuckGo's HTML endpoint when SearXNG is unset or returns nothing. |
| `SEARCH_TIMEOUT_MS` | `10000` | Per search backend request. |
| `JOB_TTL_MS` | `600000` | Retention of `instantReturn` job results. |
| `BROWSER_RECYCLE_AFTER` | `250` | Contexts per Chromium before it is drained and replaced. |
| `BROWSER_CHANNEL` | `chromium` | Patchright channel (new headless Chromium). |
| `CHROMIUM_EXECUTABLE_PATH` | bundled | Browser override. |
| `BROWSER_HEADLESS` | `true` | Set `false` only with a virtual display. |

## What changes in the API when `FIRE_ENGINE_BETA_URL` is set

Operators should know that the variable is a global switch, not just a feature
toggle:

- **Engine order.** `fire-engine;chrome-cdp` (quality 50) and its retry/stealth
  variants become the primary engines ahead of `playwright` (20). The plain
  `fetch` engine and the tlsclient variants are **removed** from the default
  waterfall; tlsclient is still used for `fastMode`, `atsv`, audio/video,
  robots.txt and sitemap fetches.
- **Files.** PDF, document and image URLs are always fetched through chrome-cdp
  and handed to the parsers; the file engines no longer download directly
  (unless `forceEngine` is pinned). This service therefore must stay up and
  must be able to reach those files.
- **Search and map.** `/v1/search`, `/v2/search` and map discovery go to this
  service's `/search`, `/v2/search` and `/map`; the API's own `SEARXNG_ENDPOINT`
  and DuckDuckGo fallbacks are bypassed. Set `SEARXNG_ENDPOINT` on this service
  instead. If no backend returns results, map's `site:` lookup retries four
  times (about 5 s) before continuing with sitemap/index results.
- **US-only teams** may now use search (the API only rejects them when the
  variable is unset).
- **rawBase64** becomes available (it requires fire-engine).
- **Stealth auto-escalation.** With `proxy: "auto"`, a 401/403/429 result makes
  the API retry on the stealth engines; without `STEALTH_PROXY_SERVER` that
  retry reuses the default egress.
- **SSRF.** With `BLOCK_PRIVATE_NETWORKS=true` (default) private/internal URLs
  fail with `Chrome error: net::ERR_ACCESS_DENIED`; previously the self-hosted
  playwright/fetch engines may have reached them.
- `FIRE_ENGINE_AB_URL`, `FIRE_ENGINE_STAGING_URL` and GCS hand-off variables are
  not needed and should stay unset.

## Development and tests

```bash
pnpm install
pnpm test          # unit tests, no browser required
pnpm build
# Contract tests against the Docker image (fixture site runs inside the container):
./test/contract/run-docker.sh
# Optionally send the API's real branding script:
BRANDING_ENTRY=../api/src/scraper/scrapeURL/engines/fire-engine/branding-script/index.ts ./test/contract/run-docker.sh
```

The contract test builds requests exactly as the API's `scrapeURLWithFireEngineChromeCDP`
and `scrapeURLWithFireEngineTLSClient` do and validates responses with the
API's own zod schemas and error classifier (`test/contract/api-contract.ts`).

## Trust boundary

`executeJavascript` actions run caller-supplied JavaScript in the browser
(never in the service process). Keep the service on a private network reachable
only by the Firecrawl API, keep `BLOCK_PRIVATE_NETWORKS` on, and apply the
CPU/memory/PID limits in the Compose overlay.
