import "server-only";
import { audit } from "./audit";
import { assertCanManageTeam, ForbiddenError, resolveScope, scopeClause, type Viewer } from "./authz";
import { callAs } from "./call-as";
import { query } from "./db";
import { env } from "./env";
import { FirecrawlApiError } from "./firecrawl-api";

/** The agent backend is optional; these answers mean "not available here", not "your run failed". */
export class AgentUnavailableError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

/**
 * The API hides "Agent beta is not enabled." behind a generic 500, so when the
 * operator has not configured the agent service (AGENT_SERVICE_URL on the
 * dashboard) any 5xx from an agent endpoint is treated as "not available".
 */
export function isAgentUnavailable(error: unknown, agentConfigured = true): boolean {
  if (!(error instanceof FirecrawlApiError)) return false;
  if (!agentConfigured && error.status >= 500) return true;
  if (error.status === 501 || error.status === 503) return true;
  if (error.status === 404 && /not found|cannot (get|post)/i.test(error.message) && !/agent job/i.test(error.message)) return true;
  return error.status >= 500 && /not enabled|not configured|unavailable/i.test(error.message);
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isAgentUnavailable(error, Boolean(env().AGENT_SERVICE_URL))) {
      const apiError = error as FirecrawlApiError;
      throw new AgentUnavailableError(apiError.status, apiError.message);
    }
    throw error;
  }
}

export type AgentRunRow = { id: string; teamId: string; userEmail: string | null; prompt: string | null; createdAt: string; statusCode: number };

/** Runs started through the API (any client), from the community request log. */
export async function listAgentRuns(viewer: Viewer, teamFilter?: string | null): Promise<AgentRunRow[]> {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, teamFilter), "r.team_id", params);
  const rows = await query<Record<string, unknown>>(
    `SELECT r.job_id, r.team_id, u.email, r.target, r.created_at, r.status_code
     FROM community.request_log r LEFT JOIN dashboard."user" u ON u."teamId" = r.team_id
     WHERE ${where} AND r.method = 'POST' AND r.endpoint IN ('/v2/agent', '/v1/agent') AND r.job_id IS NOT NULL
     ORDER BY r.created_at DESC LIMIT 100`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.job_id),
    teamId: String(row.team_id),
    userEmail: (row.email as string | null) ?? null,
    prompt: (row.target as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    statusCode: Number(row.status_code),
  }));
}

async function runTeam(viewer: Viewer, runId: string): Promise<string> {
  const rows = await query<{ team_id: string }>(
    `SELECT team_id FROM community.request_log
     WHERE job_id = $1 AND method = 'POST' AND endpoint IN ('/v2/agent', '/v1/agent') AND team_id IS NOT NULL
     ORDER BY created_at LIMIT 1`,
    [runId],
  );
  const teamId = rows[0]?.team_id;
  if (!teamId) throw new ForbiddenError("Agent run not found.");
  assertCanManageTeam(viewer, teamId);
  return teamId;
}

export async function startAgent(
  viewer: Viewer,
  input: { prompt: string; urls?: string[]; schema?: unknown; maxCredits?: number; effort?: "low" | "medium" | "high" },
): Promise<{ id: string }> {
  if (!viewer.teamId) throw new ForbiddenError("Your account has no Firecrawl team.");
  const result = await guard(() =>
    callAs<{ id: string }>(viewer, viewer.teamId!, "/v2/agent", {
      method: "POST",
      body: { ...input, origin: "community-dashboard" },
    }),
  );
  await audit(viewer.userId, "agent.started", { teamId: viewer.teamId }, { runId: result.id });
  return { id: result.id };
}

export type AgentStatus = {
  status: "processing" | "completed" | "failed";
  error?: string;
  data?: unknown;
  creditsUsed?: number;
  expiresAt?: string;
  model?: string;
};

export async function agentDetail(viewer: Viewer, runId: string) {
  const teamId = await runTeam(viewer, runId);
  const status = await guard(() => callAs<AgentStatus>(viewer, teamId, `/v2/agent/${runId}`));
  let trace: { events: Array<Record<string, unknown>>; activeBrowserSessions?: { id: string; liveViewUrl: string }[] } | null = null;
  try {
    trace = await callAs(viewer, teamId, `/v2/agent/${runId}/trace?liveView=true`);
  } catch {
    trace = null;
  }
  return { teamId, status, trace };
}

export async function cancelAgent(viewer: Viewer, runId: string): Promise<void> {
  const teamId = await runTeam(viewer, runId);
  await guard(() => callAs(viewer, teamId, `/v2/agent/${runId}`, { method: "DELETE" }));
  await audit(viewer.userId, "agent.cancelled", { teamId }, { runId });
}

export async function agentSkill(viewer: Viewer, runId: string) {
  const teamId = await runTeam(viewer, runId);
  return guard(() =>
    callAs<{ skill: { name: string; skillMd: string; spec?: unknown; workflow?: unknown; schema?: unknown } }>(
      viewer,
      teamId,
      `/v2/agent/${runId}/skill`,
    ),
  );
}
