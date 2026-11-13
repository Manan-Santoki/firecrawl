import "server-only";
import type { Viewer } from "./authz";
import { query } from "./db";

export type NotificationRow = {
  id: number;
  createdAt: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
};

/** Adds a notification for each user; a repeated dedupe key is ignored. */
export async function notify(
  userIds: string[],
  input: { kind: string; title: string; body?: string | null; link?: string | null; dedupeKey?: string | null },
): Promise<number> {
  let created = 0;
  for (const userId of new Set(userIds)) {
    const rows = await query<{ id: string }>(
      `INSERT INTO dashboard.notification (user_id, kind, title, body, link, dedupe_key)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, input.kind, input.title.slice(0, 300), input.body?.slice(0, 2000) ?? null, input.link ?? null, input.dedupeKey ?? null],
    );
    created += rows.length;
  }
  return created;
}

export async function adminUserIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM dashboard."user" WHERE role = 'admin' AND COALESCE(banned, false) = false`,
  );
  return rows.map((row) => row.id);
}

function mapRow(row: Record<string, unknown>): NotificationRow {
  return {
    id: Number(row.id),
    createdAt: new Date(row.created_at as string).toISOString(),
    kind: String(row.kind),
    title: String(row.title),
    body: (row.body as string | null) ?? null,
    link: (row.link as string | null) ?? null,
    readAt: row.read_at ? new Date(row.read_at as string).toISOString() : null,
  };
}

/** Only ever the viewer's own notifications. */
export async function listNotifications(viewer: Viewer, options: { limit?: number; afterId?: number } = {}) {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, created_at, kind, title, body, link, read_at FROM dashboard.notification
     WHERE user_id = $1::uuid AND id > $2 ORDER BY id DESC LIMIT $3`,
    [viewer.userId, options.afterId ?? 0, options.limit ?? 50],
  );
  return rows.map(mapRow);
}

export async function unreadCount(viewer: Viewer): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dashboard.notification WHERE user_id = $1::uuid AND read_at IS NULL`,
    [viewer.userId],
  );
  return rows[0].n;
}

export async function markRead(viewer: Viewer, ids: number[] | "all"): Promise<void> {
  if (ids === "all") {
    await query(`UPDATE dashboard.notification SET read_at = now() WHERE user_id = $1::uuid AND read_at IS NULL`, [viewer.userId]);
    return;
  }
  await query(
    `UPDATE dashboard.notification SET read_at = now() WHERE user_id = $1::uuid AND id = ANY($2::bigint[]) AND read_at IS NULL`,
    [viewer.userId, ids],
  );
}

export type Preferences = { limitAlerts: boolean; jobNotifications: boolean };

export async function getPreferences(viewer: Viewer): Promise<Preferences> {
  const rows = await query<{ limit_alerts: boolean; job_notifications: boolean }>(
    `SELECT limit_alerts, job_notifications FROM dashboard.user_preference WHERE user_id = $1::uuid`,
    [viewer.userId],
  );
  return { limitAlerts: rows[0]?.limit_alerts ?? true, jobNotifications: rows[0]?.job_notifications ?? true };
}

export async function setPreferences(viewer: Viewer, preferences: Preferences): Promise<void> {
  await query(
    `INSERT INTO dashboard.user_preference (user_id, limit_alerts, job_notifications, updated_at)
     VALUES ($1::uuid, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET limit_alerts = EXCLUDED.limit_alerts, job_notifications = EXCLUDED.job_notifications, updated_at = now()`,
    [viewer.userId, preferences.limitAlerts, preferences.jobNotifications],
  );
}
