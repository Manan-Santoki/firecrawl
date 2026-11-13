import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentServiceConfig } from "../src/config.js";
import { MemoryKV, type KV } from "../src/kv.js";
import { silentLogger } from "../src/logger.js";
import { AgentRunner } from "../src/runner.js";
import { createApp } from "../src/server.js";
import { defaultSkillsDir, loadSkills } from "../src/skills.js";
import { JobStore } from "../src/store.js";

export const SECRET = "test-interop-secret-0123456789";
export const TEAM = "22222222-2222-4222-8222-222222222222";

export type Recorded = { method: string; path: string; headers: IncomingMessage["headers"]; body: any };

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

export type MockReply = { status?: number; json: unknown; delayMs?: number };

export async function startMock(
  handler: (req: Recorded) => MockReply | Promise<MockReply>,
  bindHost = "127.0.0.1",
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server: Server = createServer(async (req, res) => {
    const rec: Recorded = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: await readBody(req) };
    requests.push(rec);
    try {
      const reply = await handler(rec);
      if (reply.delayMs) await new Promise(r => setTimeout(r, reply.delayMs));
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.json));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(r => server.listen(0, bindHost, r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** OpenAI Chat Completions response helpers. */
export function toolCallReply(calls: { name: string; args: unknown }[], tokens = 100): MockReply {
  return {
    json: {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((c, i) => ({
              id: `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
        },
      ],
      usage: { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10 },
    },
  };
}

export function textReply(content: string, tokens = 100): MockReply {
  return {
    json: {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10 },
    },
  };
}

/** Count tool results already in the conversation, to script multi-step runs. */
export function toolResults(body: any): string[] {
  return (body?.messages ?? []).filter((m: any) => m.role === "tool").map((m: any) => m.content as string);
}

/** A Firecrawl API double with the v2 response shapes the service reads. */
export function firecrawlHandler(overrides: Partial<Record<string, (r: Recorded) => MockReply>> = {}) {
  return (r: Recorded): MockReply => {
    const key = `${r.method} ${r.path.replace(/\/v2\/scrape\/[^/]+\/interact/, "/v2/scrape/:id/interact")}`;
    const o = overrides[key];
    if (o) return o(r);
    switch (key) {
      case "POST /v2/search":
        return {
          json: {
            success: true,
            id: "search-1",
            creditsUsed: 2,
            data: {
              web: [
                { url: "https://example.com/pricing", title: "Example pricing", description: "Plans and prices" },
                { url: "https://example.com/about", title: "About", description: "About us" },
              ],
            },
          },
        };
      case "POST /v2/scrape":
        return {
          json: {
            success: true,
            data: {
              markdown: `# Page ${r.body.url}\nPro plan costs $20 per month. Founded in 2019.`,
              metadata: { sourceURL: r.body.url, title: "Example", statusCode: 200, scrapeId: "scrape-123", creditsUsed: 1 },
            },
          },
        };
      case "POST /v2/map":
        return { json: { success: true, id: "map-1", links: [{ url: "https://example.com/pricing" }, { url: "https://other.com/x" }] } };
      default:
        return { status: 404, json: { success: false, error: `unmocked ${key}` } };
    }
  };
}

export function makeConfig(overrides: {
  llmUrl: string;
  firecrawlUrl: string;
  limits?: Partial<AgentServiceConfig["limits"]>;
  firecrawl?: Partial<AgentServiceConfig["firecrawl"]>;
  llm?: Partial<AgentServiceConfig["llm"]>;
  allowLocalWebhooks?: boolean;
  webhookSecret?: string;
}): AgentServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    interopSecret: SECRET,
    redisUrl: undefined,
    store: "memory",
    redisPrefix: "test",
    llm: {
      baseUrl: overrides.llmUrl,
      apiKey: "sk-test",
      model: "test-model",
      timeoutMs: 10_000,
      temperature: 0,
      structuredOutput: "json_schema",
      ...overrides.llm,
    },
    firecrawl: {
      apiUrl: overrides.firecrawlUrl,
      apiKey: "fc-env-key",
      timeoutMs: 10_000,
      interop: false,
      enableInteract: false,
      ...overrides.firecrawl,
    },
    limits: {
      maxConcurrentRuns: 2,
      maxStepsOverride: 0,
      maxRuntimeMs: 30_000,
      maxTotalTokens: 400_000,
      defaultMaxCredits: 2500,
      creditsPer1kTokens: 0,
      maxToolResultChars: 12_000,
      mapCredits: 1,
      ...overrides.limits,
    },
    resultTtlSeconds: 3600,
    threadTtlSeconds: 3600,
    webhookSecret: overrides.webhookSecret,
    allowLocalWebhooks: overrides.allowLocalWebhooks ?? false,
    skillsDir: undefined,
    logLevel: "error",
  };
}

export async function startService(config: AgentServiceConfig, kv: KV = new MemoryKV(), prefix = "test") {
  const store = new JobStore(kv, { prefix, resultTtlSeconds: 3600, threadTtlSeconds: 3600 });
  const runner = new AgentRunner({ config, store, skills: loadSkills([defaultSkillsDir()]), logger: silentLogger });
  const app = createApp({ config, store, runner, logger: silentLogger });
  const server = await new Promise<Server>(r => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  runner.start(20);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    runner,
    close: async () => {
      await runner.stop();
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
      await kv.close();
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(r => setTimeout(r, 25));
  }
}
