import "server-only";
import { env } from "./env";

export class FirecrawlApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "FirecrawlApiError";
  }
}

/**
 * Calls the deployment's own Firecrawl API (FIRECRAWL_API_URL, normally the
 * internal Compose address) with a key of the team the action is for. Never
 * reaches Firecrawl Cloud.
 */
export async function firecrawlRequest<T = unknown>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(path, env().FIRECRAWL_API_URL);
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Origin": "community-dashboard",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    cache: "no-store",
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page; keep the text.
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Firecrawl API answered HTTP ${response.status}`;
    throw new FirecrawlApiError(response.status, message, body);
  }
  return body as T;
}
