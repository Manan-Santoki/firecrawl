import "server-only";
import { actingKey } from "./acting-key";
import { ForbiddenError, type Viewer } from "./authz";
import { query } from "./db";
import { FirecrawlApiError, firecrawlRequest } from "./firecrawl-api";
import { endpointPath, type PlaygroundKind } from "@/lib/playground-shared";

const STATUS_PATHS: Partial<Record<PlaygroundKind, (id: string) => string>> = {
  crawl: (id) => `/v2/crawl/${id}`,
  batch_scrape: (id) => `/v2/batch/scrape/${id}`,
  extract: (id) => `/v2/extract/${id}`,
  agent: (id) => `/v2/agent/${id}`,
};

const PREVIEW_LIMIT = 200_000;

/** Large or binary fields are dropped from the stored preview; the API keeps the full result. */
export function previewOf(body: unknown): unknown {
  const text = JSON.stringify(body ?? null);
  if (text.length <= PREVIEW_LIMIT) return body;
  return { truncated: true, bytes: text.length, head: text.slice(0, 4_000) };
}

export type PlaygroundResult = {
  ok: boolean;
  status: number;
  durationMs: number;
  body: unknown;
  jobId: string | null;
  historyId: string;
};

export async function runPlayground(
  viewer: Viewer,
  input: { kind: PlaygroundKind; body: Record<string, unknown>; keyId?: number | null; title?: string | null },
): Promise<PlaygroundResult> {
  const key = await actingKey(viewer, { keyId: input.keyId ?? null });
  const started = performance.now();
  let status = 200;
  let body: unknown;
  try {
    body = await firecrawlRequest(key.key, endpointPath(input.kind), {
      method: "POST",
      body: { ...input.body, origin: "community-dashboard-playground" },
      timeoutMs: 180_000,
    });
  } catch (error) {
    if (!(error instanceof FirecrawlApiError)) throw error;
    status = error.status;
    body = error.body ?? { error: error.message };
  }
  const durationMs = Math.round(performance.now() - started);
  const jobId =
    body && typeof body === "object" && "id" in body && typeof (body as { id: unknown }).id === "string"
      ? (body as { id: string }).id
      : null;
  const rows = await query<{ id: string }>(
    `INSERT INTO dashboard.playground_request
       (user_id, team_id, api_key_id, kind, title, request, status_code, duration_ms, job_id, response_preview)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb)
     RETURNING id`,
    [
      viewer.userId,
      key.teamId,
      key.id,
      input.kind,
      input.title?.slice(0, 200) ?? null,
      JSON.stringify(input.body),
      status,
      durationMs,
      jobId,
      JSON.stringify(previewOf(body)),
    ],
  );
  return { ok: status < 400, status, durationMs, body, jobId, historyId: rows[0].id };
}

/** Polls an async playground job as the viewer (the history row proves ownership). */
export async function pollPlayground(viewer: Viewer, historyId: string): Promise<{ status: number; body: unknown }> {
  const rows = await query<{ kind: PlaygroundKind; job_id: string | null; api_key_id: string | null; team_id: string }>(
    `SELECT kind, job_id, api_key_id, team_id FROM dashboard.playground_request WHERE id = $1::uuid AND user_id = $2::uuid`,
    [historyId, viewer.userId],
  );
  const row = rows[0];
  if (!row || !row.job_id || !STATUS_PATHS[row.kind]) throw new ForbiddenError("Unknown playground run.");
  const key = await actingKey(viewer, { keyId: row.api_key_id ? Number(row.api_key_id) : null }).catch(() =>
    actingKey(viewer),
  );
  try {
    const body = await firecrawlRequest(key.key, STATUS_PATHS[row.kind]!(row.job_id));
    return { status: 200, body };
  } catch (error) {
    if (error instanceof FirecrawlApiError) return { status: error.status, body: error.body ?? { error: error.message } };
    throw error;
  }
}

export type HistoryItem = {
  id: string;
  createdAt: string;
  kind: PlaygroundKind;
  title: string | null;
  request: Record<string, unknown>;
  statusCode: number | null;
  durationMs: number | null;
  jobId: string | null;
};

export async function listHistory(viewer: Viewer, limit = 50): Promise<HistoryItem[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, created_at, kind, title, request, status_code, duration_ms, job_id
     FROM dashboard.playground_request WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
    [viewer.userId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    createdAt: new Date(row.created_at as string).toISOString(),
    kind: row.kind as PlaygroundKind,
    title: (row.title as string | null) ?? null,
    request: row.request as Record<string, unknown>,
    statusCode: (row.status_code as number | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    jobId: (row.job_id as string | null) ?? null,
  }));
}

export async function deleteHistory(viewer: Viewer, id: string): Promise<void> {
  await query(`DELETE FROM dashboard.playground_request WHERE id = $1::uuid AND user_id = $2::uuid`, [id, viewer.userId]);
}
