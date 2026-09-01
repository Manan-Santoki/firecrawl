# Firecrawl Community browser service

Provider-neutral browser sessions for the public Firecrawl `BROWSER_SERVICE_URL` contract.

## Implemented contract

- authenticated create, execute and idempotent delete endpoints
- one isolated Chromium process per session
- hard maximum concurrency, total TTL and inactivity TTL
- serialized commands within each session
- Node execution with persistent `browser`, `context` and `page` globals
- Bash execution, including `agent-browser` through the session CDP endpoint
- Python execution through Playwright's async API
- proxied CDP WebSocket URL
- read-only and interactive screencast views
- automatic dialog dismissal and process cleanup on timeouts or shutdown

Session recording/replay and encrypted persistent profiles are not release-qualified yet. The API returns a clear `404` for recording endpoints, and the public feature matrix keeps replay marked **Planned**.

## Trust boundary

The execute endpoint intentionally runs operator-submitted code. Run this service on a private container network, authenticate it with a unique `BROWSER_SERVICE_API_KEY`, expose only the Firecrawl API publicly, drop unnecessary Linux capabilities, and apply CPU/memory/PID limits. Do not share one instance between mutually untrusted tenants without an additional sandbox boundary such as microVMs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3006` | REST, viewer and CDP proxy port. |
| `BROWSER_PUBLIC_URL` | `http://127.0.0.1:3006` | URL embedded in CDP and viewer responses. Use the service URL reachable by the API and clients. |
| `BROWSER_SERVICE_API_KEY` | required | Bearer secret shared only with the Firecrawl API. |
| `MAX_CONCURRENT_SESSIONS` | `2` | Hard process/session capacity. |
| `BROWSER_PROFILE_ROOT` | OS temp directory | Optional persistent-profile root; mount a protected volume to persist it. |
| `CHROMIUM_EXECUTABLE_PATH` | bundled Playwright Chromium | Browser executable override. |
| `PYTHON_EXECUTABLE` | `python3` | Python runtime containing `playwright`. |

## Development

```bash
pnpm install
pnpm test
pnpm build
```
