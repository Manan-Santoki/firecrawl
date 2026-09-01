import assert from "node:assert/strict";
import test from "node:test";
import { loadManifest, render } from "./render-capabilities.mjs";

test("the checked-in manifest validates and renders every capability", () => {
  const manifest = loadManifest();
  const rendered = render(manifest);
  for (const capability of manifest.capabilities) {
    assert.match(rendered, new RegExp(capability.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("duplicate ids and unsupported statuses fail closed", () => {
  const base = {
    schemaVersion: 2,
    evidence: {
      sourceOfTruth: "Hosted docs",
      sourceUrl: "https://docs.example.test/v2",
      hostedOpenApiUrl: "https://docs.example.test/openapi.json",
      communityRelease: "community-v1.2.3.1",
      testId: "test-1",
      verifiedAt: "2026-08-31",
      limitations: "Fixture only",
    },
    capabilities: [
      { id: "a", group: "A", name: "A", community: "available", requirements: "none", evidence: "test" },
      { id: "a", group: "A", name: "B", community: "mystery", requirements: "none", evidence: "test" },
    ],
  };
  assert.throws(() => loadManifest(JSON.stringify(base)), /Duplicate capability id|Unknown status/);
});

test("evidence metadata is mandatory and uses stable machine-readable formats", () => {
  const manifest = JSON.parse(JSON.stringify(loadManifest()));
  delete manifest.evidence.testId;
  assert.throws(() => loadManifest(JSON.stringify(manifest)), /missing testId/);

  const invalidDate = JSON.parse(JSON.stringify(loadManifest()));
  invalidDate.evidence.verifiedAt = "August 31";
  assert.throws(() => loadManifest(JSON.stringify(invalidDate)), /YYYY-MM-DD/);
});
