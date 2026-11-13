import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "patchright";
import type { ServiceConfig } from "./config.js";
import { BASIC_LAUNCH_ARGS, STEALTH_LAUNCH_ARGS } from "./stealth.js";

export type BrowserMode = "basic" | "stealth";

interface Generation {
  browser: Browser;
  served: number;
  active: number;
  retiring: boolean;
  version: string;
}

/**
 * One shared Chromium per mode. Every scrape runs in a fresh, isolated
 * BrowserContext that is closed when the scrape ends. Browsers are recycled
 * after a bounded number of contexts (closing only once their in-flight
 * contexts drain) and relaunched transparently after a crash.
 */
export class BrowserPool {
  private readonly current = new Map<BrowserMode, Generation>();
  private readonly launching = new Map<BrowserMode, Promise<Generation>>();
  private readonly draining = new Set<Generation>();
  private closed = false;

  constructor(private readonly config: ServiceConfig) {}

  private async launch(mode: BrowserMode): Promise<Generation> {
    const browser = await chromium.launch({
      headless: this.config.headless,
      channel: this.config.chromiumExecutablePath ? undefined : this.config.browserChannel,
      executablePath: this.config.chromiumExecutablePath,
      args: mode === "stealth" ? STEALTH_LAUNCH_ARGS : BASIC_LAUNCH_ARGS,
      chromiumSandbox: false,
    });
    const generation: Generation = {
      browser,
      served: 0,
      active: 0,
      retiring: false,
      version: browser.version(),
    };
    browser.on("disconnected", () => {
      if (this.current.get(mode) === generation) this.current.delete(mode);
      this.draining.delete(generation);
    });
    return generation;
  }

  private async generation(mode: BrowserMode): Promise<Generation> {
    if (this.closed) throw new Error("browser pool is closed");
    const existing = this.current.get(mode);
    if (existing && existing.browser.isConnected() && !existing.retiring) return existing;
    let pending = this.launching.get(mode);
    if (!pending) {
      pending = this.launch(mode).finally(() => this.launching.delete(mode));
      this.launching.set(mode, pending);
    }
    const generation = await pending;
    this.current.set(mode, generation);
    return generation;
  }

  async browserVersion(mode: BrowserMode): Promise<string> {
    return (await this.generation(mode)).version;
  }

  async withContext<T>(
    mode: BrowserMode,
    options: BrowserContextOptions,
    fn: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const generation = await this.generation(mode);
    generation.active++;
    generation.served++;
    if (generation.served >= this.config.browserRecycleAfter && !generation.retiring) {
      generation.retiring = true;
      this.draining.add(generation);
      if (this.current.get(mode) === generation) this.current.delete(mode);
    }
    let context: BrowserContext | undefined;
    try {
      context = await generation.browser.newContext(options);
      return await fn(context);
    } finally {
      if (context) await context.close().catch(() => undefined);
      generation.active--;
      if (generation.retiring && generation.active === 0) {
        this.draining.delete(generation);
        await generation.browser.close().catch(() => undefined);
      }
    }
  }

  get stats() {
    const out: Record<string, unknown> = {};
    for (const [mode, generation] of this.current) {
      out[mode] = { version: generation.version, served: generation.served, active: generation.active };
    }
    out.draining = this.draining.size;
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.current.values(), ...this.draining];
    this.current.clear();
    this.draining.clear();
    await Promise.all(all.map(generation => generation.browser.close().catch(() => undefined)));
  }
}
