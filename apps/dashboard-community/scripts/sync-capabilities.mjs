#!/usr/bin/env node
// Bundles community/capabilities.yml (JSON content) into the dashboard so the
// container build, whose context is this directory, can render the feature
// matrix. `--check` fails when the bundled copy is stale (run in CI).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../../../community/capabilities.yml");
const target = path.resolve(here, "../src/generated/capabilities.json");

const manifest = JSON.parse(await readFile(source, "utf8"));
const rendered = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current.replace(/\r\n/g, "\n") !== rendered) {
    console.error("src/generated/capabilities.json is stale; run `pnpm sync:capabilities`.");
    process.exit(1);
  }
} else {
  await writeFile(target, rendered);
}
