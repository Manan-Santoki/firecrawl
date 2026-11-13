import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createGateway, rewritePath } from "../index-storage/gcs-json-gateway.mjs";

test("object and bucket calls from STORAGE_EMULATOR_HOST clients gain the /storage/v1 prefix", () => {
  assert.equal(rewritePath("/b/idx/o/abc.json?alt=media"), "/storage/v1/b/idx/o/abc.json?alt=media");
  assert.equal(rewritePath("/b/idx"), "/storage/v1/b/idx");
  assert.equal(rewritePath("/b?project=x"), "/storage/v1/b?project=x");
  assert.equal(rewritePath("/b"), "/storage/v1/b");
});

test("already-qualified, upload and download paths pass through unchanged", () => {
  for (const path of [
    "/storage/v1/b/idx/o/abc.json?alt=media",
    "/upload/storage/v1/b/idx/o?uploadType=resumable",
    "/download/storage/v1/b/idx/o/abc.json",
    "/bucket-named-b/object",
    "/",
    "",
  ]) {
    assert.equal(rewritePath(path), path || "/");
  }
});

test("the gateway streams method, body, status and headers to the rewritten backend path", async () => {
  const seen = [];
  const backend = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, host: request.headers.host, body });
      response.writeHead(201, { "content-type": "application/json", "x-backend": "yes" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = backend.address().port;
  const gateway = createGateway({ backend: `http://127.0.0.1:${backendPort}` });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;
  try {
    const download = await fetch(`http://127.0.0.1:${gatewayPort}/b/idx/o/abc.json?alt=media`);
    assert.equal(download.status, 201);
    assert.equal(download.headers.get("x-backend"), "yes");
    const upload = await fetch(`http://127.0.0.1:${gatewayPort}/upload/storage/v1/b/idx/o?uploadType=media&name=a.json`, {
      method: "POST",
      body: "{\"html\":\"x\"}",
    });
    assert.equal(upload.status, 201);
    assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
      ["GET", "/storage/v1/b/idx/o/abc.json?alt=media"],
      ["POST", "/upload/storage/v1/b/idx/o?uploadType=media&name=a.json"],
    ]);
    assert.equal(seen[1].body, "{\"html\":\"x\"}");
    assert.equal(seen[0].host, `127.0.0.1:${backendPort}`);
  } finally {
    gateway.close();
    backend.close();
  }
});
