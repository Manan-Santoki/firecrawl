import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, twoFactor } from "better-auth/plugins";
import { pools } from "./db";
import { env } from "./env";

/**
 * Sign-up is closed to the public: accounts are only created by the bootstrap
 * and invite server actions, which call `auth.api.signUpEmail` without an
 * HTTP request after validating their one-time token. Any sign-up that
 * arrives over HTTP is refused here (and the route handler also 404s it).
 */
export function isPublicSignUpAttempt(path: string, hasRequest: boolean): boolean {
  return hasRequest && path.startsWith("/sign-up");
}

function buildAuth() {
  const config = env();
  const trustedOrigins = [
    config.DASHBOARD_URL,
    ...(config.DASHBOARD_TRUSTED_ORIGINS?.split(",").map((origin) => origin.trim()) ?? []),
  ].filter(Boolean);

  return betterAuth({
    appName: "Firecrawl Dashboard",
    baseURL: config.DASHBOARD_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: pools().app,
    trustedOrigins,
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      autoSignIn: true,
    },
    user: {
      additionalFields: {
        teamId: { type: "string", required: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: config.DASHBOARD_LOGIN_RATE_LIMIT },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: config.DASHBOARD_URL.startsWith("https://"),
      cookiePrefix: "fc-dashboard",
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (isPublicSignUpAttempt(ctx.path, Boolean(ctx.request))) {
          throw new APIError("FORBIDDEN", {
            message: "Sign-up is invite-only.",
          });
        }
      }),
    },
    plugins: [
      admin({
        defaultRole: "member",
        adminRoles: ["admin"],
        bannedUserMessage: "This account has been disabled by an administrator.",
      }),
      twoFactor({ issuer: "Firecrawl Dashboard" }),
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof buildAuth>;
const globalForAuth = globalThis as unknown as { __dashboardAuth?: Auth };

export function auth(): Auth {
  globalForAuth.__dashboardAuth ??= buildAuth();
  return globalForAuth.__dashboardAuth;
}
