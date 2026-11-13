import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function upstreamState(ref = "HEAD", cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const exists = spawnSync("git", ["cat-file", "-e", `${ref}:community/upstream.json`], { cwd });
  let recorded;
  if (exists.status === 0) {
    recorded = JSON.parse(git("show", `${ref}:community/upstream.json`));
    if (!/^v\d+\.\d+\.\d+$/.test(recorded.tag) || !/^[a-f0-9]{40}$/.test(recorded.sourceSha)) {
      throw new Error("Invalid community/upstream.json release provenance");
    }
    if (git("rev-parse", `refs/tags/canonical/${recorded.tag}^{commit}`) !== recorded.sourceSha) {
      throw new Error("Recorded upstream SHA does not match its canonical release tag");
    }
  }
  const tags = git("for-each-ref", "--sort=-version:refname", "--format=%(refname)", "refs/tags/canonical/v*")
    .split("\n").filter(tag => /\/v\d+\.\d+\.\d+$/.test(tag));
  for (const tagRef of tags) {
    const tag = tagRef.split("/").at(-1);
    if (tag === recorded?.tag) return recorded;
    const sourceSha = git("rev-parse", `${tagRef}^{commit}`);
    if (spawnSync("git", ["merge-base", "--is-ancestor", sourceSha, ref], { cwd }).status === 0) {
      return { tag, sourceSha };
    }
  }
  throw new Error("No integrated semantic upstream release found");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(upstreamState(process.argv[2])));
}
