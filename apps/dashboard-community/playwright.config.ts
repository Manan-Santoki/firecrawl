import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a real Docker Compose stack:
 *   docker compose --env-file apps/dashboard-community/e2e/compose.env \
 *     -f docker-compose.yaml -f community/docker-compose.auth.yaml \
 *     -f community/docker-compose.dashboard.yaml up -d --build
 * then `pnpm test:e2e`. The specs share one database, so they run in order.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.DASHBOARD_E2E_URL ?? "http://localhost:3393",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
});
