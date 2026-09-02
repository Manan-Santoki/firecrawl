import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const releaseMetadataPaths = new Set([
  ".github/workflows/community-auto-release.yml",
  ".github/workflows/community-ci.yml",
  ".github/workflows/community-upstream-sync.yml",
  "community/capabilities.yml",
  "community/scripts/release-impact.mjs",
  "community/scripts/release-impact.test.mjs",
  "community/scripts/select-upstream-release.mjs",
  "community/scripts/select-upstream-release.test.mjs",
  "community/scripts/should-dispatch-ci.mjs",
  "community/scripts/should-dispatch-ci.test.mjs",
]);

export function normalizePath(value) {
  return String(value).trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isDocumentationOnlyPath(value) {
  const candidate = normalizePath(value);
  if (candidate === "") return true;
  if (releaseMetadataPaths.has(candidate)) return true;
  return /(?:^|\/)[^/]+\.mdx?$/i.test(candidate);
}

export function releaseRelevantPaths(paths) {
  return paths.map(normalizePath).filter(candidate => candidate !== "" && !isDocumentationOnlyPath(candidate));
}

export function requiresRelease(paths) {
  return releaseRelevantPaths(paths).length > 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${requiresRelease(process.argv.slice(2))}\n`);
}
