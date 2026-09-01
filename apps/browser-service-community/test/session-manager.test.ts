import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserServiceError,
  SessionManager,
  type BrowserRuntime,
  type BrowserRuntimeFactory,
} from "../src/session-manager.js";

class FakeRuntime implements BrowserRuntime {
  readonly internalCdpUrl = "ws://127.0.0.1:9222/devtools/browser/fake";
  readonly calls: string[] = [];
  closeCalls = 0;

  async execute(language: string, code: string) {
    this.calls.push(`${language}:${code}`);
    await new Promise(resolve => setTimeout(resolve, code === "first" ? 15 : 1));
    return { stdout: code, result: JSON.stringify(code), stderr: "", exitCode: 0, killed: false };
  }

  async close() {
    this.closeCalls += 1;
  }
}

function factoryWith(runtime: FakeRuntime): BrowserRuntimeFactory {
  return async () => runtime;
}

test("create, serialized execute, and idempotent delete release one slot", async () => {
  const runtime = new FakeRuntime();
  const manager = new SessionManager({
    maxSessions: 1,
    publicUrl: "http://browser-service:3006",
    runtimeFactory: factoryWith(runtime),
  });

  const created = await manager.create({ ttl: 60, activityTtl: 30, record: false });
  assert.match(created.cdpUrl, new RegExp(`/cdp/${created.sessionId}\\?token=`));

  const first = manager.execute(created.sessionId, { language: "node", code: "first", timeout: 5 });
  const second = manager.execute(created.sessionId, { language: "bash", code: "second", timeout: 5 });
  assert.deepEqual((await first).stdout, "first");
  assert.deepEqual((await second).stdout, "second");
  assert.deepEqual(runtime.calls, ["node:first", "bash:second"]);

  const released = await manager.delete(created.sessionId);
  const repeated = await manager.delete(created.sessionId);
  assert.equal(released.ok, true);
  assert.deepEqual(repeated, released);
  assert.equal(runtime.closeCalls, 1);
  assert.equal(manager.activeCount, 0);
  await manager.close();
});

test("capacity and unknown sessions fail with stable HTTP semantics", async () => {
  const manager = new SessionManager({
    maxSessions: 1,
    publicUrl: "http://browser-service:3006",
    runtimeFactory: factoryWith(new FakeRuntime()),
  });
  await manager.create({ ttl: 60 });
  await assert.rejects(() => manager.create({ ttl: 60 }), (error: unknown) => {
    assert.ok(error instanceof BrowserServiceError);
    assert.equal(error.status, 429);
    return true;
  });
  await assert.rejects(
    () => manager.execute("missing", { language: "node", code: "1", timeout: 5 }),
    (error: unknown) => error instanceof BrowserServiceError && error.status === 404,
  );
  await manager.close();
});

test("expiry sweep closes inactive sessions and preserves an idempotency tombstone", async () => {
  let now = 10_000;
  const runtime = new FakeRuntime();
  const manager = new SessionManager({
    maxSessions: 1,
    publicUrl: "http://browser-service:3006",
    runtimeFactory: factoryWith(runtime),
    now: () => now,
  });
  const created = await manager.create({ ttl: 60, activityTtl: 10 });
  now += 10_001;
  await manager.sweepExpired();
  assert.equal(manager.activeCount, 0);
  assert.equal(runtime.closeCalls, 1);
  assert.equal((await manager.delete(created.sessionId)).ok, true);
  await manager.close();
});
