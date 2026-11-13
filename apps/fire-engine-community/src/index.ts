import http from "node:http";
import { BrowserPool } from "./browser-pool.js";
import { loadConfig } from "./config.js";
import { ScrapeService, type Logger } from "./scrape-service.js";
import { SearchService } from "./search.js";
import { createApp } from "./server.js";

const logger: Logger = {
  info: (message, meta) => console.log(JSON.stringify({ level: "info", message, ...meta })),
  warn: (message, meta) => console.warn(JSON.stringify({ level: "warn", message, ...meta })),
};

const config = loadConfig();
const pool = new BrowserPool(config);
const scrapes = new ScrapeService(config, pool, logger);
const search = new SearchService(config);

const server = http.createServer(
  createApp({ scrapes, search, apiKey: config.apiKey, stats: () => pool.stats }),
);
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  logger.info("fire-engine-community listening", {
    host: config.host,
    port: config.port,
    maxConcurrentScrapes: config.maxConcurrentScrapes,
    proxy: config.proxy ? "configured" : "none",
    stealthProxy: config.stealthProxy ? "configured" : "none",
    searchBackend: search.backend,
    auth: config.apiKey ? "enabled" : "disabled",
  });
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  server.close();
  await scrapes.close();
  await pool.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
