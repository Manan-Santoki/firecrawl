import { expect, test } from "@playwright/test";

// Runs last: it exhausts the sign-in budget for this client for a minute.
test("sign-in is rate limited per client", async ({ request }) => {
  const limit = Number(process.env.DASHBOARD_E2E_LOGIN_RATE_LIMIT ?? 40);
  const statuses: number[] = [];
  for (let attempt = 0; attempt <= limit + 1; attempt++) {
    const response = await request.post("/api/auth/sign-in/email", {
      data: { email: "nobody@e2e.test", password: "wrong-password-123" },
      headers: { origin: process.env.DASHBOARD_E2E_URL ?? "http://localhost:3393" },
    });
    statuses.push(response.status());
    if (response.status() === 429) break;
  }
  expect(statuses).toContain(429);
  expect(statuses.filter((status) => status === 401).length).toBeGreaterThan(0);
});
