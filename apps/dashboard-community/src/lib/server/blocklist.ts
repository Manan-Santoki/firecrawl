import "server-only";
import { audit } from "./audit";
import { assertAdmin, assertCanManageTeam, ForbiddenError, type Viewer } from "./authz";
import { query, transaction } from "./db";

export type BlocklistData = { blocklist: string[]; allowedKeywords: string[] };

/** Normalizes a pasted list: one entry per line or comma, trimmed, lowercase, de-duplicated. */
export function parseEntries(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0 && entry.length <= 253),
    ),
  ].slice(0, 5_000);
}

function asData(value: unknown): BlocklistData {
  const record = (value ?? {}) as Partial<BlocklistData>;
  return {
    blocklist: Array.isArray(record.blocklist) ? record.blocklist.map(String) : [],
    allowedKeywords: Array.isArray(record.allowedKeywords) ? record.allowedKeywords.map(String) : [],
  };
}

async function orgOf(teamId: string): Promise<string> {
  const rows = await query<{ org_id: string }>(`SELECT org_id FROM public.teams WHERE id = $1::uuid`, [teamId]);
  if (!rows[0]) throw new ForbiddenError("Unknown team.");
  return rows[0].org_id;
}

/** The global list (org_id IS NULL) applies to every team; only admins read or change it. */
export async function getGlobalBlocklist(viewer: Viewer): Promise<BlocklistData> {
  assertAdmin(viewer);
  const rows = await query<{ data: unknown }>(`SELECT data FROM public.blocklist WHERE org_id IS NULL ORDER BY id LIMIT 1`);
  return asData(rows[0]?.data);
}

export async function getTeamBlocklist(viewer: Viewer, teamId: string): Promise<BlocklistData> {
  assertCanManageTeam(viewer, teamId);
  const rows = await query<{ data: unknown }>(`SELECT data FROM public.blocklist WHERE org_id = $1::uuid ORDER BY id`, [await orgOf(teamId)]);
  const merged: BlocklistData = { blocklist: [], allowedKeywords: [] };
  for (const row of rows) {
    const data = asData(row.data);
    merged.blocklist.push(...data.blocklist);
    merged.allowedKeywords.push(...data.allowedKeywords);
  }
  return { blocklist: [...new Set(merged.blocklist)], allowedKeywords: [...new Set(merged.allowedKeywords)] };
}

/** Replaces the list in the existing Firecrawl table; the API reloads it periodically. */
export async function saveBlocklist(viewer: Viewer, scope: { global: true } | { teamId: string }, data: BlocklistData) {
  const value = JSON.stringify({ blocklist: data.blocklist, allowedKeywords: data.allowedKeywords });
  if ("global" in scope) {
    assertAdmin(viewer);
    await transaction(async (client) => {
      const updated = await client.query(
        `UPDATE public.blocklist SET data = $1::jsonb WHERE id = (SELECT id FROM public.blocklist WHERE org_id IS NULL ORDER BY id LIMIT 1)`,
        [value],
      );
      if (!updated.rowCount) await client.query(`INSERT INTO public.blocklist (data, org_id) VALUES ($1::jsonb, NULL)`, [value]);
    });
    await audit(viewer.userId, "blocklist.global_updated", {}, { entries: data.blocklist.length, keywords: data.allowedKeywords.length });
    return;
  }
  assertCanManageTeam(viewer, scope.teamId);
  const orgId = await orgOf(scope.teamId);
  await transaction(async (client) => {
    await client.query(`DELETE FROM public.blocklist WHERE org_id = $1::uuid`, [orgId]);
    if (data.blocklist.length || data.allowedKeywords.length) {
      await client.query(`INSERT INTO public.blocklist (data, org_id) VALUES ($1::jsonb, $2::uuid)`, [value, orgId]);
    }
  });
  await audit(viewer.userId, "blocklist.team_updated", { teamId: scope.teamId }, { entries: data.blocklist.length, keywords: data.allowedKeywords.length });
}

export async function recentBlocklistHits(viewer: Viewer, teamId: string | null) {
  if (teamId) assertCanManageTeam(viewer, teamId);
  else assertAdmin(viewer);
  return query<{ domain: string; url: string | null; created_at: Date; team_id: string | null }>(
    `SELECT domain, url, created_at, team_id FROM public.blocklist_hits
     WHERE ($1::uuid IS NULL OR team_id = $1::uuid) ORDER BY created_at DESC LIMIT 50`,
    [teamId],
  );
}
