import { loadConfig } from "./config.js";
import { MemoryKV, RedisKV } from "./kv.js";
import { createLogger } from "./logger.js";
import { AgentRunner } from "./runner.js";
import { createApp } from "./server.js";
import { defaultSkillsDir, loadSkills } from "./skills.js";
import { JobStore } from "./store.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);

const kv = config.store === "redis" ? new RedisKV(config.redisUrl!) : new MemoryKV();
if (config.store === "memory") {
  logger.warn("Using the in-memory job store; runs are lost on restart. Set REDIS_URL for durable state.");
}
const store = new JobStore(kv, {
  prefix: config.redisPrefix,
  resultTtlSeconds: config.resultTtlSeconds,
  threadTtlSeconds: config.threadTtlSeconds,
});
const skills = loadSkills([defaultSkillsDir(), ...(config.skillsDir ? [config.skillsDir] : [])]);
const runner = new AgentRunner({ config, store, skills, logger });
const app = createApp({ config, store, runner, logger });

const server = app.listen(config.port, config.host, () => {
  logger.info("agent service listening", {
    host: config.host,
    port: config.port,
    store: config.store,
    model: config.llm.model,
    firecrawlApiUrl: config.firecrawl.apiUrl,
    skills: skills.map(s => s.name),
    maxConcurrentRuns: config.limits.maxConcurrentRuns,
  });
  runner.start();
});

async function shutdown(signal: string) {
  logger.info("shutting down", { signal });
  server.close();
  await runner.stop();
  await kv.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
