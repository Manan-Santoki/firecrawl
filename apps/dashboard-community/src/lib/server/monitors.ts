import "server-only";
import { audit } from "./audit";
import { assertCanManageTeam, ForbiddenError, resolveScope, scopeClause, type Viewer } from "./authz";
import { callAs } from "./call-as";
import { query } from "./db";

export type MonitorRow = {
  id: string;
  teamId: string;
  userEmail: string | null;
  name: string;
  status: string;
  cron: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  targetCount: number;
  lastSummary: Record<string, number> | null;
};

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

/** Monitors are read straight from public.monitors (scoped); changes go through the API. */
export async function listMonitors(viewer: Viewer, teamFilter?: string | null): Promise<MonitorRow[]> {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, teamFilter), "m.team_id", params);
  const rows = await query<Record<string, unknown>>(
    `SELECT m.id, m.team_id, u.email, m.name, m.status, m.schedule_cron, m.schedule_timezone, m.next_run_at,
            m.last_run_at, jsonb_array_length(m.targets) AS target_count, m.last_check_summary
     FROM public.monitors m LEFT JOIN dashboard."user" u ON u."teamId" = m.team_id
     WHERE ${where} AND m.deleted_at IS NULL ORDER BY m.created_at DESC`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    teamId: String(row.team_id),
    userEmail: (row.email as string | null) ?? null,
    name: String(row.name),
    status: String(row.status),
    cron: String(row.schedule_cron),
    timezone: String(row.schedule_timezone),
    nextRunAt: iso(row.next_run_at),
    lastRunAt: iso(row.last_run_at),
    targetCount: Number(row.target_count ?? 0),
    lastSummary: (row.last_check_summary as Record<string, number> | null) ?? null,
  }));
}

async function monitorTeam(viewer: Viewer, monitorId: string): Promise<string> {
  const rows = await query<{ team_id: string }>(
    `SELECT team_id FROM public.monitors WHERE id = $1::uuid AND deleted_at IS NULL`,
    [monitorId],
  );
  const teamId = rows[0]?.team_id;
  if (!teamId) throw new ForbiddenError("Monitor not found.");
  assertCanManageTeam(viewer, teamId);
  return teamId;
}

export type MonitorInput = {
  name: string;
  schedule: { cron?: string; text?: string; timezone: string };
  urls: string[];
  formats: string[];
  webhookUrl?: string | null;
  retentionDays: number;
  goal?: string | null;
};

function toApiBody(input: MonitorInput): Record<string, unknown> {
  return {
    name: input.name,
    schedule: input.schedule.cron
      ? { cron: input.schedule.cron, timezone: input.schedule.timezone }
      : { text: input.schedule.text, timezone: input.schedule.timezone },
    targets: [{ type: "scrape", urls: input.urls, scrapeOptions: { formats: input.formats } }],
    ...(input.webhookUrl ? { webhook: input.webhookUrl } : {}),
    retentionDays: input.retentionDays,
    ...(input.goal ? { goal: input.goal } : {}),
  };
}

export async function createMonitor(viewer: Viewer, input: MonitorInput) {
  if (!viewer.teamId) throw new ForbiddenError("Your account has no Firecrawl team.");
  const body = await callAs<{ data: { id: string } }>(viewer, viewer.teamId, "/v2/monitor", {
    method: "POST",
    body: { ...toApiBody(input), origin: "community-dashboard" },
  });
  await audit(viewer.userId, "monitor.created", { teamId: viewer.teamId }, { monitorId: body.data.id });
  return body.data;
}

export async function updateMonitor(viewer: Viewer, monitorId: string, input: Partial<MonitorInput> & { status?: "active" | "paused" }) {
  const teamId = await monitorTeam(viewer, monitorId);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.status) patch.status = input.status;
  if (input.urls && input.schedule && input.formats && input.retentionDays !== undefined) {
    Object.assign(patch, toApiBody(input as MonitorInput));
  }
  await callAs(viewer, teamId, `/v2/monitor/${monitorId}`, { method: "PATCH", body: patch });
  await audit(viewer.userId, "monitor.updated", { teamId }, { monitorId, status: input.status });
}

export async function deleteMonitor(viewer: Viewer, monitorId: string) {
  const teamId = await monitorTeam(viewer, monitorId);
  await callAs(viewer, teamId, `/v2/monitor/${monitorId}`, { method: "DELETE" });
  await audit(viewer.userId, "monitor.deleted", { teamId }, { monitorId });
}

export async function runMonitor(viewer: Viewer, monitorId: string) {
  const teamId = await monitorTeam(viewer, monitorId);
  return callAs<{ id: string }>(viewer, teamId, `/v2/monitor/${monitorId}/run`, { method: "POST", body: {} });
}

export type MonitorDetail = {
  id: string;
  name: string;
  status: string;
  schedule: { cron: string; timezone: string };
  targets: Array<Record<string, unknown>>;
  webhook: unknown;
  retentionDays: number;
  goal: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  estimatedCreditsPerMonth: number | null;
};

export type MonitorCheck = {
  id: string;
  status: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  actualCredits: number | null;
  summary: { totalPages: number; same: number; changed: number; new: number; removed: number; error: number } | null;
  error: string | null;
  createdAt: string;
};

export async function getMonitor(viewer: Viewer, monitorId: string) {
  const teamId = await monitorTeam(viewer, monitorId);
  const [monitor, checks] = await Promise.all([
    callAs<{ data: MonitorDetail }>(viewer, teamId, `/v2/monitor/${monitorId}`),
    callAs<{ data: MonitorCheck[] }>(viewer, teamId, `/v2/monitor/${monitorId}/checks?limit=50`),
  ]);
  return { teamId, monitor: monitor.data, checks: checks.data };
}

export type CheckPage = {
  id: string;
  url: string;
  status: "same" | "new" | "changed" | "removed" | "error";
  statusCode: number | null;
  error: string | null;
  diff: { text?: string; json?: unknown } | null;
  judgment: { meaningful: boolean; reason: string } | null;
};

export async function getCheck(viewer: Viewer, monitorId: string, checkId: string) {
  const teamId = await monitorTeam(viewer, monitorId);
  const body = await callAs<{ data: MonitorCheck & { pages: CheckPage[] } }>(
    viewer,
    teamId,
    `/v2/monitor/${monitorId}/checks/${checkId}?limit=100`,
  );
  return body.data;
}
