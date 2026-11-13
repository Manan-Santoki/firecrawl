import "server-only";
import { audit } from "./audit";
import { assertCanManageTeam, ForbiddenError, resolveScope, scopeClause, type Viewer } from "./authz";
import { callAs } from "./call-as";
import { query } from "./db";

export type BrowserSessionRow = {
  id: string;
  teamId: string;
  userEmail: string | null;
  status: string;
  streamWebView: boolean;
  createdAt: string;
  updatedAt: string;
  creditsUsed: number | null;
};

export async function listBrowserSessions(viewer: Viewer, options: { teamId?: string | null; includeClosed?: boolean } = {}) {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, options.teamId), "b.team_id", params);
  const rows = await query<Record<string, unknown>>(
    `SELECT b.id, b.team_id, u.email, b.status, b.stream_web_view, b.created_at, b.updated_at, b.credits_used
     FROM public.browser_sessions b
     LEFT JOIN dashboard."user" u ON u."teamId"::text = b.team_id
     WHERE ${where} ${options.includeClosed ? "AND b.created_at > now() - interval '7 days'" : "AND b.status = 'active' AND b.deleted_at IS NULL"}
     ORDER BY b.created_at DESC LIMIT 200`,
    params,
  );
  return rows.map(
    (row): BrowserSessionRow => ({
      id: String(row.id),
      teamId: String(row.team_id),
      userEmail: (row.email as string | null) ?? null,
      status: String(row.status),
      streamWebView: Boolean(row.stream_web_view),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
      creditsUsed: row.credits_used === null ? null : Number(row.credits_used),
    }),
  );
}

/** The owning team of a session, if the viewer may act on it. */
async function sessionTeam(viewer: Viewer, sessionId: string): Promise<string> {
  const rows = await query<{ team_id: string }>(`SELECT team_id FROM public.browser_sessions WHERE id = $1::uuid`, [sessionId]);
  const teamId = rows[0]?.team_id;
  if (!teamId) throw new ForbiddenError("Browser session not found.");
  assertCanManageTeam(viewer, teamId);
  return teamId;
}

export type BrowserLinks = {
  id: string;
  status?: string;
  liveViewUrl?: string;
  interactiveLiveViewUrl?: string;
  expiresAt?: string;
};

export async function createBrowserSession(
  viewer: Viewer,
  input: { ttl: number; activityTtl: number; streamWebView: boolean; blockAds: boolean; profile?: { name: string; saveChanges: boolean } | null },
): Promise<BrowserLinks> {
  if (!viewer.teamId) throw new ForbiddenError("Your account has no Firecrawl team.");
  const body = await callAs<BrowserLinks & { success: boolean }>(viewer, viewer.teamId, "/v2/browser", {
    method: "POST",
    body: {
      ttl: input.ttl,
      activityTtl: input.activityTtl,
      streamWebView: input.streamWebView,
      blockAds: input.blockAds,
      ...(input.profile?.name ? { profile: input.profile } : {}),
      origin: "community-dashboard",
    },
  });
  await audit(viewer.userId, "browser.created", { teamId: viewer.teamId }, { sessionId: body.id });
  return body;
}

/** Live View links come from the API on demand; they are never stored by the dashboard. */
export async function browserSessionLinks(viewer: Viewer, sessionId: string): Promise<BrowserLinks> {
  const teamId = await sessionTeam(viewer, sessionId);
  return callAs<BrowserLinks>(viewer, teamId, `/v2/browser/${sessionId}`);
}

export type ExecuteResult = { stdout?: string; stderr?: string; result?: unknown; exitCode?: number; killed?: boolean; error?: string };

export async function executeInBrowser(
  viewer: Viewer,
  sessionId: string,
  input: { code: string; language: "node" | "python" | "bash"; timeout: number },
): Promise<ExecuteResult> {
  const teamId = await sessionTeam(viewer, sessionId);
  return callAs<ExecuteResult>(viewer, teamId, `/v2/browser/${sessionId}/execute`, {
    method: "POST",
    body: { ...input, origin: "community-dashboard" },
    timeoutMs: (input.timeout + 15) * 1000,
  });
}

export async function closeBrowserSession(viewer: Viewer, sessionId: string): Promise<void> {
  const teamId = await sessionTeam(viewer, sessionId);
  await callAs(viewer, teamId, `/v2/browser/${sessionId}`, { method: "DELETE", timeoutMs: 45_000 });
  await audit(viewer.userId, "browser.closed", { teamId }, { sessionId });
}

export type BrowserProfileRow = { teamId: string; userEmail: string | null; name: string; createdAt: string; savedAt: string; sizeBytes: number | null };

export async function listBrowserProfiles(viewer: Viewer, teamFilter?: string | null): Promise<BrowserProfileRow[]> {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, teamFilter), "p.team_id", params);
  const rows = await query<Record<string, unknown>>(
    `SELECT p.team_id, u.email, p.name, p.created_at, p.saved_at, p.size_bytes
     FROM public.browser_profiles p LEFT JOIN dashboard."user" u ON u."teamId" = p.team_id
     WHERE ${where} ORDER BY p.saved_at DESC`,
    params,
  );
  return rows.map((row) => ({
    teamId: String(row.team_id),
    userEmail: (row.email as string | null) ?? null,
    name: String(row.name),
    createdAt: new Date(row.created_at as string).toISOString(),
    savedAt: new Date(row.saved_at as string).toISOString(),
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  }));
}

export async function deleteBrowserProfile(viewer: Viewer, teamId: string, name: string): Promise<void> {
  assertCanManageTeam(viewer, teamId);
  await callAs(viewer, teamId, `/v2/browser/profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
  await audit(viewer.userId, "browser.profile_deleted", { teamId }, { name });
}
