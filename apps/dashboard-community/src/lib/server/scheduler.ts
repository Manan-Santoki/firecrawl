import "server-only";
import { evaluateAlerts } from "./alerts";
import type { Viewer } from "./authz";
import { CLEANUP_JOBS, type CleanupJob, runCleanup } from "./cleanup";
import { pools, query } from "./db";
import { listJobs } from "./jobs";
import { notify } from "./notifications";

/** Background work for the dashboard process: alerts, job notifications and retention. */

const SYSTEM: Viewer = { userId: "system", email: "", name: "system", role: "admin", teamId: null, twoFactorEnabled: false };

/** Runs `fn` only if no other dashboard replica holds the same lock. */
async function exclusively(name: string, fn: () => Promise<void>): Promise<void> {
  const client = await pools().app.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [name]);
    if (!rows[0].locked) return;
    try {
      await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [name]);
    }
  } finally {
    client.release();
  }
}

/** Notifies owners once when a crawl or batch scrape of theirs finishes. */
export async function notifyFinishedJobs(): Promise<number> {
  const jobs = await listJobs(SYSTEM, { days: 1, limit: 200 });
  const finished = jobs.filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled");
  if (finished.length === 0) return 0;
  const owners = await query<{ id: string; team_id: string; job_notifications: boolean | null }>(
    `SELECT u.id, u."teamId" AS team_id, p.job_notifications FROM dashboard."user" u
     LEFT JOIN dashboard.user_preference p ON p.user_id = u.id WHERE u."teamId" = ANY($1::uuid[])`,
    [[...new Set(finished.map((job) => job.teamId))]],
  );
  let created = 0;
  for (const job of finished) {
    const recipients = owners.filter((owner) => owner.team_id === job.teamId && owner.job_notifications !== false).map((owner) => owner.id);
    if (!recipients.length) continue;
    created += await notify(recipients, {
      kind: "job",
      title: `${job.kind === "crawl" ? "Crawl" : "Batch scrape"} ${job.status}`,
      body: `${job.target ?? job.id}: ${job.completed ?? 0} pages done, ${job.failed ?? 0} failed.`,
      link: `/jobs/${job.id}`,
      dedupeKey: `job:${job.id}`,
    });
  }
  return created;
}

let started = false;

export function startScheduler(): void {
  if (started || process.env.DASHBOARD_DISABLE_SCHEDULER === "true") return;
  started = true;
  const safe = (name: string, fn: () => Promise<unknown>) => () => {
    exclusively(`firecrawl-dashboard:${name}`, async () => {
      await fn();
    }).catch((error) => console.error(`Dashboard task ${name} failed`, error instanceof Error ? error.message : error));
  };
  const minute = safe("minute", async () => {
    await evaluateAlerts();
    await notifyFinishedJobs();
  });
  const hourly = safe("cleanup", async () => {
    for (const job of Object.keys(CLEANUP_JOBS) as CleanupJob[]) await runCleanup(job, "schedule");
  });
  setTimeout(minute, 15_000).unref?.();
  setInterval(minute, 60_000).unref?.();
  setTimeout(hourly, 60_000).unref?.();
  setInterval(hourly, 60 * 60_000).unref?.();
}
