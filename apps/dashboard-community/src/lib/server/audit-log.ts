import "server-only";
import { assertAdmin, type Viewer } from "./authz";
import { query } from "./db";

export type AuditRow = {
  id: number;
  createdAt: string;
  actorEmail: string | null;
  action: string;
  targetEmail: string | null;
  details: Record<string, unknown>;
};

/** Security-relevant actions, newest first. Admin only. */
export async function listAuditLog(viewer: Viewer, filters: { action?: string | null; q?: string | null; limit?: number } = {}): Promise<AuditRow[]> {
  assertAdmin(viewer);
  const params: unknown[] = [];
  const clauses = ["TRUE"];
  if (filters.action) {
    params.push(`${filters.action}%`);
    clauses.push(`a.action LIKE $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    clauses.push(`(actor.email ILIKE $${params.length} OR target.email ILIKE $${params.length} OR a.details::text ILIKE $${params.length})`);
  }
  params.push(Math.min(filters.limit ?? 200, 1000));
  const rows = await query<Record<string, unknown>>(
    `SELECT a.id, a.created_at, actor.email AS actor_email, a.action, target.email AS target_email, a.details
     FROM dashboard.audit_log a
     LEFT JOIN dashboard."user" actor ON actor.id = a.actor_id
     LEFT JOIN dashboard."user" target ON target.id = a.target_user_id
     WHERE ${clauses.join(" AND ")} ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    createdAt: new Date(row.created_at as string).toISOString(),
    actorEmail: (row.actor_email as string | null) ?? null,
    action: String(row.action),
    targetEmail: (row.target_email as string | null) ?? null,
    details: (row.details as Record<string, unknown>) ?? {},
  }));
}
