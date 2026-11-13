/**
 * Optional live test against a real OpenAI-compatible model and a real
 * self-hosted Firecrawl API. Skipped unless every variable is set:
 *
 *   AGENT_LIVE_OPENAI_BASE_URL, AGENT_LIVE_MODEL, AGENT_LIVE_FIRECRAWL_API_URL
 *   (optional) AGENT_LIVE_OPENAI_API_KEY, AGENT_LIVE_FIRECRAWL_API_KEY,
 *              AGENT_LIVE_URL (page to extract from, default https://example.com)
 *
 * Firecrawl Cloud URLs are refused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFirecrawlCloudUrl } from "../../src/config.js";
import { makeGateway, pollTerminal } from "../gateway.js";
import { makeConfig, SECRET, startService, TEAM } from "../helpers.js";

const env = process.env;
const enabled = !!(env.AGENT_LIVE_OPENAI_BASE_URL && env.AGENT_LIVE_MODEL && env.AGENT_LIVE_FIRECRAWL_API_URL);

describe("live agent run", { skip: !enabled && "AGENT_LIVE_* variables not set" }, () => {
  it("extracts schema-shaped data from a real page", { timeout: 300_000 }, async () => {
    assert.ok(!isFirecrawlCloudUrl(env.AGENT_LIVE_FIRECRAWL_API_URL!), "refusing to call Firecrawl Cloud");
    const config = makeConfig({
      llmUrl: env.AGENT_LIVE_OPENAI_BASE_URL!.replace(/\/$/, ""),
      firecrawlUrl: env.AGENT_LIVE_FIRECRAWL_API_URL!.replace(/\/$/, ""),
      llm: { apiKey: env.AGENT_LIVE_OPENAI_API_KEY, model: env.AGENT_LIVE_MODEL!, timeoutMs: 120_000 },
      firecrawl: { apiKey: env.AGENT_LIVE_FIRECRAWL_API_KEY },
      limits: { maxRuntimeMs: 240_000 },
    });
    const svc = await startService(config);
    try {
      const gw = makeGateway(svc.url, SECRET);
      const url = env.AGENT_LIVE_URL ?? "https://example.com";
      const start = await gw.start({
        teamId: TEAM,
        prompt: `What is the main heading of ${url}?`,
        urls: [url],
        strictConstrainToURLs: true,
        effort: "low",
        apiKey: env.AGENT_LIVE_FIRECRAWL_API_KEY ?? "bypass",
        schema: {
          type: "object",
          properties: { heading: { type: "string" } },
          required: ["heading"],
        },
      });
      assert.equal(start.status, 200);
      const status = await pollTerminal(gw, start.id, 280_000);
      console.log(JSON.stringify(status, null, 2));
      assert.equal(status.status, "success", status.error);
      assert.equal(typeof status.data.heading, "string");
      assert.ok(status.creditsUsed >= 1);
    } finally {
      await svc.close();
    }
  });
});
