import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const annotationKeys = new Set(["description", "summary", "title", "example", "examples", "externalDocs", "xml"]);

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

function resolveLocalRef(document, reference, seen) {
  if (!reference.startsWith("#/")) return { $ref: reference };
  if (seen.has(reference)) return { $refCycle: reference };
  const value = reference.slice(2).split("/").reduce(
    (current, segment) => current?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
    document,
  );
  if (value === undefined) throw new Error(`OpenAPI contains an unresolved reference: ${reference}`);
  return normalizeContractValue(document, value, new Set([...seen, reference]));
}

function normalizeContractValue(document, value, seen = new Set()) {
  if (Array.isArray(value)) return value.map(item => normalizeContractValue(document, item, seen));
  if (!value || typeof value !== "object") return value;
  if (typeof value.$ref === "string") return resolveLocalRef(document, value.$ref, seen);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !annotationKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeContractValue(document, item, seen)]),
  );
}

function normalizedParameters(document, pathItem, operation) {
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map(parameter => normalizeContractValue(document, parameter))
    .map(parameter => ({
      ...parameter,
      name: parameter.in === "path" ? "{parameter}" : parameter.name,
    }));
  return parameters.sort((left, right) => `${left.in}:${left.name}`.localeCompare(`${right.in}:${right.name}`));
}

function normalizedSecurity(document, security) {
  return normalizeContractValue(document, security)
    .map(requirement => Object.entries(requirement)
      .map(([name, scopes]) => ({
        scheme: normalizeContractValue(
          document,
          document.components?.securitySchemes?.[name] ?? { missingScheme: name },
        ),
        scopes: [...scopes].sort(),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function operationContracts(document) {
  const contracts = new Map();
  for (const [route, pathItem] of Object.entries(document?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!methods.has(method.toLowerCase())) continue;
      const key = `${method.toUpperCase()} ${normalizePath(route)}`;
      contracts.set(key, {
        parameters: normalizedParameters(document, pathItem, operation),
        requestBody: operation.requestBody
          ? normalizeContractValue(document, operation.requestBody)
          : null,
        responses: normalizeContractValue(document, operation.responses ?? {}),
        security: normalizedSecurity(document, operation.security ?? document.security ?? []),
      });
    }
  }
  return contracts;
}

function schemaAccepts(accepting, candidate) {
  if (!accepting || Object.keys(accepting).length === 0) return true;
  if (!candidate || Object.keys(candidate).length === 0) return false;
  if (JSON.stringify(accepting) === JSON.stringify(candidate)) return true;
  // Full JSON Schema subsumption is undecidable in the general case. Unknown
  // combinator relationships must fail closed instead of certifying parity.
  if ([accepting, candidate].some(schema => schema.oneOf || schema.anyOf || schema.allOf || schema.not)) {
    return false;
  }
  const acceptingTypes = new Set(Array.isArray(accepting.type) ? accepting.type : accepting.type ? [accepting.type] : []);
  const candidateTypes = new Set(Array.isArray(candidate.type) ? candidate.type : candidate.type ? [candidate.type] : []);
  if (acceptingTypes.size && [...candidateTypes].some(type => !acceptingTypes.has(type))) return false;
  if (accepting.const !== undefined && accepting.const !== candidate.const) return false;
  if (Array.isArray(accepting.enum) && Array.isArray(candidate.enum)) {
    if (candidate.enum.some(value => !accepting.enum.includes(value))) return false;
  }
  if (typeof accepting.minimum === "number" && (candidate.minimum ?? -Infinity) < accepting.minimum) return false;
  if (typeof accepting.maximum === "number" && (candidate.maximum ?? Infinity) > accepting.maximum) return false;
  if (accepting.items && candidate.items && !schemaAccepts(accepting.items, candidate.items)) return false;
  if (accepting.properties && candidate.properties) {
    for (const [name, candidateProperty] of Object.entries(candidate.properties)) {
      if (accepting.properties[name] && !schemaAccepts(accepting.properties[name], candidateProperty)) return false;
      if (!accepting.properties[name] && accepting.additionalProperties === false) return false;
    }
    const acceptingRequired = new Set(accepting.required ?? []);
    const candidateRequired = new Set(candidate.required ?? []);
    if ([...acceptingRequired].some(name => !candidateRequired.has(name))) return false;
  }
  return true;
}

function semanticContractIssues(hosted, community) {
  const issues = [];
  if (JSON.stringify(hosted.security) !== JSON.stringify(community.security)) {
    issues.push("security contract differs");
  }

  const hostedParameters = new Map(hosted.parameters.map(item => [`${item.in}:${item.name}`, item]));
  const communityParameters = new Map(community.parameters.map(item => [`${item.in}:${item.name}`, item]));
  for (const [key, parameter] of hostedParameters) {
    const target = communityParameters.get(key);
    if (!target) {
      issues.push(`missing parameter ${key}`);
    } else if (!schemaAccepts(target.schema ?? {}, parameter.schema ?? {})) {
      issues.push(`request parameter schema rejects hosted contract for ${key}`);
    }
  }
  for (const [key, parameter] of communityParameters) {
    const source = hostedParameters.get(key);
    if (parameter.required && !source?.required) issues.push(`additional required parameter ${key}`);
  }

  if (hosted.requestBody) {
    if (!community.requestBody) {
      issues.push("missing request body");
    } else {
      if (community.requestBody.required && !hosted.requestBody.required) {
        issues.push("request body is more restrictive");
      }
      for (const [mediaType, hostedMedia] of Object.entries(hosted.requestBody.content ?? {})) {
        const communityMedia = community.requestBody.content?.[mediaType];
        if (!communityMedia) issues.push(`missing request media type ${mediaType}`);
        else if (!schemaAccepts(communityMedia.schema ?? {}, hostedMedia.schema ?? {})) {
          issues.push(`request schema rejects hosted contract for ${mediaType}`);
        }
      }
    }
  }

  for (const [status, hostedResponse] of Object.entries(hosted.responses ?? {})) {
    if (!/^2\d\d$/.test(status) && status !== "default") continue;
    const communityResponse = community.responses?.[status];
    if (!communityResponse) {
      issues.push(`missing success response ${status}`);
      continue;
    }
    for (const [mediaType, communityMedia] of Object.entries(communityResponse.content ?? {})) {
      const hostedMedia = hostedResponse.content?.[mediaType];
      if (!hostedMedia) issues.push(`undocumented response media type ${status} ${mediaType}`);
      else if (!schemaAccepts(hostedMedia.schema ?? {}, communityMedia.schema ?? {})) {
        issues.push(`response schema exceeds hosted contract for ${status} ${mediaType}`);
      }
    }
  }
  return issues;
}

export function compareDocuments(hosted, community) {
  const hostedContracts = operationContracts(hosted);
  const communityContracts = operationContracts(community);
  if (hostedContracts.size === 0) {
    throw new Error("Hosted OpenAPI contains no operations; refusing a vacuous compatibility pass");
  }
  const hostedOperations = new Set(hostedContracts.keys());
  const communityOperations = new Set(communityContracts.keys());
  const missing = [...hostedOperations].filter(operation => !communityOperations.has(operation)).sort();
  const extra = [...communityOperations].filter(operation => !hostedOperations.has(operation)).sort();
  const matching = [...hostedOperations].filter(operation => communityOperations.has(operation)).sort();
  const contractDiffs = matching.flatMap(operation => {
    const hostedContract = hostedContracts.get(operation);
    const communityContract = communityContracts.get(operation);
    return JSON.stringify(hostedContract) === JSON.stringify(communityContract)
      ? []
      : [{ operation, hosted: hostedContract, community: communityContract }];
  });
  const semanticMismatches = matching.flatMap(operation => {
    const issues = semanticContractIssues(hostedContracts.get(operation), communityContracts.get(operation));
    return issues.length ? [{ operation, issues }] : [];
  });
  return {
    compatible: missing.length === 0 && semanticMismatches.length === 0,
    counts: {
      hosted: hostedOperations.size,
      community: communityOperations.size,
      matching: matching.length,
      missing: missing.length,
      extra: extra.length,
      contractDiffs: contractDiffs.length,
      semanticMismatches: semanticMismatches.length,
    },
    missing,
    extra,
    matching,
    contractDiffs,
    semanticMismatches,
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
    console.error(
      `Community OpenAPI drift: ${report.missing.length} missing operation(s), ${report.semanticMismatches.length} semantic contract mismatch(es)`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    const output = argument("--output") ?? "openapi-compatibility.json";
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      compatible: false,
      comparisonError: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
