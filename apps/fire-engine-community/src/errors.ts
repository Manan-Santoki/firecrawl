/**
 * Error strings are part of the contract: the Firecrawl API classifies a
 * failed fire-engine job by substring (see fire-engine/scrape.ts and
 * checkStatus.ts upstream). Keep these messages stable.
 *
 *  - "Chrome error: <code>"              -> SiteError, or SSLError for ERR_CERT_/ERR_SSL_
 *  - "Dns resolution error for hostname: " -> DNSResolutionError
 *  - "File exceeds size limit"            -> UnsupportedFileError
 *  - "failed to finish without timing out" -> FEPageLoadFailed
 *  - "Element ..." / "Javascript execution failed" -> ActionError (user-visible)
 *  - anything else                        -> EngineError (falls back to the next engine)
 */
export class ScrapeError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 500,
  ) {
    super(message);
    this.name = "ScrapeError";
  }
}

export const TIMEOUT_MESSAGE = "Scrape failed to finish without timing out";

export function dnsError(hostname: string): ScrapeError {
  return new ScrapeError(`Dns resolution error for hostname: ${hostname}`);
}

export function chromeError(code: string): ScrapeError {
  return new ScrapeError(`Chrome error: ${code}`);
}

export function elementError(detail: string): ScrapeError {
  return new ScrapeError(`Element ${detail}`);
}

export function javascriptError(detail: string): ScrapeError {
  return new ScrapeError(`Javascript execution failed: ${detail}`);
}

export function fileTooLarge(limit: number): ScrapeError {
  return new ScrapeError(`File exceeds size limit of ${limit} bytes`);
}

export class CapacityError extends ScrapeError {
  constructor(detail: string) {
    super(`fire-engine-community capacity exceeded: ${detail}`, 429);
  }
}

/**
 * Translates a Playwright navigation error into the contract vocabulary.
 */
export function classifyNavigationError(error: unknown, url: string): ScrapeError {
  if (error instanceof ScrapeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const netCode = /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1];
  if (netCode === "ERR_NAME_NOT_RESOLVED" || netCode === "ERR_NAME_RESOLUTION_FAILED") {
    let hostname = url;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // keep raw url
    }
    return dnsError(hostname);
  }
  if (netCode) return chromeError(`net::${netCode}`);
  if (/Timeout \d+ms exceeded|timed out/i.test(message)) {
    return new ScrapeError(TIMEOUT_MESSAGE);
  }
  return new ScrapeError(`Navigation failed: ${sanitize(message)}`);
}

/** Translates an undici/Node network error for the tlsclient engine. */
export function classifyFetchError(error: unknown, url: string): ScrapeError {
  if (error instanceof ScrapeError) return error;
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code ?? "";
  const message = `${(error as Error)?.message ?? ""} ${cause?.message ?? ""}`;
  let hostname = url;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // keep raw url
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return dnsError(hostname);
  if (
    /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/i.test(code) ||
    /certificate|self[- ]signed|SSL/i.test(message)
  ) {
    return chromeError("net::ERR_CERT_AUTHORITY_INVALID");
  }
  if (code === "ECONNREFUSED") return chromeError("net::ERR_CONNECTION_REFUSED");
  if (code === "ECONNRESET") return chromeError("net::ERR_CONNECTION_RESET");
  if (code === "UND_ERR_CONNECT_TIMEOUT") return chromeError("net::ERR_CONNECTION_TIMED_OUT");
  if ((error as Error)?.name === "AbortError" || (error as Error)?.name === "TimeoutError") {
    return new ScrapeError(TIMEOUT_MESSAGE);
  }
  return new ScrapeError(`Request failed: ${sanitize(message.trim() || code)}`);
}

/**
 * Error strings are logged by the API. Strip Playwright call logs and keep
 * them short; never include proxy credentials.
 */
export function sanitize(message: string): string {
  const firstLine = message.split("\n")[0] ?? message;
  return firstLine.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***:***@").slice(0, 500);
}
