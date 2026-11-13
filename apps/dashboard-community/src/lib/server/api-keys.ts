import "server-only";
import { audit } from "./audit";
import { assertCanManageTeam, ForbiddenError, resolveScope, scopeClause, type Viewer } from "./authz";
import { query } from "./db";
import { invalidateAuthCache } from "./redis";
import { formatApiKey, maskApiKey } from "./tokens";

export const CREDIT_INTERVALS = ["day", "week", "month"] as const;
export type CreditInterval = (typeof CREDIT_INTERVALS)[number];

export type ApiKeyRow = {
  id: number;
  name: string | null;
  masked: string;
  teamId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  createdAt: string;
  creditLimit: number | null;
  creditLimitInterval: string | null;
  concurrency: number | null;
  lastUsedAt: string | null;
  creditsUsed30d: number;
};

type RawKey = {
  id: string;
  name: string | null;
  key: string;
  team_id: string;
  owner_email: string | null;
  owner_name: string | null;
  created_at: Date;
  credit_limit: number | null;
  credit_limit_interval: string | null;
  concurrency: number | null;
  last_used_at: Date | null;
  credits_30d: string | null;
};

/** Keys visible to the viewer: their own team's, or every team's for admins. */
export async function listApiKeys(viewer: Viewer, teamFilter?: string | null): Promise<ApiKeyRow[]> {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, teamFilter), "k.team_id", params);
  const rows = await query<RawKey>(
    `SELECT k.id, k.name, k.key::text AS key, k.team_id, u.email AS owner_email, u.name AS owner_name,
            k.created_at, k.credit_limit, k.credit_limit_interval, k.concurrency,
            (SELECT max(r.created_at) FROM community.request_log r WHERE r.api_key_id = k.id) AS last_used_at,
            (SELECT sum(c.credits) FROM community.credit_usage c
              WHERE c.api_key_id = k.id AND c.created_at > now() - interval '30 days') AS credits_30d
     FROM public.api_keys k
     LEFT JOIN dashboard."user" u ON u."teamId" = k.team_id
     WHERE k.team_id IS NOT NULL AND ${where}
     ORDER BY k.created_at DESC NULLS LAST, k.id DESC`,
    params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    masked: maskApiKey(row.key),
    teamId: row.team_id,
    ownerEmail: row.owner_email,
    ownerName: row.owner_name,
    createdAt: new Date(row.created_at).toISOString(),
    creditLimit: row.credit_limit,
    creditLimitInterval: row.credit_limit_interval,
    concurrency: row.concurrency,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    creditsUsed30d: Number(row.credits_30d ?? 0),
  }));
}

async function loadKey(id: number) {
  const rows = await query<{ id: string; key: string; team_id: string | null }>(
    `SELECT id, key::text AS key, team_id FROM public.api_keys WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Creates a key in the Firecrawl schema exactly as the API stores it (a UUID
 * in public.api_keys) and returns the full `fc-` form. It is the only time the
 * full key leaves the server; listings show a masked form.
 */
export async function createApiKey(
  viewer: Viewer,
  input: { name: string; teamId?: string | null },
): Promise<{ id: number; key: string }> {
  const teamId = input.teamId ?? viewer.teamId;
  assertCanManageTeam(viewer, teamId);
  const rows = await query<{ id: string; key: string }>(
    `INSERT INTO public.api_keys (name, team_id, owner_id)
     VALUES ($1, $2::uuid, $3::uuid)
     RETURNING id, key::text AS key`,
    [input.name.trim().slice(0, 100), teamId, viewer.userId],
  );
  await audit(viewer.userId, "api_key.created", { teamId }, { apiKeyId: Number(rows[0].id) });
  return { id: Number(rows[0].id), key: formatApiKey(rows[0].key) };
}

export async function renameApiKey(viewer: Viewer, id: number, name: string): Promise<void> {
  const key = await loadKey(id);
  if (!key) throw new ForbiddenError();
  assertCanManageTeam(viewer, key.team_id);
  await query(`UPDATE public.api_keys SET name = $2 WHERE id = $1`, [id, name.trim().slice(0, 100)]);
}

/** Deletes the key row and drops the API's cached auth entry for it. */
export async function revokeApiKey(viewer: Viewer, id: number): Promise<void> {
  const key = await loadKey(id);
  if (!key) throw new ForbiddenError();
  assertCanManageTeam(viewer, key.team_id);
  await query(`DELETE FROM public.api_keys WHERE id = $1`, [id]);
  await invalidateAuthCache([{ id: key.id, key: key.key }], key.team_id ?? undefined);
  await audit(viewer.userId, "api_key.revoked", { teamId: key.team_id }, { apiKeyId: id });
}

export async function setApiKeyLimits(
  viewer: Viewer,
  id: number,
  limits: { creditLimit: number | null; creditLimitInterval: CreditInterval | null; concurrency: number | null },
): Promise<void> {
  const key = await loadKey(id);
  if (!key) throw new ForbiddenError();
  assertCanManageTeam(viewer, key.team_id);
  const hasLimit = limits.creditLimit !== null;
  await query(
    `UPDATE public.api_keys
     SET credit_limit = $2, credit_limit_interval = $3, concurrency = $4
     WHERE id = $1`,
    [id, limits.creditLimit, hasLimit ? (limits.creditLimitInterval ?? "month") : null, limits.concurrency],
  );
  await invalidateAuthCache([{ id: key.id, key: key.key }], key.team_id ?? undefined);
  await audit(viewer.userId, "api_key.limits_updated", { teamId: key.team_id }, { apiKeyId: id, ...limits });
}

/**
 * A key the dashboard uses to call the Firecrawl API on behalf of a team
 * (cancel a crawl, read its results). Only server code sees it.
 */
export async function teamApiKeyForActions(teamId: string): Promise<string | null> {
  const rows = await query<{ key: string }>(
    `SELECT key::text AS key FROM public.api_keys WHERE team_id = $1::uuid ORDER BY id LIMIT 1`,
    [teamId],
  );
  return rows[0] ? formatApiKey(rows[0].key) : null;
}
