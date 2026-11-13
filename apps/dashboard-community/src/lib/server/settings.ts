import "server-only";
import { z } from "zod";
import { audit } from "./audit";
import { assertAdmin, type Viewer } from "./authz";
import { query } from "./db";
import { env } from "./env";

/** Instance settings the dashboard owns (stored in dashboard.setting). */
const intervalSchema = z.enum(["day", "week", "month"]);

export const SETTING_SCHEMAS = {
  defaultLimits: z.object({
    creditLimit: z.number().int().min(0).nullable(),
    creditLimitInterval: intervalSchema.nullable(),
    concurrencyLimit: z.number().int().min(1).nullable(),
  }),
  invitePolicy: z.object({
    defaultTtlHours: z.number().int().min(1).max(24 * 30),
    requireEmail: z.boolean(),
    defaultRole: z.enum(["member", "admin"]),
  }),
  retention: z.object({
    requestLogDays: z.number().int().min(1).max(3650),
    playgroundDays: z.number().int().min(1).max(3650),
    alertEventDays: z.number().int().min(1).max(3650),
    notificationDays: z.number().int().min(1).max(3650),
  }),
  alertWebhook: z.object({
    url: z.union([z.url(), z.literal("")]),
    secret: z.string().max(256),
  }),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };

export function defaultSettings(): Settings {
  const config = env();
  return {
    defaultLimits: { creditLimit: null, creditLimitInterval: null, concurrencyLimit: null },
    invitePolicy: { defaultTtlHours: config.DASHBOARD_INVITE_TTL_HOURS, requireEmail: false, defaultRole: "member" },
    retention: {
      requestLogDays: config.COMMUNITY_REQUEST_LOG_RETENTION_DAYS,
      playgroundDays: 90,
      alertEventDays: 90,
      notificationDays: 60,
    },
    alertWebhook: { url: "", secret: "" },
  };
}

export async function getSettings(): Promise<Settings> {
  const settings = defaultSettings();
  const rows = await query<{ key: string; value: unknown }>(`SELECT key, value FROM dashboard.setting`);
  for (const row of rows) {
    if (!(row.key in SETTING_SCHEMAS)) continue;
    const key = row.key as SettingKey;
    const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
    if (parsed.success) (settings as Record<SettingKey, unknown>)[key] = parsed.data;
  }
  return settings;
}

export async function setSetting<K extends SettingKey>(viewer: Viewer, key: K, value: unknown): Promise<Settings[K]> {
  assertAdmin(viewer);
  const parsed = SETTING_SCHEMAS[key].parse(value) as Settings[K];
  await query(
    `INSERT INTO dashboard.setting (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3::uuid)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(parsed), viewer.userId],
  );
  // Secrets are never written to the audit log.
  const logged = key === "alertWebhook" ? { url: (parsed as Settings["alertWebhook"]).url, secret: "[set]" } : parsed;
  await audit(viewer.userId, "settings.updated", {}, { key, value: logged });
  return parsed;
}

/** Shows that a secret is set without revealing any of it. */
export function maskSecret(value: string | undefined): string {
  return value ? "configured" : "not set";
}

/** Read-only view of the effective configuration. No secret value is ever included. */
export function effectiveConfig() {
  const config = env();
  const url = (value?: string) => {
    if (!value) return "not set";
    try {
      const parsed = new URL(value);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return "configured";
    }
  };
  return [
    { group: "Dashboard", items: [
      { label: "Public URL", value: config.DASHBOARD_URL },
      { label: "Auth secret", value: maskSecret(config.BETTER_AUTH_SECRET) },
      { label: "Bootstrap token", value: config.DASHBOARD_BOOTSTRAP_TOKEN ? "set (remove it after setup)" : "not set" },
      { label: "SMTP", value: config.SMTP_HOST ? `${config.SMTP_HOST}:${config.SMTP_PORT}` : "not configured (invite links are copied)" },
    ] },
    { group: "Firecrawl API", items: [
      { label: "Internal API URL", value: url(config.FIRECRAWL_API_URL) },
      { label: "Public API URL", value: url(config.FIRECRAWL_PUBLIC_API_URL ?? config.FIRECRAWL_API_URL) },
      { label: "Request-log retention (API)", value: `${config.COMMUNITY_REQUEST_LOG_RETENTION_DAYS} days` },
    ] },
    { group: "AI", items: [
      { label: "LLM endpoint", value: url(config.OPENAI_BASE_URL) },
      { label: "LLM API key", value: maskSecret(config.OPENAI_API_KEY) },
      { label: "Model", value: config.MODEL_NAME ?? "not set" },
      { label: "Embedding model", value: config.MODEL_EMBEDDING_NAME ?? "not set" },
      { label: "SearXNG", value: url(config.SEARXNG_ENDPOINT) },
    ] },
    { group: "Data", items: [
      { label: "Application database", value: maskSecret(config.DATABASE_URL) },
      { label: "Queue database", value: maskSecret(config.NUQ_DATABASE_URL) },
      { label: "Redis", value: maskSecret(config.REDIS_RATE_LIMIT_URL ?? config.REDIS_URL) },
    ] },
    { group: "Community services", items: [
      { label: "Browser service", value: url(config.BROWSER_SERVICE_URL) },
      { label: "Fire Engine", value: url(config.FIRE_ENGINE_BETA_URL) },
      { label: "Highlight", value: url(config.HIGHLIGHT_SERVICE_URL) },
      { label: "Audio/video grab", value: url(config.AVGRAB_SERVICE_URL) },
      { label: "Fire Privacy", value: url(config.FIRE_PRIVACY_URL) },
      { label: "Agent service", value: url(config.AGENT_SERVICE_URL) },
      { label: "Index service", value: url(config.INDEX_SERVICE_URL) },
    ] },
  ];
}
