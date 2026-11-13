// Black-box contract suite for the highlight service. It is run in-process by
// test/contract.test.ts and against built containers by
// test/container-contract.mjs.
//
// `apiClient` reproduces the request and response handling of upstream
// Firecrawl `apps/api/src/search/highlight-model.ts` (tag v2.11.739): the same
// headers, the same `JSON.stringify({ query, pages })` bodies, and the same
// acceptance rules for the response.
import assert from "node:assert/strict";
import { PAGE_MARKDOWN } from "./fakes.mjs";

export function apiRequestHeaders(token, requestId) {
  const headers = { "Content-Type": "application/json" };
  if (requestId) headers["X-Request-ID"] = requestId;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Mirrors generateHighlightsBatchRequest: returns Map<id, {highlights, markdown}> or throws. */
export async function apiClient(baseUrl, endpoint, query, pages, token, requestId = "contract-request") {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: apiRequestHeaders(token, requestId),
    body: JSON.stringify({ query, pages }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const error = new Error(`highlight model HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  if (typeof data !== "object" || data === null || Array.isArray(data) || ("pages" in data && !Array.isArray(data.pages))) {
    throw new Error("highlight model returned an invalid response");
  }
  const results = new Map();
  for (const page of data.pages ?? []) {
    if (typeof page !== "object" || page === null) continue;
    if (typeof page.id !== "string" || !page.output) continue;
    results.set(page.id, { highlights: page.output.highlights ?? [], markdown: page.output.markdown ?? "" });
  }
  return { results, raw: data };
}

function assertHighlightShape(output) {
  assert.ok(Array.isArray(output.highlights));
  assert.equal(typeof output.markdown, "string");
  for (const h of output.highlights) {
    assert.equal(typeof h.block_index, "number");
    assert.ok(["heading", "text", "code", "table"].includes(h.kind));
    assert.ok(["bm25", "embedding", "hybrid"].includes(h.via));
    assert.equal(typeof h.score, "number");
    assert.equal(typeof h.span_md, "string");
    assert.ok(h.span_md.length > 0);
  }
}

const OTHER_PAGE = `# Gardening tips

Water tomatoes deeply twice a week.

Mulch keeps soil moist during hot summers.
`;

/**
 * @param {{ baseUrl: string, token: string, mode: "hybrid" | "bm25" | "degraded", indexed: boolean }} target
 * @returns {Array<{ name: string, run: () => Promise<void> }>}
 */
export function contractCases(target) {
  const { baseUrl, token, mode, indexed } = target;
  const post = (path, body, headers = apiRequestHeaders(token, "contract-request")) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  return [
    {
      name: "health endpoints are public and report the ranking mode",
      run: async () => {
        assert.equal((await fetch(`${baseUrl}/health/liveness`)).status, 200);
        const readiness = await (await fetch(`${baseUrl}/health/readiness`)).json();
        assert.equal(readiness.ranking, mode === "bm25" ? "bm25" : "hybrid");
        assert.equal(readiness.indexedEndpoint, indexed);
      },
    },
    {
      name: "missing or wrong bearer token is rejected",
      run: async () => {
        const body = { query: "q", pages: [{ id: "0", markdown: "text" }] };
        assert.equal((await post("/batch_highlight", body, apiRequestHeaders(undefined))).status, 401);
        assert.equal((await post("/batch_highlight", body, apiRequestHeaders("wrong-token"))).status, 401);
        await assert.rejects(apiClient(baseUrl, "/batch_highlight", "q", body.pages, undefined), { status: 401 });
      },
    },
    {
      name: "single /highlight returns {highlights, markdown}",
      run: async () => {
        const res = await post("/highlight", { query: "when was acme founded", markdown: PAGE_MARKDOWN });
        assert.equal(res.status, 200);
        const output = await res.json();
        assertHighlightShape(output);
        assert.match(output.markdown, /founded in 1952 in Ohio/);
        if (mode === "hybrid") assert.ok(output.highlights.some(h => h.via !== "bm25"));
        else assert.ok(output.highlights.every(h => h.via === "bm25"));
      },
    },
    {
      name: "/batch_highlight returns every page keyed by caller id",
      run: async () => {
        const pages = [
          { id: "0", markdown: PAGE_MARKDOWN },
          { id: "1", markdown: OTHER_PAGE },
          { id: "page-2", markdown: `${PAGE_MARKDOWN}\n\nThe Starter plan is the cheapest option.` },
        ];
        const { results, raw } = await apiClient(baseUrl, "/batch_highlight", "starter plan monthly price", pages, token);
        assert.deepEqual(raw.pages.map(p => p.id), ["0", "1", "page-2"]);
        for (const page of raw.pages) assertHighlightShape(page.output);
        assert.match(results.get("0").markdown, /Starter/);
        assert.match(results.get("page-2").markdown, /Starter/);
        if (mode !== "hybrid") assert.equal(results.get("1").markdown, "", "unrelated page keeps the provider snippet");
      },
    },
    {
      name: "semantic-only query is answered only when embeddings are working",
      run: async () => {
        const { results } = await apiClient(baseUrl, "/batch_highlight", "how expensive is it", [{ id: "0", markdown: PAGE_MARKDOWN }], token);
        const output = results.get("0");
        if (mode === "hybrid") {
          assert.match(output.markdown, /\$19|\$99|billed/);
          assert.ok(output.highlights.every(h => h.via === "embedding"));
        } else {
          assert.deepEqual(output, { highlights: [], markdown: "" });
        }
      },
    },
    {
      name: "empty batch and invalid bodies",
      run: async () => {
        const empty = await post("/batch_highlight", { query: "q", pages: [] });
        assert.equal(empty.status, 200);
        assert.deepEqual(await empty.json(), { pages: [] });
        assert.equal((await post("/batch_highlight", { pages: [] })).status, 400);
        assert.equal((await post("/highlight", { query: "q" })).status, 400);
        assert.equal((await post("/batch_highlight", { query: "   ", pages: [] })).status, 400);
      },
    },
    {
      name: "/batch_highlight_indexed loads index objects and omits misses",
      run: async () => {
        const pages = [
          { id: "0", url: "https://acme.test/", indexObject: "11111111-1111-4111-8111-111111111111.json" },
          { id: "1", url: "https://docs.test/rate-limits", indexObject: "22222222-2222-4222-8222-222222222222.json" },
          { id: "2", url: "https://missing.test/", indexObject: "44444444-4444-4444-8444-444444444444.json" },
          { id: "3", url: "https://gone.test/", indexObject: "33333333-3333-4333-8333-333333333333.json" },
        ];
        if (!indexed) {
          await assert.rejects(apiClient(baseUrl, "/batch_highlight_indexed", "rate limit retries", pages, token), { status: 503 });
          return;
        }
        const { results } = await apiClient(baseUrl, "/batch_highlight_indexed", "rate limit per minute retry", pages, token);
        assert.deepEqual([...results.keys()].sort(), ["0", "1"]);
        assert.match(results.get("1").markdown, /500 requests per minute/);
        assert.doesNotMatch(results.get("1").markdown, /Biscuit/);
        const founded = await apiClient(baseUrl, "/batch_highlight_indexed", "when was acme founded", pages.slice(0, 1), token);
        assert.match(founded.results.get("0").markdown, /1952/);
      },
    },
    {
      name: "/batch_highlight_indexed fails the call when no object can be read",
      run: async () => {
        if (!indexed) return;
        await assert.rejects(
          apiClient(baseUrl, "/batch_highlight_indexed", "q", [{ id: "0", url: "https://x.test/", indexObject: "server-error.json" }], token),
          { status: 502 },
        );
        assert.equal(
          (await post("/batch_highlight_indexed", { query: "q", pages: [{ id: "0", url: "u", indexObject: "../secret" }] })).status,
          502,
        );
      },
    },
  ];
}
