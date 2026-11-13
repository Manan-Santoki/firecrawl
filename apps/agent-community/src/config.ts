import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform(v =>
      v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase()),
    );

const int = (fallback: number, min = 0) =>
  z
    .string()
    .optional()
    .transform(v => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().min(min));

const num = (fallback: number) =>
  z
    .string()
    .optional()
    .transform(v => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().min(0));

const optionalString = z
  .string()
  .optional()
  .transform(v => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: int(3010, 1),

  // Shared secret the Firecrawl API sends as `Authorization: Bearer ...`.
  AGENT_INTEROP_SECRET: optionalString,

  REDIS_URL: optionalString,
  AGENT_STORE: z.enum(["redis", "memory"]).optional(),
  AGENT_REDIS_PREFIX: z.string().default("agent-community"),

  // Model contract. OPENAI_* are the canonical OpenAI-compatible variables;
  // COMMUNITY_MODEL_* is the community distribution contract.
  COMMUNITY_MODEL_PROVIDER: z
    .enum(["openai-compatible", "openai", "ollama"])
    .default("openai-compatible"),
  COMMUNITY_MODEL_NAME: optionalString,
  AGENT_MODEL: optionalString,
  MODEL_NAME: optionalString,
  OPENAI_BASE_URL: optionalString,
  OPENAI_API_KEY: optionalString,
  OLLAMA_BASE_URL: optionalString,
  AGENT_LLM_TIMEOUT_MS: int(120_000, 1000),
  AGENT_LLM_TEMPERATURE: num(0.2),
  AGENT_STRUCTURED_OUTPUT: z
    .enum(["json_schema", "json_object", "prompt"])
    .default("json_schema"),

  // Tools. The service never falls back to Firecrawl Cloud.
  FIRECRAWL_API_URL: optionalString,
  FIRECRAWL_API_KEY: optionalString,
  AGENT_FIRECRAWL_TIMEOUT_MS: int(90_000, 1000),
  AGENT_FIRECRAWL_INTEROP: bool(false),
  AGENT_ENABLE_INTERACT: bool(false),
  AGENT_ALLOW_FIRECRAWL_CLOUD: bool(false),

  // Bounds.
  AGENT_MAX_CONCURRENT_RUNS: int(2, 1),
  AGENT_MAX_STEPS: int(0),
  AGENT_MAX_RUNTIME_SECONDS: int(600, 10),
  AGENT_MAX_TOTAL_TOKENS: int(400_000, 1000),
  AGENT_DEFAULT_MAX_CREDITS: int(2500, 1),
  AGENT_CREDITS_PER_1K_TOKENS: num(0),
  AGENT_MAX_TOOL_RESULT_CHARS: int(12_000, 500),
  AGENT_MAP_CREDITS: int(1),

  // Storage lifetime.
  AGENT_RESULT_TTL_SECONDS: int(86_400, 60),
  AGENT_THREAD_TTL_SECONDS: int(7 * 86_400, 60),

  // Webhooks.
  AGENT_WEBHOOK_SECRET: optionalString,
  AGENT_ALLOW_LOCAL_WEBHOOKS: bool(false),

  AGENT_SKILLS_DIR: optionalString,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AgentServiceConfig = {
  host: string;
  port: number;
  interopSecret: string;
  redisUrl: string | undefined;
  store: "redis" | "memory";
  redisPrefix: string;
  llm: {
    baseUrl: string;
    apiKey: string | undefined;
    model: string;
    timeoutMs: number;
    temperature: number;
    structuredOutput: "json_schema" | "json_object" | "prompt";
  };
  firecrawl: {
    apiUrl: string;
    apiKey: string | undefined;
    timeoutMs: number;
    interop: boolean;
    enableInteract: boolean;
  };
  limits: {
    maxConcurrentRuns: number;
    maxStepsOverride: number;
    maxRuntimeMs: number;
    maxTotalTokens: number;
    defaultMaxCredits: number;
    creditsPer1kTokens: number;
    maxToolResultChars: number;
    mapCredits: number;
  };
  resultTtlSeconds: number;
  threadTtlSeconds: number;
  webhookSecret: string | undefined;
  allowLocalWebhooks: boolean;
  skillsDir: string | undefined;
  logLevel: "debug" | "info" | "warn" | "error";
};

const FIRECRAWL_CLOUD = /(^|\.)firecrawl\.dev$/i;

export function isFirecrawlCloudUrl(value: string): boolean {
  try {
    return FIRECRAWL_CLOUD.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentServiceConfig {
  const e = envSchema.parse(env);

  const model = e.AGENT_MODEL ?? e.COMMUNITY_MODEL_NAME ?? e.MODEL_NAME;
  if (!model) {
    throw new Error("Set AGENT_MODEL (or COMMUNITY_MODEL_NAME) to the model id to use.");
  }

  let baseUrl = e.OPENAI_BASE_URL;
  if (!baseUrl && e.COMMUNITY_MODEL_PROVIDER === "ollama") {
    baseUrl = `${(e.OLLAMA_BASE_URL ?? "http://ollama:11434").replace(/\/$/, "")}/v1`;
  }
  if (!baseUrl && e.COMMUNITY_MODEL_PROVIDER === "openai") {
    baseUrl = "https://api.openai.com/v1";
  }
  if (!baseUrl) {
    throw new Error("Set OPENAI_BASE_URL to an OpenAI-compatible endpoint (for example http://litellm:4000/v1).");
  }

  if (!e.FIRECRAWL_API_URL) {
    throw new Error("Set FIRECRAWL_API_URL to the self-hosted Firecrawl API (for example http://api:3002).");
  }
  if (isFirecrawlCloudUrl(e.FIRECRAWL_API_URL) && !e.AGENT_ALLOW_FIRECRAWL_CLOUD) {
    throw new Error(
      "FIRECRAWL_API_URL points at Firecrawl Cloud. This service is meant for self-hosted Firecrawl; set AGENT_ALLOW_FIRECRAWL_CLOUD=true to override.",
    );
  }

  if (!e.AGENT_INTEROP_SECRET || e.AGENT_INTEROP_SECRET.length < 16) {
    throw new Error(
      "Set AGENT_INTEROP_SECRET (at least 16 characters) to the same value as the Firecrawl API's AGENT_INTEROP_SECRET.",
    );
  }

  const store = e.AGENT_STORE ?? (e.REDIS_URL ? "redis" : "memory");
  if (store === "redis" && !e.REDIS_URL) {
    throw new Error("AGENT_STORE=redis requires REDIS_URL.");
  }

  return {
    host: e.HOST,
    port: e.PORT,
    interopSecret: e.AGENT_INTEROP_SECRET,
    redisUrl: e.REDIS_URL,
    store,
    redisPrefix: e.AGENT_REDIS_PREFIX,
    llm: {
      baseUrl: baseUrl.replace(/\/$/, ""),
      apiKey: e.OPENAI_API_KEY,
      model,
      timeoutMs: e.AGENT_LLM_TIMEOUT_MS,
      temperature: e.AGENT_LLM_TEMPERATURE,
      structuredOutput: e.AGENT_STRUCTURED_OUTPUT,
    },
    firecrawl: {
      apiUrl: e.FIRECRAWL_API_URL.replace(/\/$/, ""),
      apiKey: e.FIRECRAWL_API_KEY,
      timeoutMs: e.AGENT_FIRECRAWL_TIMEOUT_MS,
      interop: e.AGENT_FIRECRAWL_INTEROP,
      enableInteract: e.AGENT_ENABLE_INTERACT,
    },
    limits: {
      maxConcurrentRuns: e.AGENT_MAX_CONCURRENT_RUNS,
      maxStepsOverride: e.AGENT_MAX_STEPS,
      maxRuntimeMs: e.AGENT_MAX_RUNTIME_SECONDS * 1000,
      maxTotalTokens: e.AGENT_MAX_TOTAL_TOKENS,
      defaultMaxCredits: e.AGENT_DEFAULT_MAX_CREDITS,
      creditsPer1kTokens: e.AGENT_CREDITS_PER_1K_TOKENS,
      maxToolResultChars: e.AGENT_MAX_TOOL_RESULT_CHARS,
      mapCredits: e.AGENT_MAP_CREDITS,
    },
    resultTtlSeconds: e.AGENT_RESULT_TTL_SECONDS,
    threadTtlSeconds: e.AGENT_THREAD_TTL_SECONDS,
    webhookSecret: e.AGENT_WEBHOOK_SECRET,
    allowLocalWebhooks: e.AGENT_ALLOW_LOCAL_WEBHOOKS,
    skillsDir: e.AGENT_SKILLS_DIR,
    logLevel: e.LOG_LEVEL,
  };
}
