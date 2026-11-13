import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { OpenAICompatibleEmbedder } from "../src/embeddings.js";
import { GcsIndexStore } from "../src/index-store.js";
import { createApp } from "../src/server.js";
import { apiClient, contractCases } from "./contract-cases.mjs";
import { INDEX_BUCKET, PAGE_MARKDOWN, startFakeEmbeddings, startFakeGcs } from "./fakes.mjs";

const TOKEN = "contract-highlight-token";

async function startService(env: Record<string, string>) {
  const config = loadConfig({ HIGHLIGHT_SERVICE_TOKEN: TOKEN, ...env });
  const server = http.createServer(
    createApp({
      config,
      embedder: config.embeddings ? new OpenAICompatibleEmbedder(config.embeddings) : null,
      indexStore: config.indexStore ? new GcsIndexStore(config.indexStore) : null,
      log: () => undefined,
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

const modes = [
  { mode: "hybrid", embeddings: {} },
  { mode: "bm25", embeddings: null },
  { mode: "degraded", embeddings: { failWith: 503 } },
] as const;

for (const { mode, embeddings } of modes) {
  for (const indexed of [true, false]) {
    test(`contract: ${mode} ranking, indexed endpoint ${indexed ? "configured" : "unconfigured"}`, async t => {
      const fakeEmbeddings = embeddings ? await startFakeEmbeddings({ ...embeddings, apiKey: "embed-key" }) : null;
      const fakeGcs = await startFakeGcs({ token: "gcs-token" });
      const service = await startService({
        ...(fakeEmbeddings
          ? { EMBEDDINGS_BASE_URL: fakeEmbeddings.url, EMBEDDINGS_MODEL: "fake-embed", EMBEDDINGS_API_KEY: "embed-key" }
          : {}),
        ...(indexed
          ? { GCS_INDEX_BUCKET_NAME: INDEX_BUCKET, GCS_STORAGE_ENDPOINT: fakeGcs.url, GCS_STORAGE_TOKEN: "gcs-token" }
          : {}),
      });
      try {
        for (const testCase of contractCases({ baseUrl: service.url, token: TOKEN, mode, indexed })) {
          await t.test(testCase.name, testCase.run);
        }
        if (fakeEmbeddings && mode === "hybrid") {
          const request = fakeEmbeddings.requests[0]!;
          assert.equal(request.path, "/v1/embeddings");
          assert.equal(request.headers.authorization, "Bearer embed-key");
          assert.equal(request.body.model, "fake-embed");
          assert.ok(Array.isArray(request.body.input) && request.body.input.length > 1);
        }
      } finally {
        await service.close();
        await fakeGcs.close();
        await fakeEmbeddings?.close();
      }
    });
  }
}

test("slow embeddings are cut off by the request budget and fall back to BM25", async () => {
  const slow = await startFakeEmbeddings({ delayMs: 3000 });
  const service = await startService({
    EMBEDDINGS_BASE_URL: slow.url,
    EMBEDDINGS_MODEL: "fake-embed",
    REQUEST_BUDGET_MS: "300",
  });
  try {
    const started = Date.now();
    const { results } = await apiClient(
      service.url,
      "/batch_highlight",
      "when was acme founded",
      [{ id: "0", markdown: PAGE_MARKDOWN }],
      TOKEN,
    );
    assert.ok(Date.now() - started < 2000, "responded within the budget");
    const output = results.get("0")!;
    assert.match(output.markdown, /1952/);
    assert.ok(output.highlights.every((h: { via: string }) => h.via === "bm25"));
  } finally {
    await service.close();
    await slow.close();
  }
});

test("service-account credentials are exchanged for a GCS access token", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let exchanges = 0;
  const tokenServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const assertion = new URLSearchParams(raw).get("assertion") ?? "";
      const [header, claims, signature] = assertion.split(".");
      const valid = createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature ?? "", "base64url"));
      const payload = JSON.parse(Buffer.from(claims ?? "", "base64url").toString());
      exchanges++;
      if (!valid || payload.iss !== "reader@example.iam.gserviceaccount.com" || !payload.scope.includes("devstorage.read_only")) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "minted-token", expires_in: 3600 }));
    });
  });
  tokenServer.listen(0, "127.0.0.1");
  await once(tokenServer, "listening");
  const tokenPort = (tokenServer.address() as { port: number }).port;
  const fakeGcs = await startFakeGcs({ token: "minted-token" });
  const credentials = Buffer.from(
    JSON.stringify({
      client_email: "reader@example.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: `http://127.0.0.1:${tokenPort}/token`,
    }),
  ).toString("base64");
  const service = await startService({
    GCS_INDEX_BUCKET_NAME: INDEX_BUCKET,
    GCS_STORAGE_ENDPOINT: fakeGcs.url,
    GCS_CREDENTIALS: credentials,
  });
  try {
    const page = { id: "0", url: "https://acme.test/", indexObject: "11111111-1111-4111-8111-111111111111.json" };
    for (let i = 0; i < 2; i++) {
      const { results } = await apiClient(service.url, "/batch_highlight_indexed", "acme founded", [page], TOKEN);
      assert.match(results.get("0")!.markdown, /1952/);
    }
    assert.equal(exchanges, 1, "access token is cached");
  } finally {
    await service.close();
    await fakeGcs.close();
    await new Promise<void>(resolve => tokenServer.close(() => resolve()));
  }
});

test("pages beyond MAX_PAGES_PER_REQUEST are omitted, not rejected", async () => {
  const service = await startService({ MAX_PAGES_PER_REQUEST: "2" });
  try {
    const pages = ["a", "b", "c"].map(id => ({ id, markdown: PAGE_MARKDOWN }));
    const { results } = await apiClient(service.url, "/batch_highlight", "acme founded", pages, TOKEN);
    assert.deepEqual([...results.keys()], ["a", "b"]);
  } finally {
    await service.close();
  }
});
