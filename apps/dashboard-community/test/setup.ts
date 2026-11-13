import { vi } from "vitest";

// Integration tests need a PostgreSQL migrated with community/migrations
// (through 110-dashboard-schema) and seeded with 090-seed.sql.
process.env.DATABASE_URL = process.env.DASHBOARD_TEST_DATABASE_URL ?? "postgresql://invalid:invalid@127.0.0.1:1/none";
process.env.DASHBOARD_URL = "http://localhost:3999";
process.env.BETTER_AUTH_SECRET = "test-only-secret-0123456789abcdef0123456789";
process.env.DASHBOARD_BOOTSTRAP_TOKEN = "test-bootstrap-token";
process.env.FIRECRAWL_API_URL = "http://127.0.0.1:1";
delete process.env.REDIS_URL;
delete process.env.NUQ_DATABASE_URL;

// The Next.js cookie plugin needs a request scope; server-side tests have none.
vi.mock("better-auth/next-js", () => ({
  nextCookies: () => ({ id: "next-cookies" }),
  toNextJsHandler: () => ({}),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
