import "server-only";
import Redis from "ioredis";
import { env } from "./env";

type Clients = { rateLimit: Redis | null; evict: Redis | null };
const globalForRedis = globalThis as unknown as { __dashboardRedis?: Clients };

function connect(url: string | undefined): Redis | null {
  if (!url) return null;
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    enableOfflineQueue: false,
  });
}

function clients(): Clients {
  if (!globalForRedis.__dashboardRedis) {
    const config = env();
    const rateLimitUrl = config.REDIS_RATE_LIMIT_URL ?? config.REDIS_URL;
    const rateLimit = connect(rateLimitUrl);
    const evictUrl = config.REDIS_EVICT_URL ?? rateLimitUrl;
    const evict = evictUrl === rateLimitUrl ? rateLimit : connect(evictUrl);
    rateLimit?.on("error", () => undefined);
    evict?.on("error", () => undefined);
    globalForRedis.__dashboardRedis = { rateLimit, evict };
  }
  return globalForRedis.__dashboardRedis;
}

/** Redis holding the API's crawl state (read-only use). */
export function crawlRedis(): Redis | null {
  return clients().evict;
}

export function rateLimitRedis(): Redis | null {
  return clients().rateLimit;
}

/**
 * The API caches each key's auth chunk (team, ban flag, limits) for up to ten
 * minutes. After revoking a key, disabling a user or changing limits, drop
 * those entries so the change applies to the next request.
 */
export function authCacheKeys(apiKeys: { id: number | string; key: string }[], teamId?: string): string[] {
  const keys: string[] = [];
  for (const apiKey of apiKeys) {
    for (const purpose of ["general", "hosted_mcp_oauth"]) {
      for (const mode of ["scrape", "extract"]) {
        keys.push(`acuc_${purpose}_${apiKey.key}_${mode}`);
      }
    }
    keys.push(`api-key-concurrency:${apiKey.id}`);
  }
  if (teamId) {
    keys.push(`acuc_team_${teamId}_scrape`, `acuc_team_${teamId}_extract`);
  }
  return keys;
}

export async function invalidateAuthCache(
  apiKeys: { id: number | string; key: string }[],
  teamId?: string,
): Promise<boolean> {
  const redis = rateLimitRedis();
  const keys = authCacheKeys(apiKeys, teamId);
  if (!redis || keys.length === 0) return false;
  try {
    await redis.del(...keys);
    return true;
  } catch {
    return false;
  }
}
