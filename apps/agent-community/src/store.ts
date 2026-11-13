import type { KV } from "./kv.js";
import { isTerminal, type AgentRun, type AgentThread, type TraceEvent } from "./types.js";

export type StoreOptions = {
  prefix: string;
  resultTtlSeconds: number;
  threadTtlSeconds: number;
};

const ZDR_TOMBSTONE_SECONDS = 7 * 86_400;
const MAX_TEAM_INDEX = 200;

/**
 * All durable job state lives here. Runs, traces and snapshots expire with the
 * result TTL (24h by default, matching the API's job access window); a zero
 * data retention run expires after its own retention and leaves a tombstone so
 * status reads answer 410 zdr_expired instead of 404.
 */
export class JobStore {
  constructor(
    readonly kv: KV,
    private opts: StoreOptions,
  ) {}

  private k(...parts: string[]) {
    return [this.opts.prefix, ...parts].join(":");
  }

  private ttlFor(run: AgentRun): number {
    if (run.zeroDataRetention && run.zeroDataRetentionMinutes && isTerminal(run)) {
      return Math.max(60, Math.round(run.zeroDataRetentionMinutes * 60));
    }
    return this.opts.resultTtlSeconds;
  }

  async createRun(run: AgentRun): Promise<boolean> {
    const created = await this.kv.setNX(this.k("run", run.id), JSON.stringify(run), this.ttlFor(run));
    if (created) {
      await this.kv.zadd(this.k("team", run.teamId), Date.parse(run.createdAt), run.id);
      await this.kv.expire(this.k("team", run.teamId), this.opts.resultTtlSeconds);
    }
    return created;
  }

  async getRun(id: string): Promise<AgentRun | null> {
    const raw = await this.kv.get(this.k("run", id));
    return raw ? (JSON.parse(raw) as AgentRun) : null;
  }

  async saveRun(run: AgentRun): Promise<void> {
    const ttl = this.ttlFor(run);
    const toStore = isTerminal(run) ? { ...run, apiKey: undefined } : run;
    await this.kv.set(this.k("run", run.id), JSON.stringify(toStore), ttl);
    if (isTerminal(run)) {
      for (const key of [this.k("events", run.id), this.k("snapshots", run.id)]) {
        await this.kv.expire(key, ttl);
      }
      if (run.zeroDataRetention) {
        await this.kv.set(this.k("zdr", run.id), "1", ttl + ZDR_TOMBSTONE_SECONDS);
      }
    }
  }

  async isZdrExpired(id: string): Promise<boolean> {
    return (await this.kv.get(this.k("zdr", id))) !== null;
  }

  async listTeamRuns(teamId: string, limit: number): Promise<AgentRun[]> {
    const ids = await this.kv.zrevrange(this.k("team", teamId), 0, MAX_TEAM_INDEX - 1);
    const runs: AgentRun[] = [];
    for (const id of ids) {
      const run = await this.getRun(id);
      if (run) runs.push(run);
      else await this.kv.zrem(this.k("team", teamId), id);
      if (runs.length >= limit) break;
    }
    return runs;
  }

  // Cancellation is a separate key so the runner's whole-record writes can
  // never drop a concurrent cancel.
  async requestCancel(id: string): Promise<void> {
    await this.kv.set(this.k("cancel", id), "1", this.opts.resultTtlSeconds);
  }

  async isCancelRequested(id: string): Promise<boolean> {
    return (await this.kv.get(this.k("cancel", id))) !== null;
  }

  async appendEvent(id: string, event: TraceEvent): Promise<void> {
    await this.kv.rpush(this.k("events", id), JSON.stringify(event), this.opts.resultTtlSeconds);
  }

  async getEvents(id: string): Promise<TraceEvent[]> {
    return (await this.kv.lrange(this.k("events", id), 0, -1)).map(e => JSON.parse(e) as TraceEvent);
  }

  async saveSnapshot(id: string, snapshotId: string, content: string): Promise<void> {
    await this.kv.set(this.k("snapshot", id, snapshotId), content, this.opts.resultTtlSeconds);
    await this.kv.rpush(this.k("snapshots", id), snapshotId, this.opts.resultTtlSeconds);
  }

  async getSnapshot(id: string, snapshotId: string): Promise<string | null> {
    return this.kv.get(this.k("snapshot", id, snapshotId));
  }

  async getSkill(id: string): Promise<string | null> {
    return this.kv.get(this.k("skill", id));
  }

  async saveSkill(id: string, value: string): Promise<void> {
    await this.kv.set(this.k("skill", id), value, this.opts.resultTtlSeconds);
  }

  // --- Threads ---

  async getThread(id: string): Promise<AgentThread | null> {
    const raw = await this.kv.get(this.k("thread", id));
    return raw ? (JSON.parse(raw) as AgentThread) : null;
  }

  async saveThread(thread: AgentThread): Promise<void> {
    await this.kv.set(this.k("thread", thread.id), JSON.stringify(thread), this.opts.threadTtlSeconds);
  }

  async isThreadExpired(id: string): Promise<boolean> {
    return (await this.kv.get(this.k("thread-gone", id))) !== null;
  }

  /** Record that a thread existed so a later read can answer 410, not 404. */
  async markThreadKnown(id: string): Promise<void> {
    await this.kv.set(this.k("thread-gone", id), "1", this.opts.threadTtlSeconds * 4);
  }

  /** One run at a time per thread. Resolves the holder when the lock is taken. */
  async lockThread(threadId: string, runId: string): Promise<string | null> {
    const key = this.k("thread-lock", threadId);
    if (await this.kv.setNX(key, runId, this.opts.resultTtlSeconds)) return null;
    const holder = await this.kv.get(key);
    if (holder) {
      const run = await this.getRun(holder);
      if (run && !isTerminal(run)) return holder;
    }
    // Stale lock from a finished or expired run: take it over.
    await this.kv.set(key, runId, this.opts.resultTtlSeconds);
    return null;
  }

  async unlockThread(threadId: string, runId: string): Promise<void> {
    const key = this.k("thread-lock", threadId);
    if ((await this.kv.get(key)) === runId) await this.kv.del(key);
  }

  // --- Queue and liveness ---

  async enqueue(id: string): Promise<void> {
    await this.kv.rpush(this.k("queue"), id);
  }

  async dequeue(): Promise<string | null> {
    return this.kv.lpop(this.k("queue"));
  }

  async heartbeat(id: string): Promise<void> {
    await this.kv.zadd(this.k("active"), Date.now(), id);
  }

  async clearActive(id: string): Promise<void> {
    await this.kv.zrem(this.k("active"), id);
  }

  /** Runs whose worker stopped heart-beating (process crash or restart). */
  async staleActive(olderThanMs: number): Promise<string[]> {
    return this.kv.zrangeByScore(this.k("active"), 0, Date.now() - olderThanMs);
  }
}
