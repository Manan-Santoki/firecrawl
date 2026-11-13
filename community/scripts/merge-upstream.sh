#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_SHA:?SOURCE_SHA is required}"
: "${PREVIOUS_SHA:?PREVIOUS_SHA is required}"
: "${TAG:?TAG is required}"
base_ref="${BASE_REF:-origin/main}"

if ! git merge-base --is-ancestor "${PREVIOUS_SHA}" HEAD; then
  git merge --strategy=ours --no-edit "${PREVIOUS_SHA}" \
    -m "Restore ancestry for the recorded upstream release"
fi

git merge --no-commit --no-ff "${SOURCE_SHA}" || {
  git rev-parse --verify MERGE_HEAD >/dev/null
}
git restore --source="${base_ref}" --staged --worktree -- .github/workflows
if [[ -n "$(git diff --name-only --diff-filter=U)" ]]; then
  git diff --name-only --diff-filter=U
  git merge --abort
  exit 1
fi
node --input-type=module -e '
  import fs from "node:fs";
  fs.writeFileSync("community/upstream.json", JSON.stringify({
    tag: process.env.TAG, sourceSha: process.env.SOURCE_SHA,
  }, null, 2) + "\n");
'
git add community/upstream.json
git commit -m "Merge upstream ${TAG} with community automation"
