import assert from "node:assert/strict";
import test from "node:test";

import { isDocumentationOnlyPath, releaseRelevantPaths, requiresRelease } from "./release-impact.mjs";

test("documentation and release bookkeeping do not publish runtime images", () => {
  const paths = [
    "COMMUNITY_FEATURES.md",
    "community/README.md",
    "apps/browser-service-community/README.md",
    "community/capabilities.yml",
    ".github/workflows/community-auto-release.yml",
    ".github/workflows/community-ci.yml",
    ".github/workflows/community-upstream-sync.yml",
    "community/scripts/release-impact.mjs",
    "community/scripts/release-impact.test.mjs",
    "community/scripts/select-upstream-release.mjs",
    "community/scripts/select-upstream-release.test.mjs",
    "community/scripts/should-dispatch-ci.mjs",
    "community/scripts/should-dispatch-ci.test.mjs",
  ];

  assert.equal(requiresRelease(paths), false);
  assert.deepEqual(releaseRelevantPaths(paths), []);
});

test("runtime, dependency and compose changes require a release", () => {
  const paths = [
    "apps/api/src/index.ts",
    "pnpm-lock.yaml",
    "community/docker-compose.browser.yaml",
  ];

  assert.equal(requiresRelease(paths), true);
  assert.deepEqual(releaseRelevantPaths(paths), paths);
});

test("a runtime change cannot be hidden by accompanying documentation", () => {
  assert.equal(requiresRelease(["community/README.md", "apps/browser-service-community/src/runtime.ts"]), true);
  assert.equal(isDocumentationOnlyPath("docs\\release.mdx"), true);
});
