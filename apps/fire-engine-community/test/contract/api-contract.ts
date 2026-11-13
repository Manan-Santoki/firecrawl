import { z } from "zod";

/**
 * Verbatim copies (types only) of the response schemas the Firecrawl API
 * applies to fire-engine responses, from upstream tag v2.11.739:
 *   apps/api/src/scraper/scrapeURL/engines/fire-engine/scrape.ts
 *   apps/api/src/scraper/scrapeURL/engines/fire-engine/checkStatus.ts
 *   apps/api/src/scraper/scrapeURL/engines/fire-engine/fileSchema.ts
 * plus the request builders mirroring scrapeURLWithFireEngineChromeCDP and
 * scrapeURLWithFireEngineTLSClient in fire-engine/index.ts.
 */

const browserCookieSchema = z.object({ name: z.string(), value: z.string() }).passthrough();

export const fireEngineFileSchema = z
  .object({
    name: z.string(),
    content: z.string().optional(),
    gcs_uri: z.string().optional(),
    sha256: z.string().optional(),
    size_bytes: z.number().optional(),
  })
  .refine(f => (f.content !== undefined) !== (f.gcs_uri !== undefined), {
    message: "file must carry exactly one of content or gcs_uri",
  })
  .optional()
  .or(z.null());

const actionResultsSchema = z
  .union([
    z.object({ idx: z.number(), type: z.literal("screenshot"), result: z.object({ path: z.string() }) }),
    z.object({
      idx: z.number(),
      type: z.literal("scrape"),
      result: z.union([
        z.object({ url: z.string(), html: z.string() }),
        z.object({ url: z.string(), accessibility: z.string() }),
      ]),
    }),
    z.object({ idx: z.number(), type: z.literal("executeJavascript"), result: z.object({ return: z.string() }) }),
    z.object({ idx: z.number(), type: z.literal("pdf"), result: z.object({ link: z.string() }) }),
    z.object({
      idx: z.number(),
      type: z.literal("getCookies"),
      result: z.object({ cookies: browserCookieSchema.array() }).passthrough(),
    }),
  ])
  .array()
  .optional();

/** fire-engine/scrape.ts successSchema (POST /scrape). */
export const scrapeSuccessSchema = z.object({
  jobId: z.string().optional(),
  timeTaken: z.number(),
  content: z.string(),
  url: z.string().optional(),
  pageStatusCode: z.number(),
  pageError: z.string().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  screenshots: z.string().array().optional(),
  actionContent: z.object({ url: z.string(), html: z.string() }).array().optional(),
  actionResults: actionResultsSchema,
  file: fireEngineFileSchema,
  docUrl: z.string().optional(),
  usedMobileProxy: z.boolean().optional(),
  youtubeTranscriptContent: z.any().optional(),
  timezone: z.string().optional(),
});

export const scrapeProcessingSchema = z.object({ jobId: z.string(), processing: z.boolean() });

export const scrapeFailedSchema = z.object({
  error: z.string(),
  retryWithStealth: z.boolean().optional(),
  failureReason: z.literal("site_protection").optional(),
});

/** fire-engine/checkStatus.ts schemas (GET /scrape/:jobId). */
export const checkSuccessSchema = scrapeSuccessSchema.extend({
  jobId: z.string(),
  state: z.literal("completed"),
  processing: z.literal(false),
});
export const checkProcessingSchema = z.object({
  jobId: z.string(),
  state: z.enum(["delayed", "active", "waiting", "waiting-children", "unknown", "prioritized", "pending"]),
  processing: z.boolean(),
});
export const checkFailedSchema = z.object({
  jobId: z.string(),
  state: z.literal("failed"),
  processing: z.literal(false),
  error: z.string(),
});

/**
 * Mirrors the error classification the API applies to a failed response
 * (fire-engine/scrape.ts), returning the API error class name.
 */
export function classifyFailure(error: string): string {
  if (error.includes("Chrome error: ")) {
    const code = error.split("Chrome error: ")[1]!;
    return code.includes("ERR_CERT_") || code.includes("ERR_SSL_") || code.includes("ERR_BAD_SSL_") ? "SSLError" : "SiteError";
  }
  if (error.includes("Dns resolution error for hostname: ")) return "DNSResolutionError";
  if (error.includes("File exceeds size limit")) return "UnsupportedFileError";
  if (error.includes("failed to finish without timing out")) return "FEPageLoadFailed";
  if (error.includes("Element") || error.includes("Javascript execution failed")) return "ActionError";
  if (error.includes("proxies available for")) return "ProxySelectionError";
  return "EngineError";
}

type Action = Record<string, unknown> & { type: string };

export interface ScrapeOptionsLike {
  url: string;
  formats?: Array<{ type: string; fullPage?: boolean; viewport?: { width: number; height: number }; quality?: number }>;
  actions?: Action[];
  waitFor?: number;
  headers?: Record<string, string>;
  mobile?: boolean;
  location?: { country?: string; languages?: string[] };
  skipTlsVerification?: boolean;
  proxy?: "basic" | "auto" | "stealth" | "enhanced";
  timeout?: number;
  stealthFlag?: boolean;
  brandingScript?: string;
}

/** Builds the chrome-cdp request exactly as scrapeURLWithFireEngineChromeCDP does. */
export function chromeCdpRequest(options: ScrapeOptionsLike): Record<string, unknown> {
  const formats = options.formats ?? [];
  const has = (type: string) => formats.find(f => f.type === type);
  const wantsRawBase64 = has("rawBase64") !== undefined;
  const hasBranding = has("branding") !== undefined;
  const defaultWait = hasBranding ? 2000 : 0;
  const effectiveWait = wantsRawBase64 ? 0 : options.waitFor ? options.waitFor : defaultWait;
  const screenshot = has("screenshot");
  const actions: Action[] = [
    ...(effectiveWait > 0 ? [{ type: "wait", milliseconds: Math.min(effectiveWait, 30000) }] : []),
    ...(!wantsRawBase64 ? (options.actions ?? []) : []).map(action => {
      const { metadata: _metadata, ...rest } = action;
      return rest as Action;
    }),
    ...(screenshot
      ? [{ type: "screenshot", fullPage: screenshot.fullPage || false, ...(screenshot.viewport ? { viewport: screenshot.viewport } : {}) }]
      : []),
    ...(hasBranding
      ? [{ type: "executeJavascript", script: options.brandingScript ?? "", realViewport: true, metadata: { __firecrawl_internal: true } }]
      : []),
  ];
  return {
    url: options.url,
    scrapeId: "00000000-0000-4000-8000-000000000001",
    team_id: "contract-test",
    engine: "chrome-cdp",
    ...(wantsRawBase64 ? { format: "rawBase64" } : {}),
    instantReturn: false,
    skipTlsVerification: options.skipTlsVerification,
    headers: options.headers,
    ...(actions.length > 0 ? { actions } : {}),
    priority: 10,
    geolocation: options.location,
    mobile: options.mobile,
    timeout: options.timeout ?? 30000,
    disableSmartWaitCache: undefined,
    mobileProxy: options.stealthFlag ?? (options.proxy === "stealth" || options.proxy === "enhanced"),
    autoProxy: options.proxy === "auto",
    maxAge: 0,
    saveScrapeResultToGCS: false,
    zeroDataRetention: false,
    ...(hasBranding ? { blockMedia: false } : {}),
    profile: undefined,
  };
}

/** Builds the tlsclient request exactly as scrapeURLWithFireEngineTLSClient does. */
export function tlsClientRequest(options: ScrapeOptionsLike): Record<string, unknown> {
  return {
    url: options.url,
    scrapeId: "00000000-0000-4000-8000-000000000002",
    engine: "tlsclient",
    instantReturn: false,
    skipTlsVerification: options.skipTlsVerification,
    headers: options.headers,
    priority: 10,
    atsv: undefined,
    geolocation: options.location,
    disableJsDom: true,
    mobileProxy: options.stealthFlag ?? false,
    autoProxy: options.proxy === "auto",
    timeout: options.timeout ?? 15000,
    maxAge: 0,
    saveScrapeResultToGCS: false,
    zeroDataRetention: false,
  };
}

/** Same parsing the API applies to executeJavascript returns. */
export function parseJavascriptReturn(raw: string): { type: string; value: unknown } {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && typeof parsed.type === "string" && "value" in parsed) {
    return { type: String(parsed.type), value: parsed.value };
  }
  return { type: "unknown", value: parsed };
}
