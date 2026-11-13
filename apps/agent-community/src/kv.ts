import { Redis } from "ioredis";

/**
 * The few storage primitives the job store needs. Redis is the production
 * backend (the Firecrawl stack already runs it); the in-memory backend keeps
 * unit and contract tests hermetic.
 */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Set only when absent. Resolves true when this call created the key. */
  setNX(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  del(key: string): Promise<void>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  rpush(key: string, value: string, ttlSeconds?: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lpop(key: string): Promise<string | null>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangeByScore(key: string, min: number, max: number): Promise<string[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

type Entry = { value: string | string[] | Map<string, number>; expiresAt?: number };

export class MemoryKV implements KV {
  private data = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private exp(ttl?: number) {
    return ttl ? Date.now() + ttl * 1000 : undefined;
  }

  async get(key: string) {
    const e = this.live(key);
    return typeof e?.value === "string" ? e.value : null;
  }
  async set(key: string, value: string, ttlSeconds?: number) {
    this.data.set(key, { value, expiresAt: this.exp(ttlSeconds) });
  }
  async setNX(key: string, value: string, ttlSeconds?: number) {
    if (this.live(key)) return false;
    this.data.set(key, { value, expiresAt: this.exp(ttlSeconds) });
    return true;
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async expire(key: string, ttlSeconds: number) {
    const e = this.live(key);
    if (e) e.expiresAt = this.exp(ttlSeconds);
  }
  async rpush(key: string, value: string, ttlSeconds?: number) {
    const e = this.live(key);
    if (e && Array.isArray(e.value)) e.value.push(value);
    else this.data.set(key, { value: [value] });
    if (ttlSeconds) await this.expire(key, ttlSeconds);
  }
  async lrange(key: string, start: number, stop: number) {
    const e = this.live(key);
    if (!e || !Array.isArray(e.value)) return [];
    return e.value.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async lpop(key: string) {
    const e = this.live(key);
    if (!e || !Array.isArray(e.value)) return null;
    return e.value.shift() ?? null;
  }
  private zset(key: string, create: boolean): Map<string, number> | undefined {
    const e = this.live(key);
    if (e && e.value instanceof Map) return e.value;
    if (!create) return undefined;
    const m = new Map<string, number>();
    this.data.set(key, { value: m });
    return m;
  }
  async zadd(key: string, score: number, member: string) {
    this.zset(key, true)!.set(member, score);
  }
  async zrem(key: string, member: string) {
    this.zset(key, false)?.delete(member);
  }
  async zrevrange(key: string, start: number, stop: number) {
    const m = this.zset(key, false);
    if (!m) return [];
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return sorted.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async zrangeByScore(key: string, min: number, max: number) {
    const m = this.zset(key, false);
    if (!m) return [];
    return [...m.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k);
  }
  async ping() {
    return true;
  }
  async close() {}
}

export class RedisKV implements KV {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    this.redis.on("error", () => {
      // ioredis reconnects on its own; readiness reports the outage.
    });
  }

  async get(key: string) {
    return this.redis.get(key);
  }
  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds) await this.redis.set(key, value, "EX", ttlSeconds);
    else await this.redis.set(key, value);
  }
  async setNX(key: string, value: string, ttlSeconds?: number) {
    const r = ttlSeconds
      ? await this.redis.set(key, value, "EX", ttlSeconds, "NX")
      : await this.redis.set(key, value, "NX");
    return r === "OK";
  }
  async del(key: string) {
    await this.redis.del(key);
  }
  async expire(key: string, ttlSeconds: number) {
    await this.redis.expire(key, ttlSeconds);
  }
  async rpush(key: string, value: string, ttlSeconds?: number) {
    const multi = this.redis.multi().rpush(key, value);
    if (ttlSeconds) multi.expire(key, ttlSeconds);
    await multi.exec();
  }
  async lrange(key: string, start: number, stop: number) {
    return this.redis.lrange(key, start, stop);
  }
  async lpop(key: string) {
    return this.redis.lpop(key);
  }
  async zadd(key: string, score: number, member: string) {
    await this.redis.zadd(key, score, member);
  }
  async zrem(key: string, member: string) {
    await this.redis.zrem(key, member);
  }
  async zrevrange(key: string, start: number, stop: number) {
    return this.redis.zrevrange(key, start, stop);
  }
  async zrangeByScore(key: string, min: number, max: number) {
    return this.redis.zrangebyscore(key, min, max);
  }
  async ping() {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
  async close() {
    this.redis.disconnect();
  }
}
