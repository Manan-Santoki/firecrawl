import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createApp } from "../src/server.js";
import { SessionManager, type BrowserRuntime } from "../src/session-manager.js";

class FakeRuntime implements BrowserRuntime {
  readonly internalCdpUrl = "ws://127.0.0.1:9222/devtools/browser/fake";
  async execute(_language: string, code: string) {
    return { stdout: code, result: "null", stderr: "", exitCode: 0, killed: false };
  }
  async close() {}
}

async function fixture() {
  const manager = new SessionManager({
    maxSessions: 2,
    publicUrl: "http://127.0.0.1",
    runtimeFactory: async () => new FakeRuntime(),
  });
  const server = http.createServer(createApp({ manager, apiKey: "test-browser-key" }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    manager,
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await manager.close();
      server.close();
      await once(server, "close");
    },
  };
}

test("health is public while browser lifecycle requires bearer authentication", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.url}/health/liveness`)).status, 200);
    assert.equal(
      (await fetch(`${app.url}/browsers`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
      401,
    );

    const createdResponse = await fetch(`${app.url}/browsers`, {
      method: "POST",
      headers: { authorization: "Bearer test-browser-key", "content-type": "application/json" },
      body: JSON.stringify({ ttl: 60, activityTtl: 30 }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { sessionId: string };

    const execResponse = await fetch(`${app.url}/browsers/${created.sessionId}/exec`, {
      method: "POST",
      headers: { authorization: "Bearer test-browser-key", "content-type": "application/json" },
      body: JSON.stringify({ language: "node", code: "hello", timeout: 5 }),
    });
    assert.equal(execResponse.status, 200);
    assert.equal(((await execResponse.json()) as { stdout: string }).stdout, "hello");

    const firstDelete = await fetch(`${app.url}/browsers/${created.sessionId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-browser-key" },
    });
    const secondDelete = await fetch(`${app.url}/browsers/${created.sessionId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-browser-key" },
    });
    assert.equal(firstDelete.status, 200);
    assert.equal(secondDelete.status, 200);
    assert.deepEqual(await secondDelete.json(), await firstDelete.json());
  } finally {
    await app.close();
  }
});

test("invalid payloads and missing sessions return 400 and 404", async () => {
  const app = await fixture();
  const headers = { authorization: "Bearer test-browser-key", "content-type": "application/json" };
  try {
    const invalid = await fetch(`${app.url}/browsers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ttl: 1 }),
    });
    assert.equal(invalid.status, 400);

    const missing = await fetch(`${app.url}/browsers/missing/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ language: "node", code: "1", timeout: 5 }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});
