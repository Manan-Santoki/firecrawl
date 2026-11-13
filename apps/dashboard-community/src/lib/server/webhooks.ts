import "server-only";
import { audit } from "./audit";
import { ForbiddenError, resolveScope, scopeClause, type Viewer } from "./authz";
import { query } from "./db";
import { deliverSigned, newWebhookSecret } from "./signing";

export const WEBHOOK_EVENTS = ["crawl", "batch_scrape", "agent"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type UserWebhook = { id: string; url: string; events: WebhookEvent[]; enabled: boolean; createdAt: string; secretHint: string };

const mask = (secret: string) => `${secret.slice(0, 8)}…${secret.slice(-4)}`;

/** Only the viewer's own default webhooks. */
export async function listWebhooks(viewer: Viewer): Promise<UserWebhook[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, url, events, enabled, created_at, secret FROM dashboard.user_webhook WHERE user_id = $1::uuid ORDER BY created_at`,
    [viewer.userId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    url: String(row.url),
    events: row.events as WebhookEvent[],
    enabled: Boolean(row.enabled),
    createdAt: new Date(row.created_at as string).toISOString(),
    secretHint: mask(String(row.secret)),
  }));
}

/** The default webhook for an event, used by the playground for crawls, batches and agent runs. */
export async function defaultWebhookFor(viewer: Viewer, event: WebhookEvent): Promise<{ url: string; secret: string } | null> {
  const rows = await query<{ url: string; secret: string }>(
    `SELECT url, secret FROM dashboard.user_webhook WHERE user_id = $1::uuid AND enabled AND $2 = ANY(events) ORDER BY created_at LIMIT 1`,
    [viewer.userId, event],
  );
  return rows[0] ?? null;
}

export async function createWebhook(viewer: Viewer, input: { url: string; events: WebhookEvent[] }): Promise<{ id: string; secret: string }> {
  if (!viewer.teamId) throw new ForbiddenError("Your account has no Firecrawl team.");
  const secret = newWebhookSecret();
  const rows = await query<{ id: string }>(
    `INSERT INTO dashboard.user_webhook (user_id, team_id, url, secret, events) VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[]) RETURNING id`,
    [viewer.userId, viewer.teamId, input.url, secret, input.events],
  );
  await audit(viewer.userId, "webhook.created", { teamId: viewer.teamId }, { webhookId: rows[0].id, url: input.url });
  return { id: rows[0].id, secret };
}

async function ownWebhook(viewer: Viewer, id: string) {
  const rows = await query<{ id: string; url: string; secret: string }>(
    `SELECT id, url, secret FROM dashboard.user_webhook WHERE id = $1::uuid AND user_id = $2::uuid`,
    [id, viewer.userId],
  );
  if (!rows[0]) throw new ForbiddenError("Webhook not found.");
  return rows[0];
}

export async function updateWebhook(viewer: Viewer, id: string, input: { enabled?: boolean; events?: WebhookEvent[] }) {
  await ownWebhook(viewer, id);
  await query(
    `UPDATE dashboard.user_webhook SET enabled = COALESCE($2, enabled), events = COALESCE($3::text[], events) WHERE id = $1::uuid`,
    [id, input.enabled ?? null, input.events ?? null],
  );
}

export async function deleteWebhook(viewer: Viewer, id: string) {
  await ownWebhook(viewer, id);
  await query(`DELETE FROM dashboard.user_webhook WHERE id = $1::uuid`, [id]);
  await audit(viewer.userId, "webhook.deleted", { teamId: viewer.teamId }, { webhookId: id });
}

/** Sends a signed `webhook.test` event and records the attempt. */
export async function testWebhook(viewer: Viewer, id: string) {
  const hook = await ownWebhook(viewer, id);
  const result = await deliverSigned(hook.url, hook.secret, "webhook.test", { message: "Test delivery from the Firecrawl dashboard." });
  await query(
    `INSERT INTO dashboard.webhook_delivery (webhook_id, target, event, status_code, success, latency_ms, error)
     VALUES ($1::uuid, $2, 'webhook.test', $3, $4, $5, $6)`,
    [id, hook.url, result.statusCode, result.success, result.latencyMs, result.error],
  );
  return result;
}

export type DeliveryRow = { source: "dashboard" | "api"; createdAt: string; event: string; url: string; statusCode: number | null; success: boolean; latencyMs: number | null; error: string | null };

/**
 * Recent deliveries: the dashboard's own test sends plus the API's webhook
 * attempts for the viewer's team (public.webhook_logs).
 */
export async function recentDeliveries(viewer: Viewer, teamFilter?: string | null): Promise<DeliveryRow[]> {
  const own = await query<Record<string, unknown>>(
    `SELECT d.created_at, d.event, d.target, d.status_code, d.success, d.latency_ms, d.error
     FROM dashboard.webhook_delivery d JOIN dashboard.user_webhook w ON w.id = d.webhook_id
     WHERE w.user_id = $1::uuid ORDER BY d.created_at DESC LIMIT 50`,
    [viewer.userId],
  );
  const params: unknown[] = [];
  const where = scopeClause(resolveScope(viewer, teamFilter ?? viewer.teamId), "l.team_id", params);
  const api = await query<Record<string, unknown>>(
    `SELECT l.created_at, l.event, l.url, l.status_code, l.success, l.latency_ms, l.error
     FROM public.webhook_logs l WHERE ${where} ORDER BY l.created_at DESC LIMIT 100`,
    params,
  );
  const map = (source: DeliveryRow["source"]) => (row: Record<string, unknown>): DeliveryRow => ({
    source,
    createdAt: new Date(row.created_at as string).toISOString(),
    event: String(row.event),
    url: String(row.target ?? row.url),
    statusCode: row.status_code === null ? null : Number(row.status_code),
    success: Boolean(row.success),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    error: (row.error as string | null) ?? null,
  });
  return [...own.map(map("dashboard")), ...api.map(map("api"))].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}
