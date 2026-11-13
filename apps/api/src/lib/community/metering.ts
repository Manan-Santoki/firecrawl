import { sql } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db/connection";
import { isValidUuid } from "../owner-id";
import { logger as _logger } from "../logger";

const logger = _logger.child({ module: "community-metering" });

// Limits and windows change rarely; a short cache keeps the gate to one
// database round trip per team every few seconds under load.
const GATE_CACHE_TTL_MS = 5_000;
const TEAM_LIMITS_CACHE_TTL_MS = 30_000;
// What an unlimited team reports as its remaining balance. Finite, so the
// upstream 402 payloads that echo it stay valid JSON numbers.
const UNLIMITED_REMAINING = 2_147_483_647;

/**
 * Community metering replaces Firecrawl Cloud billing only when Cloud billing
 * is not configured, the deployment authenticates against its own database,
 * and the operator has not opted out with SELF_HOSTED_BILLING_MODE=disabled.
 */
export function isCommunityMeteringEnabled(): boolean {
  return (
    config.USE_DB_AUTHENTICATION === true &&
    config.SELF_HOSTED_BILLING_MODE === "metered"
  );
}

export type CreditGateState = {
  teamLimit: number | null;
  teamInterval: string | null;
  teamUsed: number | null;
  keyLimit: number | null;
  keyInterval: string | null;
  keyUsed: number | null;
};

export type CreditGateDecision = {
  allowed: boolean;
  /** The team's remaining credits in its window (large when unlimited). */
  remaining: number;
  /** Which limit refused, when one did. */
  limitedBy: "team" | "api_key" | null;
};

/**
 * Decides a credit check from the current window usage. Returns null when
 * neither the team nor the key has a limit, which callers treat exactly like
 * an unconfigured billing service: allow without clamping.
 */
export function evaluateCreditGate(
  state: CreditGateState,
  requested: number,
): CreditGateDecision | null {
  const hasTeamLimit = state.teamLimit !== null;
  const hasKeyLimit = state.keyLimit !== null;
  if (!hasTeamLimit && !hasKeyLimit) return null;

  const teamRemaining = hasTeamLimit
    ? Math.max(0, state.teamLimit! - (state.teamUsed ?? 0))
    : UNLIMITED_REMAINING;
  const keyRemaining = hasKeyLimit
    ? Math.max(0, state.keyLimit! - (state.keyUsed ?? 0))
    : UNLIMITED_REMAINING;
  const value = Math.max(0, requested);

  if (value > teamRemaining) {
    return { allowed: false, remaining: teamRemaining, limitedBy: "team" };
  }
  if (value > keyRemaining) {
    // The team still covers the request; the key's own cap refused it. The
    // upstream middleware turns this into its `api_key_spend_limit` 402.
    return { allowed: false, remaining: teamRemaining, limitedBy: "api_key" };
  }
  return { allowed: true, remaining: teamRemaining, limitedBy: null };
}

const gateCache = new Map<string, { at: number; state: CreditGateState }>();

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readGateState(
  teamId: string,
  apiKeyId: number | null,
): Promise<CreditGateState> {
  const cacheKey = `${teamId}:${apiKeyId ?? ""}`;
  const cached = gateCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GATE_CACHE_TTL_MS) {
    return cached.state;
  }
  const result = await db.execute(
    sql`SELECT * FROM community.credit_gate_state(${teamId}::uuid, ${apiKeyId}::bigint)`,
  );
  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
  const state: CreditGateState = {
    teamLimit: toNumberOrNull(row.team_limit),
    teamInterval: (row.team_interval as string | null) ?? null,
    teamUsed: toNumberOrNull(row.team_used),
    keyLimit: toNumberOrNull(row.key_limit),
    keyInterval: (row.key_interval as string | null) ?? null,
    keyUsed: toNumberOrNull(row.key_used),
  };
  if (gateCache.size > 10_000) gateCache.clear();
  gateCache.set(cacheKey, { at: Date.now(), state });
  return state;
}

function apiKeyIdFrom(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

/**
 * The community credit gate, in the shape of AutumnService.checkCredits.
 * Null means "no limit applies" (or the gate could not be read, which fails
 * open with a warning, matching upstream's billing-outage behavior).
 */
export async function checkCommunityCredits(params: {
  teamId: string;
  value: number;
  properties?: Record<string, unknown>;
}): Promise<{ allowed: boolean; remaining: number } | null> {
  if (!isCommunityMeteringEnabled() || !isValidUuid(params.teamId)) {
    return null;
  }
  try {
    const state = await readGateState(
      params.teamId,
      apiKeyIdFrom(params.properties?.apiKeyId),
    );
    const decision = evaluateCreditGate(state, params.value);
    if (decision === null) return null;
    return { allowed: decision.allowed, remaining: decision.remaining };
  } catch (error) {
    logger.warn("Community credit gate unavailable; failing open", {
      teamId: params.teamId,
      error,
    });
    return null;
  }
}

/**
 * Appends one charge to community.credit_usage. Fire-and-forget: billing
 * callers never wait on, or fail because of, the ledger write.
 */
export function recordCommunityCreditUsage(params: {
  teamId: string;
  value: number;
  properties?: Record<string, unknown>;
}): void {
  if (!isCommunityMeteringEnabled() || !isValidUuid(params.teamId)) return;
  if (!Number.isFinite(params.value) || params.value === 0) return;
  const endpoint =
    typeof params.properties?.endpoint === "string"
      ? params.properties.endpoint
      : "unknown";
  const jobId =
    typeof params.properties?.jobId === "string"
      ? params.properties.jobId
      : null;
  const apiKeyId = apiKeyIdFrom(params.properties?.apiKeyId);

  void db
    .execute(
      sql`INSERT INTO community.credit_usage (team_id, api_key_id, endpoint, job_id, credits)
          VALUES (${params.teamId}::uuid, ${apiKeyId}::bigint, ${endpoint}, ${jobId}, ${params.value})`,
    )
    .then(() => {
      // The next gate check for this team must see the new charge.
      for (const key of gateCache.keys()) {
        if (key.startsWith(`${params.teamId}:`)) gateCache.delete(key);
      }
    })
    .catch(error => {
      logger.warn("Failed to record community credit usage", {
        teamId: params.teamId,
        value: params.value,
        endpoint,
        error,
      });
    });
}

const teamLimitsCache = new Map<
  string,
  { at: number; concurrency: number | null }
>();

/**
 * The operator-set concurrency for a team (community.team_limits), else
 * COMMUNITY_DEFAULT_CONCURRENCY_LIMIT, else null for upstream's default.
 */
export async function getCommunityConcurrencyLimit(
  teamId: string,
): Promise<number | null> {
  if (config.USE_DB_AUTHENTICATION !== true || !isValidUuid(teamId)) {
    return null;
  }
  const fallback = config.COMMUNITY_DEFAULT_CONCURRENCY_LIMIT ?? null;
  const cached = teamLimitsCache.get(teamId);
  if (cached && Date.now() - cached.at < TEAM_LIMITS_CACHE_TTL_MS) {
    return cached.concurrency ?? fallback;
  }
  try {
    const result = await db.execute(
      sql`SELECT concurrency_limit FROM community.team_limits WHERE team_id = ${teamId}::uuid`,
    );
    const concurrency = toNumberOrNull(
      (result.rows?.[0] as Record<string, unknown> | undefined)
        ?.concurrency_limit,
    );
    if (teamLimitsCache.size > 10_000) teamLimitsCache.clear();
    teamLimitsCache.set(teamId, { at: Date.now(), concurrency });
    return concurrency ?? fallback;
  } catch (error) {
    logger.warn("Failed to read community team limits", { teamId, error });
    return fallback;
  }
}
