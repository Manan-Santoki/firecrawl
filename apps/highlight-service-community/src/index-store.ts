import { createSign } from "node:crypto";
import TurndownService from "turndown";
import { gfm } from "joplin-turndown-plugin-gfm";
import type { IndexStoreConfig } from "./config.js";

// Reads the Firecrawl index objects that `/batch_highlight_indexed` refers to.
// The API writes each object with `saveIndexToGCS` as `{id}.json` containing
// `{ url, html, statusCode, ... }` in GCS_INDEX_BUCKET_NAME. This reader speaks
// the public GCS JSON API, so it works against Google Cloud Storage, the
// `fake-gcs-server` emulator, or any compatible gateway.

export class IndexObjectError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface IndexStore {
  /** Returns the page markdown, or null when the object does not exist. */
  loadMarkdown(objectName: string, signal: AbortSignal): Promise<string | null>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,1023}$/;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** HTML beyond this many characters is ignored to bound conversion time. */
const MAX_HTML_CHARS = 2_000_000;
let turndown: TurndownService | null = null;

export function htmlToMarkdown(html: string): string {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    turndown.use(gfm);
    turndown.remove(["script", "style", "noscript", "iframe", "svg", "head", "nav", "footer", "form"] as never);
  }
  return turndown.turndown(html.slice(0, MAX_HTML_CHARS));
}

function looksLikeHtml(content: string): boolean {
  return /<(?:html|body|div|p|h[1-6]|article|main|section|table|ul|ol|span|a)\b/i.test(content.slice(0, 20_000));
}

export class GcsIndexStore implements IndexStore {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;
  private readonly serviceAccount: ServiceAccount | null;

  constructor(private readonly config: IndexStoreConfig) {
    this.serviceAccount = config.credentials ? GcsIndexStore.parseCredentials(config.credentials) : null;
  }

  private static parseCredentials(encoded: string): ServiceAccount {
    let parsed: unknown;
    try {
      const raw = encoded.trim().startsWith("{") ? encoded : Buffer.from(encoded, "base64").toString("utf8");
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("GCS_CREDENTIALS must be base64-encoded service-account JSON");
    }
    const account = parsed as Partial<ServiceAccount>;
    if (typeof account.client_email !== "string" || typeof account.private_key !== "string") {
      throw new Error("GCS_CREDENTIALS is missing client_email or private_key");
    }
    return account as ServiceAccount;
  }

  private async authorization(signal: AbortSignal): Promise<string | undefined> {
    if (this.config.staticToken) return `Bearer ${this.config.staticToken}`;
    if (!this.serviceAccount) return undefined;
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return `Bearer ${this.accessToken.value}`;
    }
    this.tokenPromise ??= this.fetchAccessToken(signal).finally(() => {
      this.tokenPromise = null;
    });
    return `Bearer ${await this.tokenPromise}`;
  }

  private async fetchAccessToken(signal: AbortSignal): Promise<string> {
    const account = this.serviceAccount!;
    const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/devstorage.read_only",
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${base64url(signer.sign(account.private_key))}`;
    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal,
    });
    if (!response.ok) {
      throw new IndexObjectError(`GCS token exchange failed with HTTP ${response.status}`, response.status);
    }
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new IndexObjectError("GCS token exchange returned no access_token");
    this.accessToken = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return data.access_token;
  }

  async loadMarkdown(objectName: string, parentSignal: AbortSignal): Promise<string | null> {
    if (!OBJECT_NAME.test(objectName) || objectName.split("/").includes("..")) {
      throw new IndexObjectError("invalid index object name", 400);
    }
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(this.config.timeoutMs)]);
    const headers: Record<string, string> = {};
    const authorization = await this.authorization(signal);
    if (authorization) headers.authorization = authorization;

    const url =
      `${this.config.endpoint}/storage/v1/b/${encodeURIComponent(this.config.bucket)}` +
      `/o/${encodeURIComponent(objectName)}?alt=media`;
    const response = await fetch(url, { headers, signal });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new IndexObjectError(`index object HTTP ${response.status}`, response.status);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > this.config.maxObjectBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new IndexObjectError("index object exceeds INDEX_MAX_OBJECT_BYTES", 413);
    }
    const text = await readBounded(response, this.config.maxObjectBytes);
    let doc: { html?: unknown; markdown?: unknown; statusCode?: unknown };
    try {
      doc = JSON.parse(text);
    } catch {
      throw new IndexObjectError("index object is not valid JSON");
    }
    if (typeof doc.statusCode === "number" && (doc.statusCode < 200 || doc.statusCode >= 300)) {
      return null;
    }
    if (typeof doc.markdown === "string" && doc.markdown.trim()) return doc.markdown;
    if (typeof doc.html !== "string" || !doc.html.trim()) return null;
    return looksLikeHtml(doc.html) ? htmlToMarkdown(doc.html) : doc.html;
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new IndexObjectError("index object exceeds INDEX_MAX_OBJECT_BYTES", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
