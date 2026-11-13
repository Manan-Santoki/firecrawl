import { afterEach, describe, expect, it, vi } from "vitest";
import { diffLines } from "@/lib/diff";
import { buildBody, DEFAULT_FORM, newAction, schemaFromFields } from "@/lib/playground-body";
import { snippets } from "@/lib/playground-shared";
import { FirecrawlApiError } from "@/lib/server/firecrawl-api";

describe("playground request bodies", () => {
  it("builds a scrape with every documented option", () => {
    const body = buildBody("scrape", {
      ...DEFAULT_FORM,
      url: "https://example.com",
      formats: ["markdown", "screenshot", "json", "branding", "summary", "highlights"],
      screenshotFullPage: true,
      jsonPrompt: "title",
      highlightsQuery: "pricing",
      brandingMode: "fast",
      actions: [newAction("wait"), { type: "click", selector: "#more", all: true }, newAction("scrape")],
      country: "de",
      languages: "de, en",
      mobile: true,
      proxy: "stealth",
      maxAge: "3600000",
      lockdown: true,
      redactPII: true,
      redactMode: "aggressive",
      onlyMainContent: false,
      includeTags: "main",
      excludeTags: "nav, footer",
      waitFor: "500",
      timeout: "30000",
    });
    expect(body).toMatchObject({
      url: "https://example.com",
      formats: [
        "markdown",
        { type: "screenshot", fullPage: true },
        { type: "json", prompt: "title", schema: { type: "object" } },
        { type: "branding", mode: "fast" },
        "summary",
        { type: "highlights", query: "pricing" },
      ],
      actions: [{ type: "wait", milliseconds: 1000 }, { type: "click", selector: "#more", all: true }, { type: "scrape" }],
      location: { country: "DE", languages: ["de", "en"] },
      mobile: true,
      proxy: "stealth",
      maxAge: 3600000,
      lockdown: true,
      redactPII: { mode: "aggressive" },
      onlyMainContent: false,
      includeTags: ["main"],
      excludeTags: ["nav", "footer"],
      waitFor: 500,
      timeout: 30000,
    });
  });

  it("omits defaults so the minimal body stays minimal", () => {
    expect(buildBody("scrape", DEFAULT_FORM)).toEqual({ url: "https://example.com", formats: ["markdown"] });
    expect(buildBody("map", { ...DEFAULT_FORM, limit: "" })).toEqual({ url: "https://example.com" });
  });

  it("builds crawl, batch, search, extract and agent bodies", () => {
    expect(buildBody("crawl", { ...DEFAULT_FORM, limit: "10", includePaths: "^/blog", webhookUrl: "https://hook.test" })).toMatchObject({
      url: "https://example.com",
      limit: 10,
      includePaths: ["^/blog"],
      webhook: "https://hook.test",
      scrapeOptions: { formats: ["markdown"] },
    });
    expect(buildBody("batch_scrape", DEFAULT_FORM)).toMatchObject({ urls: ["https://example.com", "https://example.org"] });
    expect(buildBody("search", { ...DEFAULT_FORM, sources: ["web", "news"], searchScrape: true })).toMatchObject({
      query: "firecrawl self-hosted",
      sources: ["web", "news"],
      scrapeOptions: { formats: ["markdown"] },
    });
    expect(buildBody("extract", DEFAULT_FORM)).toMatchObject({ urls: ["https://example.com", "https://example.org"], schema: { required: ["title"] } });
    expect(buildBody("agent", { ...DEFAULT_FORM, maxCredits: "50", effort: "high" })).toMatchObject({ maxCredits: 50, effort: "high" });
  });

  it("turns builder fields into a JSON Schema", () => {
    expect(
      schemaFromFields([
        { name: "tags", type: "array", required: true, description: "labels" },
        { name: "", type: "string", required: true, description: "" },
      ]),
    ).toEqual({ type: "object", properties: { tags: { type: "array", items: { type: "string" }, description: "labels" } }, required: ["tags"] });
  });

  it("renders copyable curl, Python and JavaScript without a real key", () => {
    const code = snippets("scrape", { url: "https://example.com", formats: ["markdown"], onlyMainContent: false }, "https://api.example.test");
    expect(code.curl).toContain("https://api.example.test/v2/scrape");
    expect(code.curl).toContain("$FIRECRAWL_API_KEY");
    expect(code.python).toContain('firecrawl.scrape("https://example.com", formats=["markdown"], only_main_content=False)');
    expect(code.javascript).toContain('firecrawl.scrape("https://example.com"');
    expect(snippets("batch_scrape", { urls: ["a"] }, "x").javascript).toContain("batchScrape");
  });
});

describe("diff viewer", () => {
  it("classifies unified diff lines", () => {
    expect(diffLines("@@ -1 +1 @@\n-old\n+new\n same").map((line) => line.kind)).toEqual(["hunk", "del", "add", "ctx"]);
  });
});

describe("agent backend availability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps 501, 503 and 'not enabled' answers to unavailable, but not a missing run", async () => {
    const { isAgentUnavailable } = await import("@/lib/server/agent");
    expect(isAgentUnavailable(new FirecrawlApiError(501, "Not implemented"))).toBe(true);
    expect(isAgentUnavailable(new FirecrawlApiError(500, "Agent beta is not enabled."))).toBe(true);
    expect(isAgentUnavailable(new FirecrawlApiError(404, "Cannot POST /v2/agent"))).toBe(true);
    expect(isAgentUnavailable(new FirecrawlApiError(404, "Agent job not found"))).toBe(false);
    expect(isAgentUnavailable(new FirecrawlApiError(402, "Insufficient credits"))).toBe(false);
    // A generic 500 means "not available" only when no agent service is configured.
    expect(isAgentUnavailable(new FirecrawlApiError(500, "An unexpected error occurred."), false)).toBe(true);
    expect(isAgentUnavailable(new FirecrawlApiError(500, "An unexpected error occurred."), true)).toBe(false);
  });

  it("turns a mocked 501 from POST /v2/agent into AgentUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false, error: "Agent listing is not configured" }), { status: 501 })),
    );
    vi.resetModules();
    vi.doMock("@/lib/server/acting-key", () => ({ actingKey: async () => ({ id: 1, key: "fc-test", teamId: "t" }) }));
    vi.doMock("@/lib/server/audit", () => ({ audit: async () => undefined }));
    const agent = await import("@/lib/server/agent");
    await expect(
      agent.startAgent({ userId: "u", email: "e", name: "n", role: "member", teamId: "t", twoFactorEnabled: false }, { prompt: "hi" }),
    ).rejects.toBeInstanceOf(agent.AgentUnavailableError);
    vi.doUnmock("@/lib/server/acting-key");
    vi.doUnmock("@/lib/server/audit");
  });
});
