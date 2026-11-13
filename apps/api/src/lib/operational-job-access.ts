import { config } from "../config";
import { isUuidV7Id } from "./bigtable-row-key";
import { logger } from "./logger";
import {
  readApiJobAccess,
  type ApiJobAccess,
  type ApiJobKind,
} from "./job-access-store";

type OperationalJobAccess = {
  teamId: string;
  kind: ApiJobKind;
  clientOrigin?: string;
  expiresAtMs: number;
  zeroDataRetentionMinutes?: number;
};

/**
 * Who owns a job and until when it may be fetched, from the Bigtable job
 * access row that logRequest (and, for crawl and batch children, logScrape)
 * writes. A missing or expired row is the documented end of the job's
 * fetchable life; there is no other store to ask. A failed read is an
 * outage, not a missing job: it is rethrown so the caller answers an error
 * rather than a 404 for a job that exists.
 */
async function resolveOperationalJobAccess(params: {
  id: string;
  kinds: readonly ApiJobKind[];
}): Promise<OperationalJobAccess | null> {
  // An id that is not a UUIDv7 names no row: not found, not an outage.
  if (!isUuidV7Id(params.id)) return null;
  let access: ApiJobAccess | null;
  try {
    access = await readApiJobAccess(params.id);
  } catch (error) {
    logger.error("Bigtable job access read failed", {
      error,
      jobId: params.id,
    });
    throw error;
  }
  if (!access) return null;
  return params.kinds.includes(access.kind) ? access : null;
}

export function getScrapeJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["scrape"] });
}

export function getExtractJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["extract", "agent"] });
}

// Same lifetime as the default Bigtable access row (JOB_ACCESS_TTL_MS).
const AGENT_SERVICE_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Community self-host fallback: without a Bigtable job access table, nothing
 * records who owns an agent run, but the agent service behind
 * EXTRACT_V3_BETA_URL does. Its status response carries the run's `teamId`
 * and `createdAt`, so ownership is read from there and the run stays
 * fetchable for 24 hours from its start, like a default access row. A 404
 * (or a ZDR run whose result is gone) is a missing job; any other failure is
 * an outage and is rethrown, matching the Bigtable path.
 */
async function resolveAgentAccessFromService(
  id: string,
): Promise<OperationalJobAccess | null> {
  if (!isUuidV7Id(id)) return null;
  const base = config.EXTRACT_V3_BETA_URL!.replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(
      `${base}/internal/extracts/${encodeURIComponent(id)}`,
      {
        headers: { Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    logger.error("Agent service job access read failed", { error, jobId: id });
    throw error;
  }
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error("Agent service job access read failed", {
      status: response.status,
      text,
      jobId: id,
    });
    throw new Error(`Agent service returned ${response.status}: ${text}`);
  }
  const body = (await response.json().catch(() => null)) as {
    teamId?: unknown;
    createdAt?: unknown;
    zeroDataRetentionMinutes?: unknown;
  } | null;
  const createdAtMs =
    typeof body?.createdAt === "string" ? Date.parse(body.createdAt) : NaN;
  if (typeof body?.teamId !== "string" || !Number.isFinite(createdAtMs)) {
    // An agent service without the ownership fields cannot authorize reads.
    logger.error("Agent service status has no teamId/createdAt", { jobId: id });
    return null;
  }
  const zdrMinutes = body.zeroDataRetentionMinutes;
  return {
    teamId: body.teamId,
    kind: "agent",
    expiresAtMs: createdAtMs + AGENT_SERVICE_ACCESS_TTL_MS,
    ...(typeof zdrMinutes === "number" &&
    Number.isFinite(zdrMinutes) &&
    zdrMinutes > 0
      ? { zeroDataRetentionMinutes: zdrMinutes }
      : {}),
  };
}

export function getAgentJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  if (!config.BIGTABLE_JOB_ACCESS_TABLE && config.EXTRACT_V3_BETA_URL) {
    return resolveAgentAccessFromService(id);
  }
  return resolveOperationalJobAccess({ id, kinds: ["agent"] });
}

export function getCrawlJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["crawl", "batch_scrape"] });
}
