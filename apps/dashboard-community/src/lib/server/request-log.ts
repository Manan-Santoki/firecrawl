import "server-only";
import { resolveScope, scopeClause, type Viewer } from "./authz";
import { query } from "./db";

export const RANGES = { "1h": 1, "24h": 24, "7d": 24 * 7, "30d": 24 * 30 } as const;
export type RangeKey = keyof typeof RANGES;
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "errors"] as const;

export type LogFilters = {
  range: RangeKey;
  endpoint: string | null;
  status: (typeof STATUS_CLASSES)[number] | null;
  apiKeyId: number | null;
  teamId: string | null;
  q: string | null;
  page: number;
};

export const PAGE_SIZE = 50;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseLogFilters(params: Record<string, string | string[] | undefined>): LogFilters {
  const range = first(params.range);
  const status = first(params.status);
  const key = Number(first(params.key));
  const page = Number(first(params.page));
  const team = first(params.user);
  return {
    range: range && range in RANGES ? (range as RangeKey) : "24h",
    endpoint: first(params.endpoint)?.slice(0, 200) || null,
    status: STATUS_CLASSES.includes(status as never) ? (status as LogFilters["status"]) : null,
    apiKeyId: Number.isInteger(key) && key > 0 ? key : null,
    teamId: team && /^[0-9a-f-]{36}$/i.test(team) ? team : null,
    q: first(params.q)?.trim().slice(0, 200) || null,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

export type LogRow = {
  id: number;
  createdAt: string;
  teamId: string | null;
  userEmail: string | null;
  apiKeyId: number | null;
  apiKeyName: string | null;
  method: string;
  endpoint: string;
  path: string;
  target: string | null;
  statusCode: number;
  durationMs: number;
  jobId: string | null;
  error: string | null;
  origin: string | null;
  zeroDataRetention: boolean;
  credits: number | null;
};

/** WHERE clause and params for the filters, always inside the viewer's scope. */
export function buildLogWhere(viewer: Viewer, filters: LogFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = [scopeClause(resolveScope(viewer, filters.teamId), "r.team_id", params)];
  params.push(RANGES[filters.range]);
  clauses.push(`r.created_at > now() - make_interval(hours => $${params.length})`);
  if (filters.endpoint) {
    params.push(filters.endpoint);
    clauses.push(`r.endpoint = $${params.length}`);
  }
  if (filters.status === "errors") clauses.push("r.status_code >= 400");
  else if (filters.status) {
    const base = Number(filters.status[0]) * 100;
    clauses.push(`r.status_code >= ${base} AND r.status_code < ${base + 100}`);
  }
  if (filters.apiKeyId) {
    params.push(filters.apiKeyId);
    clauses.push(`r.api_key_id = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    clauses.push(`(r.target ILIKE ${p} OR r.job_id ILIKE ${p} OR r.error ILIKE ${p} OR r.path ILIKE ${p})`);
  }
  return { where: clauses.join(" AND "), params };
}

const SELECT = `
  SELECT r.id, r.created_at, r.team_id, u.email AS user_email, r.api_key_id, k.name AS api_key_name,
         r.method, r.endpoint, r.path, r.target, r.status_code, r.duration_ms, r.job_id, r.error,
         r.origin, r.zero_data_retention,
         CASE WHEN r.method = 'POST' AND r.job_id IS NOT NULL THEN (
           SELECT sum(c.credits) FROM community.credit_usage c
           WHERE c.job_id = r.job_id AND c.team_id = r.team_id
         ) END AS credits
  FROM community.request_log r
  LEFT JOIN public.api_keys k ON k.id = r.api_key_id
  LEFT JOIN dashboard."user" u ON u."teamId" = r.team_id`;

function mapRow(row: Record<string, unknown>): LogRow {
  return {
    id: Number(row.id),
    createdAt: new Date(row.created_at as string).toISOString(),
    teamId: (row.team_id as string | null) ?? null,
    userEmail: (row.user_email as string | null) ?? null,
    apiKeyId: row.api_key_id === null ? null : Number(row.api_key_id),
    apiKeyName: (row.api_key_name as string | null) ?? null,
    method: String(row.method),
    endpoint: String(row.endpoint),
    path: String(row.path),
    target: (row.target as string | null) ?? null,
    statusCode: Number(row.status_code),
    durationMs: Number(row.duration_ms),
    jobId: (row.job_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    origin: (row.origin as string | null) ?? null,
    zeroDataRetention: Boolean(row.zero_data_retention),
    credits: row.credits === null || row.credits === undefined ? null : Number(row.credits),
  };
}

export async function searchLogs(viewer: Viewer, filters: LogFilters) {
  const { where, params } = buildLogWhere(viewer, filters);
  const countRows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM community.request_log r WHERE ${where}`,
    params,
  );
  const rows = await query<Record<string, unknown>>(
    `${SELECT} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC
     LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`,
    params,
  );
  return { total: countRows[0].n, rows: rows.map(mapRow) };
}

export async function* exportLogs(viewer: Viewer, filters: LogFilters, max = 50_000): AsyncGenerator<LogRow> {
  const { where, params } = buildLogWhere(viewer, filters);
  let lastId: number | null = null;
  let emitted = 0;
  while (emitted < max) {
    const pageParams = [...params];
    let cursor = "";
    if (lastId !== null) {
      pageParams.push(lastId);
      cursor = ` AND r.id < $${pageParams.length}`;
    }
    const rows = await query<Record<string, unknown>>(
      `${SELECT} WHERE ${where}${cursor} ORDER BY r.id DESC LIMIT 1000`,
      pageParams,
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      const mapped = mapRow(row);
      lastId = mapped.id;
      emitted++;
      yield mapped;
      if (emitted >= max) return;
    }
  }
}

export async function listEndpoints(viewer: Viewer): Promise<string[]> {
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer), "r.team_id", params);
  const rows = await query<{ endpoint: string }>(
    `SELECT DISTINCT r.endpoint FROM community.request_log r
     WHERE ${where} AND r.created_at > now() - interval '30 days' ORDER BY 1 LIMIT 100`,
    params,
  );
  return rows.map((row) => row.endpoint);
}

const CSV_COLUMNS: (keyof LogRow)[] = [
  "createdAt",
  "userEmail",
  "apiKeyId",
  "apiKeyName",
  "method",
  "endpoint",
  "path",
  "target",
  "statusCode",
  "durationMs",
  "credits",
  "jobId",
  "error",
  "origin",
];

export function csvHeader(): string {
  return CSV_COLUMNS.join(",") + "\n";
}

/** RFC 4180 quoting, plus a leading quote on formula-like cells (CSV injection). */
export function csvLine(row: LogRow): string {
  return (
    CSV_COLUMNS.map((column) => {
      const value = row[column];
      if (value === null || value === undefined) return "";
      let text = String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(",") + "\n"
  );
}
