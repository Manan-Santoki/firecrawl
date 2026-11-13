import "server-only";
import { assertCanManageTeam, ForbiddenError, type Viewer } from "./authz";
import { query } from "./db";
import { formatApiKey } from "./tokens";

/** Name of the per-user key the dashboard creates when no key is picked. */
export const INTERNAL_KEY_NAME = "Dashboard (internal)";

export type ActingKey = { id: number; key: string; teamId: string };

/**
 * The key the dashboard uses to call the Firecrawl API for a user, so the
 * request is attributed, limited and billed exactly like their own calls.
 * A chosen key must belong to the team being acted for; without one the
 * team's internal dashboard key is used (and created on first use).
 */
export async function actingKey(
  viewer: Viewer,
  options: { keyId?: number | null; teamId?: string | null } = {},
): Promise<ActingKey> {
  const teamId = options.teamId ?? viewer.teamId;
  assertCanManageTeam(viewer, teamId);
  if (options.keyId) {
    const rows = await query<{ id: string; key: string; team_id: string }>(
      `SELECT id, key::text AS key, team_id FROM public.api_keys WHERE id = $1`,
      [options.keyId],
    );
    const row = rows[0];
    if (!row || row.team_id !== teamId) throw new ForbiddenError("That API key does not belong to this account.");
    return { id: Number(row.id), key: formatApiKey(row.key), teamId: row.team_id };
  }
  const existing = await query<{ id: string; key: string }>(
    `SELECT id, key::text AS key FROM public.api_keys WHERE team_id = $1::uuid AND name = $2 ORDER BY id LIMIT 1`,
    [teamId, INTERNAL_KEY_NAME],
  );
  if (existing[0]) return { id: Number(existing[0].id), key: formatApiKey(existing[0].key), teamId: teamId! };
  const created = await query<{ id: string; key: string }>(
    `INSERT INTO public.api_keys (name, team_id, owner_id) VALUES ($1, $2::uuid, $3::uuid) RETURNING id, key::text AS key`,
    [INTERNAL_KEY_NAME, teamId, viewer.userId],
  );
  return { id: Number(created[0].id), key: formatApiKey(created[0].key), teamId: teamId! };
}
