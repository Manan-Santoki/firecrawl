import { Agent, ProxyAgent, fetch, type Dispatcher } from "undici";
import { resolveProxy, type ProxySettings, type ServiceConfig } from "./config.js";
import { classifyBody, decodeBody, fileNameFor } from "./content.js";
import { ScrapeError, TIMEOUT_MESSAGE, chromeError, classifyFetchError, fileTooLarge } from "./errors.js";
import { resolveLocation } from "./geo.js";
import { isBlockedUrl } from "./net-guard.js";
import type { ScrapeRequest, ScrapeSuccess } from "./schema.js";
import { clientHints } from "./stealth.js";

const MAX_REDIRECTS = 10;

/**
 * The "tlsclient" engine: a plain HTTP client with a Chrome-like header set.
 * Upstream uses a TLS-fingerprinting client; this community implementation
 * uses Node's TLS stack, so JA3/JA4 fingerprints do not match Chrome. The API
 * only selects tlsclient for fast-mode, robots.txt/sitemap fetches and media
 * fallbacks.
 */
export class TlsClientEngine {
  private readonly dispatchers = new Map<string, Dispatcher>();

  constructor(
    private readonly config: ServiceConfig,
    private readonly chromeMajor: () => string,
  ) {}

  private dispatcher(proxy: ProxySettings | undefined, insecure: boolean): Dispatcher {
    const key = `${proxy?.server ?? ""}|${proxy?.username ?? ""}|${insecure}`;
    let dispatcher = this.dispatchers.get(key);
    if (!dispatcher) {
      const connect = { rejectUnauthorized: !insecure };
      if (proxy) {
        const token =
          proxy.username !== undefined
            ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}`
            : undefined;
        dispatcher = new ProxyAgent({ uri: proxy.server, token, requestTls: connect });
      } else {
        dispatcher = new Agent({ connect });
      }
      if (this.dispatchers.size > 64) this.dispatchers.clear();
      this.dispatchers.set(key, dispatcher);
    }
    return dispatcher;
  }

  async scrape(request: ScrapeRequest, stealth: boolean, signal: AbortSignal, startedAt = Date.now()): Promise<ScrapeSuccess> {
    const timeoutMs = Math.min(request.timeout ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs);
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - startedAt)));
    const combined = AbortSignal.any([signal, timeout]);
    const location = resolveLocation(request.geolocation);
    const proxy = resolveProxy(stealth ? (this.config.stealthProxy ?? this.config.proxy) : this.config.proxy, location.country);
    const dispatcher = this.dispatcher(proxy, request.skipTlsVerification === true);

    const major = this.chromeMajor();
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    const headers: Record<string, string> = {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": location.acceptLanguage,
      "accept-encoding": "gzip, deflate, br",
      "upgrade-insecure-requests": "1",
      ...clientHints(userAgent),
    };
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "content-length" || lower === "connection") continue;
      headers[lower] = value;
    }

    let url = request.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw chromeError("net::ERR_INVALID_URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw chromeError("net::ERR_DISALLOWED_URL_SCHEME");
      if (await isBlockedUrl(url, this.config.blockPrivateNetworks)) {
        throw chromeError("net::ERR_ACCESS_DENIED (private network targets are blocked)");
      }
      let response;
      try {
        response = await fetch(url, { headers, redirect: "manual", dispatcher, signal: combined });
      } catch (error) {
        if (signal.aborted) throw new ScrapeError("Scrape cancelled by client");
        if (timeout.aborted) throw new ScrapeError(TIMEOUT_MESSAGE);
        throw classifyFetchError(error, url);
      }
      const redirectTo = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && redirectTo) {
        await response.body?.cancel().catch(() => undefined);
        url = new URL(redirectTo, url).toString();
        continue;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
      });
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > this.config.maxFileBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw fileTooLarge(this.config.maxFileBytes);
      }
      let body: Buffer;
      try {
        body = await readLimited(response.body, this.config.maxFileBytes);
      } catch (error) {
        if (error instanceof ScrapeError) throw error;
        if (timeout.aborted) throw new ScrapeError(TIMEOUT_MESSAGE);
        throw classifyFetchError(error, url);
      }
      const contentType = responseHeaders["content-type"];
      const kind = classifyBody(contentType);
      const binary = kind === "binary";
      return {
        timeTaken: Date.now() - startedAt,
        content: binary ? "" : decodeBody(body, contentType),
        url,
        pageStatusCode: response.status,
        responseHeaders,
        ...(binary || request.format === "rawBase64"
          ? { file: { name: fileNameFor(url), content: body.toString("base64"), size_bytes: body.length } }
          : {}),
        usedMobileProxy: stealth && this.config.stealthProxy !== undefined,
        ...(location.timezone ? { timezone: location.timezone } : {}),
      };
    }
    throw chromeError("net::ERR_TOO_MANY_REDIRECTS");
  }

  async close() {
    await Promise.all([...this.dispatchers.values()].map(d => d.close().catch(() => undefined)));
  }
}

async function readLimited(stream: unknown, limit: number): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) throw fileTooLarge(limit);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
