import "server-only";
import { resolveScope, scopeClause, type Scope, type Viewer } from "./authz";
import { pools, query } from "./db";

export type OverviewStats = {
  requestsToday: number;
  requests7d: number;
  successRate7d: number | null;
  avgLatencyMs7d: number | null;
  creditsToday: number;
  credits7d: number;
  openBrowserSessions: number;
  queue: { queued: number; active: number } | null;
};

export async function overviewStats(viewer: Viewer, teamFilter?: string | null): Promise<OverviewStats> {
  const scope = resolveScope(viewer, teamFilter);
  const p1: unknown[] = [];
  const w1 = scopeClause(scope, "r.team_id", p1);
  const [requests] = await query<Record<string, string | null>>(
    `SELECT
       count(*) FILTER (WHERE r.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS today,
       count(*) AS week,
       avg(CASE WHEN r.status_code < 400 THEN 1.0 ELSE 0.0 END) AS success,
       avg(r.duration_ms) FILTER (WHERE r.method <> 'GET') AS latency
     FROM community.request_log r
     WHERE ${w1} AND r.created_at > now() - interval '7 days'`,
    p1,
  );
  const p2: unknown[] = [];
  const w2 = scopeClause(scope, "c.team_id", p2);
  const [credits] = await query<Record<string, string | null>>(
    `SELECT
       COALESCE(sum(c.credits) FILTER (WHERE c.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS today,
       COALESCE(sum(c.credits), 0) AS week
     FROM community.credit_usage c
     WHERE ${w2} AND c.created_at > now() - interval '7 days'`,
    p2,
  );
  const p3: unknown[] = [];
  const w3 = scopeClause(scope, "b.team_id", p3);
  const [browsers] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.browser_sessions b
     WHERE ${w3} AND b.status = 'active' AND b.deleted_at IS NULL`,
    p3,
  );
  return {
    requestsToday: Number(requests.today ?? 0),
    requests7d: Number(requests.week ?? 0),
    successRate7d: requests.success === null ? null : Number(requests.success),
    avgLatencyMs7d: requests.latency === null ? null : Math.round(Number(requests.latency)),
    creditsToday: Number(credits.today ?? 0),
    credits7d: Number(credits.week ?? 0),
    openBrowserSessions: browsers.n,
    queue: await queueDepth(scope),
  };
}

/** Scrape queue depth from the NuQ database, filtered to the viewer's teams. */
async function queueDepth(scope: Scope): Promise<{ queued: number; active: number } | null> {
  const nuq = pools().nuq;
  if (!nuq) return null;
  const params: unknown[] = [];
  const where = scopeClause(scope, "q.owner_id", params);
  try {
    const result = await nuq.query<{ queued: number; active: number }>(
      `SELECT count(*) FILTER (WHERE q.status = 'queued')::int AS queued,
              count(*) FILTER (WHERE q.status = 'active')::int AS active
       FROM nuq.queue_scrape q
       WHERE ${where} AND q.status IN ('queued', 'active')`,
      params,
    );
    return result.rows[0];
  } catch {
    return null;
  }
}

export type DailyPoint = { day: string } & Record<string, number | string>;

export type UsageSeries = {
  keys: string[];
  points: DailyPoint[];
};

/** Pivots (day, key, value) rows into one object per day for Recharts. */
export function pivotDaily(rows: { day: string; key: string; value: number }[], days: number, now = new Date()): UsageSeries {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.key, (totals.get(row.key) ?? 0) + row.value);
  // Keep the eight biggest series and fold the rest into "other".
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const kept = new Set(ranked.slice(0, 8));
  const keys = [...kept];
  if (ranked.length > 8) keys.push("other");

  const byDay = new Map<string, DailyPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const day = date.toISOString().slice(0, 10);
    const point: DailyPoint = { day };
    for (const key of keys) point[key] = 0;
    byDay.set(day, point);
  }
  for (const row of rows) {
    const point = byDay.get(row.day);
    if (!point) continue;
    const key = kept.has(row.key) ? row.key : "other";
    point[key] = Number(point[key] ?? 0) + row.value;
  }
  return { keys, points: [...byDay.values()] };
}

type Dimension = "endpoint" | "user" | "key";

function dimensionSql(dimension: Dimension, table: "r" | "c"): string {
  if (dimension === "endpoint") return `${table}.endpoint`;
  if (dimension === "user") return `COALESCE(u.email, 'unattributed')`;
  return `COALESCE(k.name || ' #' || ${table}.api_key_id, CASE WHEN ${table}.api_key_id IS NULL THEN 'no key' ELSE 'revoked #' || ${table}.api_key_id END)`;
}

export async function requestSeries(viewer: Viewer, dimension: Dimension, days: number, teamFilter?: string | null) {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, teamFilter), "r.team_id", params);
  params.push(days);
  const rows = await query<{ day: string; key: string; value: string }>(
    `SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            ${dimensionSql(dimension, "r")} AS key, count(*) AS value
     FROM community.request_log r
     LEFT JOIN dashboard."user" u ON u."teamId" = r.team_id
     LEFT JOIN public.api_keys k ON k.id = r.api_key_id
     WHERE ${where} AND r.created_at > now() - make_interval(days => $${params.length}) AND r.method <> 'GET'
     GROUP BY 1, 2`,
    params,
  );
  return pivotDaily(
    rows.map((row) => ({ day: row.day, key: row.key, value: Number(row.value) })),
    days,
  );
}

export async function creditSeries(viewer: Viewer, dimension: Dimension, days: number, teamFilter?: string | null) {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, teamFilter), "c.team_id", params);
  params.push(days);
  const rows = await query<{ day: string; key: string; value: string }>(
    `SELECT to_char(date_trunc('day', c.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            ${dimensionSql(dimension, "c")} AS key, sum(c.credits) AS value
     FROM community.credit_usage c
     LEFT JOIN dashboard."user" u ON u."teamId" = c.team_id
     LEFT JOIN public.api_keys k ON k.id = c.api_key_id
     WHERE ${where} AND c.created_at > now() - make_interval(days => $${params.length})
     GROUP BY 1, 2`,
    params,
  );
  return pivotDaily(
    rows.map((row) => ({ day: row.day, key: row.key, value: Number(row.value) })),
    days,
  );
}

/** Per-user totals for the admin overview table. */
export async function perUserToday(viewer: Viewer) {
  if (viewer.role !== "admin") return [];
  return query<{ email: string; name: string; requests: number; credits: string; errors: number }>(
    `SELECT u.email, u.name,
            (SELECT count(*) FROM community.request_log r WHERE r.team_id = u."teamId"
               AND r.created_at > now() - interval '24 hours')::int AS requests,
            (SELECT count(*) FROM community.request_log r WHERE r.team_id = u."teamId"
               AND r.created_at > now() - interval '24 hours' AND r.status_code >= 400)::int AS errors,
            (SELECT COALESCE(sum(c.credits), 0) FROM community.credit_usage c WHERE c.team_id = u."teamId"
               AND c.created_at > now() - interval '24 hours') AS credits
     FROM dashboard."user" u ORDER BY requests DESC, u.email LIMIT 50`,
  );
}
