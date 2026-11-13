import { CapacityError } from "./errors.js";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/**
 * Bounded concurrency with a bounded FIFO queue. Requests beyond the queue
 * limit, or waiting longer than the queue timeout, are rejected with a
 * CapacityError so the Firecrawl API falls through to its next engine instead
 * of piling up browser contexts.
 */
export class Limiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
    private readonly queueTimeoutMs: number,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new CapacityError("request aborted while queued"));
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new CapacityError(`${this.active} active, ${this.queue.length} queued`));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: undefined, signal, onAbort: undefined };
      const drop = (error: Error) => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        this.cleanup(waiter);
        reject(error);
      };
      if (this.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => drop(new CapacityError("queue wait timeout")), this.queueTimeoutMs);
      }
      if (signal) {
        waiter.onAbort = () => drop(new CapacityError("request aborted while queued"));
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private cleanup(waiter: Waiter) {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        this.cleanup(next);
        next.resolve(this.releaser());
      } else {
        this.active--;
      }
    };
  }
}
