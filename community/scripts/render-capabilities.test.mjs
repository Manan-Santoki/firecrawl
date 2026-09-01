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
    schemaVersion: 1,
    capabilities: [
      { id: "a", group: "A", name: "A", community: "available", requirements: "none", evidence: "test" },
      { id: "a", group: "A", name: "B", community: "mystery", requirements: "none", evidence: "test" },
    ],
  };
  assert.throws(() => loadManifest(JSON.stringify(base)), /Duplicate capability id|Unknown status/);
});
