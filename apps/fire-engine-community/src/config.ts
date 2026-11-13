export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

export interface ServiceConfig {
  host: string;
  port: number;
  apiKey: string;
  maxConcurrentScrapes: number;
  maxQueuedScrapes: number;
  queueTimeoutMs: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  navigationLoadCapMs: number;
  networkIdleCapMs: number;
  maxFileBytes: number;
  maxContentBytes: number;
  blockPrivateNetworks: boolean;
  blockAds: boolean;
  antibotRetry: boolean;
  antibotRetryMinBudgetMs: number;
  browserRecycleAfter: number;
  browserChannel: string | undefined;
  chromiumExecutablePath: string | undefined;
  headless: boolean;
  proxy: ProxySettings | undefined;
  stealthProxy: ProxySettings | undefined;
  jobTtlMs: number;
  searxngEndpoint: string | undefined;
  searxngEngines: string | undefined;
  searxngCategories: string | undefined;
  searchDuckDuckGoFallback: boolean;
  searchTimeoutMs: number;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

function proxy(env: NodeJS.ProcessEnv, prefix: string): ProxySettings | undefined {
  const server = str(env, `${prefix}_SERVER`);
  if (!server) return undefined;
  return {
    server,
    username: str(env, `${prefix}_USERNAME`),
    password: str(env, `${prefix}_PASSWORD`),
    bypass: str(env, `${prefix}_BYPASS`),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    host: str(env, "HOST") ?? "0.0.0.0",
    port: int(env, "PORT", 3010, 1),
    apiKey: str(env, "FIRE_ENGINE_API_KEY") ?? "",
    maxConcurrentScrapes: int(env, "MAX_CONCURRENT_SCRAPES", 4, 1),
    maxQueuedScrapes: int(env, "MAX_QUEUED_SCRAPES", 32, 0),
    queueTimeoutMs: int(env, "QUEUE_TIMEOUT_MS", 30_000, 0),
    defaultTimeoutMs: int(env, "DEFAULT_SCRAPE_TIMEOUT_MS", 60_000, 1_000),
    maxTimeoutMs: int(env, "MAX_SCRAPE_TIMEOUT_MS", 180_000, 1_000),
    navigationLoadCapMs: int(env, "NAVIGATION_LOAD_CAP_MS", 15_000, 0),
    networkIdleCapMs: int(env, "NETWORK_IDLE_CAP_MS", 2_000, 0),
    maxFileBytes: int(env, "MAX_FILE_BYTES", 50 * 1024 * 1024, 1),
    maxContentBytes: int(env, "MAX_CONTENT_BYTES", 25 * 1024 * 1024, 1),
    blockPrivateNetworks: bool(env, "BLOCK_PRIVATE_NETWORKS", true),
    blockAds: bool(env, "BLOCK_ADS", true),
    antibotRetry: bool(env, "ANTIBOT_RETRY", true),
    antibotRetryMinBudgetMs: int(env, "ANTIBOT_RETRY_MIN_BUDGET_MS", 8_000, 0),
    browserRecycleAfter: int(env, "BROWSER_RECYCLE_AFTER", 250, 1),
    browserChannel: str(env, "BROWSER_CHANNEL") ?? "chromium",
    chromiumExecutablePath: str(env, "CHROMIUM_EXECUTABLE_PATH"),
    headless: bool(env, "BROWSER_HEADLESS", true),
    proxy: proxy(env, "PROXY"),
    stealthProxy: proxy(env, "STEALTH_PROXY"),
    jobTtlMs: int(env, "JOB_TTL_MS", 10 * 60_000, 1_000),
    searxngEndpoint: str(env, "SEARXNG_ENDPOINT"),
    searxngEngines: str(env, "SEARXNG_ENGINES"),
    searxngCategories: str(env, "SEARXNG_CATEGORIES"),
    searchDuckDuckGoFallback: bool(env, "SEARCH_DUCKDUCKGO_FALLBACK", true),
    searchTimeoutMs: int(env, "SEARCH_TIMEOUT_MS", 10_000, 500),
  };
}

/**
 * Operator proxies may embed a `{country}` placeholder in the username (a
 * common convention for geo-targeted residential/mobile proxy providers). It
 * is substituted with the request's ISO country code, or removed when absent.
 */
export function resolveProxy(
  settings: ProxySettings | undefined,
  country: string | undefined,
): ProxySettings | undefined {
  if (!settings) return undefined;
  const substitute = (value: string | undefined) =>
    value?.replaceAll("{country}", country ?? "").replaceAll("{COUNTRY}", (country ?? "").toUpperCase());
  return {
    server: settings.server,
    username: substitute(settings.username),
    password: substitute(settings.password),
    bypass: settings.bypass,
  };
}
