import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function normalizePath(value) {
  const withoutVersion = value.replace(/^\/v2(?=\/|$)/, "") || "/";
  return withoutVersion.replace(/\{[^}]+\}/g, "{parameter}").replace(/\/$/, "") || "/";
}

export function operationSet(document) {
  const operations = new Set();
  for (const [route, pathItem] of Object.entries(document?.paths ?? {})) {
    for (const method of Object.keys(pathItem ?? {})) {
      if (methods.has(method.toLowerCase())) {
        operations.add(`${method.toUpperCase()} ${normalizePath(route)}`);
      }
    }
  }
  return operations;
}

export function compareDocuments(hosted, community) {
  const hostedOperations = operationSet(hosted);
  const communityOperations = operationSet(community);
  const missing = [...hostedOperations].filter(operation => !communityOperations.has(operation)).sort();
  const extra = [...communityOperations].filter(operation => !hostedOperations.has(operation)).sort();
  const matching = [...hostedOperations].filter(operation => communityOperations.has(operation)).sort();
  return {
    compatible: missing.length === 0,
    counts: {
      hosted: hostedOperations.size,
      community: communityOperations.size,
      matching: matching.length,
      missing: missing.length,
      extra: extra.length,
    },
    missing,
    extra,
    matching,
  };
}

async function readDocument(source) {
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Failed to fetch ${source}: HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await fs.readFile(path.resolve(source), "utf8"));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const hostedSource = argument("--hosted");
  const communitySource = argument("--community");
  const output = argument("--output") ?? "openapi-compatibility.json";
  if (!hostedSource || !communitySource) {
    throw new Error("Usage: compare-openapi.mjs --hosted <url|file> --community <url|file> [--output <file>]");
  }

  const [hosted, community] = await Promise.all([
    readDocument(hostedSource),
    readDocument(communitySource),
  ]);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceOfTruth: hostedSource,
    communitySource,
    ...compareDocuments(hosted, community),
  };
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.counts));
  if (!report.compatible) {
    console.error(`Community OpenAPI is missing ${report.missing.length} hosted operation(s): ${report.missing.join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
