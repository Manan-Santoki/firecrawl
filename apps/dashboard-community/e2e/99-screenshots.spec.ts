import path from "node:path";
import { expect, test } from "@playwright/test";
import { ADMIN, PASSWORD } from "./helpers";

/** Light and dark captures of every page, written to docs/screenshots. */
const PAGES: { name: string; path: string }[] = (process.env.SCREENSHOT_PAGES ?? "overview:/,keys:/keys,logs:/logs,jobs:/jobs,usage:/usage,health:/health,users:/users,profile:/profile")
  .split(",")
  .map((entry) => {
    const [name, route] = entry.split(":");
    return { name, path: route };
  });

const OUT = path.resolve(__dirname, "..", "docs", "screenshots");

for (const theme of ["light", "dark"] as const) {
  test(`screenshots (${theme})`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: theme });
    await context.addCookies([{ name: "fc-dashboard-theme", value: theme, url: baseURL! }]);
    const page = await context.newPage();

    await page.goto("/login");
    await page.screenshot({ path: path.join(OUT, `login-${theme}.png`) });
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);

    for (const entry of PAGES) {
      await page.goto(entry.path);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `${entry.name}-${theme}.png`), fullPage: true });
    }
    await context.close();
  });
}
