/**
 * Minimal client for the operator's own Firecrawl API. Only the endpoints the
 * agent uses as tools; there is no default URL, so nothing can silently reach
 * Firecrawl Cloud.
 */
export type FirecrawlClientOptions = {
  apiUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  /** When set, scrape and search carry `__agentInterop` so the API attributes them to the agent run. */
  interop?: { secret: string; requestId: string; shouldBill: boolean };
};

export class FirecrawlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FirecrawlError";
  }
}

export type SearchHit = { url: string; title?: string; description?: string };
export type ScrapeResult = {
  url: string;
  markdown: string;
  title?: string;
  statusCode?: number;
  scrapeId?: string;
  creditsUsed: number;
};

export class FirecrawlClient {
  constructor(private opts: FirecrawlClientOptions) {}

  private async call(
    method: "POST" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<any> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const res = await fetch(`${this.opts.apiUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // fall through with the raw text in the error
    }
    if (!res.ok || json?.success === false) {
      const detail = typeof json?.error === "string" ? json.error : text.slice(0, 300);
      throw new FirecrawlError(res.status, `Firecrawl ${path} failed (${res.status}): ${detail}`);
    }
    return json;
  }

  private interop(): Record<string, unknown> {
    const i = this.opts.interop;
    return i ? { __agentInterop: { auth: i.secret, requestId: i.requestId, shouldBill: i.shouldBill } } : {};
  }

  async search(
    input: { query: string; limit?: number; country?: string; safe?: boolean },
    signal?: AbortSignal,
  ): Promise<{ hits: SearchHit[]; creditsUsed: number }> {
    const json = await this.call(
      "POST",
      "/v2/search",
      {
        query: input.query,
        limit: Math.min(Math.max(input.limit ?? 5, 1), 10),
        ...(input.country ? { country: input.country } : {}),
        ...(input.safe ? { safe: true } : {}),
        origin: "agent-community",
        ...this.interop(),
      },
      signal,
    );
    const data = json?.data;
    const rows: any[] = Array.isArray(data) ? data : [...(data?.web ?? []), ...(data?.news ?? [])];
    return {
      hits: rows
        .filter(r => typeof r?.url === "string")
        .map(r => ({ url: r.url, title: r.title, description: r.description ?? r.snippet })),
      creditsUsed: typeof json?.creditsUsed === "number" ? json.creditsUsed : rows.length > 0 ? 1 : 0,
    };
  }

  async scrape(
    input: { url: string; location?: { country?: string; languages?: string[] } },
    signal?: AbortSignal,
  ): Promise<ScrapeResult> {
    const json = await this.call(
      "POST",
      "/v2/scrape",
      {
        url: input.url,
        formats: ["markdown"],
        onlyMainContent: true,
        ...(input.location?.country ? { location: input.location } : {}),
        origin: "agent-community",
        ...this.interop(),
      },
      signal,
    );
    const d = json?.data ?? {};
    const meta = d.metadata ?? {};
    return {
      url: meta.sourceURL ?? meta.url ?? input.url,
      markdown: typeof d.markdown === "string" ? d.markdown : "",
      title: meta.title,
      statusCode: meta.statusCode,
      scrapeId: meta.scrapeId,
      creditsUsed: typeof meta.creditsUsed === "number" ? meta.creditsUsed : 1,
    };
  }

  async map(input: { url: string; search?: string; limit?: number }, signal?: AbortSignal): Promise<string[]> {
    const json = await this.call(
      "POST",
      "/v2/map",
      {
        url: input.url,
        ...(input.search ? { search: input.search } : {}),
        limit: Math.min(Math.max(input.limit ?? 100, 1), 500),
        origin: "agent-community",
      },
      signal,
    );
    const links: any[] = json?.links ?? [];
    return links.map(l => (typeof l === "string" ? l : l?.url)).filter((u): u is string => typeof u === "string");
  }

  async interact(
    input: { scrapeId: string; prompt?: string; code?: string },
    signal?: AbortSignal,
  ): Promise<{ output?: string; stdout?: string; result?: unknown; error?: string }> {
    const json = await this.call(
      "POST",
      `/v2/scrape/${encodeURIComponent(input.scrapeId)}/interact`,
      input.code ? { code: input.code, language: "node", timeout: 60 } : { prompt: input.prompt, timeout: 60 },
      signal,
    );
    return { output: json?.output, stdout: json?.stdout, result: json?.result, error: json?.error };
  }

  async stopInteract(scrapeId: string): Promise<number> {
    try {
      const json = await this.call("DELETE", `/v2/scrape/${encodeURIComponent(scrapeId)}/interact`, undefined);
      return typeof json?.creditsBilled === "number" ? json.creditsBilled : 0;
    } catch {
      return 0;
    }
  }
}
