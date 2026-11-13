import "server-only";
import { teamApiKeyForActions } from "./api-keys";
import { audit } from "./audit";
import { assertCanManageTeam, ForbiddenError, resolveScope, scopeClause, type Viewer } from "./authz";
import { query } from "./db";
import { firecrawlRequest } from "./firecrawl-api";
import { crawlRedis } from "./redis";

export type JobKind = "crawl" | "batch_scrape";
export type JobStatus = "scraping" | "completed" | "cancelled" | "failed" | "expired" | "unknown";

export type JobRow = {
  id: string;
  kind: JobKind;
  teamId: string;
  userEmail: string | null;
  apiKeyName: string | null;
  target: string | null;
  createdAt: string;
  status: JobStatus;
  total: number | null;
  completed: number | null;
  failed: number | null;
  credits: number;
};

export type CrawlProgress = {
  exists: boolean;
  cancelled: boolean;
  total: number;
  done: number;
  succeeded: number;
  kickoffFinished: boolean;
  error: string | null;
};

/** Derives a display status from the API's Redis crawl bookkeeping. */
export function crawlStatus(progress: CrawlProgress | null): {
  status: JobStatus;
  total: number | null;
  completed: number | null;
  failed: number | null;
} {
  if (!progress) return { status: "unknown", total: null, completed: null, failed: null };
  if (!progress.exists) return { status: "expired", total: null, completed: null, failed: null };
  const failed = Math.max(0, progress.done - progress.succeeded);
  const base = { total: progress.total, completed: progress.succeeded, failed };
  if (progress.cancelled) return { status: "cancelled", ...base };
  if (progress.error) return { status: "failed", ...base };
  if (progress.kickoffFinished && progress.done >= progress.total) return { status: "completed", ...base };
  return { status: "scraping", ...base };
}

async function readProgress(id: string): Promise<CrawlProgress | null> {
  const redis = crawlRedis();
  if (!redis) return null;
  try {
    const [stored, total, done, succeeded, kickoff, error] = await Promise.all([
      redis.get(`crawl:${id}`),
      redis.scard(`crawl:${id}:jobs`),
      redis.scard(`crawl:${id}:jobs_done`),
      redis.zcard(`crawl:${id}:jobs_donez_ordered`),
      redis.get(`crawl:${id}:kickoff:finish`),
      redis.get(`crawl:${id}:error`),
    ]);
    let cancelled = false;
    if (stored) {
      try {
        cancelled = Boolean((JSON.parse(stored) as { cancelled?: boolean }).cancelled);
      } catch {
        // Unexpected shape: leave as not cancelled.
      }
    }
    return {
      exists: stored !== null,
      cancelled,
      total,
      done,
      succeeded,
      kickoffFinished: kickoff !== null,
      error,
    };
  } catch {
    return null;
  }
}

const JOB_ENDPOINTS: Record<string, JobKind> = {
  "/v2/crawl": "crawl",
  "/v1/crawl": "crawl",
  "/v2/batch/scrape": "batch_scrape",
  "/v1/batch/scrape": "batch_scrape",
};

export async function listJobs(
  viewer: Viewer,
  options: { teamId?: string | null; days?: number; limit?: number } = {},
): Promise<JobRow[]> {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, options.teamId), "r.team_id", params);
  params.push(Object.keys(JOB_ENDPOINTS));
  const endpoints = `$${params.length}::text[]`;
  params.push(options.days ?? 7);
  const rows = await query<Record<string, unknown>>(
    `SELECT DISTINCT ON (r.job_id) r.job_id, r.endpoint, r.team_id, r.target, r.created_at,
            u.email AS user_email, k.name AS api_key_name,
            (SELECT COALESCE(sum(c.credits), 0) FROM community.credit_usage c
              WHERE c.job_id = r.job_id AND c.team_id = r.team_id) AS credits
     FROM community.request_log r
     LEFT JOIN dashboard."user" u ON u."teamId" = r.team_id
     LEFT JOIN public.api_keys k ON k.id = r.api_key_id
     WHERE ${where} AND r.method = 'POST' AND r.status_code < 400 AND r.job_id IS NOT NULL
       AND r.endpoint = ANY(${endpoints})
       AND r.created_at > now() - make_interval(days => $${params.length})
     ORDER BY r.job_id, r.created_at`,
    params,
  );
  rows.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());
  const limited = rows.slice(0, options.limit ?? 100);
  return Promise.all(
    limited.map(async (row) => {
      const id = String(row.job_id);
      const progress = crawlStatus(await readProgress(id));
      return {
        id,
        kind: JOB_ENDPOINTS[String(row.endpoint)] ?? "crawl",
        teamId: String(row.team_id),
        userEmail: (row.user_email as string | null) ?? null,
        apiKeyName: (row.api_key_name as string | null) ?? null,
        target: (row.target as string | null) ?? null,
        createdAt: new Date(row.created_at as string).toISOString(),
        credits: Number(row.credits ?? 0),
        ...progress,
      };
    }),
  );
}

export async function activeJobCount(viewer: Viewer, teamId?: string | null): Promise<number> {
  const jobs = await listJobs(viewer, { teamId, days: 1, limit: 200 });
  return jobs.filter((job) => job.status === "scraping").length;
}

/** The job's owning team and kind, but only if the viewer may see it. */
export async function findJob(viewer: Viewer, jobId: string): Promise<{ teamId: string; kind: JobKind } | null> {
  const rows = await query<{ team_id: string; endpoint: string }>(
    `SELECT team_id, endpoint FROM community.request_log
     WHERE job_id = $1 AND method = 'POST' AND team_id IS NOT NULL AND endpoint = ANY($2::text[])
     ORDER BY created_at LIMIT 1`,
    [jobId, Object.keys(JOB_ENDPOINTS)],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    assertCanManageTeam(viewer, row.team_id);
  } catch {
    return null;
  }
  return { teamId: row.team_id, kind: JOB_ENDPOINTS[row.endpoint] };
}

function jobPath(kind: JobKind, id: string): string {
  return kind === "crawl" ? `/v2/crawl/${id}` : `/v2/batch/scrape/${id}`;
}

/** Cancels through the Firecrawl API, as the job's own team. */
export async function cancelJob(viewer: Viewer, jobId: string): Promise<void> {
  const job = await findJob(viewer, jobId);
  if (!job) throw new ForbiddenError("Job not found.");
  const apiKey = await teamApiKeyForActions(job.teamId);
  if (!apiKey) throw new Error("The job's owner has no API key left to act with.");
  await firecrawlRequest(apiKey, jobPath(job.kind, jobId), { method: "DELETE" });
  await audit(viewer.userId, "job.cancelled", { teamId: job.teamId }, { jobId });
}

export type JobResultsPage = {
  status: string;
  total: number;
  completed: number;
  creditsUsed: number | null;
  expiresAt: string | null;
  next: string | null;
  data: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
};

/** One page of results via the API's status endpoint, as the job's team. */
export async function jobResults(viewer: Viewer, jobId: string, skip = 0): Promise<JobResultsPage & { kind: JobKind }> {
  const job = await findJob(viewer, jobId);
  if (!job) throw new ForbiddenError("Job not found.");
  const apiKey = await teamApiKeyForActions(job.teamId);
  if (!apiKey) throw new Error("The job's owner has no API key left to act with.");
  const page = await firecrawlRequest<JobResultsPage>(apiKey, `${jobPath(job.kind, jobId)}?skip=${skip}&limit=25`);
  let errors: Array<Record<string, unknown>> = [];
  try {
    const result = await firecrawlRequest<{ errors?: Array<Record<string, unknown>> }>(
      apiKey,
      `${jobPath(job.kind, jobId)}/errors`,
    );
    errors = result.errors ?? [];
  } catch {
    // Errors are optional detail.
  }
  return { ...page, errors, kind: job.kind };
}
