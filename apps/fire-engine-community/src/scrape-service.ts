/*
 * The detect-then-retry flow in runBrowser/runTls follows the anti-bot retry
 * loop in Crawl4AI `crawl4ai/async_webcrawler.py` (commit
 * cae74b203a33994f7e13b9052c3b0d5c93daa0e6, Apache-2.0; see
 * THIRD_PARTY_NOTICES.md), reduced to one stealth retry inside the original
 * time budget.
 */
import { randomUUID } from "node:crypto";
import { detectBlock } from "./antibot.js";
import type { BrowserPool } from "./browser-pool.js";
import { ChromeCdpEngine } from "./cdp-engine.js";
import type { ServiceConfig } from "./config.js";
import { ScrapeError, sanitize } from "./errors.js";
import { Limiter } from "./limiter.js";
import type { ScrapeRequest, ScrapeSuccess } from "./schema.js";
import { TlsClientEngine } from "./tls-engine.js";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ScrapeRunner {
  run(request: ScrapeRequest, signal: AbortSignal): Promise<ScrapeSuccess>;
}

type JobState =
  | { state: "active"; controller: AbortController; expires: number }
  | { state: "completed"; result: ScrapeSuccess; expires: number }
  | { state: "failed"; error: string; expires: number };

/**
 * Scrape orchestration: admission control, engine selection, anti-bot retry
 * and the optional asynchronous job store used by `instantReturn` clients.
 */
export class ScrapeService implements ScrapeRunner {
  readonly limiter: Limiter;
  private readonly cdp: ChromeCdpEngine;
  private readonly tls: TlsClientEngine;
  private readonly jobs = new Map<string, JobState>();
  private chromeMajor = "151";
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly config: ServiceConfig,
    private readonly pool: BrowserPool,
    private readonly logger: Logger,
  ) {
    this.limiter = new Limiter(config.maxConcurrentScrapes, config.maxQueuedScrapes, config.queueTimeoutMs);
    this.cdp = new ChromeCdpEngine(config, pool);
    this.tls = new TlsClientEngine(config, () => this.chromeMajor);
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  async run(request: ScrapeRequest, signal: AbortSignal): Promise<ScrapeSuccess> {
    const release = await this.limiter.acquire(signal);
    const startedAt = Date.now();
    try {
      if (request.engine === "tlsclient") return await this.runTls(request, signal, startedAt);
      return await this.runBrowser(request, signal, startedAt);
    } finally {
      release();
    }
  }

  private canRetry(request: ScrapeRequest, startedAt: number): boolean {
    if (!this.config.antibotRetry || request.mobileProxy === true) return false;
    // Safe Mode disables site handling and anti-detection; never escalate.
    const overrides = request.behaviorOverrides ?? {};
    if (overrides.disableSiteHandling === true || overrides.exposeWebdriver === true) return false;
    const budget = Math.min(request.timeout ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs);
    return startedAt + budget - Date.now() >= this.config.antibotRetryMinBudgetMs;
  }

  private async runBrowser(request: ScrapeRequest, signal: AbortSignal, startedAt: number): Promise<ScrapeSuccess> {
    const mode = request.mobileProxy === true ? "stealth" : "basic";
    const result = await this.cdp.scrape(request, mode, signal, startedAt);
    this.chromeMajor = (await this.pool.browserVersion(mode)).split(".")[0] ?? this.chromeMajor;
    if (result.file || !this.canRetry(request, startedAt)) return result;
    const verdict = detectBlock(result.pageStatusCode, result.content);
    if (!verdict.blocked) return result;
    this.logger.info("anti-bot block detected, retrying in stealth mode", {
      reason: verdict.reason,
      stealthProxy: this.config.stealthProxy !== undefined,
    });
    try {
      const retried = await this.cdp.scrape(request, "stealth", signal, startedAt);
      return retried;
    } catch (error) {
      this.logger.warn("stealth retry failed; returning the original response", {
        error: sanitize(error instanceof Error ? error.message : String(error)),
      });
      return result;
    }
  }

  private async runTls(request: ScrapeRequest, signal: AbortSignal, startedAt: number): Promise<ScrapeSuccess> {
    const stealth = request.mobileProxy === true;
    const result = await this.tls.scrape(request, stealth, signal, startedAt);
    // Without a different egress there is nothing a plain HTTP retry can change.
    if (stealth || !this.config.stealthProxy || result.file || !this.canRetry(request, startedAt)) return result;
    const verdict = detectBlock(result.pageStatusCode, result.content);
    if (!verdict.blocked) return result;
    this.logger.info("anti-bot block detected on tlsclient, retrying through the stealth proxy", { reason: verdict.reason });
    try {
      return await this.tls.scrape(request, true, signal, startedAt);
    } catch {
      return result;
    }
  }

  // ---- asynchronous job API (instantReturn: true) ----

  startJob(request: ScrapeRequest): string {
    const jobId = request.scrapeId && !this.jobs.has(request.scrapeId) ? request.scrapeId : randomUUID();
    const controller = new AbortController();
    const ttl = this.config.jobTtlMs;
    this.jobs.set(jobId, { state: "active", controller, expires: Date.now() + ttl + this.config.maxTimeoutMs });
    this.run(request, controller.signal).then(
      result => {
        if (this.jobs.has(jobId)) this.jobs.set(jobId, { state: "completed", result, expires: Date.now() + ttl });
      },
      error => {
        if (this.jobs.has(jobId)) {
          this.jobs.set(jobId, {
            state: "failed",
            error: error instanceof ScrapeError ? error.message : sanitize(String((error as Error)?.message ?? error)),
            expires: Date.now() + ttl,
          });
        }
      },
    );
    return jobId;
  }

  jobStatus(jobId: string): Record<string, unknown> | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (job.state === "active") return { jobId, state: "active", processing: true };
    if (job.state === "failed") return { jobId, state: "failed", processing: false, error: job.error };
    return { ...job.result, jobId, state: "completed", processing: false };
  }

  deleteJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.state === "active") job.controller.abort();
    this.jobs.delete(jobId);
    return true;
  }

  get jobCount(): number {
    return this.jobs.size;
  }

  private sweep() {
    const now = Date.now();
    for (const [jobId, job] of this.jobs) {
      if (job.expires < now) this.deleteJob(jobId);
    }
  }

  async close() {
    clearInterval(this.sweeper);
    for (const jobId of [...this.jobs.keys()]) this.deleteJob(jobId);
    await this.tls.close();
  }
}
