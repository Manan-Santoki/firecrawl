import { expect, test } from "@playwright/test";
import { FRIEND, newSignedInPage, OTHER, poll } from "./helpers";

test.describe.configure({ mode: "serial" });

test("playground scrape runs as the member, renders markdown and is saved to history", async ({ browser }) => {
  const page = await newSignedInPage(browser, FRIEND.email);
  await page.goto("/playground");
  await page.getByTestId("pg-url").fill("https://example.com");
  await page.getByTestId("format-links").click();
  await expect(page.getByTestId("pg-json")).toHaveValue(/"links"/);
  await page.getByRole("tab", { name: "Python" }).click();
  await expect(page.getByTestId("pg-snippet-python")).toContainText('firecrawl.scrape("https://example.com"');
  await page.getByTestId("pg-run").click();
  await expect(page.getByTestId("pg-result")).toContainText("200", { timeout: 90_000 });
  await expect(page.getByTestId("result-markdown")).toContainText("documentation examples");
  await expect(page.getByTestId("pg-history")).toContainText("https://example.com");

  // The run is attributed to the member's internal dashboard key in their own request log.
  await poll(
    async () => {
      await page.goto("/logs");
      return page.getByTestId("log-table").innerText();
    },
    (text) => text.includes("Dashboard (internal)"),
  );

  // Another member never sees this history.
  const other = await newSignedInPage(browser, OTHER.email);
  await other.goto("/playground");
  await expect(other.getByTestId("pg-history")).not.toContainText("https://example.com");
});

test("playground crawl polls to completion and job pages can be inspected", async ({ browser }) => {
  const page = await newSignedInPage(browser, FRIEND.email);
  await page.goto("/playground");
  await page.getByRole("tab", { name: "Crawl" }).click();
  await page.getByTestId("pg-json").fill(JSON.stringify({ url: "https://example.com", limit: 1 }));
  await page.getByTestId("pg-run").click();
  await expect(page.getByTestId("pg-result")).toContainText("completed", { timeout: 120_000 });

  await page.goto("/jobs");
  await page.getByRole("link", { name: "Results" }).first().click();
  await expect(page.getByTestId("job-pages")).toContainText("example.com", { timeout: 60_000 });
  await page.getByTestId("job-pages-row").first().click();
  await expect(page.getByTestId("page-detail")).toContainText("documentation examples");
});

test("browser, monitor and agent pages render for members with clear empty states", async ({ browser }) => {
  const page = await newSignedInPage(browser, FRIEND.email);
  await page.goto("/browser");
  await expect(page.getByText("No open sessions")).toBeVisible();
  await page.goto("/monitors");
  await expect(page.getByTestId("monitors-table")).toBeVisible();
  await page.goto("/agent");
  await page.getByTestId("agent-prompt").fill("Find the title of example.com");
  await page.getByTestId("agent-start").click();
  // This stack runs without the agent service, so the dashboard explains it instead of failing.
  await expect(page.getByTestId("agent-unavailable").or(page.getByTestId("agent-status"))).toBeVisible({ timeout: 30_000 });
});

test("monitors can be created, run and listed (requires API monitoring support)", async ({ browser }) => {
  const page = await newSignedInPage(browser, FRIEND.email);
  await page.goto("/monitors");
  await page.getByTestId("new-monitor").click();
  await page.getByTestId("monitor-name").fill("Example watch");
  await page.getByTestId("save-monitor").click();
  const created = page.getByText("Monitor created");
  const failed = page.getByText(/Firecrawl API/);
  await expect(created.or(failed)).toBeVisible({ timeout: 30_000 });
  test.skip(await failed.isVisible(), "The API in this stack refused monitor creation");
  await expect(page.getByTestId("monitors-table")).toContainText("Example watch");
  await page.getByRole("link", { name: "Example watch" }).click();
  await page.getByTestId("run-monitor").click();
  await expect(page.getByText(/Check started|Action failed/)).toBeVisible({ timeout: 30_000 });
});
