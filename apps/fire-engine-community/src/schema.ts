import { z } from "zod";

/**
 * Request contract for POST /scrape, derived from the Firecrawl API client in
 * apps/api/src/scraper/scrapeURL/engines/fire-engine/scrape.ts (upstream
 * v2.11.739). Unknown fields are accepted and ignored so that newer API
 * releases that add optional knobs do not fail closed.
 */

const viewportSchema = z.object({
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320),
});

const metadataSchema = z.record(z.string(), z.unknown()).optional();

export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("wait"),
      milliseconds: z.number().nonnegative().optional(),
      selector: z.string().optional(),
      metadata: metadataSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("click"),
      selector: z.string(),
      all: z.boolean().optional(),
      metadata: metadataSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("screenshot"),
      fullPage: z.boolean().optional(),
      quality: z.number().min(1).max(100).optional(),
      viewport: viewportSchema.optional(),
      metadata: metadataSchema,
    })
    .passthrough(),
  z.object({ type: z.literal("write"), text: z.string(), metadata: metadataSchema }).passthrough(),
  z.object({ type: z.literal("press"), key: z.string(), metadata: metadataSchema }).passthrough(),
  z
    .object({
      type: z.literal("scroll"),
      direction: z.enum(["up", "down"]).optional(),
      selector: z.string().optional(),
      metadata: metadataSchema,
    })
    .passthrough(),
  z.object({ type: z.literal("scrape"), metadata: metadataSchema }).passthrough(),
  z
    .object({
      type: z.literal("executeJavascript"),
      script: z.string(),
      realViewport: z.boolean().optional(),
      metadata: metadataSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("pdf"),
      landscape: z.boolean().optional(),
      scale: z.number().positive().max(2).optional(),
      format: z
        .enum(["A0", "A1", "A2", "A3", "A4", "A5", "A6", "Letter", "Legal", "Tabloid", "Ledger"])
        .optional(),
      metadata: metadataSchema,
    })
    .passthrough(),
  z.object({ type: z.literal("getCookies"), metadata: metadataSchema }).passthrough(),
]);

export type ScrapeAction = z.infer<typeof actionSchema>;

const geolocationSchema = z
  .object({
    country: z.string().optional(),
    languages: z.array(z.string()).optional(),
  })
  .passthrough();

export const scrapeRequestSchema = z
  .object({
    url: z.string().min(1),
    engine: z.enum(["chrome-cdp", "tlsclient", "playwright"]).default("chrome-cdp"),
    scrapeId: z.string().optional(),
    team_id: z.string().optional(),
    format: z.enum(["html", "rawBase64"]).optional(),
    headers: z.record(z.string(), z.string()).optional().nullable(),
    blockMedia: z.boolean().optional(),
    forceNonRender: z.boolean().optional(),
    priority: z.number().optional(),
    instantReturn: z.boolean().optional(),
    geolocation: geolocationSchema.optional().nullable(),
    mobile: z.boolean().optional().nullable(),
    mobileProxy: z.boolean().optional(),
    autoProxy: z.boolean().optional(),
    skipTlsVerification: z.boolean().optional().nullable(),
    timeout: z.number().positive().optional(),
    actions: z.array(actionSchema).max(100).optional(),
    disableSmartWaitCache: z.boolean().optional(),
    profile: z.object({ owner: z.string().optional(), name: z.string() }).passthrough().optional(),
    pdfMaxSize: z.number().optional(),
    // Accepted for contract compatibility; the community service never writes
    // to Firecrawl Cloud storage and keeps nothing after the response.
    maxAge: z.number().optional(),
    saveScrapeResultToGCS: z.boolean().optional(),
    zeroDataRetention: z.boolean().optional(),
    logRequest: z.boolean().optional(),
    atsv: z.boolean().optional(),
    disableJsDom: z.boolean().optional(),
    behaviorOverrides: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;

export type ActionResult =
  | { idx: number; type: "screenshot"; result: { path: string } }
  | { idx: number; type: "scrape"; result: { url: string; html: string } }
  | { idx: number; type: "executeJavascript"; result: { return: string } }
  | { idx: number; type: "pdf"; result: { link: string } }
  | { idx: number; type: "getCookies"; result: { cookies: Array<Record<string, unknown>> } };

export interface ScrapeSuccess {
  jobId?: string;
  timeTaken: number;
  content: string;
  url: string;
  pageStatusCode: number;
  pageError?: string;
  responseHeaders: Record<string, string>;
  screenshots?: string[];
  actionContent?: Array<{ url: string; html: string }>;
  actionResults?: ActionResult[];
  file?: { name: string; content: string; size_bytes?: number } | null;
  usedMobileProxy: boolean;
  timezone?: string;
}

export interface ScrapeFailure {
  error: string;
}

export const searchRequestSchema = z
  .object({
    query: z.string().min(1).max(2048),
    lang: z.string().optional(),
    country: z.string().optional(),
    location: z.string().optional(),
    tbs: z.string().optional(),
    numResults: z.number().int().min(0).max(1000).default(5),
    page: z.number().int().min(1).max(100).default(1),
    type: z.union([z.string(), z.array(z.string())]).optional(),
    safe: z.string().optional(),
    includeDomains: z.array(z.string()).optional(),
    excludeDomains: z.array(z.string()).optional(),
  })
  .passthrough();

export type SearchRequest = z.infer<typeof searchRequestSchema>;
