import { type Browser, expect, type Page } from "@playwright/test";

export const API_URL = process.env.FIRECRAWL_E2E_API_URL ?? "http://localhost:3392";
export const BOOTSTRAP_TOKEN = process.env.DASHBOARD_E2E_BOOTSTRAP_TOKEN ?? "e2e-bootstrap-token";
// A public page the scraper can fetch (Firecrawl rejects single-label hosts).
export const SCRAPE_URL = process.env.E2E_SCRAPE_URL ?? "https://example.com";
export const PASSWORD = "e2e-password-long-enough";

export const ADMIN = { name: "Owner Admin", email: "owner@e2e.test" };
export const FRIEND = { name: "Friend One", email: "friend@e2e.test" };
export const OTHER = { name: "Other Member", email: "other@e2e.test" };

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

export async function newSignedInPage(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

/** Creates an invite as the signed-in admin and returns the link. */
export async function createInvite(page: Page, email?: string): Promise<string> {
  await page.goto("/users");
  await page.getByTestId("invite-user").click();
  if (email) await page.getByLabel("Email (optional)").fill(email);
  await page.getByTestId("create-invite").click();
  const url = await page.getByTestId("invite-url").inputValue();
  await page.getByRole("button", { name: "Done" }).click();
  return url;
}

export async function acceptInvite(browser: Browser, url: string, person: { name: string; email: string }): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(new URL(url).pathname);
  await page.getByLabel("Name").fill(person.name);
  const email = page.getByLabel("Email");
  if (!(await email.inputValue())) await email.fill(person.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

export async function createKey(page: Page, name: string): Promise<string> {
  await page.goto("/keys");
  await page.getByTestId("create-key").click();
  await page.getByTestId("new-key-name").fill(name);
  await page.getByTestId("submit-new-key").click();
  const key = await page.getByTestId("new-key-value").inputValue();
  await page.getByTestId("close-new-key").click();
  return key;
}

export async function scrape(apiKey: string, url = SCRAPE_URL) {
  const response = await fetch(`${API_URL}/v2/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"] }),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

export async function poll<T>(fn: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  let value = await fn();
  while (!accept(value) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    value = await fn();
  }
  return value;
}
