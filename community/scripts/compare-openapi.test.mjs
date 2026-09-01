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

test("rejects empty hosted contracts instead of passing vacuously", () => {
  assert.throws(() => compareDocuments({ paths: {} }, { paths: {} }), /contains no operations/);
});

test("reports request, response, and security contract drift", () => {
  const hosted = {
    components: { schemas: { Request: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } },
    paths: {
      "/scrape": {
        post: {
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Request" } } } },
          responses: { 200: { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  };
  const community = structuredClone(hosted);
  community.paths["/scrape"].post.security = [];
  community.paths["/scrape"].post.requestBody.content["application/json"].schema = { type: "string" };
  const result = compareDocuments(hosted, community);
  assert.equal(result.compatible, false);
  assert.equal(result.counts.semanticMismatches, 1);
  assert.equal(result.semanticMismatches[0].operation, "POST /scrape");
  assert.ok(result.counts.contractDiffs >= 1);
});

test("additive response fields and error statuses are compatible but retained as raw drift", () => {
  const hosted = {
    paths: {
      "/scrape": {
        post: {
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { success: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
    },
  };
  const community = structuredClone(hosted);
  community.paths["/scrape"].post.responses[200].content["application/json"].schema.properties.data = { type: "object" };
  community.paths["/scrape"].post.responses[400] = { content: { "application/json": { schema: { type: "object" } } } };
  const result = compareDocuments(hosted, community);
  assert.equal(result.compatible, true);
  assert.equal(result.counts.contractDiffs, 1);
  assert.equal(result.counts.semanticMismatches, 0);
});

test("unknown schema combinators fail closed", () => {
  const hosted = {
    paths: {
      "/scrape": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { oneOf: [{ type: "string" }, { type: "number" }] },
              },
            },
          },
          responses: {},
        },
      },
    },
  };
  const community = structuredClone(hosted);
  community.paths["/scrape"].post.requestBody.content["application/json"].schema = {
    type: "boolean",
  };
  const result = compareDocuments(hosted, community);
  assert.equal(result.compatible, false);
  assert.match(result.semanticMismatches[0].issues.join(" "), /request schema rejects/);
});

test("different authentication schemes are incompatible", () => {
  const hosted = {
    components: { securitySchemes: { auth: { type: "http", scheme: "bearer" } } },
    paths: { "/scrape": { post: { security: [{ auth: [] }], responses: {} } } },
  };
  const community = {
    components: {
      securitySchemes: { auth: { type: "apiKey", in: "header", name: "x-api-key" } },
    },
    paths: { "/v2/scrape": { post: { security: [{ auth: [] }], responses: {} } } },
  };
  const result = compareDocuments(hosted, community);
  assert.equal(result.compatible, false);
  assert.match(result.semanticMismatches[0].issues.join(" "), /security contract differs/);
});
