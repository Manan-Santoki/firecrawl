// Runs the black-box contract suite against the built container image.
//
//   HIGHLIGHT_IMAGE=firecrawl-highlight-service-community:dev node test/container-contract.mjs
//
// Fake embeddings and GCS servers run on the host; containers reach them via
// host.docker.internal (mapped to the host gateway on Linux).
import { execFileSync } from "node:child_process";
import { contractCases } from "./contract-cases.mjs";
import { INDEX_BUCKET, startFakeEmbeddings, startFakeGcs } from "./fakes.mjs";

const image = process.env.HIGHLIGHT_IMAGE ?? "firecrawl-highlight-service-community:dev";
const token = "container-contract-token";
const hostAlias = "host.docker.internal";

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

async function waitHealthy(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${url}/health/liveness`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`container at ${url} never became healthy`);
}

const embeddings = await startFakeEmbeddings({ host: "0.0.0.0", apiKey: "embed-key" });
const brokenEmbeddings = await startFakeEmbeddings({ host: "0.0.0.0", failWith: 503 });
const gcs = await startFakeGcs({ host: "0.0.0.0" });

const targets = [
  {
    mode: "hybrid",
    indexed: true,
    env: {
      EMBEDDINGS_BASE_URL: `http://${hostAlias}:${embeddings.port}/v1`,
      EMBEDDINGS_MODEL: "fake-embed",
      EMBEDDINGS_API_KEY: "embed-key",
    },
  },
  { mode: "bm25", indexed: true, env: {} },
  { mode: "bm25", indexed: false, env: {}, noIndex: true },
  {
    mode: "degraded",
    indexed: true,
    env: { EMBEDDINGS_BASE_URL: `http://${hostAlias}:${brokenEmbeddings.port}/v1`, EMBEDDINGS_MODEL: "fake-embed" },
  },
];

let failures = 0;
let passes = 0;
try {
  for (const target of targets) {
    const env = {
      HIGHLIGHT_SERVICE_TOKEN: token,
      ...(target.noIndex
        ? {}
        : { GCS_INDEX_BUCKET_NAME: INDEX_BUCKET, STORAGE_EMULATOR_HOST: `${hostAlias}:${gcs.port}` }),
      ...target.env,
    };
    const name = `highlight-contract-${target.mode}-${target.indexed ? "indexed" : "plain"}-${process.pid}`;
    const args = ["run", "--detach", "--name", name, "--add-host", `${hostAlias}:host-gateway`, "--publish", "127.0.0.1::3007"];
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    docker(...args, image);
    try {
      const mapped = docker("port", name, "3007/tcp").split("\n")[0];
      const baseUrl = `http://${mapped.replace("0.0.0.0", "127.0.0.1")}`;
      await waitHealthy(baseUrl);
      for (const testCase of contractCases({ baseUrl, token, mode: target.mode, indexed: target.indexed })) {
        const label = `[${target.mode}${target.indexed ? "+indexed" : ""}] ${testCase.name}`;
        try {
          await testCase.run();
          passes++;
          console.log(`ok - ${label}`);
        } catch (error) {
          failures++;
          console.log(`not ok - ${label}\n  ${String(error?.stack ?? error).split("\n").join("\n  ")}`);
        }
      }
      const state = docker("inspect", "--format", "{{.State.Running}} {{.Config.User}}", name);
      if (state !== "true node") {
        failures++;
        console.log(`not ok - [${target.mode}] container state/user unexpected: ${state}`);
      }
    } finally {
      if (failures > 0) console.log(docker("logs", name));
      docker("rm", "--force", name);
    }
  }
} finally {
  await embeddings.close();
  await brokenEmbeddings.close();
  await gcs.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
