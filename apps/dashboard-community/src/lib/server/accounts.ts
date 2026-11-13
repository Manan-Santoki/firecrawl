import "server-only";
import type { PoolClient } from "pg";
import { auth } from "./auth";
import { audit } from "./audit";
import { assertAdmin, type Role, type Viewer } from "./authz";
import { pools, query } from "./db";
import { env } from "./env";
import { notify } from "./notifications";
import { getSettings } from "./settings";
import { hashToken, newToken, safeEqual } from "./tokens";

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

/**
 * Creates the Firecrawl organization and team a dashboard user owns. These
 * two rows are everything API-key authentication needs: auth_chunk_2 joins
 * api_keys -> teams and returns teams.org_id and teams.banned, and the global
 * blocklist row is already seeded once per deployment by 090-seed.sql. Billing,
 * rate-limit flags and plan limits come from community functions, not rows.
 */
export async function provisionTeam(client: PoolClient | null, name: string): Promise<string> {
  const sql = `
    WITH org AS (
      INSERT INTO public.organizations (name) VALUES ($1) RETURNING id
    )
    INSERT INTO public.teams (name, org_id, banned)
    SELECT $1, org.id, false FROM org
    RETURNING id`;
  const rows = client
    ? (await client.query<{ id: string }>(sql, [name])).rows
    : await query<{ id: string }>(sql, [name]);
  return rows[0].id;
}

async function userCount(): Promise<number> {
  const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM dashboard."user"`);
  return rows[0].n;
}

export async function needsBootstrap(): Promise<boolean> {
  return (await userCount()) === 0;
}

type NewAccount = { name: string; email: string; password: string };

async function createAccount(account: NewAccount): Promise<string> {
  try {
    const result = await auth().api.signUpEmail({
      body: { name: account.name, email: account.email, password: account.password },
    });
    return result.user.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AccountError(
      /exist/i.test(message) ? "An account with this email already exists." : message,
    );
  }
}

async function adoptOrProvisionTeam(name: string, preferredTeamId?: string): Promise<string> {
  if (preferredTeamId) {
    const rows = await query<{ id: string }>(
      `SELECT t.id FROM public.teams t
       WHERE t.id = $1::uuid
         AND NOT EXISTS (SELECT 1 FROM dashboard."user" u WHERE u."teamId" = t.id)`,
      [preferredTeamId],
    );
    if (rows[0]) return rows[0].id;
  }
  return provisionTeam(null, name);
}

/**
 * Creates the first account, as admin, when the bootstrap token matches and no
 * account exists yet. The advisory lock makes concurrent attempts serialize so
 * exactly one can succeed; afterwards bootstrap is permanently closed.
 */
export async function bootstrapAdmin(token: string, account: NewAccount): Promise<void> {
  const expected = env().DASHBOARD_BOOTSTRAP_TOKEN;
  if (!expected) throw new AccountError("Bootstrap is disabled: DASHBOARD_BOOTSTRAP_TOKEN is not set.");
  if (!safeEqual(token, expected)) throw new AccountError("The bootstrap token is not valid.");

  const client = await pools().app.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('firecrawl-dashboard-bootstrap'))`);
    if (!(await needsBootstrap())) {
      throw new AccountError("The dashboard has already been set up. Sign in instead.");
    }
    const userId = await createAccount(account);
    const teamId = await adoptOrProvisionTeam(account.name, env().DASHBOARD_ADMIN_TEAM_ID);
    await query(`UPDATE dashboard."user" SET role = 'admin', "teamId" = $2::uuid WHERE id = $1::uuid`, [
      userId,
      teamId,
    ]);
    await audit(userId, "bootstrap.admin_created", { userId, teamId });
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('firecrawl-dashboard-bootstrap'))`).catch(() => undefined);
    client.release();
  }
}

export type InviteRow = {
  id: string;
  email: string | null;
  role: Role;
  note: string | null;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  used_by_email: string | null;
  created_by_email: string | null;
};

export function inviteStatus(invite: Pick<InviteRow, "used_at" | "revoked_at" | "expires_at">, now = new Date()) {
  if (invite.used_at) return "used" as const;
  if (invite.revoked_at) return "revoked" as const;
  if (new Date(invite.expires_at) <= now) return "expired" as const;
  return "pending" as const;
}

export async function createInvite(
  viewer: Viewer,
  input: { email?: string | null; role: Role; note?: string | null; ttlHours?: number },
): Promise<{ url: string; expiresAt: Date }> {
  assertAdmin(viewer);
  const { invitePolicy } = await getSettings();
  if (invitePolicy.requireEmail && !input.email?.trim()) {
    throw new AccountError("Invites must name the invitee's email (see Settings).");
  }
  const { token, hash } = newToken();
  const ttl = input.ttlHours ?? invitePolicy.defaultTtlHours;
  const rows = await query<{ id: string; expires_at: Date }>(
    `INSERT INTO dashboard.invitation (token_hash, email, role, note, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5::uuid, now() + make_interval(hours => $6))
     RETURNING id, expires_at`,
    [hash, input.email?.trim().toLowerCase() || null, input.role, input.note || null, viewer.userId, ttl],
  );
  await audit(viewer.userId, "invite.created", {}, { inviteId: rows[0].id, role: input.role });
  const url = new URL(`/invite/${token}`, env().DASHBOARD_URL).toString();
  return { url, expiresAt: rows[0].expires_at };
}

export async function listInvites(viewer: Viewer): Promise<InviteRow[]> {
  assertAdmin(viewer);
  return query<InviteRow>(
    `SELECT i.id, i.email, i.role, i.note, i.created_at, i.expires_at, i.used_at, i.revoked_at,
            used.email AS used_by_email, creator.email AS created_by_email
     FROM dashboard.invitation i
     LEFT JOIN dashboard."user" used ON used.id = i.used_by
     LEFT JOIN dashboard."user" creator ON creator.id = i.created_by
     ORDER BY i.created_at DESC
     LIMIT 200`,
  );
}

export async function revokeInvite(viewer: Viewer, inviteId: string): Promise<void> {
  assertAdmin(viewer);
  await query(
    `UPDATE dashboard.invitation SET revoked_at = now()
     WHERE id = $1::uuid AND used_at IS NULL AND revoked_at IS NULL`,
    [inviteId],
  );
  await audit(viewer.userId, "invite.revoked", {}, { inviteId });
}

/** The invite a token names, if it can still be used. */
export async function findUsableInvite(token: string) {
  const rows = await query<{ id: string; email: string | null; role: Role; expires_at: Date }>(
    `SELECT id, email, role, expires_at FROM dashboard.invitation
     WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

/**
 * Redeems a single-use invite: the claim is an atomic UPDATE, so two people
 * racing the same link cannot both succeed. If account creation fails the
 * claim is released so the link stays usable.
 */
export async function acceptInvite(token: string, account: NewAccount): Promise<void> {
  const claimed = await query<{ id: string; email: string | null; role: Role; created_by: string | null }>(
    `UPDATE dashboard.invitation SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
     RETURNING id, email, role, created_by`,
    [hashToken(token)],
  );
  const invite = claimed[0];
  if (!invite) throw new AccountError("This invite link is invalid, expired or already used.");

  try {
    if (invite.email && invite.email !== account.email.trim().toLowerCase()) {
      throw new AccountError("This invite was issued for a different email address.");
    }
    const userId = await createAccount(account);
    const teamId = await provisionTeam(null, account.name);
    await query(`UPDATE dashboard."user" SET role = $2, "teamId" = $3::uuid WHERE id = $1::uuid`, [
      userId,
      invite.role,
      teamId,
    ]);
    await query(`UPDATE dashboard.invitation SET used_by = $2::uuid WHERE id = $1::uuid`, [invite.id, userId]);
    // New users start with the instance's default limits, if any are set.
    const { defaultLimits } = await getSettings();
    if (defaultLimits.creditLimit !== null || defaultLimits.concurrencyLimit !== null) {
      await query(
        `INSERT INTO community.team_limits (team_id, credit_limit, credit_limit_interval, concurrency_limit, updated_by)
         VALUES ($1::uuid, $2, $3, $4, 'default') ON CONFLICT (team_id) DO NOTHING`,
        [
          teamId,
          defaultLimits.creditLimit,
          defaultLimits.creditLimit === null ? null : (defaultLimits.creditLimitInterval ?? "month"),
          defaultLimits.concurrencyLimit,
        ],
      );
    }
    await audit(userId, "invite.accepted", { userId, teamId }, { inviteId: invite.id });
    if (invite.created_by) {
      await notify([invite.created_by], {
        kind: "invite",
        title: `${account.name} accepted your invite`,
        body: account.email,
        link: "/users",
        dedupeKey: `invite:${invite.id}`,
      });
    }
  } catch (error) {
    await query(`UPDATE dashboard.invitation SET used_at = NULL WHERE id = $1::uuid AND used_by IS NULL`, [
      invite.id,
    ]);
    throw error;
  }
}
