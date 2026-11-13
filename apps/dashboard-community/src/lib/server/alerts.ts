import "server-only";
import { z } from "zod";
import { audit } from "./audit";
import { assertAdmin, type Viewer } from "./authz";
import { pools, query } from "./db";
import { runHealthChecks } from "./health";
import { sendMail } from "./mail";
import { adminUserIds, notify } from "./notifications";
import { getSettings } from "./settings";
import { deliverSigned } from "./signing";

export const ALERT_KINDS = {
  error_rate: { label: "Error rate", unit: "% of requests with HTTP 5xx", defaultThreshold: 10 },
  queue_backlog: { label: "Queue backlog", unit: "queued scrape jobs", defaultThreshold: 500 },
  service_down: { label: "Service down", unit: "configured services down", defaultThreshold: 1 },
  credit_limit: { label: "Credit limit nearly used", unit: "% of a user's or key's limit", defaultThreshold: 80 },
  agent_failures: { label: "Agent failures", unit: "failed agent starts", defaultThreshold: 3 },
} as const;
export type AlertKind = keyof typeof ALERT_KINDS;

export const ruleSchema = z.object({
  kind: z.enum(Object.keys(ALERT_KINDS) as [AlertKind, ...AlertKind[]]),
  name: z.string().trim().min(1).max(100),
  threshold: z.number().min(0).max(1_000_000),
  windowMinutes: z.number().int().min(1).max(24 * 60),
  cooldownMinutes: z.number().int().min(1).max(7 * 24 * 60),
  channels: z.object({ inApp: z.boolean(), email: z.boolean(), webhook: z.boolean() }),
  enabled: z.boolean(),
});
export type RuleInput = z.infer<typeof ruleSchema>;

export type AlertRuleRow = RuleInput & { id: string; lastFiredAt: string | null };

function mapRule(row: Record<string, unknown>): AlertRuleRow {
  return {
    id: String(row.id),
    kind: row.kind as AlertKind,
    name: String(row.name),
    threshold: Number(row.threshold),
    windowMinutes: Number(row.window_minutes),
    cooldownMinutes: Number(row.cooldown_minutes),
    channels: row.channels as RuleInput["channels"],
    enabled: Boolean(row.enabled),
    lastFiredAt: row.last_fired_at ? new Date(row.last_fired_at as string).toISOString() : null,
  };
}

export async function listRules(viewer: Viewer): Promise<AlertRuleRow[]> {
  assertAdmin(viewer);
  return (await query<Record<string, unknown>>(`SELECT * FROM dashboard.alert_rule ORDER BY created_at`)).map(mapRule);
}

export async function saveRule(viewer: Viewer, id: string | null, input: RuleInput): Promise<void> {
  assertAdmin(viewer);
  const rule = ruleSchema.parse(input);
  if (id) {
    await query(
      `UPDATE dashboard.alert_rule SET kind = $2, name = $3, threshold = $4, window_minutes = $5, cooldown_minutes = $6,
         channels = $7::jsonb, enabled = $8 WHERE id = $1::uuid`,
      [id, rule.kind, rule.name, rule.threshold, rule.windowMinutes, rule.cooldownMinutes, JSON.stringify(rule.channels), rule.enabled],
    );
  } else {
    await query(
      `INSERT INTO dashboard.alert_rule (kind, name, threshold, window_minutes, cooldown_minutes, channels, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::uuid)`,
      [rule.kind, rule.name, rule.threshold, rule.windowMinutes, rule.cooldownMinutes, JSON.stringify(rule.channels), rule.enabled, viewer.userId],
    );
  }
  await audit(viewer.userId, id ? "alert.rule_updated" : "alert.rule_created", {}, { ...rule, id });
}

export async function deleteRule(viewer: Viewer, id: string): Promise<void> {
  assertAdmin(viewer);
  await query(`DELETE FROM dashboard.alert_rule WHERE id = $1::uuid`, [id]);
  await audit(viewer.userId, "alert.rule_deleted", {}, { id });
}

export type AlertEventRow = {
  id: number;
  createdAt: string;
  kind: string;
  severity: string;
  message: string;
  deliveries: { channel: string; success: boolean; detail?: string }[];
};

export async function listEvents(viewer: Viewer, limit = 100): Promise<AlertEventRow[]> {
  assertAdmin(viewer);
  const rows = await query<Record<string, unknown>>(
    `SELECT id, created_at, kind, severity, message, deliveries FROM dashboard.alert_event ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    createdAt: new Date(row.created_at as string).toISOString(),
    kind: String(row.kind),
    severity: String(row.severity),
    message: String(row.message),
    deliveries: (row.deliveries as AlertEventRow["deliveries"]) ?? [],
  }));
}

export type Finding = { message: string; severity: "warning" | "critical"; teamId?: string; userId?: string; details: Record<string, unknown> };

/** Evaluates one rule against current data. Pure SQL reads; no side effects. */
export async function evaluateRule(rule: AlertRuleRow): Promise<Finding[]> {
  switch (rule.kind) {
    case "error_rate": {
      const [row] = await query<{ total: number; errors: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status_code >= 500)::int AS errors
         FROM community.request_log WHERE created_at > now() - make_interval(mins => $1)`,
        [rule.windowMinutes],
      );
      const rate = row.total ? (row.errors / row.total) * 100 : 0;
      return row.total >= 10 && rate >= rule.threshold
        ? [{ severity: "critical", message: `Error rate ${rate.toFixed(1)}% over the last ${rule.windowMinutes} min (${row.errors} of ${row.total} requests).`, details: { rate, ...row } }]
        : [];
    }
    case "queue_backlog": {
      const nuq = pools().nuq;
      if (!nuq) return [];
      const result = await nuq.query<{ queued: number }>(`SELECT count(*)::int AS queued FROM nuq.queue_scrape WHERE status = 'queued'`);
      const queued = result.rows[0].queued;
      return queued >= rule.threshold
        ? [{ severity: "warning", message: `${queued} scrape jobs are waiting in the queue.`, details: { queued } }]
        : [];
    }
    case "service_down": {
      const down = (await runHealthChecks()).filter((check) => check.state === "down");
      return down.length >= Math.max(1, rule.threshold)
        ? [{ severity: "critical", message: `Down: ${down.map((check) => check.name).join(", ")}.`, details: { services: down.map((check) => check.id) } }]
        : [];
    }
    case "credit_limit": {
      const rows = await query<{ team_id: string; user_id: string | null; email: string | null; credit_limit: number; used: string }>(
        `SELECT l.team_id, u.id AS user_id, u.email, l.credit_limit,
                (SELECT COALESCE(sum(c.credits), 0) FROM community.credit_usage c
                  WHERE c.team_id = l.team_id AND c.created_at >= community.credit_window_start(l.credit_limit_interval)) AS used
         FROM community.team_limits l LEFT JOIN dashboard."user" u ON u."teamId" = l.team_id
         WHERE l.credit_limit IS NOT NULL AND l.credit_limit > 0`,
      );
      return rows
        .filter((row) => (Number(row.used) / row.credit_limit) * 100 >= rule.threshold)
        .map((row) => ({
          severity: Number(row.used) >= row.credit_limit ? "critical" : "warning",
          teamId: row.team_id,
          userId: row.user_id ?? undefined,
          message: `${row.email ?? row.team_id} has used ${Number(row.used)} of ${row.credit_limit} credits in the current window.`,
          details: { used: Number(row.used), limit: row.credit_limit },
        }));
    }
    case "agent_failures": {
      const [row] = await query<{ failed: number }>(
        `SELECT count(*)::int AS failed FROM community.request_log
         WHERE endpoint IN ('/v2/agent', '/v1/agent') AND method = 'POST' AND status_code >= 500
           AND created_at > now() - make_interval(mins => $1)`,
        [rule.windowMinutes],
      );
      return row.failed >= rule.threshold
        ? [{ severity: "warning", message: `${row.failed} agent runs failed to start in the last ${rule.windowMinutes} min.`, details: row }]
        : [];
    }
  }
}

async function deliver(rule: AlertRuleRow, finding: Finding, eventId: number) {
  const deliveries: AlertEventRow["deliveries"] = [];
  const admins = await adminUserIds();
  const dedupe = `alert:${rule.id}:${finding.teamId ?? "all"}:${eventId}`;
  if (rule.channels.inApp) {
    await notify(admins, { kind: "alert", title: rule.name, body: finding.message, link: "/alerts", dedupeKey: dedupe });
    deliveries.push({ channel: "in-app", success: true });
  }
  // Users opted in to their own limit alerts are told directly.
  if (rule.kind === "credit_limit" && finding.userId) {
    const pref = await query<{ limit_alerts: boolean }>(`SELECT limit_alerts FROM dashboard.user_preference WHERE user_id = $1::uuid`, [finding.userId]);
    if (pref[0]?.limit_alerts ?? true) {
      await notify([finding.userId], { kind: "limit", title: "You are close to your credit limit", body: finding.message, link: "/usage", dedupeKey: dedupe });
      deliveries.push({ channel: "user", success: true });
    }
  }
  if (rule.channels.email) {
    const emails = await query<{ email: string }>(`SELECT email FROM dashboard."user" WHERE id = ANY($1::uuid[])`, [admins]);
    const sent = await sendMail(emails.map((row) => row.email), `[Firecrawl] ${rule.name}`, finding.message);
    deliveries.push({ channel: "email", success: sent, detail: sent ? undefined : "SMTP not configured or failed" });
  }
  if (rule.channels.webhook) {
    const { alertWebhook } = await getSettings();
    if (alertWebhook.url) {
      const result = await deliverSigned(alertWebhook.url, alertWebhook.secret, "alert.fired", { rule: { id: rule.id, kind: rule.kind, name: rule.name }, ...finding });
      deliveries.push({ channel: "webhook", success: result.success, detail: result.error ?? `HTTP ${result.statusCode}` });
    } else {
      deliveries.push({ channel: "webhook", success: false, detail: "No alert webhook configured" });
    }
  }
  await query(`UPDATE dashboard.alert_event SET deliveries = $2::jsonb WHERE id = $1`, [eventId, JSON.stringify(deliveries)]);
}

/** Evaluates every enabled rule outside its cooldown and records and delivers what fired. */
export async function evaluateAlerts(): Promise<number> {
  const rules = (await query<Record<string, unknown>>(
    `SELECT * FROM dashboard.alert_rule
     WHERE enabled AND (last_fired_at IS NULL OR last_fired_at < now() - make_interval(mins => cooldown_minutes))`,
  )).map(mapRule);
  let fired = 0;
  for (const rule of rules) {
    let findings: Finding[] = [];
    try {
      findings = await evaluateRule(rule);
    } catch (error) {
      console.error("Alert rule evaluation failed", rule.id, error instanceof Error ? error.message : error);
      continue;
    }
    for (const finding of findings) {
      const rows = await query<{ id: string }>(
        `INSERT INTO dashboard.alert_event (rule_id, kind, severity, subject_team_id, message, details)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb) RETURNING id`,
        [rule.id, rule.kind, finding.severity, finding.teamId ?? null, finding.message, JSON.stringify(finding.details)],
      );
      await deliver(rule, finding, Number(rows[0].id));
      fired++;
    }
    if (findings.length) await query(`UPDATE dashboard.alert_rule SET last_fired_at = now() WHERE id = $1::uuid`, [rule.id]);
  }
  return fired;
}

export async function testAlertWebhook(viewer: Viewer) {
  assertAdmin(viewer);
  const { alertWebhook } = await getSettings();
  if (!alertWebhook.url) throw new z.ZodError([{ code: "custom", path: ["url"], message: "Set an alert webhook URL first.", input: "" }]);
  return deliverSigned(alertWebhook.url, alertWebhook.secret, "alert.test", { message: "Test alert from the Firecrawl dashboard." });
}
