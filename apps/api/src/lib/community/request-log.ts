import type { NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db/connection";
import { isValidUuid } from "../owner-id";
import { logger as _logger } from "../logger";
import { BatchWriter } from "./batch-writer";

const logger = _logger.child({ module: "community-request-log" });

const API_PATH = /^\/v[0-2](\/|$)/;
const UUID_IN_PATH =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_GLOBAL = new RegExp(UUID_IN_PATH.source, "gi");
const TARGET_MAX = 2048;
const ERROR_MAX = 4096;

export type RequestLogEntry = {
  createdAt: Date;
  teamId: string | null;
  apiKeyId: number | null;
  method: string;
  endpoint: string;
  path: string;
  apiVersion: string | null;
  target: string | null;
  statusCode: number;
  durationMs: number;
  jobId: string | null;
  error: string | null;
  origin: string | null;
  zeroDataRetention: boolean;
};

/** What the middleware captured while the controller answered. */
export type CapturedResponse = {
  endpoint: string | null;
  body: unknown;
};

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function describeTarget(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  for (const field of ["url", "query", "prompt"]) {
    const value = body[field];
    if (typeof value === "string" && value.trim() !== "") {
      return truncate(value.trim(), TARGET_MAX);
    }
  }
  const urls = body.urls;
  if (Array.isArray(urls) && urls.length > 0 && typeof urls[0] === "string") {
    const rest = urls.length - 1;
    return truncate(
      rest > 0 ? `${urls[0]} (+${rest} more)` : (urls[0] as string),
      TARGET_MAX,
    );
  }
  return null;
}

function describeJobId(
  responseBody: Record<string, unknown> | null,
  path: string,
): string | null {
  if (responseBody) {
    if (typeof responseBody.id === "string" && responseBody.id) {
      return responseBody.id;
    }
    const data = asRecord(responseBody.data);
    const metadata = asRecord(data?.metadata);
    if (typeof metadata?.scrapeId === "string" && metadata.scrapeId) {
      return metadata.scrapeId;
    }
  }
  const fromPath = path.match(UUID_IN_PATH);
  return fromPath ? fromPath[0] : null;
}

function describeError(
  statusCode: number,
  responseBody: Record<string, unknown> | null,
): string | null {
  if (statusCode < 400 && responseBody?.success !== false) return null;
  const candidate = responseBody?.error ?? responseBody?.message;
  if (typeof candidate === "string" && candidate) {
    return truncate(candidate, ERROR_MAX);
  }
  if (candidate !== undefined && candidate !== null) {
    return truncate(JSON.stringify(candidate), ERROR_MAX);
  }
  return statusCode >= 400 ? `HTTP ${statusCode}` : null;
}

/**
 * The matched route as a pattern ("/v2/crawl/:jobId"). Error handlers answer
 * after Express has restored `baseUrl`, so a bare sub-router path is not
 * trusted; the caller then falls back to the normalized request path.
 */
export function routeEndpoint(
  baseUrl: string | undefined,
  routePath: unknown,
): string | null {
  if (typeof routePath !== "string" || routePath === "") return null;
  if (baseUrl) return `${baseUrl}${routePath}`;
  return API_PATH.test(routePath) ? routePath : null;
}

/**
 * Builds the log row for a finished request. Pure, so the redaction and
 * attribution rules are unit-testable without Express.
 */
export function buildRequestLogEntry(input: {
  method: string;
  path: string;
  requestBody: unknown;
  statusCode: number;
  durationMs: number;
  captured: CapturedResponse;
  teamId: string | null | undefined;
  apiKeyId: number | null | undefined;
  now?: Date;
}): RequestLogEntry {
  const requestBody = asRecord(input.requestBody);
  const responseBody = asRecord(input.captured.body);
  const zeroDataRetention = requestBody?.zeroDataRetention === true;
  const version = input.path.match(/^\/(v[0-2])/)?.[1] ?? null;
  const origin =
    typeof requestBody?.origin === "string"
      ? truncate(requestBody.origin, 128)
      : null;

  return {
    createdAt: input.now ?? new Date(),
    teamId: input.teamId && isValidUuid(input.teamId) ? input.teamId : null,
    apiKeyId:
      typeof input.apiKeyId === "number" && input.apiKeyId > 0
        ? input.apiKeyId
        : null,
    method: input.method,
    endpoint: input.captured.endpoint ?? input.path.replace(UUID_GLOBAL, ":id"),
    path: truncate(input.path, 512),
    apiVersion: version,
    // Zero-data-retention requests keep their metadata but never their target.
    target: zeroDataRetention ? null : describeTarget(requestBody),
    statusCode: input.statusCode,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    jobId: describeJobId(responseBody, input.path),
    error: zeroDataRetention
      ? input.statusCode >= 400
        ? `HTTP ${input.statusCode}`
        : null
      : describeError(input.statusCode, responseBody),
    origin,
    zeroDataRetention,
  };
}

async function insertRequestLogRows(rows: RequestLogEntry[]): Promise<void> {
  if (rows.length === 0) return;
  const values = rows.map(
    row =>
      sql`(${row.createdAt.toISOString()}::timestamptz, ${row.teamId}::uuid, ${row.apiKeyId}::bigint, ${row.method}, ${row.endpoint}, ${row.path}, ${row.apiVersion}, ${row.target}, ${row.statusCode}, ${row.durationMs}, ${row.jobId}, ${row.error}, ${row.origin}, ${row.zeroDataRetention})`,
  );
  await db.execute(sql`
    INSERT INTO community.request_log (
      created_at, team_id, api_key_id, method, endpoint, path, api_version,
      target, status_code, duration_ms, job_id, error, origin,
      zero_data_retention
    ) VALUES ${sql.join(values, sql`, `)}
  `);
}

let writer: BatchWriter<RequestLogEntry> | null = null;

function requestLogWriter(): BatchWriter<RequestLogEntry> {
  writer ??= new BatchWriter<RequestLogEntry>({
    name: "request_log",
    maxQueue: 10_000,
    flushSize: 200,
    flushIntervalMs: 1_000,
    write: insertRequestLogRows,
  });
  return writer;
}

export function isCommunityRequestLogEnabled(): boolean {
  return (
    config.USE_DB_AUTHENTICATION === true &&
    config.COMMUNITY_REQUEST_LOG_ENABLED === true
  );
}

/**
 * Records every versioned API request (status, latency, team, key, target,
 * job id, error) once its response has finished. It only observes: the row is
 * queued in memory and written in the background, so logging never delays or
 * fails an API request.
 */
export function communityRequestLogMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (
      !isCommunityRequestLogEnabled() ||
      req.method === "OPTIONS" ||
      !API_PATH.test(req.path)
    ) {
      return next();
    }

    const startedAt = process.hrtime.bigint();
    const path = req.path;
    const captured: CapturedResponse = { endpoint: null, body: undefined };

    const originalJson = res.json.bind(res);
    res.json = function (body: any) {
      // The route is only known while the controller that matched answers.
      captured.endpoint = routeEndpoint(req.baseUrl, req.route?.path);
      captured.body = body;
      return originalJson(body);
    };

    res.on("finish", () => {
      try {
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const auth = (req as any).auth as { team_id?: string } | undefined;
        const acuc = (req as any).acuc as { api_key_id?: number } | undefined;
        requestLogWriter().push(
          buildRequestLogEntry({
            method: req.method,
            path,
            requestBody: req.body,
            statusCode: res.statusCode,
            durationMs,
            captured,
            teamId: auth?.team_id,
            apiKeyId: acuc?.api_key_id,
          }),
        );
      } catch (error) {
        logger.warn("Failed to build community request log entry", { error });
      }
    });

    next();
  };
}

export async function flushCommunityRequestLog(): Promise<void> {
  await writer?.flush();
}

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
// Arbitrary constant shared by every API process so only one purges at once.
const RETENTION_LOCK_KEY = 4_271_337_060;

/** Deletes request-log rows past COMMUNITY_REQUEST_LOG_RETENTION_DAYS. */
export async function purgeCommunityRequestLog(): Promise<{
  requestLogDeleted: number;
  creditUsageDeleted: number;
} | null> {
  return db.transaction(async tx => {
    const lock = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}) AS held`,
    );
    if ((lock.rows?.[0] as { held?: boolean } | undefined)?.held !== true) {
      return null;
    }
    const result = await tx.execute(
      sql`SELECT * FROM community.purge_expired(${config.COMMUNITY_REQUEST_LOG_RETENTION_DAYS}::integer)`,
    );
    const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
    return {
      requestLogDeleted: Number(row.request_log_deleted ?? 0),
      creditUsageDeleted: Number(row.credit_usage_deleted ?? 0),
    };
  });
}

let retentionTimer: NodeJS.Timeout | null = null;

/** Starts the hourly retention purge in this API process. */
export function startCommunityRequestLogRetention(): void {
  if (!isCommunityRequestLogEnabled() || retentionTimer !== null) return;
  const run = () => {
    purgeCommunityRequestLog()
      .then(result => {
        if (
          result &&
          result.requestLogDeleted + result.creditUsageDeleted > 0
        ) {
          logger.info("Purged expired community request log rows", result);
        }
      })
      .catch(error => {
        logger.warn("Community request log retention purge failed", { error });
      });
  };
  setTimeout(run, 30_000).unref?.();
  retentionTimer = setInterval(run, RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}
