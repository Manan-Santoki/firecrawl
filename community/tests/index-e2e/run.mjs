#!/usr/bin/env node
// End-to-end check of the community scrape index with Docker Compose:
//   1. scrape a fixture page twice with maxAge; the second is an index hit and
//      the origin is not contacted again;
//   2. the index row and its "<id>.json" object exist in PostgreSQL / storage;
//   3. lockdown serves the cached page and refuses an uncached one without
//      touching the origin;
//   4. the cache survives a restart of the index database and storage;
//   5. (optional) /v2/search replaces the provider snippet with an excerpt the
//      highlight service read from the indexed object.
//
// Usage (from the repository root, Docker required):
//   node community/tests/index-e2e/run.mjs [--keep] [--skip-build]
// Environment:
//   INDEX_E2E_PROJECT          Compose project name (default fcindex)
//   INDEX_E2E_PORT             host port for the API (default 3392)
//   INDEX_E2E_HIGHLIGHT_COMPOSE path to community/docker-compose.highlight.yaml;
//                              enables step 5 with HIGHLIGHT_IMAGE (default
//                              firecrawl-highlight-service-community:dev)
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const project = process.env.INDEX_E2E_PROJECT ?? "fcindex";
const port = process.env.INDEX_E2E_PORT ?? "3392";
const highlightCompose = process.env.INDEX_E2E_HIGHLIGHT_COMPOSE;
const bucket = "firecrawl-index-e2e";
const fixture = "http://fixture.index-e2e.test:8080";
const apiBase = `http://127.0.0.1:${port}`;

const secret = () => randomBytes(18).toString("base64url");
const apiKeyUuid = randomUUID();
const env = {
  ...process.env,
  PORT: port,
  APP_POSTGRES_PASSWORD: process.env.APP_POSTGRES_PASSWORD ?? secret(),
  INDEX_POSTGRES_PASSWORD: process.env.INDEX_POSTGRES_PASSWORD ?? secret(),
  FIRECRAWL_ORG_ID: randomUUID(),
  FIRECRAWL_TEAM_ID: randomUUID(),
  FIRECRAWL_API_KEY_UUID: apiKeyUuid,
  GCS_INDEX_BUCKET_NAME: bucket,
  STORAGE_EMULATOR_HOST: "http://firecrawl-index-storage:4443",
  HIGHLIGHT_SERVICE_TOKEN: process.env.HIGHLIGHT_SERVICE_TOKEN ?? secret(),
};
// base64url secrets are already RFC 3986 unreserved.
env.APP_POSTGRES_PASSWORD_URLENCODED = encodeURIComponent(env.APP_POSTGRES_PASSWORD);
env.INDEX_POSTGRES_PASSWORD_URLENCODED = encodeURIComponent(env.INDEX_POSTGRES_PASSWORD);
const apiKey = `fc-${apiKeyUuid.replaceAll("-", "")}`;

const files = [
  "docker-compose.yaml",
  "community/docker-compose.auth.yaml",
  ...(highlightCompose ? [highlightCompose, "community/tests/index-e2e/docker-compose.e2e-highlight.yaml"] : []),
  "community/docker-compose.index.yaml",
  "community/tests/index-e2e/docker-compose.e2e.yaml",
];
const composeArgs = ["compose", "-p", project, ...files.flatMap(file => ["-f", file])];

function docker(argv, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync("docker", [...composeArgs, ...argv], {
    env,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker compose ${argv.join(" ")} failed (${result.status}): ${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = {};
function check(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 2000)}`}`);
  }
  console.log(`ok - ${message}`);
}

async function api(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const sql = query => docker(
  ["exec", "-T", "firecrawl-index-db", "psql", "-U", "postgres", "-d", "firecrawl_index", "-Atc", query],
  { quiet: true },
);
const hits = () => JSON.parse(docker(
  ["exec", "-T", "index-e2e-fixture", "wget", "-q", "-O", "-", "http://127.0.0.1:8080/__hits"],
  { quiet: true },
));

async function waitFor(description, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${description} (last: ${String(last).slice(0, 500)})`);
}

async function main() {
  if (!args.has("--skip-build")) {
    const buildable = ["api", "playwright-service", "nuq-postgres", "firecrawl-db-migrate", "firecrawl-index-db-migrate"];
    docker(["build", ...buildable]);
  }
  // Secrets are generated per run, so always start from empty volumes.
  docker(["down", "-v", "--remove-orphans"], { allowFailure: true });
  // Base-stack services (e.g. rabbitmq's first boot on Docker Desktop) can
  // fail transiently; retries keep the check about the index.
  for (let attempt = 1; ; attempt++) {
    try {
      docker(["up", "-d", "--no-build"]);
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`retrying compose up after: ${error.message.split("\n")[0]}`);
      await sleep(5000);
    }
  }

  await waitFor("API liveness", async () => {
    const response = await fetch(`${apiBase}/`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  }, 600_000);
  // The harness starts workers after the API listener; give them a moment.
  await sleep(10_000);

  const articleUrl = `${fixture}/article`;

  // 1. First scrape: index miss, live fetch, document queued for the index.
  const first = await api("/v2/scrape", { url: articleUrl, formats: ["markdown"], maxAge: 600_000 });
  check(first.status === 200 && first.body?.success, "first scrape succeeds", first);
  check(first.body.data.metadata.cacheState === "miss", "first scrape is an index miss", first.body.data.metadata);
  check(/Columnar basalt/.test(first.body.data.markdown), "first scrape returns the fixture page");
  const hitsAfterFirst = hits()["/article"] ?? 0;
  check(hitsAfterFirst >= 1, "origin served the first scrape", hitsAfterFirst);

  // 2. The index worker flushes the row; the object is in the bucket.
  const indexId = await waitFor("index row", async () => sql(
    "SELECT id FROM public.index WHERE resolved_url LIKE '%/article' ORDER BY created_at DESC LIMIT 1",
  ) || false, 90_000);
  check(/^[0-9a-f-]{36}$/.test(indexId), "index worker inserted the row", indexId);
  const object = JSON.parse(docker([
    "exec", "-T", "firecrawl-index-storage", "wget", "-q", "-O", "-",
    `http://127.0.0.1:4443/storage/v1/b/${bucket}/o/${indexId}.json?alt=media`,
  ], { quiet: true }));
  check(object.statusCode === 200 && /Columnar basalt/.test(object.html), `bucket holds ${indexId}.json with the page HTML`);
  evidence.indexId = indexId;
  evidence.indexRow = sql(`SELECT url, resolved_url, status, is_mobile, block_ads, has_screenshot FROM public.index WHERE id = '${indexId}'`);

  // 3. Second scrape with maxAge: served from the index, origin untouched.
  const second = await api("/v2/scrape", { url: articleUrl, formats: ["markdown"], maxAge: 600_000 });
  check(second.status === 200 && second.body?.success, "second scrape succeeds", second);
  check(second.body.data.metadata.cacheState === "hit", "second scrape is an index hit", second.body.data.metadata);
  check(Boolean(second.body.data.metadata.cachedAt), "hit reports cachedAt", second.body.data.metadata);
  check(second.body.data.markdown === first.body.data.markdown, "hit returns the cached markdown");
  check((hits()["/article"] ?? 0) === hitsAfterFirst, "origin was not contacted for the hit");
  evidence.cachedAt = second.body.data.metadata.cachedAt;

  // maxAge: 0 bypasses the index and goes live.
  const fresh = await api("/v2/scrape", { url: articleUrl, formats: ["markdown"], maxAge: 0 });
  check(fresh.body?.data?.metadata?.cacheState !== "hit", "maxAge 0 bypasses the index", fresh.body?.data?.metadata);
  check((hits()["/article"] ?? 0) > hitsAfterFirst, "maxAge 0 reached the origin");
  const hitsBeforeLockdown = hits()["/article"] ?? 0;

  // 4. Lockdown: cached page served, uncached page refused without a fetch.
  const locked = await api("/v2/scrape", { url: articleUrl, formats: ["markdown"], lockdown: true });
  check(locked.status === 200 && locked.body?.data?.metadata?.cacheState === "hit", "lockdown serves the cached page", locked);
  check((hits()["/article"] ?? 0) === hitsBeforeLockdown, "lockdown hit did not contact the origin");
  const refused = await api("/v2/scrape", { url: `${fixture}/uncached`, formats: ["markdown"], lockdown: true });
  check(refused.status >= 400 && refused.body?.code === "SCRAPE_LOCKDOWN_CACHE_MISS", "lockdown refuses an uncached page", refused);
  check(!hits()["/uncached"], "lockdown miss never contacted the origin");
  evidence.lockdownMiss = { status: refused.status, code: refused.body.code };

  // 5. Persistence across restarts of the index database and object store.
  docker(["restart", "firecrawl-index-db", "firecrawl-index-storage-backend", "firecrawl-index-storage"]);
  docker(["up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "firecrawl-index-db", "firecrawl-index-storage-backend", "firecrawl-index-storage"]);
  const afterRestart = await waitFor("lockdown hit after restart", async () => {
    const result = await api("/v2/scrape", { url: articleUrl, formats: ["markdown"], lockdown: true });
    return result.body?.data?.metadata?.cacheState === "hit" ? result : false;
  }, 60_000);
  // maxAge: 0 indexes a newer copy asynchronously, and the fixture embeds the
  // origin request number, so the newest indexed copy is either the one the
  // pre-restart lockdown hit returned or the maxAge: 0 copy.
  check(
    [locked.body.data.markdown, fresh.body?.data?.markdown].includes(afterRestart.body.data.markdown),
    "cache survives index database and storage restarts",
  );

  // 6. Search excerpts from the indexed object via the highlight service.
  if (highlightCompose) {
    const search = await api("/v2/search", {
      query: "why does cooling lava form hexagonal basalt columns",
      limit: 1,
      highlights: true,
    });
    check(search.status === 200 && search.body?.success, "search succeeds", search);
    const result = search.body.data.web?.[0];
    check(result?.url === articleUrl, "search returns the fixture result", search.body.data);
    check(result.description !== "PROVIDER SNIPPET" && /basalt|column|lava/i.test(result.description ?? ""),
      "search excerpt was generated from the indexed page", result);
    evidence.searchExcerpt = result.description;
  } else {
    console.log("skip - search excerpts (set INDEX_E2E_HIGHLIGHT_COMPOSE)");
  }

  console.log(JSON.stringify({ evidence }, null, 2));
}

let failed = false;
try {
  await main();
  console.log("index e2e passed");
} catch (error) {
  failed = true;
  console.error(`not ok - ${error.message}`);
  const logs = docker(["logs", "--no-color", "--tail", "200", "api"], { allowFailure: true, quiet: true });
  console.error(logs.split("\n").filter(line => /index|error|warn/i.test(line)).slice(-80).join("\n"));
} finally {
  if (!args.has("--keep")) docker(["down", "-v", "--remove-orphans"], { allowFailure: true });
}
process.exitCode = failed ? 1 : 0;
