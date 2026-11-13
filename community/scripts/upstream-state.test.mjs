import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { upstreamState } from "./upstream-state.mjs";

const mergeScript = fileURLToPath(new URL("./merge-upstream.sh", import.meta.url));

function fixture(context) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-state-"));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  };
  const commit = message => {
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  write("app.txt", "initial\n");
  write(".github/workflows/test.yml", "upstream workflow\n");
  const initial = commit("Initial");
  git("tag", "canonical/v1.0.0");
  git("switch", "-c", "canonical");
  write("app.txt", "integrated\n");
  const integrated = commit("Upstream 1.0.1");
  git("tag", "canonical/v1.0.1");
  git("switch", "main");
  git("merge", "--squash", "canonical");
  write(".github/workflows/test.yml", "community workflow\n");
  write("community/upstream.json", JSON.stringify({ tag: "v1.0.1", sourceSha: integrated }));
  commit("Squashed upstream 1.0.1");
  return { cwd, git, write, commit, initial, integrated };
}

test("recorded provenance survives a squash merge and validates the exact tag", context => {
  const repo = fixture(context);
  assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", repo.integrated, "main"], { cwd: repo.cwd }).status, 1);
  assert.deepEqual(upstreamState("HEAD", repo.cwd), { tag: "v1.0.1", sourceSha: repo.integrated });
  repo.write("community/upstream.json", JSON.stringify({ tag: "v1.0.1", sourceSha: repo.initial }));
  repo.commit("Invalid provenance");
  assert.throws(() => upstreamState("HEAD", repo.cwd), /does not match/);
});

test("repositories without provenance fall back to reachable tags", context => {
  const repo = fixture(context);
  assert.deepEqual(upstreamState(repo.initial, repo.cwd), { tag: "v1.0.0", sourceSha: repo.initial });
});

test("sync applies only the next delta and preserves community workflows", context => {
  const repo = fixture(context);
  repo.git("switch", "canonical");
  repo.write("app.txt", "next release\n");
  repo.write(".github/workflows/test.yml", "changed upstream workflow\n");
  repo.write(".github/workflows/new.yml", "new upstream workflow\n");
  const next = repo.commit("Upstream 1.0.2");
  repo.git("tag", "canonical/v1.0.2");
  repo.git("switch", "main");
  repo.git("switch", "-c", "sync");
  execFileSync("bash", [mergeScript], {
    cwd: repo.cwd,
    env: { ...process.env, SOURCE_SHA: next, PREVIOUS_SHA: repo.integrated, TAG: "v1.0.2", BASE_REF: "main" },
    stdio: "pipe",
  });
  assert.equal(repo.git("show", "HEAD:app.txt"), "next release");
  assert.equal(repo.git("show", "HEAD:.github/workflows/test.yml"), "community workflow");
  assert.equal(fs.existsSync(path.join(repo.cwd, ".github/workflows/new.yml")), false);
  assert.equal(repo.git("merge-base", next, "HEAD"), next);
  assert.deepEqual(upstreamState("HEAD", repo.cwd), { tag: "v1.0.2", sourceSha: next });
  repo.git("switch", "main");
  repo.git("merge", "--squash", "sync");
  repo.commit("Squash next release");
  assert.deepEqual(upstreamState("HEAD", repo.cwd), { tag: "v1.0.2", sourceSha: next });
});

test("runtime conflicts abort without advancing provenance", context => {
  const repo = fixture(context);
  repo.git("switch", "canonical");
  repo.write("app.txt", "upstream incompatible change\n");
  const next = repo.commit("Upstream conflict");
  repo.git("switch", "main");
  repo.write("app.txt", "community incompatible change\n");
  repo.commit("Community change");
  const result = spawnSync("bash", [mergeScript], {
    cwd: repo.cwd,
    env: { ...process.env, SOURCE_SHA: next, PREVIOUS_SHA: repo.integrated, TAG: "v1.0.2", BASE_REF: "main" },
  });
  assert.equal(result.status, 1);
  assert.equal(repo.git("status", "--porcelain"), "");
  assert.equal(repo.git("show", "HEAD:app.txt"), "community incompatible change");
  assert.deepEqual(upstreamState("HEAD", repo.cwd), { tag: "v1.0.1", sourceSha: repo.integrated });
});
