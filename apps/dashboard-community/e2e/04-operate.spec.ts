import { expect, test } from "@playwright/test";
import { ADMIN, createKey, FRIEND, newSignedInPage, poll, scrape } from "./helpers";

test.describe.configure({ mode: "serial" });

test("members cannot open administration pages", async ({ browser }) => {
  const page = await newSignedInPage(browser, FRIEND.email);
  for (const path of ["/settings", "/alerts", "/retention", "/audit", "/users"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/$/);
  }
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
});

test("settings show effective configuration without secrets and save defaults", async ({ browser }) => {
  const page = await newSignedInPage(browser, ADMIN.email);
  await page.goto("/settings");
  const config = page.getByTestId("effective-config");
  await expect(config).toContainText("Auth secret");
  await expect(config).toContainText("configured");
  await expect(page.locator("body")).not.toContainText("e2e-only-better-auth-secret");
  await expect(page.locator("body")).not.toContainText("e2e-postgres-password");
  await page.getByTestId("save-default-limits").click();
  await expect(page.getByText("Default limits saved")).toBeVisible();
});

test("feature matrix renders capabilities and runs a self-test", async ({ browser }) => {
  const page = await newSignedInPage(browser, ADMIN.email);
  await page.goto("/features");
  await expect(page.getByTestId("feature-matrix")).toContainText("Community operator dashboard");
  await page.getByTestId("selftest-scrape").click();
  await expect(page.getByTestId("feature-matrix").getByTestId("selftest-result").first()).toContainText("pass", { timeout: 90_000 });
  await page.getByRole("tab", { name: /Self-test history/ }).click();
  await expect(page.getByTestId("selftest-history")).toContainText("Scrape markdown");
});

test("a member's team blocklist is enforced by the API, then lifted", async ({ browser }) => {
  const page = await newSignedInPage(browser, FRIEND.email);
  const key = await createKey(page, "blocklist key");
  await page.goto("/blocklist");
  await page.getByTestId("team-blocklist-domains").fill("example.com");
  await page.getByTestId("team-blocklist-save").click();
  await expect(page.getByText("Team blocklist saved")).toBeVisible();
  const blocked = await poll(() => scrape(key), (result) => result.status >= 400, 60_000);
  expect(blocked.status, JSON.stringify(blocked.body)).toBeGreaterThanOrEqual(400);

  await page.getByTestId("team-blocklist-domains").fill("");
  await page.getByTestId("team-blocklist-save").click();
  await expect(page.getByText("Team blocklist saved").first()).toBeVisible();
  const allowed = await poll(() => scrape(key), (result) => result.status === 200, 60_000);
  expect(allowed.status).toBe(200);
});

test("alerts, retention, webhooks, docs and notifications work end to end", async ({ browser }) => {
  const admin = await newSignedInPage(browser, ADMIN.email);

  await admin.goto("/alerts");
  await admin.getByTestId("new-alert-rule").click();
  await admin.getByTestId("alert-name").fill("Any 5xx");
  await admin.getByTestId("save-alert-rule").click();
  await expect(admin.getByTestId("alert-rules")).toContainText("Any 5xx");

  await admin.goto("/retention");
  await admin.getByTestId("purge-playground_history").click();
  await expect(admin.getByText(/rows deleted/)).toBeVisible();
  await expect(admin.getByTestId("cleanup-runs")).toContainText("manual");

  await admin.goto("/audit");
  await expect(admin.getByTestId("audit-table")).toContainText("auth.signed_in");
  await expect(admin.getByTestId("audit-table")).toContainText("api_key.created");

  // Invites accepted earlier in the suite notified the admin.
  await admin.goto("/notifications");
  await expect(admin.getByTestId("notifications-table")).toContainText("accepted your invite");

  const friend = await newSignedInPage(browser, FRIEND.email);
  await friend.goto("/webhooks");
  await friend.getByTestId("new-webhook").click();
  await friend.getByTestId("webhook-url").fill("http://127.0.0.1:9/never");
  await friend.getByTestId("save-webhook").click();
  await expect(friend.getByTestId("webhook-secret")).toHaveValue(/^whsec_/);
  await friend.getByRole("button", { name: "Done" }).click();
  await friend.getByTestId("test-webhook").click();
  await expect(friend.getByTestId("webhook-test-result")).toContainText("not delivered");
  await expect(friend.getByTestId("webhook-deliveries")).toContainText("webhook.test");

  await friend.goto("/docs");
  await expect(friend.getByTestId("docs-base-url")).toHaveValue(/^http/);
});

test("command palette navigates", async ({ browser }) => {
  const page = await newSignedInPage(browser, ADMIN.email);
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.type("Audit log");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/audit$/);
});
