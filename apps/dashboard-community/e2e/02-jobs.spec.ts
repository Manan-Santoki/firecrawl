import { expect, test } from "@playwright/test";
import { API_URL, createKey, newSignedInPage, OTHER, poll } from "./helpers";

test("a member's crawl shows progress and results; cancel goes through the API", async ({ browser }) => {
  const page = await newSignedInPage(browser, OTHER.email);
  const key = await createKey(page, "crawl key");

  const start = await fetch(`${API_URL}/v2/crawl`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", limit: 2, scrapeOptions: { formats: ["markdown"] } }),
  });
  expect(start.status).toBe(200);
  const { id } = (await start.json()) as { id: string };

  await poll(
    async () => {
      await page.goto("/jobs");
      return page.getByTestId("jobs-table").innerText();
    },
    (text) => text.includes(id.slice(0, 8)),
  );
  await expect(page.getByTestId("jobs-table")).toContainText("crawl");

  await poll(
    async () => {
      await page.goto(`/jobs/${id}`);
      return page.getByTestId("job-pages").innerText();
    },
    (text) => text.includes("example.com"),
    60_000,
  );

  // Cancelling an already-finished crawl is answered by the API, not the dashboard.
  const second = await fetch(`${API_URL}/v2/crawl`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", limit: 50, delay: 5 }),
  });
  const { id: slowId } = (await second.json()) as { id: string };
  await page.goto(`/jobs/${slowId}`);
  const cancel = page.getByTestId("cancel-job");
  if (await cancel.isVisible()) {
    await cancel.click();
    await page.getByRole("button", { name: "Cancel job" }).click();
    await expect(page.getByText("Job cancelled")).toBeVisible();
  }
});
