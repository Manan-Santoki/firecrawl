import "server-only";
import { headers } from "next/headers";
import { auth } from "./auth";
import { audit } from "./audit";
import { assertAdmin, ForbiddenError, type Role, type Viewer } from "./authz";
import { query, transaction } from "./db";
import { invalidateAuthCache } from "./redis";
import type { CreditInterval } from "./api-keys";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  disabled: boolean;
  twoFactorEnabled: boolean;
  teamId: string | null;
  createdAt: string;
  creditLimit: number | null;
  creditLimitInterval: string | null;
  concurrencyLimit: number | null;
  keyCount: number;
  requests24h: number;
  requests7d: number;
  credits30d: number;
  lastActiveAt: string | null;
};

export async function listUsers(viewer: Viewer): Promise<UserRow[]> {
  assertAdmin(viewer);
  const rows = await query<Record<string, unknown>>(
    `SELECT u.id, u.name, u.email, u.role, COALESCE(u.banned, false) AS banned,
            COALESCE(u."twoFactorEnabled", false) AS two_factor, u."teamId" AS team_id, u."createdAt" AS created_at,
            l.credit_limit, l.credit_limit_interval, l.concurrency_limit,
            (SELECT count(*) FROM public.api_keys k WHERE k.team_id = u."teamId")::int AS key_count,
            (SELECT count(*) FROM community.request_log r
              WHERE r.team_id = u."teamId" AND r.created_at > now() - interval '24 hours')::int AS requests_24h,
            (SELECT count(*) FROM community.request_log r
              WHERE r.team_id = u."teamId" AND r.created_at > now() - interval '7 days')::int AS requests_7d,
            (SELECT COALESCE(sum(c.credits), 0) FROM community.credit_usage c
              WHERE c.team_id = u."teamId" AND c.created_at > now() - interval '30 days') AS credits_30d,
            (SELECT max(s."updatedAt") FROM dashboard."session" s WHERE s."userId" = u.id) AS last_active
     FROM dashboard."user" u
     LEFT JOIN community.team_limits l ON l.team_id = u."teamId"
     ORDER BY u."createdAt"`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: row.role === "admin" ? "admin" : "member",
    disabled: Boolean(row.banned),
    twoFactorEnabled: Boolean(row.two_factor),
    teamId: (row.team_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    creditLimit: (row.credit_limit as number | null) ?? null,
    creditLimitInterval: (row.credit_limit_interval as string | null) ?? null,
    concurrencyLimit: (row.concurrency_limit as number | null) ?? null,
    keyCount: Number(row.key_count),
    requests24h: Number(row.requests_24h),
    requests7d: Number(row.requests_7d),
    credits30d: Number(row.credits_30d),
    lastActiveAt: row.last_active ? new Date(row.last_active as string).toISOString() : null,
  }));
}

/** Lightweight id -> label list for admin filters. */
export async function listUserOptions(viewer: Viewer): Promise<{ teamId: string; label: string }[]> {
  if (viewer.role !== "admin") return [];
  return query<{ teamId: string; label: string }>(
    `SELECT u."teamId" AS "teamId", u.name || ' <' || u.email || '>' AS label
     FROM dashboard."user" u WHERE u."teamId" IS NOT NULL ORDER BY u.name`,
  );
}

async function loadUser(userId: string) {
  const rows = await query<{ id: string; team_id: string | null; role: string | null }>(
    `SELECT id, "teamId" AS team_id, role FROM dashboard."user" WHERE id = $1::uuid`,
    [userId],
  );
  if (!rows[0]) throw new ForbiddenError("Unknown user.");
  return rows[0];
}

async function teamKeys(teamId: string) {
  return query<{ id: string; key: string }>(
    `SELECT id, key::text AS key FROM public.api_keys WHERE team_id = $1::uuid`,
    [teamId],
  );
}

async function adminCount(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dashboard."user" WHERE role = 'admin' AND COALESCE(banned, false) = false`,
  );
  return rows[0].n;
}

/**
 * Enables or disables a user everywhere at once: their dashboard sessions end
 * (Better Auth ban), and their Firecrawl team is banned so every API key of
 * theirs is rejected with 403 by the API's auth path.
 */
export async function setUserDisabled(viewer: Viewer, userId: string, disabled: boolean): Promise<void> {
  assertAdmin(viewer);
  if (userId === viewer.userId) throw new ForbiddenError("You cannot disable your own account.");
  const user = await loadUser(userId);
  await transaction(async (client) => {
    await client.query(`UPDATE dashboard."user" SET banned = $2, "banReason" = $3 WHERE id = $1::uuid`, [
      userId,
      disabled,
      disabled ? "Disabled by an administrator" : null,
    ]);
    if (disabled) {
      await client.query(`DELETE FROM dashboard."session" WHERE "userId" = $1::uuid`, [userId]);
    }
    if (user.team_id) {
      await client.query(`UPDATE public.teams SET banned = $2, updated_at = now() WHERE id = $1::uuid`, [
        user.team_id,
        disabled,
      ]);
    }
  });
  if (user.team_id) await invalidateAuthCache(await teamKeys(user.team_id), user.team_id);
  await audit(viewer.userId, disabled ? "user.disabled" : "user.enabled", { userId, teamId: user.team_id });
}

export async function setUserRole(viewer: Viewer, userId: string, role: Role): Promise<void> {
  assertAdmin(viewer);
  const user = await loadUser(userId);
  if (user.role === "admin" && role !== "admin" && (await adminCount()) <= 1) {
    throw new ForbiddenError("At least one active administrator is required.");
  }
  await query(`UPDATE dashboard."user" SET role = $2 WHERE id = $1::uuid`, [userId, role]);
  await audit(viewer.userId, "user.role_changed", { userId }, { role });
}

export type TeamLimitsInput = {
  creditLimit: number | null;
  creditLimitInterval: CreditInterval | null;
  concurrencyLimit: number | null;
};

export async function setTeamLimits(viewer: Viewer, userId: string, limits: TeamLimitsInput): Promise<void> {
  assertAdmin(viewer);
  const user = await loadUser(userId);
  if (!user.team_id) throw new ForbiddenError("This user has no Firecrawl team.");
  const interval = limits.creditLimit === null ? null : (limits.creditLimitInterval ?? "month");
  await query(
    `INSERT INTO community.team_limits (team_id, credit_limit, credit_limit_interval, concurrency_limit, updated_at, updated_by)
     VALUES ($1::uuid, $2, $3, $4, now(), $5)
     ON CONFLICT (team_id) DO UPDATE SET
       credit_limit = EXCLUDED.credit_limit,
       credit_limit_interval = EXCLUDED.credit_limit_interval,
       concurrency_limit = EXCLUDED.concurrency_limit,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [user.team_id, limits.creditLimit, interval, limits.concurrencyLimit, viewer.userId],
  );
  await invalidateAuthCache(await teamKeys(user.team_id), user.team_id);
  await audit(viewer.userId, "user.limits_updated", { userId, teamId: user.team_id }, { ...limits });
}

export async function setUserPassword(viewer: Viewer, userId: string, newPassword: string): Promise<void> {
  assertAdmin(viewer);
  await loadUser(userId);
  await auth().api.setUserPassword({ body: { userId, newPassword }, headers: await headers() });
  await query(`DELETE FROM dashboard."session" WHERE "userId" = $1::uuid`, [userId]);
  await audit(viewer.userId, "user.password_reset", { userId });
}

export async function getTeamLimitsForViewer(viewer: Viewer) {
  if (!viewer.teamId) return null;
  const rows = await query<{ credit_limit: number | null; credit_limit_interval: string | null; concurrency_limit: number | null }>(
    `SELECT credit_limit, credit_limit_interval, concurrency_limit FROM community.team_limits WHERE team_id = $1::uuid`,
    [viewer.teamId],
  );
  return rows[0] ?? null;
}
