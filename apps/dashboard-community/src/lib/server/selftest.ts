import "server-only";
import { actingKey } from "./acting-key";
import type { Viewer } from "./authz";
import { query } from "./db";
import { FirecrawlApiError, firecrawlRequest } from "./firecrawl-api";
import { SELF_TESTS, type SelfTestId } from "@/lib/self-tests";

type Outcome = { status: "pass" | "fail" | "skip"; detail: string };
type Doc = Record<string, unknown> & { metadata?: Record<string, unknown> };

const TARGET = "https://example.com";

async function post<T = Record<string, unknown>>(key: string, path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  return firecrawlRequest<T>(key, path, { method: "POST", body: { ...(body as object), origin: "community-dashboard-selftest" }, timeoutMs });
}

async function scrape(key: string, options: Record<string, unknown>): Promise<Doc> {
  const result = await post<{ data: Doc }>(key, "/v2/scrape", { url: TARGET, ...options });
  return result.data;
}

function expectField(doc: Doc, field: string, describe: string): Outcome {
  const value = doc[field];
  const ok = typeof value === "string" ? value.length > 0 : value !== undefined && value !== null;
  return ok ? { status: "pass", detail: describe } : { status: "fail", detail: `Response had no ${field}` };
}

async function pollJob(key: string, path: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const status = await firecrawlRequest<Record<string, unknown>>(key, path);
    if (status.status !== "scraping" && status.status !== "processing") return status;
    if (Date.now() - started > timeoutMs) return status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const RUNNERS: Record<SelfTestId, (key: string) => Promise<Outcome>> = {
  scrape: async (key) => {
    const doc = await scrape(key, { formats: ["markdown"] });
    const markdown = String(doc.markdown ?? "");
    return /example|documentation/i.test(markdown) ? { status: "pass", detail: `${markdown.length} characters of markdown` } : { status: "fail", detail: "Unexpected markdown" };
  },
  screenshot: async (key) => expectField(await scrape(key, { formats: ["screenshot"] }), "screenshot", "Screenshot URL returned"),
  branding: async (key) => expectField(await scrape(key, { formats: ["branding"] }), "branding", "Branding returned"),
  actions: async (key) => {
    const doc = await scrape(key, { formats: ["markdown"], actions: [{ type: "wait", milliseconds: 300 }, { type: "executeJavascript", script: "document.title" }] });
    return doc.actions !== undefined || doc.markdown ? { status: "pass", detail: "Actions executed" } : { status: "fail", detail: "No action results" };
  },
  search: async (key) => {
    const result = await post<{ data: { web?: unknown[] } | unknown[] }>(key, "/v2/search", { query: "example domain", limit: 2 });
    const items = Array.isArray(result.data) ? result.data : (result.data.web ?? []);
    return items.length > 0 ? { status: "pass", detail: `${items.length} results` } : { status: "fail", detail: "No results" };
  },
  map: async (key) => {
    const result = await post<{ links: unknown[] }>(key, "/v2/map", { url: TARGET, limit: 10 });
    return result.links?.length ? { status: "pass", detail: `${result.links.length} links` } : { status: "fail", detail: "No links" };
  },
  crawl: async (key) => {
    const { id } = await post<{ id: string }>(key, "/v2/crawl", { url: TARGET, limit: 1 });
    const status = await pollJob(key, `/v2/crawl/${id}`);
    return status.status === "completed" && Number(status.completed) >= 1
      ? { status: "pass", detail: "Crawl completed" }
      : { status: "fail", detail: `Crawl ended as ${String(status.status)}` };
  },
  json: async (key) => {
    const doc = await scrape(key, {
      formats: [{ type: "json", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }],
    });
    const json = doc.json as { title?: string } | undefined;
    return json?.title ? { status: "pass", detail: `title: ${json.title}` } : { status: "fail", detail: "No structured title" };
  },
  summary: async (key) => expectField(await scrape(key, { formats: ["summary"] }), "summary", "Summary returned"),
  audio: async (key) => expectField(await scrape(key, { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", formats: ["audio"] }), "audio", "Audio returned"),
  redact_pii: async (key) => {
    const doc = await scrape(key, { formats: ["markdown"], redactPII: true });
    return typeof doc.markdown === "string" ? { status: "pass", detail: "Redacted scrape returned markdown" } : { status: "fail", detail: "No markdown" };
  },
  max_age: async (key) => {
    await scrape(key, { formats: ["markdown"], maxAge: 3_600_000 });
    const second = await scrape(key, { formats: ["markdown"], maxAge: 3_600_000 });
    const cache = second.metadata?.cacheState;
    return cache === "hit" ? { status: "pass", detail: "Second request served from cache" } : { status: "fail", detail: `cacheState: ${String(cache ?? "missing")}` };
  },
  lockdown: async (key) => {
    await scrape(key, { formats: ["markdown"], maxAge: 3_600_000 });
    const doc = await scrape(key, { formats: ["markdown"], lockdown: true });
    return typeof doc.markdown === "string" ? { status: "pass", detail: "Lockdown served cached content" } : { status: "fail", detail: "No content" };
  },
  agent: async (key) => {
    const { id } = await post<{ id: string }>(key, "/v2/agent", { prompt: "What is the title of https://example.com?", urls: [TARGET], maxCredits: 20 });
    const status = await pollJob(key, `/v2/agent/${id}`, 180_000);
    return status.status === "completed" ? { status: "pass", detail: "Agent completed" } : { status: "fail", detail: `Agent ended as ${String(status.status)}` };
  },
  interact: async (key) => {
    const session = await post<{ id: string }>(key, "/v2/browser", { ttl: 60, streamWebView: false });
    try {
      const result = await post<{ exitCode?: number; stdout?: string }>(key, `/v2/browser/${session.id}/execute`, { code: "console.log(1 + 1)", language: "node", timeout: 30 });
      return result.exitCode === 0 ? { status: "pass", detail: "Session created and code executed" } : { status: "fail", detail: `exit ${String(result.exitCode)}` };
    } finally {
      await firecrawlRequest(key, `/v2/browser/${session.id}`, { method: "DELETE" }).catch(() => undefined);
    }
  },
};

export type SelfTestResult = { feature: SelfTestId; status: "pass" | "fail" | "skip"; latencyMs: number; detail: string; createdAt: string };

/** Runs one self-test as the viewer (billed to them) and records the result. */
export async function runSelfTest(viewer: Viewer, feature: SelfTestId): Promise<SelfTestResult> {
  const key = await actingKey(viewer);
  const started = performance.now();
  let outcome: Outcome;
  try {
    outcome = await RUNNERS[feature](key.key);
  } catch (error) {
    outcome =
      error instanceof FirecrawlApiError
        ? { status: "fail", detail: `HTTP ${error.status}: ${error.message}`.slice(0, 500) }
        : { status: "fail", detail: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
  const latencyMs = Math.round(performance.now() - started);
  const rows = await query<{ created_at: Date }>(
    `INSERT INTO dashboard.selftest_run (feature, status, latency_ms, detail, run_by) VALUES ($1, $2, $3, $4, $5::uuid) RETURNING created_at`,
    [feature, outcome.status, latencyMs, outcome.detail, viewer.userId],
  );
  return { feature, ...outcome, latencyMs, createdAt: new Date(rows[0].created_at).toISOString() };
}

export async function selfTestHistory(limit = 200): Promise<SelfTestResult[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT feature, status, latency_ms, detail, created_at FROM dashboard.selftest_run ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows
    .filter((row) => (row.feature as string) in SELF_TESTS)
    .map((row) => ({
      feature: row.feature as SelfTestId,
      status: row.status as SelfTestResult["status"],
      latencyMs: Number(row.latency_ms),
      detail: String(row.detail ?? ""),
      createdAt: new Date(row.created_at as string).toISOString(),
    }));
}
