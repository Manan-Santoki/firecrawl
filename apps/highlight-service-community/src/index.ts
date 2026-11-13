import http from "node:http";
import { loadConfig } from "./config.js";
import { OpenAICompatibleEmbedder } from "./embeddings.js";
import { GcsIndexStore } from "./index-store.js";
import { createApp } from "./server.js";

const config = loadConfig();
const embedder = config.embeddings ? new OpenAICompatibleEmbedder(config.embeddings) : null;
const indexStore = config.indexStore ? new GcsIndexStore(config.indexStore) : null;

const server = http.createServer(createApp({ config, embedder, indexStore }));
server.requestTimeout = Math.max(30_000, config.requestBudgetMs * 4);

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "Community highlight service listening",
      host: config.host,
      port: config.port,
      ranking: embedder ? "hybrid" : "bm25",
      embeddings: embedder?.description ?? null,
      indexedEndpoint: indexStore !== null,
      auth: config.token ? "bearer" : "disabled",
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
