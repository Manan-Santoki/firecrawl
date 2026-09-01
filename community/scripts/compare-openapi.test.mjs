import assert from "node:assert/strict";
import test from "node:test";
import { compareDocuments, operationSet } from "./compare-openapi.mjs";

test("normalizes the v2 prefix and path parameter names", () => {
  const operations = operationSet({ paths: { "/v2/crawl/{crawlId}": { get: {} } } });
  assert.deepEqual([...operations], ["GET /crawl/{parameter}"]);
});

test("reports hosted operations missing from community and preserves extras", () => {
  const hosted = { paths: { "/scrape": { post: {} }, "/agent": { get: {}, post: {} } } };
  const community = { paths: { "/v2/scrape": { post: {} }, "/v2/agent": { post: {} }, "/v2/browser": { post: {} } } };
  const result = compareDocuments(hosted, community);

  assert.equal(result.compatible, false);
  assert.deepEqual(result.missing, ["GET /agent"]);
  assert.deepEqual(result.extra, ["POST /browser"]);
  assert.equal(result.counts.matching, 2);
});

test("extra community endpoints do not break hosted compatibility", () => {
  const result = compareDocuments(
    { paths: { "/scrape": { post: {} } } },
    { paths: { "/v2/scrape": { post: {} }, "/v2/browser": { post: {} } } },
  );
  assert.equal(result.compatible, true);
  assert.equal(result.counts.extra, 1);
});
