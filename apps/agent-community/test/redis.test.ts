/**
 * Runs against a real Redis when AGENT_TEST_REDIS_URL is set (CI provides one).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { RedisKV } from "../src/kv.js";
import { JobStore } from "../src/store.js";
import { makeGateway, pollTerminal } from "./gateway.js";
import { firecrawlHandler, makeConfig, SECRET, startMock, startService, TEAM, textReply, toolCallReply, toolResults } from "./helpers.js";

const url = process.env.AGENT_TEST_REDIS_URL;

describe("redis-backed store", { skip: !url && "AGENT_TEST_REDIS_URL not set" }, () => {
  it("persists runs, threads and traces in Redis", async () => {
    const prefix = `agent-test-${randomUUID()}`;
    const llm = await startMock(r => {
      if (!r.body.tools) return textReply(JSON.stringify({ ok: true }));
      return toolResults(r.body).length === 0
        ? toolCallReply([{ name: "scrape", args: { url: "https://example.com/" } }])
        : textReply("done");
    });
    const fc = await startMock(firecrawlHandler());
    const kv = new RedisKV(url!);
    const svc = await startService(makeConfig({ llmUrl: llm.url, firecrawlUrl: fc.url }), kv, prefix);
    try {
      const gw = makeGateway(svc.url, SECRET);
      const start = await gw.start({ teamId: TEAM, prompt: "redis run" });
      const status = await pollTerminal(gw, start.id);
      assert.equal(status.status, "success");
      assert.deepEqual(status.data, { ok: true });

      const other = new JobStore(new RedisKV(url!), { prefix, resultTtlSeconds: 60, threadTtlSeconds: 60 });
      const stored = await other.getRun(start.id);
      assert.equal(stored?.state, "succeeded");
      assert.equal(stored?.apiKey, undefined);
      assert.ok((await other.getEvents(start.id)).length >= 3);
      assert.deepEqual((await other.getThread(start.body.threadId))?.runIds, [start.id]);
      await other.kv.close();
    } finally {
      await svc.close();
      await kv.close();
      await Promise.all([llm.close(), fc.close()]);
    }
  });

  it("fails runs orphaned by a crashed worker", async () => {
    const prefix = `agent-test-${randomUUID()}`;
    const kv = new RedisKV(url!);
    const store = new JobStore(kv, { prefix, resultTtlSeconds: 60, threadTtlSeconds: 60 });
    const id = randomUUID();
    await store.createRun({
      id,
      teamId: TEAM,
      threadId: randomUUID(),
      threadTurn: 1,
      mode: "extract",
      prompt: "orphan",
      model: "spark-2",
      maxCredits: 10,
      state: "processing",
      createdAt: new Date().toISOString(),
      creditsUsed: 0,
      firecrawlCredits: 0,
      tokensUsed: 0,
      steps: 0,
      sources: [],
    });
    await kv.zadd(`${prefix}:active`, Date.now() - 120_000, id);
    const svc = await startService(makeConfig({ llmUrl: "http://127.0.0.1:9", firecrawlUrl: "http://127.0.0.1:9" }), new RedisKV(url!), prefix);
    try {
      await svc.runner.recoverStale();
      const run = await store.getRun(id);
      assert.equal(run?.state, "failed");
      assert.match(run!.error!, /service restart/);
    } finally {
      await svc.close();
      await kv.close();
    }
  });
});
