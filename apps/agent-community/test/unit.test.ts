import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFirecrawlCloudUrl, loadConfig } from "../src/config.js";
import { MemoryKV } from "../src/kv.js";
import { normalizeToolCall } from "../src/llm.js";
import { maxStepsFor, urlAllowed } from "../src/runner.js";
import { parseJsonLoose, validateData } from "../src/schema.js";
import { toStatus } from "../src/server.js";
import { defaultSkillsDir, findSitePlaybook, loadSkills } from "../src/skills.js";
import { JobStore } from "../src/store.js";
import type { AgentRun } from "../src/types.js";
import { assertPublicWebhookUrl } from "../src/webhook.js";
import { makeConfig } from "./helpers.js";

const baseEnv = {
  AGENT_INTEROP_SECRET: "0123456789abcdef0123",
  AGENT_MODEL: "qwen3:8b",
  OPENAI_BASE_URL: "http://litellm:4000/v1/",
  FIRECRAWL_API_URL: "http://api:3002/",
};

function run(partial: Partial<AgentRun>): AgentRun {
  return {
    id: "r1",
    teamId: "t1",
    threadId: "th1",
    threadTurn: 1,
    mode: "extract",
    prompt: "p",
    model: "spark-2",
    maxCredits: 100,
    state: "processing",
    createdAt: new Date().toISOString(),
    creditsUsed: 0,
    firecrawlCredits: 0,
    tokensUsed: 0,
    steps: 0,
    sources: [],
    ...partial,
  };
}

describe("config", () => {
  it("loads the OpenAI-compatible contract and trims trailing slashes", () => {
    const c = loadConfig(baseEnv);
    assert.equal(c.llm.baseUrl, "http://litellm:4000/v1");
    assert.equal(c.llm.model, "qwen3:8b");
    assert.equal(c.firecrawl.apiUrl, "http://api:3002");
    assert.equal(c.store, "memory");
    assert.equal(c.limits.maxConcurrentRuns, 2);
  });

  it("falls back to COMMUNITY_MODEL_NAME and the ollama provider default", () => {
    const c = loadConfig({
      ...baseEnv,
      AGENT_MODEL: undefined,
      OPENAI_BASE_URL: undefined,
      COMMUNITY_MODEL_PROVIDER: "ollama",
      COMMUNITY_MODEL_NAME: "llama3.1",
      OLLAMA_BASE_URL: "http://ollama:11434",
    });
    assert.equal(c.llm.model, "llama3.1");
    assert.equal(c.llm.baseUrl, "http://ollama:11434/v1");
  });

  it("refuses Firecrawl Cloud, missing secrets and missing endpoints", () => {
    assert.throws(() => loadConfig({ ...baseEnv, FIRECRAWL_API_URL: "https://api.firecrawl.dev" }), /Firecrawl Cloud/);
    assert.throws(() => loadConfig({ ...baseEnv, AGENT_INTEROP_SECRET: "short" }), /AGENT_INTEROP_SECRET/);
    assert.throws(() => loadConfig({ ...baseEnv, FIRECRAWL_API_URL: undefined }), /FIRECRAWL_API_URL/);
    assert.throws(() => loadConfig({ ...baseEnv, OPENAI_BASE_URL: undefined }), /OPENAI_BASE_URL/);
    assert.throws(() => loadConfig({ ...baseEnv, AGENT_MODEL: undefined }), /AGENT_MODEL/);
    assert.throws(() => loadConfig({ ...baseEnv, AGENT_STORE: "redis" }), /REDIS_URL/);
    assert.equal(isFirecrawlCloudUrl("https://firecrawl.dev"), true);
    assert.equal(isFirecrawlCloudUrl("http://firecrawl-api:3002"), false);
  });

  it("maps effort to step budgets unless overridden", () => {
    const c = makeConfig({ llmUrl: "http://x", firecrawlUrl: "http://y" });
    assert.equal(maxStepsFor({ effort: "low" }, c), 8);
    assert.equal(maxStepsFor({ effort: undefined }, c), 16);
    assert.equal(maxStepsFor({ effort: "high" }, c), 30);
    c.limits.maxStepsOverride = 4;
    assert.equal(maxStepsFor({ effort: "high" }, c), 4);
  });
});

describe("url constraints", () => {
  it("allows only pages under the provided URLs", () => {
    const allowed = ["https://docs.example.com/guide", "https://www.shop.com"];
    assert.equal(urlAllowed("https://docs.example.com/guide", allowed), true);
    assert.equal(urlAllowed("https://docs.example.com/guide/a?b=1", allowed), true);
    assert.equal(urlAllowed("https://docs.example.com/guidebook", allowed), false);
    assert.equal(urlAllowed("https://docs.example.com/other", allowed), false);
    assert.equal(urlAllowed("https://shop.com/item", allowed), true);
    assert.equal(urlAllowed("file:///etc/passwd", undefined), false);
    assert.equal(urlAllowed("not a url", undefined), false);
  });
});

describe("structured output helpers", () => {
  it("parses JSON wrapped in fences or prose", () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseJsonLoose('Here you go: {"a":[1,2]} thanks'), { ok: true, value: { a: [1, 2] } });
    assert.deepEqual(parseJsonLoose("[1,2]"), { ok: true, value: [1, 2] });
    assert.deepEqual(parseJsonLoose("nope"), { ok: false });
  });

  it("validates against JSON Schema with formats", () => {
    const schema = { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"] };
    assert.equal(validateData(schema, { url: "https://a.b" }).ok, true);
    const bad = validateData(schema, { url: "nope" });
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0]!, /\/url/);
    assert.equal(validateData(undefined, 42).ok, true);
  });
});

describe("tool call normalization", () => {
  it("fills missing ids and stringifies object arguments", () => {
    const call = normalizeToolCall({ function: { name: "scrape", arguments: { url: "https://a.b" } } }, 0);
    assert.equal(call.type, "function");
    assert.ok(call.id.startsWith("call_0_"));
    assert.equal(call.function.arguments, '{"url":"https://a.b"}');
    assert.equal(normalizeToolCall({ id: "x", function: { name: "s", arguments: "{}" } }, 1).id, "x");
  });
});

describe("status mapping", () => {
  it("maps internal states onto ExtractV3AgentStatus", () => {
    assert.equal(toStatus(run({ state: "queued" })).status, "processing");
    const ok = toStatus(run({ state: "succeeded", data: { a: 1 }, completedAt: "2026-01-01T00:00:00.000Z" }));
    assert.equal(ok.status, "success");
    assert.deepEqual(ok.data, { a: 1 });
    assert.equal(ok.completedAt, "2026-01-01T00:00:00.000Z");
    const capped = toStatus(run({ state: "credit_limit_reached", error: "cap", partial: { a: 1 }, partialSchemaValid: true }));
    assert.equal(capped.status, "failed");
    assert.equal(capped.stopReason, "credit_limit_reached");
    assert.deepEqual(capped.partial, { a: 1 });
    assert.equal(toStatus(run({ state: "cancelled", error: "c" })).status, "failed");
    assert.equal("data" in toStatus(run({ state: "failed" })), false);
    assert.equal("apiKey" in toStatus(run({ apiKey: "secret" })), false);
    // Ownership fields the community gateway uses for job access.
    const owned = toStatus(run({ zeroDataRetention: true, zeroDataRetentionMinutes: 15 }));
    assert.equal(owned.teamId, "t1");
    assert.equal(typeof owned.createdAt, "string");
    assert.equal(owned.zeroDataRetentionMinutes, 15);
  });
});

describe("skills from web-agent", () => {
  const skills = loadSkills([defaultSkillsDir()]);
  it("discovers the bundled SKILL.md playbooks", () => {
    assert.deepEqual(
      skills.map(s => s.name),
      ["competitor-analysis", "deep-research", "e-commerce", "financial-research", "pricing-tracker", "structured-extraction"],
    );
    for (const s of skills) assert.ok(s.description.length > 20, s.name);
  });
  it("matches site playbooks by hostname", () => {
    assert.equal(findSitePlaybook(skills, "https://www.sec.gov/cgi-bin/browse-edgar")?.platform, "SEC EDGAR");
    assert.equal(findSitePlaybook(skills, "https://finance.yahoo.com/quote/AAPL")?.skill, "financial-research");
    assert.equal(findSitePlaybook(skills, "https://example.com"), null);
  });
});

describe("webhook target policy", () => {
  it("blocks loopback and private targets unless allowed", async () => {
    await assert.rejects(assertPublicWebhookUrl("http://127.0.0.1:9/x", false), /private/);
    await assert.rejects(assertPublicWebhookUrl("http://10.1.2.3/x", false), /private/);
    await assert.rejects(assertPublicWebhookUrl("http://[::1]/x", false), /private/);
    await assert.rejects(assertPublicWebhookUrl("ftp://8.8.8.8/x", false), /http/);
    await assertPublicWebhookUrl("http://8.8.8.8/x", false);
    await assertPublicWebhookUrl("http://127.0.0.1/x", true);
  });
});

describe("job store", () => {
  it("drops the tool API key once a run is terminal and tombstones ZDR runs", async () => {
    const store = new JobStore(new MemoryKV(), { prefix: "t", resultTtlSeconds: 60, threadTtlSeconds: 60 });
    const r = run({ apiKey: "fc-secret", zeroDataRetention: true, zeroDataRetentionMinutes: 1 });
    assert.equal(await store.createRun(r), true);
    assert.equal(await store.createRun(r), false);
    assert.equal((await store.getRun("r1"))!.apiKey, "fc-secret");
    await store.saveRun({ ...r, state: "succeeded" });
    assert.equal((await store.getRun("r1"))!.apiKey, undefined);
    assert.equal(await store.isZdrExpired("r1"), true);
  });

  it("serializes runs on a thread", async () => {
    const store = new JobStore(new MemoryKV(), { prefix: "t", resultTtlSeconds: 60, threadTtlSeconds: 60 });
    await store.createRun(run({ id: "a", state: "processing" }));
    assert.equal(await store.lockThread("th", "a"), null);
    assert.equal(await store.lockThread("th", "b"), "a");
    await store.saveRun(run({ id: "a", state: "succeeded" }));
    assert.equal(await store.lockThread("th", "b"), null, "a finished run's lock is taken over");
  });
});
