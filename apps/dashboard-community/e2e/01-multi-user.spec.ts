import { expect, type Page, test } from "@playwright/test";
import {
  ADMIN,
  acceptInvite,
  BOOTSTRAP_TOKEN,
  createInvite,
  createKey,
  FRIEND,
  OTHER,
  PASSWORD,
  poll,
  SCRAPE_URL,
  scrape,
  signIn,
} from "./helpers";

test.describe.configure({ mode: "serial" });

let admin: Page;
let friend: Page;
let other: Page;
let friendKey: string;

test("bootstrap creates the administrator once, then sign-up is closed", async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  admin = await context.newPage();
  await admin.goto("/login");
  await expect(admin).toHaveURL(/\/bootstrap$/);

  await admin.getByLabel("Bootstrap token").fill("not-the-token");
  await admin.getByLabel("Name").fill(ADMIN.name);
  await admin.getByLabel("Email").fill(ADMIN.email);
  await admin.getByLabel("Password").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create administrator" }).click();
  await expect(admin.getByText("The bootstrap token is not valid.")).toBeVisible();

  await admin.getByLabel("Bootstrap token").fill(BOOTSTRAP_TOKEN);
  await admin.getByLabel("Password").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create administrator" }).click();
  await expect(admin).toHaveURL(/\/$/);
  await expect(admin.getByRole("heading", { name: "Overview" })).toBeVisible();

  // Bootstrap is now closed and the public sign-up endpoint refuses.
  const bootstrap = await request.get("/bootstrap", { maxRedirects: 0 });
  expect([307, 308]).toContain(bootstrap.status());
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { name: "x", email: "intruder@e2e.test", password: PASSWORD },
  });
  expect(signUp.status()).toBe(404);
});

test("admin invites a friend who signs up with their own team", async ({ browser }) => {
  const url = await createInvite(admin, FRIEND.email);
  expect(url).toContain("/invite/");
  friend = await acceptInvite(browser, url, FRIEND);
  await expect(friend.getByText("Member workspace")).toBeVisible();
  // Members never see admin navigation.
  await expect(friend.getByRole("link", { name: "Users" })).toHaveCount(0);

  // The link is single-use.
  const reuse = await browser.newPage();
  await reuse.goto(new URL(url).pathname);
  await expect(reuse.getByText("This invite can’t be used")).toBeVisible();
  await reuse.close();
});

test("friend creates a key, calls /v2/scrape and sees it in their log", async () => {
  friendKey = await createKey(friend, "friend laptop");
  expect(friendKey).toMatch(/^fc-[0-9a-f]{32}$/);
  // The full key is never shown again.
  await expect(friend.getByTestId("keys-table")).not.toContainText(friendKey);

  const result = await scrape(friendKey);
  expect(result.status, JSON.stringify(result.body)).toBe(200);

  await poll(
    async () => {
      await friend.goto("/logs");
      return friend.getByTestId("log-table-row").count();
    },
    (count) => count > 0,
  );
  const row = friend.getByTestId("log-table-row").filter({ hasText: SCRAPE_URL }).first();
  await expect(row).toContainText("/v2/scrape");
  await expect(row).toContainText("200");
  await row.click();
  await expect(friend.getByTestId("log-detail")).toContainText("friend laptop");
  await friend.keyboard.press("Escape");

  // Credits are charged against the friend's team.
  await poll(
    async () => {
      await friend.goto("/");
      return friend.getByTestId("stat-credits-value").innerText();
    },
    (text) => text !== "0",
  );
});

test("the admin overview shows the friend's request", async () => {
  await admin.goto("/");
  const row = admin.getByTestId("overview-users").getByRole("row").filter({ hasText: FRIEND.email });
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell").nth(1)).not.toHaveText("0");
  await admin.goto("/logs");
  await expect(admin.getByTestId("log-table")).toContainText(FRIEND.email);
});

test("another member cannot see the friend's requests, keys or jobs", async ({ browser }) => {
  const url = await createInvite(admin);
  other = await acceptInvite(browser, url, OTHER);
  await other.goto("/logs");
  await expect(other.getByTestId("log-table")).not.toContainText(SCRAPE_URL);
  await expect(other.getByText("No requests match")).toBeVisible();
  await other.goto("/keys");
  await expect(other.getByTestId("keys-table")).not.toContainText("friend laptop");

  // Asking for the friend's team explicitly is refused, in the page and the export.
  const friendTeam = await friend.evaluate(async () => {
    const response = await fetch("/profile");
    const html = await response.text();
    return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(html.split("Firecrawl team")[1] ?? "")?.[1];
  });
  expect(friendTeam).toBeTruthy();
  await other.goto(`/logs?user=${friendTeam}`);
  await expect(other.getByText("You can only view your own requests.")).toBeVisible();
  const exported = await other.request.get(`/api/logs/export?user=${friendTeam}`);
  expect(exported.status()).toBe(403);
  const ownExport = await other.request.get("/api/logs/export?range=30d");
  expect(ownExport.status()).toBe(200);
  expect(await ownExport.text()).not.toContain(SCRAPE_URL);
  await other.goto("/users");
  await expect(other).toHaveURL(/\/$/);
});

test("admin limits are enforced by the API: a zero credit limit refuses with 402", async () => {
  await admin.goto("/users");
  await admin.getByTestId(`user-actions-${FRIEND.email}`).click();
  await admin.getByTestId("menu-limits").click();
  await admin.getByTestId("limit-credits").fill("0");
  await admin.getByTestId("save-user-limits").click();
  await expect(admin.getByText("Limits saved")).toBeVisible();

  // The API caches the gate for a few seconds.
  const limited = await poll(() => scrape(friendKey), (result) => result.status === 402, 30_000);
  expect(limited.status, JSON.stringify(limited.body)).toBe(402);

  await admin.getByTestId(`user-actions-${FRIEND.email}`).click();
  await admin.getByTestId("menu-limits").click();
  await admin.getByTestId("limit-credits").fill("");
  await admin.getByTestId("save-user-limits").click();
  await expect(admin.getByText("Limits saved").first()).toBeVisible();
  const allowed = await poll(() => scrape(friendKey), (result) => result.status === 200, 30_000);
  expect(allowed.status).toBe(200);
});

test("disabling the friend rejects their key and ends their session", async () => {
  await admin.goto("/users");
  await admin.getByTestId(`user-actions-${FRIEND.email}`).click();
  await admin.getByTestId("menu-disable").click();
  await admin.getByTestId("confirm-disable").click();
  await expect(admin.getByTestId(`user-status-${FRIEND.email}`)).toHaveText("Disabled");

  const rejected = await scrape(friendKey);
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(403);

  await friend.goto("/keys");
  await expect(friend).toHaveURL(/\/login$/);
  await signInExpectFailure(friend);
});

async function signInExpectFailure(page: Page) {
  await page.getByLabel("Email").fill(FRIEND.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("login-error")).toBeVisible();
}

test("re-enabling restores access", async () => {
  await admin.getByTestId(`user-actions-${FRIEND.email}`).click();
  await admin.getByTestId("menu-enable").click();
  await expect(admin.getByTestId(`user-status-${FRIEND.email}`)).toHaveText("Active");
  const result = await poll(() => scrape(friendKey), (r) => r.status === 200, 30_000);
  expect(result.status).toBe(200);
  await signIn(friend, FRIEND.email);
});
