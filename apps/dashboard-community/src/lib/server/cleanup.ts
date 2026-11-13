import "server-only";
import { audit } from "./audit";
import { assertAdmin, type Viewer } from "./authz";
import { pools, query } from "./db";
import { getSettings } from "./settings";

export const CLEANUP_JOBS = {
  request_log: "Request log and credit ledger",
  playground_history: "Playground history",
  alert_events: "Alert history",
  notifications: "Notifications",
  auth_records: "Expired sessions, verifications and invites",
} as const;
export type CleanupJob = keyof typeof CLEANUP_JOBS;

async function runJob(job: CleanupJob): Promise<number> {
  const { retention } = await getSettings();
  switch (job) {
    case "request_log": {
      const rows = await query<{ request_log_deleted: string; credit_usage_deleted: string }>(
        `SELECT * FROM community.purge_expired($1::integer)`,
        [retention.requestLogDays],
      );
      return Number(rows[0]?.request_log_deleted ?? 0) + Number(rows[0]?.credit_usage_deleted ?? 0);
    }
    case "playground_history":
      return (await pools().app.query(`DELETE FROM dashboard.playground_request WHERE created_at < now() - make_interval(days => $1)`, [retention.playgroundDays])).rowCount ?? 0;
    case "alert_events":
      return (await pools().app.query(`DELETE FROM dashboard.alert_event WHERE created_at < now() - make_interval(days => $1)`, [retention.alertEventDays])).rowCount ?? 0;
    case "notifications":
      return (await pools().app.query(`DELETE FROM dashboard.notification WHERE created_at < now() - make_interval(days => $1)`, [retention.notificationDays])).rowCount ?? 0;
    case "auth_records": {
      const sessions = await pools().app.query(`DELETE FROM dashboard."session" WHERE "expiresAt" < now()`);
      const verifications = await pools().app.query(`DELETE FROM dashboard."verification" WHERE "expiresAt" < now()`);
      const invites = await pools().app.query(
        `DELETE FROM dashboard.invitation WHERE used_at IS NULL AND (revoked_at IS NOT NULL OR expires_at < now() - interval '30 days')`,
      );
      return (sessions.rowCount ?? 0) + (verifications.rowCount ?? 0) + (invites.rowCount ?? 0);
    }
  }
}

/** Runs one cleanup job and records the run; never throws. */
export async function runCleanup(job: CleanupJob, trigger: "schedule" | "manual"): Promise<{ status: string; deleted: number; error?: string }> {
  const started = await query<{ id: string }>(
    `INSERT INTO dashboard.cleanup_run (job, trigger) VALUES ($1, $2) RETURNING id`,
    [job, trigger],
  );
  try {
    const deleted = await runJob(job);
    await query(`UPDATE dashboard.cleanup_run SET status = 'succeeded', finished_at = now(), deleted_rows = $2 WHERE id = $1`, [
      started[0].id,
      deleted,
    ]);
    return { status: "succeeded", deleted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query(`UPDATE dashboard.cleanup_run SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [started[0].id, message.slice(0, 1000)]);
    return { status: "failed", deleted: 0, error: message };
  }
}

export async function purgeNow(viewer: Viewer, job: CleanupJob) {
  assertAdmin(viewer);
  const result = await runCleanup(job, "manual");
  await audit(viewer.userId, "retention.purge_now", {}, { job, ...result });
  return result;
}

export type CleanupRunRow = { job: CleanupJob; startedAt: string; finishedAt: string | null; status: string; deletedRows: number | null; trigger: string; error: string | null };

export async function cleanupHistory(limit = 50): Promise<CleanupRunRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT job, trigger, started_at, finished_at, status, deleted_rows, error FROM dashboard.cleanup_run ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    job: row.job as CleanupJob,
    trigger: String(row.trigger),
    startedAt: new Date(row.started_at as string).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
    status: String(row.status),
    deletedRows: row.deleted_rows === null ? null : Number(row.deleted_rows),
    error: (row.error as string | null) ?? null,
  }));
}

export async function retentionSizes() {
  const rows = await query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM community.request_log) AS request_log,
       (SELECT min(created_at) FROM community.request_log) AS request_log_oldest,
       (SELECT count(*) FROM community.credit_usage) AS credit_usage,
       (SELECT count(*) FROM dashboard.playground_request) AS playground,
       (SELECT count(*) FROM dashboard.alert_event) AS alert_events,
       (SELECT count(*) FROM dashboard.notification) AS notifications`,
  );
  return rows[0];
}
