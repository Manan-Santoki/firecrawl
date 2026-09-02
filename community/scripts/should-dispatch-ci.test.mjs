import assert from "node:assert/strict";
import test from "node:test";

import { shouldDispatchCi } from "./should-dispatch-ci.mjs";

test("dispatches when no run exists for the exact branch commit", () => {
  assert.equal(shouldDispatchCi([]), true);
});

test("dispatches when GitHub only created approval-blocked runs", () => {
  assert.equal(
    shouldDispatchCi([
      { event: "pull_request", status: "completed", conclusion: "action_required" },
    ]),
    true,
  );
});

test("does not duplicate an active explicit run", () => {
  assert.equal(
    shouldDispatchCi([
      { event: "workflow_dispatch", status: "in_progress", conclusion: "" },
      { event: "pull_request", status: "completed", conclusion: "action_required" },
    ]),
    false,
  );
});

test("does not hide or retry a completed CI result", () => {
  for (const conclusion of ["success", "failure", "timed_out", "cancelled"]) {
    assert.equal(
      shouldDispatchCi([{ event: "workflow_dispatch", status: "completed", conclusion }]),
      false,
    );
  }
});

test("rejects malformed GitHub responses", () => {
  assert.throws(() => shouldDispatchCi({}), /JSON array/);
});
