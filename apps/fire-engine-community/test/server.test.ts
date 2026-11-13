import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { ScrapeError } from "../src/errors.js";
import { Limiter } from "../src/limiter.js";
import type { ScrapeRequest, ScrapeSuccess } from "../src/schema.js";
import { createApp, type CreateAppOptions } from "../src/server.js";

function fakeScrapes(behaviour: (request: ScrapeRequest, signal: AbortSignal) => Promise<ScrapeSuccess>) {
  const jobs = new Map<string, Record<string, unknown>>();
  const scrapes: CreateAppOptions["scrapes"] = {
    limiter: new Limiter(1, 0, 0),
    jobCount: 0,
    run: behaviour,
    startJob(request) {
      const id = "job-1";
      jobs.set(id, { jobId: id, state: "active", processing: true });
      behaviour(request, new AbortController().signal).then(
        result => jobs.set(id, { ...result, jobId: id, state: "completed", processing: false }),
        error => jobs.set(id, { jobId: id, state: "failed", processing: false, error: error.message }),
      );
      return id;
    },
    jobStatus: id => jobs.get(id),
    deleteJob: id => jobs.delete(id),
  };
  return scrapes;
}

const ok: ScrapeSuccess = {
  timeTaken: 1,
  content: "<html>ok</html>",
  url: "https://example.com/",
  pageStatusCode: 200,
  responseHeaders: { "content-type": "text/html" },
  usedMobileProxy: false,
};

const search: CreateAppOptions["search"] = {
  backend: "none",
  web: async () => [],
  v2: async () => ({}),
};

async function serve(options: Partial<CreateAppOptions> & Pick<CreateAppOptions, "scrapes">) {
  const server = http.createServer(createApp({ apiKey: "", search, ...options }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("POST /scrape returns the success body synchronously without a jobId", async () => {
  const app = await serve({ scrapes: fakeScrapes(async () => ok) });
  try {
    const response = await post(`${app.url}/scrape`, { url: "https://example.com", engine: "chrome-cdp" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.content, "<html>ok</html>");
    assert.equal(body.jobId, undefined);
  } finally {
    await app.close();
  }
});

test("scrape failures and capacity errors use the {error} shape", async () => {
  const failing = await serve({
    scrapes: fakeScrapes(async request => {
      if (request.url.includes("busy")) throw new ScrapeError("fire-engine-community capacity exceeded: full", 429);
      throw new ScrapeError("Element \"#x\" was not found");
    }),
  });
  try {
    const action = await post(`${failing.url}/scrape`, { url: "https://example.com" });
    assert.equal(action.status, 500);
    assert.deepEqual(await action.json(), { error: 'Element "#x" was not found' });
    const busy = await post(`${failing.url}/scrape`, { url: "https://busy.example" });
    assert.equal(busy.status, 429);
    assert.match((await busy.json()).error, /capacity exceeded/);
    const invalid = await post(`${failing.url}/scrape`, { engine: "chrome-cdp" });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /^Invalid request: url/);
  } finally {
    await failing.close();
  }
});

test("instantReturn uses the job API; unknown jobs report a failed state with HTTP 200", async () => {
  const app = await serve({ scrapes: fakeScrapes(async () => ok) });
  try {
    const started = await post(`${app.url}/scrape`, { url: "https://example.com", instantReturn: true });
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { jobId: "job-1", processing: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    const status = await (await fetch(`${app.url}/scrape/job-1`)).json();
    assert.equal(status.state, "completed");
    assert.equal(status.processing, false);
    assert.equal((await fetch(`${app.url}/scrape/job-1`, { method: "DELETE" })).status, 200);
    const missing = await fetch(`${app.url}/scrape/job-1`);
    assert.equal(missing.status, 200);
    assert.equal((await missing.json()).state, "failed");
  } finally {
    await app.close();
  }
});

test("client disconnect aborts the in-flight scrape", async () => {
  let aborted = false;
  const app = await serve({
    scrapes: fakeScrapes(
      (_request, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new ScrapeError("Scrape cancelled by client"));
          });
        }),
    ),
  });
  try {
    await fetch(`${app.url}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
      signal: AbortSignal.timeout(100),
    }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(aborted, true);
  } finally {
    await app.close();
  }
});

test("optional API key: bearer, x-api-key and path-prefix forms", async () => {
  const app = await serve({ scrapes: fakeScrapes(async () => ok), apiKey: "s3cret" });
  try {
    assert.equal((await fetch(`${app.url}/health/liveness`)).status, 200);
    assert.equal((await post(`${app.url}/scrape`, { url: "https://example.com" })).status, 401);
    assert.equal((await post(`${app.url}/scrape`, { url: "https://example.com" }, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post(`${app.url}/scrape`, { url: "https://example.com" }, { authorization: "Bearer s3cret" })).status, 200);
    assert.equal((await post(`${app.url}/scrape`, { url: "https://example.com" }, { "x-api-key": "s3cret" })).status, 200);
    assert.equal((await post(`${app.url}/key/s3cret/scrape`, { url: "https://example.com" })).status, 200);
    assert.equal((await post(`${app.url}/key/nope/scrape`, { url: "https://example.com" })).status, 401);
  } finally {
    await app.close();
  }
});

test("search endpoints never fail the API: errors become empty results", async () => {
  const app = await serve({
    scrapes: fakeScrapes(async () => ok),
    search: {
      backend: "searxng",
      web: async () => {
        throw new Error("backend down");
      },
      v2: async () => {
        throw new Error("backend down");
      },
    },
  });
  try {
    assert.deepEqual(await (await post(`${app.url}/search`, { query: "q", numResults: 3 })).json(), []);
    assert.deepEqual(await (await post(`${app.url}/v2/search`, { query: "q", numResults: 3, type: "web" })).json(), {});
    assert.deepEqual(await (await post(`${app.url}/map`, { query: "site:a.com", numResults: 100, page: 1 })).json(), []);
    assert.equal((await post(`${app.url}/v2/search`, { numResults: 3 })).status, 400);
  } finally {
    await app.close();
  }
});
