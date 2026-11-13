import { z } from "zod";

const optionalUrl = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .pipe(z.url().optional())
  .optional();

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const schema = z.object({
  DASHBOARD_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  DASHBOARD_BOOTSTRAP_TOKEN: optionalString,
  DATABASE_URL: z.string().min(1),
  NUQ_DATABASE_URL: optionalString,
  // Same Redis the API uses: REDIS_RATE_LIMIT_URL holds the auth cache the
  // dashboard invalidates, REDIS_EVICT_URL the crawl state it reads.
  REDIS_URL: optionalString,
  REDIS_RATE_LIMIT_URL: optionalString,
  REDIS_EVICT_URL: optionalString,
  FIRECRAWL_API_URL: z.url(),
  // Public API origin shown in snippets and onboarding (defaults to FIRECRAWL_API_URL).
  FIRECRAWL_PUBLIC_API_URL: optionalUrl,
  // The team the bootstrap admin adopts, normally the seeded FIRECRAWL_TEAM_ID.
  DASHBOARD_ADMIN_TEAM_ID: optionalString,
  DASHBOARD_INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),
  DASHBOARD_TRUSTED_ORIGINS: optionalString,
  // Sign-in attempts allowed per IP per minute.
  DASHBOARD_LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  // Health probes (never displayed, only their reachability).
  RABBITMQ_MANAGEMENT_URL: optionalUrl,
  NUQ_RABBITMQ_URL: optionalString,
  PLAYWRIGHT_MICROSERVICE_URL: optionalUrl,
  BROWSER_SERVICE_URL: optionalUrl,
  SEARXNG_ENDPOINT: optionalUrl,
  OPENAI_BASE_URL: optionalUrl,
  OPENAI_API_KEY: optionalString,
  MODEL_NAME: optionalString,
  MODEL_EMBEDDING_NAME: optionalString,
  EMBEDDING_SERVICE_URL: optionalUrl,
  FIRE_ENGINE_BETA_URL: optionalUrl,
  HIGHLIGHT_SERVICE_URL: optionalUrl,
  AVGRAB_SERVICE_URL: optionalUrl,
  FIRE_PRIVACY_URL: optionalUrl,
  AGENT_SERVICE_URL: optionalUrl,
  INDEX_SERVICE_URL: optionalUrl,
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  COMMUNITY_REQUEST_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type DashboardEnv = z.infer<typeof schema>;

let cached: DashboardEnv | null = null;

/** Parsed, validated environment. Throws with every missing variable named. */
export function env(): DashboardEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid dashboard configuration: ${problems}`);
  }
  cached = parsed.data;
  return cached;
}
