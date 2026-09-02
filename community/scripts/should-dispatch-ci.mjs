import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function shouldDispatchCi(runs) {
  if (!Array.isArray(runs)) {
    throw new TypeError("Expected a JSON array of workflow runs");
  }

  return !runs.some(run => run?.conclusion !== "action_required");
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = await readStdin();
  const runs = JSON.parse(input || "[]");
  process.stdout.write(`${shouldDispatchCi(runs)}\n`);
}
