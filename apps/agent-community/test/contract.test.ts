import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { makeGateway, pollTerminal } from "./gateway.js";
import {
  firecrawlHandler,
  makeConfig,
  SECRET,
  startMock,
  startService,
  TEAM,
  textReply,
  toolCallReply,
  toolResults,
  waitFor,
  type MockReply,
  type Recorded,
} from "./helpers.js";

const PRICING_SCHEMA = {
  type: "object",
  properties: {
    plan: { type: "string" },
    monthlyPrice: { type: "number" },
    source: { type: "string" },
  },
  required: ["plan", "monthlyPrice", "source"],
  additionalProperties: false,
};

/** search -> scrape -> answer; JSON when asked to finalize. */
function researchScript(r: Recorded): MockReply {
  const body = r.body;
  if (!body.tools) {
    const last = JSON.stringify(body.messages.at(-1));
    if (last.includes("Answer the task now")) return textReply("Pro costs $20/month (https://example.com/pricing)");
    return textReply(JSON.stringify({ plan: "Pro", monthlyPrice: 20, source: "https://example.com/pricing" }));
  }
  const done = toolResults(body).length;
  if (done === 0) return toolCallReply([{ name: "search", args: { query: "example pricing", limit: 2 } }]);
  if (done === 1) return toolCallReply([{ name: "scrape", args: { url: "https://example.com/pricing" } }]);
  return textReply("The Pro plan costs $20 per month. Source: https://example.com/pricing");
}

describe("EXTRACT_V3_BETA_URL contract (upstream v2.11.739)", () => {
  let llm: Awaited<ReturnType<typeof startMock>>;
  let fc: Awaited<ReturnType<typeof startMock>>;
  let svc: Awaited<ReturnType<typeof startService>>;
  let gw: ReturnType<typeof makeGateway>;
  let llmScript: (r: Recorded) => MockReply | Promise<MockReply> = researchScript;

  before(async () => {
    llm = await startMock(r => llmScript(r));
    fc = await startMock(firecrawlHandler());
    svc = await startService(makeConfig({ llmUrl: llm.url, firecrawlUrl: fc.url }));
    gw = makeGateway(svc.url, SECRET);
  });
  after(async () => {
    await svc.close();
    await llm.close();
    await fc.close();
  });

  it("rejects calls without the interop secret", async () => {
    const res = await fetch(`${svc.url}/internal/extracts/abc`, { headers: { Authorization: "Bearer wrong-secret" } });
    assert.equal(res.status, 401);
    const none = await fetch(`${svc.url}/internal/recent-agents-for-team?teamId=${TEAM}`);
    assert.equal(none.status, 401);
  });

  it("runs a schema-constrained extract end to end", async () => {
    llmScript = researchScript;
    const start = await gw.start({ teamId: TEAM, prompt: "Find the Pro plan price", schema: PRICING_SCHEMA, effort: "low" });
    assert.equal(start.status, 200);
    assert.match(start.body.threadId, /^[0-9a-f-]{36}$/);
    assert.equal(start.body.threadTurn, 1);

    const status = await pollTerminal(gw, start.id);
    assert.equal(status.success, true);
    assert.equal(status.id, start.id);
    assert.equal(status.status, "success");
    assert.deepEqual(status.data, { plan: "Pro", monthlyPrice: 20, source: "https://example.com/pricing" });
    assert.equal(status.model, "spark-2");
    assert.equal(status.effort, "low");
    assert.equal(status.mode, "extract");
    assert.equal(status.threadId, start.body.threadId);
    assert.equal(status.threadTurn, 1);
    assert.equal(status.creditsUsed, 3, "2 search credits + 1 scrape credit");
    assert.ok(!Number.isNaN(Date.parse(status.completedAt)));
    assert.equal(status.teamId, TEAM);
    assert.equal(status.error, undefined);

    // Tool calls hit the operator's Firecrawl API with the caller's key.
    const search = fc.requests.find(r => r.path === "/v2/search")!;
    assert.equal(search.headers.authorization, "Bearer fc-team-key");
    assert.equal(search.body.query, "example pricing");
    assert.equal(search.body.__agentInterop, undefined, "interop is opt-in");
    const scrape = fc.requests.find(r => r.path === "/v2/scrape")!;
    assert.deepEqual(scrape.body.formats, ["markdown"]);

    // The model saw the JSON schema and was asked for structured output.
    const finalize = llm.requests.at(-1)!.body;
    assert.equal(finalize.response_format.type, "json_schema");
    assert.deepEqual(finalize.response_format.json_schema.schema, PRICING_SCHEMA);
    assert.equal(llm.requests[0]!.headers.authorization, "Bearer sk-test");
    assert.equal(llm.requests[0]!.body.model, "test-model");

    // Trace, snapshot, skill.
    const trace = await gw.trace(start.id);
    assert.equal(trace.status, 200);
    assert.equal(trace.body.success, true);
    assert.equal(trace.body.creditsUsed, 3);
    const types = trace.body.events.map((e: any) => e.type);
    assert.deepEqual([types[0], types.at(-1)], ["started", "completed"]);
    const scraped = trace.body.events.find((e: any) => e.type === "tool_result" && e.snapshotId);
    assert.ok(scraped, "scrape result carries a snapshot id");

    const snap = await gw.snapshot(start.id, scraped.snapshotId, TEAM);
    assert.equal(snap.status, 200);
    assert.match(snap.body.snapshot, /Pro plan costs \$20/);
    assert.equal((await gw.snapshot(start.id, scraped.snapshotId, "other-team")).status, 404);

    const skill = await gw.skill(start.id);
    assert.equal(skill.status, 200);
    assert.equal(skill.body.success, true);
    assert.equal(skill.body.generated, true);
    for (const k of ["name", "spec", "skillMd", "workflow", "schema"]) assert.ok(k in skill.body.skill, k);
    assert.ok(skill.body.blueprint);
    assert.equal((await gw.skill(start.id)).body.generated, false);
    assert.equal((await gw.skill(start.id, true)).body.generated, true);

    const recent = await gw.recent(TEAM);
    assert.equal(recent.status, 200);
    const listed = recent.body.find((a: any) => a.id === start.id);
    assert.equal(listed.status, "succeeded");
    assert.equal(listed.options.prompt, "Find the Pro plan price");
    assert.equal(listed.options.modelPreset, "spark-2");

    const legacy = await gw.legacyOptions(start.id);
    assert.equal(legacy.body.model, "spark-2");
  });

  it("is idempotent on the run id and 404s unknown ids", async () => {
    llmScript = researchScript;
    const first = await gw.start({ teamId: TEAM, prompt: "Find the Pro plan price", schema: PRICING_SCHEMA });
    const again = await gw.start({ id: first.id, teamId: TEAM, prompt: "Find the Pro plan price" });
    assert.equal(again.status, 200);
    assert.equal(again.body.threadId, first.body.threadId);
    await pollTerminal(gw, first.id);
    const missing = await gw.status("0197a000-0000-7000-8000-000000000000");
    assert.equal(missing.status, 404);
  });

  it("continues a thread with prior turns as context", async () => {
    llmScript = researchScript;
    const one = await gw.start({ teamId: TEAM, prompt: "Find the Pro plan price", mode: "chat" });
    const s1 = await pollTerminal(gw, one.id);
    assert.equal(s1.status, "success");
    assert.equal(s1.mode, "chat");
    assert.match(s1.message, /\$20/);

    // Busy thread: hold the next turn open with a slow model.
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    llmScript = async r => {
      await gate;
      return researchScript(r);
    };
    const two = await gw.start({ teamId: TEAM, prompt: "And the annual price?", threadId: one.body.threadId });
    assert.equal(two.status, 200);
    assert.equal(two.body.threadId, one.body.threadId);
    assert.equal(two.body.threadTurn, 2);

    const busy = await gw.start({ teamId: TEAM, prompt: "third", threadId: one.body.threadId });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.runId, two.id);
    const running = await gw.thread(one.body.threadId, TEAM);
    assert.equal(running.body.thread.status, "running");

    release();
    const s2 = await pollTerminal(gw, two.id);
    assert.equal(s2.status, "success");
    assert.equal(s2.mode, "chat", "mode is inherited from the previous turn");
    const sawHistory = llm.requests.some(r => JSON.stringify(r.body.messages).includes("And the annual price?") && JSON.stringify(r.body.messages).includes("Find the Pro plan price"));
    assert.ok(sawHistory, "turn 2 prompt includes turn 1");

    const thread = await gw.thread(one.body.threadId, TEAM, { includeData: true });
    assert.equal(thread.status, 200);
    assert.equal(thread.body.thread.id, one.body.threadId);
    assert.equal(thread.body.thread.status, "idle");
    assert.deepEqual(thread.body.thread.runs.map((r: any) => [r.turn, r.status]), [[1, "succeeded"], [2, "succeeded"]]);
    assert.ok("data" in thread.body.thread.runs[0]);

    assert.equal((await gw.thread(one.body.threadId, "another-team")).status, 404);
    assert.equal((await gw.thread("00000000-0000-4000-8000-000000000000", TEAM)).status, 404);
    const foreign = await gw.start({ teamId: "another-team", prompt: "x", threadId: one.body.threadId });
    assert.equal(foreign.status, 404);
  });

  it("cancels a running run and reports 409 afterwards", async () => {
    llmScript = r => ({ ...researchScript(r), delayMs: 5_000 });
    const start = await gw.start({ teamId: TEAM, prompt: "slow" });
    await waitFor(async () => (await svc.store.getRun(start.id))?.state === "processing");
    const cancel = await gw.cancel(start.id);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.success, true);
    const status = await pollTerminal(gw, start.id);
    assert.equal(status.status, "failed");
    assert.match(status.error, /cancelled/);
    const again = await gw.cancel(start.id);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "Agent is already cancelled");

    llmScript = researchScript;
    const done = await gw.start({ teamId: TEAM, prompt: "quick" });
    await pollTerminal(gw, done.id);
    const late = await gw.cancel(done.id);
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "Agent already finished");
  });

  it("stops at maxCredits with stopReason and a partial result", async () => {
    llmScript = researchScript;
    const start = await gw.start({ teamId: TEAM, prompt: "Find the Pro plan price", schema: PRICING_SCHEMA, maxCredits: 2 });
    const status = await pollTerminal(gw, start.id);
    assert.equal(status.status, "failed");
    assert.equal(status.stopReason, "credit_limit_reached");
    assert.equal(status.creditsUsed, 2);
    assert.deepEqual(status.partial, { plan: "Pro", monthlyPrice: 20, source: "https://example.com/pricing" });
    assert.equal(status.partialSchemaValid, true);
    assert.equal(status.data, undefined);
    const recent = await gw.recent(TEAM);
    assert.equal(recent.body.find((a: any) => a.id === start.id).status, "credit_limit_reached");
  });

  it("enforces strictConstrainToURLs", async () => {
    llmScript = r => {
      if (!r.body.tools) return textReply(JSON.stringify({ ok: true }));
      const done = toolResults(r.body).length;
      if (done === 0) return toolCallReply([{ name: "scrape", args: { url: "https://evil.example.net/" } }]);
      if (done === 1) return toolCallReply([{ name: "scrape", args: { url: "https://docs.example.com/guide/intro" } }]);
      return textReply("done");
    };
    const before = fc.requests.length;
    const llmBefore = llm.requests.length;
    const start = await gw.start({
      teamId: TEAM,
      prompt: "Summarize the guide",
      urls: ["https://docs.example.com/guide"],
      strictConstrainToURLs: true,
    });
    const status = await pollTerminal(gw, start.id);
    assert.equal(status.status, "success");
    const offered = llm.requests.slice(llmBefore).find(r => r.body.tools)!.body.tools.map((t: any) => t.function.name);
    assert.ok(!offered.includes("search"));
    const scraped = fc.requests.slice(before).filter(r => r.path === "/v2/scrape").map(r => r.body.url);
    assert.deepEqual(scraped, ["https://docs.example.com/guide/intro"]);
    const toolMsgs = toolResults(llm.requests.at(-2)!.body);
    assert.match(toolMsgs[0]!, /URL not allowed/);
  });

  it("fails with a schema-invalid partial when the model never satisfies the schema", async () => {
    llmScript = r => {
      if (!r.body.tools) return textReply(JSON.stringify({ plan: "Pro", monthlyPrice: "twenty", source: "x" }));
      return textReply("nothing to do");
    };
    const start = await gw.start({ teamId: TEAM, prompt: "Find the price", schema: PRICING_SCHEMA });
    const status = await pollTerminal(gw, start.id);
    assert.equal(status.status, "failed");
    assert.match(status.error, /did not match the requested schema/);
    assert.equal(status.partialSchemaValid, false);
    assert.equal(status.partial.monthlyPrice, "twenty");
  });

  it("falls back to json_object when the provider rejects json_schema", async () => {
    llmScript = r => {
      if (r.body.response_format?.type === "json_schema") return { status: 400, json: { error: { message: "unsupported response_format" } } };
      if (!r.body.tools) return textReply(JSON.stringify({ plan: "Pro", monthlyPrice: 20, source: "https://example.com/pricing" }));
      return textReply("Pro is $20");
    };
    const start = await gw.start({ teamId: TEAM, prompt: "Find the price", schema: PRICING_SCHEMA });
    const status = await pollTerminal(gw, start.id);
    assert.equal(status.status, "success");
    assert.equal(llm.requests.at(-1)!.body.response_format.type, "json_object");
  });

  it("reports model endpoint errors as a failed run", async () => {
    llmScript = () => ({ status: 401, json: { error: { message: "bad key" } } });
    const start = await gw.start({ teamId: TEAM, prompt: "anything" });
    const status = await pollTerminal(gw, start.id);
    assert.equal(status.status, "failed");
    assert.match(status.error, /Model request failed: Model endpoint returned 401/);
  });

  it("keeps zero data retention runs content-free", async () => {
    llmScript = researchScript;
    const start = await gw.start({ teamId: TEAM, prompt: "secret prompt", zeroDataRetention: true, zeroDataRetentionMinutes: 5 });
    const status = await pollTerminal(gw, start.id);
    assert.equal(status.status, "success");
    const trace = await gw.trace(start.id);
    assert.equal(trace.body.zeroDataRetention, true);
    for (const e of trace.body.events) {
      assert.ok(["started", "model_step", "completed"].includes(e.type), e.type);
      assert.ok(!JSON.stringify(e).includes("example.com"));
    }
    const recent = await gw.recent(TEAM);
    const listed = recent.body.find((a: any) => a.id === start.id);
    assert.equal(listed.options.prompt, undefined);
    assert.equal(listed.options.zeroDataRetention, true);
    const threadStart = await gw.start({ teamId: TEAM, prompt: "x", zeroDataRetention: true, threadId: status.threadId });
    assert.equal(threadStart.status, 400);
  });

  it("rejects an invalid JSON schema", async () => {
    const res = await gw.start({ teamId: TEAM, prompt: "x", schema: { type: "not-a-type" } });
    assert.equal(res.status, 400);
  });
});

describe("webhooks and Firecrawl interop", () => {
  it("delivers signed agent.* webhooks and tags tool calls with __agentInterop", async () => {
    const hooks = await startMock(() => ({ json: { ok: true } }));
    const llm = await startMock(researchScript);
    const fc = await startMock(firecrawlHandler());
    const svc = await startService(
      makeConfig({
        llmUrl: llm.url,
        firecrawlUrl: fc.url,
        allowLocalWebhooks: true,
        webhookSecret: "whsec-test",
        firecrawl: { interop: true },
      }),
    );
    try {
      const gw = makeGateway(svc.url, SECRET);
      const start = await gw.start({
        teamId: TEAM,
        prompt: "Find the Pro plan price",
        schema: PRICING_SCHEMA,
        apiKey: "bypass",
        webhook: { url: `${hooks.url}/hook`, headers: { "x-custom": "1" }, metadata: { run: "a" }, events: ["started", "completed"] },
      });
      await pollTerminal(gw, start.id);
      await waitFor(async () => hooks.requests.length >= 2);
      const types = hooks.requests.map(r => r.body.type);
      assert.deepEqual(types, ["agent.started", "agent.completed"]);
      const completed = hooks.requests[1]!;
      assert.equal(completed.body.id, start.id);
      assert.deepEqual(completed.body.metadata, { run: "a" });
      assert.equal(completed.body.data.monthlyPrice, 20);
      assert.equal(completed.headers["x-custom"], "1");
      const raw = JSON.stringify(completed.body);
      const expected = `sha256=${createHmac("sha256", "whsec-test").update(raw).digest("hex")}`;
      assert.equal(completed.headers["x-firecrawl-signature"], expected);

      // "bypass" (self-host without DB auth) falls back to FIRECRAWL_API_KEY.
      const scrape = fc.requests.find(r => r.path === "/v2/scrape")!;
      assert.equal(scrape.headers.authorization, "Bearer fc-env-key");
      assert.deepEqual(scrape.body.__agentInterop, { auth: SECRET, requestId: start.id, shouldBill: false });
      assert.equal(fc.requests.find(r => r.path === "/v2/search")!.body.__agentInterop.requestId, start.id);
    } finally {
      await svc.close();
      await Promise.all([hooks.close(), llm.close(), fc.close()]);
    }
  });

  it("refuses private webhook targets by default", async () => {
    const hooks = await startMock(() => ({ json: { ok: true } }));
    const llm = await startMock(researchScript);
    const fc = await startMock(firecrawlHandler());
    const svc = await startService(makeConfig({ llmUrl: llm.url, firecrawlUrl: fc.url }));
    try {
      const gw = makeGateway(svc.url, SECRET);
      const start = await gw.start({ teamId: TEAM, prompt: "x", webhook: { url: `${hooks.url}/hook` } });
      await pollTerminal(gw, start.id);
      await new Promise(r => setTimeout(r, 100));
      assert.equal(hooks.requests.length, 0);
    } finally {
      await svc.close();
      await Promise.all([hooks.close(), llm.close(), fc.close()]);
    }
  });
});

describe("bounds", () => {
  it("finalizes after the step budget instead of looping forever", async () => {
    const llm = await startMock(r =>
      r.body.tools ? toolCallReply([{ name: "map", args: { url: "https://example.com" } }]) : textReply(JSON.stringify({ links: 1 })),
    );
    const fc = await startMock(firecrawlHandler());
    const svc = await startService(makeConfig({ llmUrl: llm.url, firecrawlUrl: fc.url, limits: { maxStepsOverride: 3 } }));
    try {
      const gw = makeGateway(svc.url, SECRET);
      const start = await gw.start({ teamId: TEAM, prompt: "map it" });
      const status = await pollTerminal(gw, start.id);
      assert.equal(status.status, "success");
      assert.equal(llm.requests.filter(r => r.body.tools).length, 3);
      assert.equal(status.creditsUsed, 3);
    } finally {
      await svc.close();
      await Promise.all([llm.close(), fc.close()]);
    }
  });

  it("fails a run that exceeds its wall-clock limit", async () => {
    const llm = await startMock(r => (r.body.tools ? { ...textReply("late"), delayMs: 3_000 } : textReply("{}")));
    const fc = await startMock(firecrawlHandler());
    const svc = await startService(makeConfig({ llmUrl: llm.url, firecrawlUrl: fc.url, limits: { maxRuntimeMs: 300 } }));
    try {
      const gw = makeGateway(svc.url, SECRET);
      const start = await gw.start({ teamId: TEAM, prompt: "slow" });
      const status = await pollTerminal(gw, start.id);
      assert.equal(status.status, "failed");
      assert.match(status.error, /time limit/);
    } finally {
      await svc.close();
      await Promise.all([llm.close(), fc.close()]);
    }
  });

  it("limits concurrent runs and queues the rest", async () => {
    let inFlight = 0;
    let peak = 0;
    const llm = await startMock(async r => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(res => setTimeout(res, 150));
      inFlight--;
      return r.body.tools ? textReply("done") : textReply("{}");
    });
    const fc = await startMock(firecrawlHandler());
    const svc = await startService(makeConfig({ llmUrl: llm.url, firecrawlUrl: fc.url, limits: { maxConcurrentRuns: 1 } }));
    try {
      const gw = makeGateway(svc.url, SECRET);
      const runs = await Promise.all([1, 2, 3].map(i => gw.start({ teamId: TEAM, prompt: `q${i}` })));
      for (const r of runs) assert.equal((await pollTerminal(gw, r.id)).status, "success");
      assert.equal(peak, 1);
    } finally {
      await svc.close();
      await Promise.all([llm.close(), fc.close()]);
    }
  });
});
