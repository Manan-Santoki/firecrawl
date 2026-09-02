import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const stableReleaseRef = /^refs\/tags\/canonical\/v\d+\.\d+\.\d+$/;

export function selectUpstreamReleaseRef(input) {
  return String(input)
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(value => stableReleaseRef.test(value));
}

async function readStdin() {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = selectUpstreamReleaseRef(await readStdin());
  if (!selected) {
    console.error("Canonical upstream has no stable semantic release tag.");
    process.exitCode = 1;
  } else {
    process.stdout.write(`${selected}\n`);
  }
}
