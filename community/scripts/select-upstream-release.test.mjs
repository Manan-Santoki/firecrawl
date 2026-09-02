import assert from "node:assert/strict";
import test from "node:test";

import { selectUpstreamReleaseRef } from "./select-upstream-release.mjs";

test("selects the first stable release from version-sorted canonical refs", () => {
  const refs = [
    "refs/tags/canonical/v2.12.0-beta.1",
    "refs/tags/canonical/v2.11.300",
    "refs/tags/canonical/v2.11.299",
  ].join("\n");

  assert.equal(selectUpstreamReleaseRef(refs), "refs/tags/canonical/v2.11.300");
});

test("rejects prereleases, malformed versions and non-canonical refs", () => {
  const refs = [
    "refs/tags/v2.11.300",
    "refs/tags/canonical/v2.11",
    "refs/tags/canonical/v2.11.300-rc.1",
    "refs/tags/canonical/not-a-version",
  ].join("\r\n");

  assert.equal(selectUpstreamReleaseRef(refs), undefined);
});

test("handles empty input without inventing a release", () => {
  assert.equal(selectUpstreamReleaseRef("\n"), undefined);
});
