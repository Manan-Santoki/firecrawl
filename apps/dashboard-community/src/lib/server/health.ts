import "server-only";
import { Socket } from "node:net";
import { pools } from "./db";
import { env } from "./env";
import { crawlRedis, rateLimitRedis } from "./redis";

export type HealthState = "ok" | "degraded" | "down" | "not_configured";

export type HealthCheck = {
  id: string;
  group: "Core" | "Data" | "AI" | "Optional services";
  name: string;
  state: HealthState;
  version: string | null;
  detail: string;
  latencyMs: number | null;
};

const TIMEOUT_MS = 4_000;

/** Removes credentials from a URL before it is ever shown. */
export function describeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "configured";
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = performance.now();
  try {
    const value = await fn();
    return { value, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { error, ms: Math.round(performance.now() - started) };
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "Timed out";
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    return cause?.code ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}

async function httpProbe(
  id: string,
  group: HealthCheck["group"],
  name: string,
  baseUrl: string | undefined,
  path: string,
  parse?: (status: number, body: unknown) => { state?: HealthState; version?: string | null; detail?: string },
  headers?: Record<string, string>,
): Promise<HealthCheck> {
  if (!baseUrl) {
    return { id, group, name, state: "not_configured", version: null, detail: "Not configured", latencyMs: null };
  }
  const target = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const result = await timed(async () => {
    const response = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store", headers });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Plain text body.
    }
    return { status: response.status, body };
  });
  if (result.error || !result.value) {
    return {
      id,
      group,
      name,
      state: "down",
      version: null,
      detail: `${describeEndpoint(baseUrl)}: ${errorText(result.error)}`,
      latencyMs: result.ms,
    };
  }
  const parsed = parse?.(result.value.status, result.value.body) ?? {};
  const state = parsed.state ?? (result.value.status < 500 ? "ok" : "down");
  return {
    id,
    group,
    name,
    state,
    version: parsed.version ?? null,
    detail: parsed.detail ?? `${describeEndpoint(baseUrl)} answered HTTP ${result.value.status}`,
    latencyMs: result.ms,
  };
}

function tcpProbe(id: string, group: HealthCheck["group"], name: string, raw: string | undefined): Promise<HealthCheck> {
  if (!raw) {
    return Promise.resolve({ id, group, name, state: "not_configured", version: null, detail: "Not configured", latencyMs: null });
  }
  let host = "";
  let port = 0;
  try {
    const url = new URL(raw);
    host = url.hostname;
    port = Number(url.port || (url.protocol === "amqps:" ? 5671 : 5672));
  } catch {
    return Promise.resolve({ id, group, name, state: "down", version: null, detail: "Invalid URL", latencyMs: null });
  }
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (state: HealthState, detail: string) => {
      socket.destroy();
      resolve({ id, group, name, state, version: null, detail, latencyMs: Math.round(performance.now() - started) });
    };
    socket.setTimeout(TIMEOUT_MS, () => done("down", `${host}:${port}: Timed out`));
    socket.once("error", (error) => done("down", `${host}:${port}: ${error.message}`));
    socket.connect(port, host, () => done("ok", `${host}:${port} accepts connections`));
  });
}

async function postgresProbe(id: string, name: string, pool: ReturnType<typeof pools>["app"] | null): Promise<HealthCheck> {
  if (!pool) {
    return { id, group: "Data", name, state: "not_configured", version: null, detail: "Not configured", latencyMs: null };
  }
  const result = await timed(() => pool.query<{ v: string }>("SELECT current_setting('server_version') AS v"));
  if (result.error || !result.value) {
    return { id, group: "Data", name, state: "down", version: null, detail: errorText(result.error), latencyMs: result.ms };
  }
  return {
    id,
    group: "Data",
    name,
    state: "ok",
    version: `PostgreSQL ${result.value.rows[0].v.split(" ")[0]}`,
    detail: "Query succeeded",
    latencyMs: result.ms,
  };
}

async function redisProbe(): Promise<HealthCheck> {
  const redis = rateLimitRedis();
  const base = { id: "redis", group: "Data" as const, name: "Redis" };
  if (!redis) return { ...base, state: "not_configured", version: null, detail: "Not configured", latencyMs: null };
  const result = await timed(async () => {
    await redis.ping();
    return redis.info("server");
  });
  if (result.error || result.value === undefined) {
    return { ...base, state: "down", version: null, detail: errorText(result.error), latencyMs: result.ms };
  }
  const version = /redis_version:(\S+)/.exec(result.value)?.[1] ?? /valkey_version:(\S+)/.exec(result.value)?.[1];
  const evictSame = crawlRedis() === redis;
  return {
    ...base,
    state: "ok",
    version: version ? `Redis ${version}` : null,
    detail: evictSame ? "PING ok (cache and crawl state)" : "PING ok",
    latencyMs: result.ms,
  };
}

async function queueProbe(): Promise<HealthCheck> {
  const nuq = pools().nuq;
  const base = { id: "queues", group: "Core" as const, name: "Workers and queues" };
  if (!nuq) return { ...base, state: "not_configured", version: null, detail: "NUQ_DATABASE_URL not set", latencyMs: null };
  const result = await timed(() =>
    nuq.query<{ queued: number; active: number; stalled: number; finished: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'active' AND locked_at < now() - interval '2 minutes')::int AS stalled,
              count(*) FILTER (WHERE status = 'completed' AND finished_at > now() - interval '15 minutes')::int AS finished,
              count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '15 minutes')::int AS failed
       FROM nuq.queue_scrape
       WHERE status IN ('queued', 'active') OR finished_at > now() - interval '15 minutes'`,
    ),
  );
  if (result.error || !result.value) {
    return { ...base, state: "down", version: null, detail: errorText(result.error), latencyMs: result.ms };
  }
  const q = result.value.rows[0];
  // Jobs that wait while nothing runs or finishes mean no worker is consuming.
  const stuck = q.queued > 0 && q.active === 0 && q.finished === 0;
  return {
    ...base,
    state: stuck || q.stalled > 0 ? "degraded" : "ok",
    version: null,
    detail: `${q.queued} queued, ${q.active} active, ${q.stalled} stalled; ${q.finished} done and ${q.failed} failed in 15 min`,
    latencyMs: result.ms,
  };
}

async function llmProbe(): Promise<HealthCheck[]> {
  const config = env();
  const authHeaders: Record<string, string> = config.OPENAI_API_KEY ? { Authorization: `Bearer ${config.OPENAI_API_KEY}` } : {};
  let models: string[] = [];
  const llm = await httpProbe("llm", "AI", "LLM endpoint", config.OPENAI_BASE_URL, "models", (status, body) => {
    if (status >= 400) return { state: "down", detail: `/models answered HTTP ${status}` };
    const data = (body as { data?: { id?: string }[] })?.data ?? [];
    models = data.map((model) => String(model.id));
    if (!config.MODEL_NAME) return { state: "degraded", detail: `${models.length} models listed; MODEL_NAME not set` };
    return models.includes(config.MODEL_NAME)
      ? { state: "ok", version: config.MODEL_NAME, detail: `${config.MODEL_NAME} is listed in /models` }
      : { state: "degraded", version: config.MODEL_NAME, detail: `${config.MODEL_NAME} is not listed in /models (${models.length} models)` };
  }, authHeaders);

  let embedding: HealthCheck;
  if (config.EMBEDDING_SERVICE_URL) {
    embedding = await httpProbe("embedding", "AI", "Embedding service", config.EMBEDDING_SERVICE_URL, "health");
  } else if (!config.MODEL_EMBEDDING_NAME) {
    embedding = { id: "embedding", group: "AI", name: "Embedding model", state: "not_configured", version: null, detail: "Not configured", latencyMs: null };
  } else {
    const listed = models.includes(config.MODEL_EMBEDDING_NAME);
    embedding = {
      id: "embedding",
      group: "AI",
      name: "Embedding model",
      state: llm.state === "down" ? "down" : listed ? "ok" : "degraded",
      version: config.MODEL_EMBEDDING_NAME,
      detail: listed
        ? `${config.MODEL_EMBEDDING_NAME} is listed in /models`
        : `${config.MODEL_EMBEDDING_NAME} is not listed by the LLM endpoint`,
      latencyMs: llm.latencyMs,
    };
  }
  return [llm, embedding];
}

export async function runHealthChecks(): Promise<HealthCheck[]> {
  const config = env();
  const optional = [
    ["fire-engine", "Fire Engine", config.FIRE_ENGINE_BETA_URL],
    ["highlight", "Highlight", config.HIGHLIGHT_SERVICE_URL],
    ["avgrab", "Audio/video grab", config.AVGRAB_SERVICE_URL],
    ["fire-privacy", "Fire Privacy", config.FIRE_PRIVACY_URL],
    ["agent", "Agent service", config.AGENT_SERVICE_URL],
    ["index", "Index service", config.INDEX_SERVICE_URL],
  ] as const;

  const checks = await Promise.all([
    httpProbe("api", "Core", "Firecrawl API", config.FIRECRAWL_API_URL, "health/liveness", (status) => ({
      state: status === 200 ? "ok" : "down",
      detail: `Liveness answered HTTP ${status}`,
    })).then(async (check) => {
      if (check.state !== "ok") return check;
      try {
        const response = await fetch(new URL("/openapi.json", config.FIRECRAWL_API_URL), {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
        const body = (await response.json()) as { info?: { version?: string } };
        return { ...check, version: body.info?.version ? `v${body.info.version}` : null };
      } catch {
        return check;
      }
    }),
    queueProbe(),
    tcpProbe("rabbitmq", "Core", "RabbitMQ", config.NUQ_RABBITMQ_URL),
    redisProbe(),
    postgresProbe("postgres-app", "Application PostgreSQL", pools().app),
    postgresProbe("postgres-nuq", "Queue PostgreSQL (NuQ)", pools().nuq),
    httpProbe("playwright", "Core", "Playwright service", config.PLAYWRIGHT_MICROSERVICE_URL, "/health", (status, body) => ({
      state: status === 200 ? "ok" : "down",
      detail:
        status === 200 && body && typeof body === "object" && "activePages" in body
          ? `Healthy, ${String((body as { activePages: number }).activePages)} active pages`
          : `Health answered HTTP ${status}`,
    })),
    httpProbe("browser", "Core", "Browser service", config.BROWSER_SERVICE_URL, "/health/liveness", (status) => ({
      state: status === 200 ? "ok" : "down",
      detail: `Liveness answered HTTP ${status}`,
    })),
    httpProbe("searxng", "AI", "SearXNG", config.SEARXNG_ENDPOINT, "/healthz", (status) => ({
      state: status === 200 ? "ok" : status === 404 ? "ok" : "down",
      detail: status === 404 ? "Reachable (no /healthz route)" : `/healthz answered HTTP ${status}`,
    })),
    llmProbe(),
    ...optional.map(([id, name, url]) => httpProbe(id, "Optional services", name, url, "/health")),
  ]);
  return checks.flat();
}
