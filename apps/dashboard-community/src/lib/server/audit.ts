import "server-only";
import { query } from "./db";

export async function audit(
  actorId: string | null,
  action: string,
  target: { userId?: string | null; teamId?: string | null } = {},
  details: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `INSERT INTO dashboard.audit_log (actor_id, action, target_user_id, target_team_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, action, target.userId ?? null, target.teamId ?? null, JSON.stringify(details)],
  ).catch(() => undefined);
}
