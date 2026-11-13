import { logger as _logger } from "../logger";

const logger = _logger.child({ module: "community-batch-writer" });

type BatchWriterOptions<T> = {
  name: string;
  /** Rows held in memory at most; further rows are dropped and counted. */
  maxQueue: number;
  /** A flush starts as soon as this many rows are queued. */
  flushSize: number;
  flushIntervalMs: number;
  write: (rows: T[]) => Promise<void>;
};

/**
 * Collects rows in memory and writes them in batches off the request path.
 * `push` never blocks and never throws: when the database is slow or down the
 * queue fills, further rows are dropped (and counted), and the API keeps
 * answering requests at full speed.
 */
export class BatchWriter<T> {
  private queue: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private dropped = 0;
  private lastFailureLogAt = 0;

  constructor(private readonly options: BatchWriterOptions<T>) {}

  push(row: T): void {
    if (this.queue.length >= this.options.maxQueue) {
      this.dropped++;
      return;
    }
    this.queue.push(row);
    if (this.queue.length >= this.options.flushSize) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.options.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  get stats(): { queued: number; dropped: number } {
    return { queued: this.queue.length, dropped: this.dropped };
  }

  /** Writes everything queued so far. Resolves even when the write fails. */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
    }
    if (this.queue.length === 0) return;
    const rows = this.queue.splice(0, this.queue.length);
    this.flushing = (async () => {
      try {
        for (let i = 0; i < rows.length; i += this.options.flushSize) {
          await this.options.write(rows.slice(i, i + this.options.flushSize));
        }
      } catch (error) {
        this.dropped += rows.length;
        const now = Date.now();
        if (now - this.lastFailureLogAt > 60_000) {
          this.lastFailureLogAt = now;
          logger.warn("Community batch write failed; rows dropped", {
            writer: this.options.name,
            rows: rows.length,
            droppedTotal: this.dropped,
            error,
          });
        }
      } finally {
        this.flushing = null;
      }
    })();
    await this.flushing;
  }
}
