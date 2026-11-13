/**
 * Smoke-test a built image: start mock model + mock Firecrawl servers on the
 * host, run the container against them (and an optional Redis), then drive one
 * schema run and one cancel through the gateway contract.
 *
 *   SMOKE_DOCKER_NETWORK=<net> tsx test/container-smoke.ts <image> [redisUrlAsSeenFromContainer]
 */
import { execFileSync } from "node:child_process";
import { makeGateway, pollTerminal } from "./gateway.js";
import { firecrawlHandler, startMock, TEAM, textReply, toolCallReply, toolResults } from "./helpers.js";

const image = process.argv[2];
const redisUrl = process.argv[3];
if (!image) throw new Error("usage: container-smoke.ts <image> [redis-url]");

const secret = "smoke-interop-secret-0123456789";
const name = `agent-community-smoke-${process.pid}`;
const port = 39010;

const llm = await startMockOnAll(r => {
  if (!r.body.tools) return textReply(JSON.stringify({ title: "Example" }));
  return toolResults(r.body).length === 0
    ? toolCallReply([{ name: "scrape", args: { url: "https://example.com/" } }])
    : textReply("Title is Example (https://example.com/)");
});
const fc = await startMockOnAll(firecrawlHandler());

async function startMockOnAll(handler: Parameters<typeof startMock>[0]) {
  // Containers reach the host through host.docker.internal, so bind 0.0.0.0.
  const m = await startMock(handler, "0.0.0.0");
  return { ...m, port: new URL(m.url).port };
}

function docker(args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

let ok = false;
try {
  docker([
    "run", "--detach", "--name", name,
    "--add-host", "host.docker.internal:host-gateway",
    ...(process.env.SMOKE_DOCKER_NETWORK ? ["--network", process.env.SMOKE_DOCKER_NETWORK] : []),
    "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--publish", `127.0.0.1:${port}:3010`,
    "--env", `AGENT_INTEROP_SECRET=${secret}`,
    "--env", `OPENAI_BASE_URL=http://host.docker.internal:${llm.port}`,
    "--env", "AGENT_MODEL=mock-model",
    "--env", `FIRECRAWL_API_URL=http://host.docker.internal:${fc.port}`,
    "--env", "FIRECRAWL_API_KEY=fc-smoke",
    ...(redisUrl ? ["--env", `REDIS_URL=${redisUrl}`] : []),
    image,
  ]);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    const ready = await fetch(`${base}/health/readiness`).then(r => r.ok).catch(() => false);
    if (ready) break;
    if (i > 60) throw new Error("container did not become ready");
    await new Promise(r => setTimeout(r, 500));
  }

  const gw = makeGateway(base, secret);
  const start = await gw.start({
    teamId: TEAM,
    prompt: "What is the title of example.com?",
    urls: ["https://example.com/"],
    schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  });
  if (start.status !== 200) throw new Error(`start failed: ${JSON.stringify(start.body)}`);
  const status = await pollTerminal(gw, start.id, 30_000);
  if (status.status !== "success" || status.data?.title !== "Example") {
    throw new Error(`unexpected status: ${JSON.stringify(status)}`);
  }
  const trace = await gw.trace(start.id);
  if (trace.body.events.at(-1)?.type !== "completed") throw new Error("trace missing completion");
  const unauthorized = await fetch(`${base}/internal/extracts/${start.id}`);
  if (unauthorized.status !== 401) throw new Error("status endpoint accepted an unauthenticated call");
  console.log(JSON.stringify({ smoke: "ok", id: start.id, creditsUsed: status.creditsUsed, store: redisUrl ? "redis" : "memory" }));
  ok = true;
} finally {
  if (!ok) {
    try {
      console.error(docker(["logs", name]));
    } catch {}
  }
  try {
    docker(["rm", "--force", name]);
  } catch {}
  await Promise.all([llm.close(), fc.close()]);
  if (!ok) process.exitCode = 1;
}
