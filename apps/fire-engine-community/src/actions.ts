/*
 * Action interpreter for the fire-engine `actions` contract. In stealth mode,
 * internal evaluations run in patchright's isolated world, as Crawl4AI's
 * `UndetectedAdapter.evaluate` does (`crawl4ai/browser_adapter.py`, commit
 * cae74b203a33994f7e13b9052c3b0d5c93daa0e6, Apache-2.0; see
 * THIRD_PARTY_NOTICES.md). User scripts always run in the main world.
 */
import type { BrowserContext, Page } from "patchright";
import { ScrapeError, elementError, javascriptError, sanitize } from "./errors.js";
import type { ActionResult, ScrapeAction } from "./schema.js";

export interface ActionRuntime {
  page: Page;
  context: BrowserContext;
  /** Milliseconds left in the scrape's overall budget. */
  remaining: () => number;
  stealth: boolean;
  defaultViewport: { width: number; height: number } | null;
}

export interface ActionOutput {
  screenshots: string[];
  actionContent: Array<{ url: string; html: string }>;
  actionResults: ActionResult[];
}

const SELECTOR_WAIT_CAP_MS = 30_000;
const CLICK_TIMEOUT_CAP_MS = 10_000;

function capped(runtime: ActionRuntime, cap: number): number {
  return Math.max(1, Math.min(cap, runtime.remaining() - 500));
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(error.message));
}

async function settle(page: Page) {
  // A click or key press may start a navigation; give it a moment to commit.
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
}

/**
 * Runs a user (or API-internal) script in the page's main world and encodes
 * the result as the API expects: JSON `{ type, value }` in `result.return`
 * (see deriveBrandingFromActions / javascriptReturns in the API).
 */
export async function runScript(page: Page, script: string): Promise<string> {
  let value: unknown;
  try {
    value = await page.evaluate(script, undefined, undefined, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Illegal return statement|await is only valid/i.test(message)) {
      try {
        value = await page.evaluate(`(async () => {\n${script}\n})()`, undefined, undefined, false);
      } catch (inner) {
        throw javascriptError(sanitize(inner instanceof Error ? inner.message : String(inner)));
      }
    } else {
      throw javascriptError(sanitize(message));
    }
  }
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  try {
    return JSON.stringify({ type: type === "array" ? "object" : type, value: value === undefined ? null : value });
  } catch {
    return JSON.stringify({ type: "string", value: String(value) });
  }
}

async function screenshot(
  runtime: ActionRuntime,
  action: Extract<ScrapeAction, { type: "screenshot" }>,
): Promise<string> {
  const { page } = runtime;
  const previous = page.viewportSize() ?? runtime.defaultViewport;
  if (action.viewport) await page.setViewportSize(action.viewport);
  try {
    const jpeg = action.quality !== undefined;
    const buffer = await page.screenshot({
      fullPage: action.fullPage ?? false,
      type: jpeg ? "jpeg" : "png",
      ...(jpeg ? { quality: Math.round(action.quality!) } : {}),
      timeout: capped(runtime, 30_000),
      animations: "disabled",
    });
    return `data:image/${jpeg ? "jpeg" : "png"};base64,${buffer.toString("base64")}`;
  } finally {
    if (action.viewport && previous) await page.setViewportSize(previous).catch(() => undefined);
  }
}

export async function runActions(runtime: ActionRuntime, actions: ScrapeAction[]): Promise<ActionOutput> {
  const output: ActionOutput = { screenshots: [], actionContent: [], actionResults: [] };
  const { page, context } = runtime;

  for (let idx = 0; idx < actions.length; idx++) {
    const action = actions[idx]!;
    if (runtime.remaining() <= 0) throw new ScrapeError("Scrape failed to finish without timing out");
    switch (action.type) {
      case "wait": {
        if (action.selector) {
          try {
            await page.waitForSelector(action.selector, { state: "visible", timeout: capped(runtime, SELECTOR_WAIT_CAP_MS) });
          } catch (error) {
            if (isTimeout(error)) throw elementError(`"${action.selector}" was not found within the wait timeout`);
            throw elementError(`"${action.selector}" could not be awaited: ${sanitize(String((error as Error).message))}`);
          }
        } else {
          await page.waitForTimeout(Math.max(0, Math.min(action.milliseconds ?? 1000, runtime.remaining())));
        }
        break;
      }
      case "click": {
        const locator = page.locator(action.selector);
        try {
          if (action.all) {
            const count = await locator.count();
            if (count === 0) throw elementError(`"${action.selector}" was not found`);
            for (let i = 0; i < count; i++) {
              await locator.nth(i).click({ timeout: capped(runtime, CLICK_TIMEOUT_CAP_MS) });
            }
          } else {
            await locator.first().click({ timeout: capped(runtime, CLICK_TIMEOUT_CAP_MS) });
          }
        } catch (error) {
          if (error instanceof ScrapeError) throw error;
          if (isTimeout(error)) throw elementError(`"${action.selector}" was not found or was not clickable`);
          throw elementError(`"${action.selector}" could not be clicked: ${sanitize((error as Error).message)}`);
        }
        await settle(page);
        break;
      }
      case "write": {
        await page.keyboard.type(action.text, { delay: runtime.stealth ? 25 + Math.floor(Math.random() * 40) : 0 });
        break;
      }
      case "press": {
        try {
          await page.keyboard.press(action.key);
        } catch (error) {
          throw new ScrapeError(`Invalid key for press action: ${sanitize((error as Error).message)}`);
        }
        await settle(page);
        break;
      }
      case "scroll": {
        const direction = action.direction === "up" ? -1 : 1;
        const found = await page.evaluate(
          ({ selector, direction }) => {
            const target = selector ? document.querySelector(selector) : null;
            if (selector && !target) return false;
            if (target) {
              target.scrollIntoView({ block: "center" });
              target.scrollBy(0, direction * (target as HTMLElement).clientHeight);
            } else {
              window.scrollBy(0, direction * window.innerHeight);
            }
            return true;
          },
          { selector: action.selector ?? null, direction },
          undefined,
          runtime.stealth,
        );
        if (!found) throw elementError(`"${action.selector}" was not found for scrolling`);
        await page.waitForTimeout(150);
        break;
      }
      case "scrape": {
        const snapshot = { url: page.url(), html: await page.content() };
        output.actionContent.push(snapshot);
        output.actionResults.push({ idx, type: "scrape", result: snapshot });
        break;
      }
      case "executeJavascript": {
        const value = await runScript(page, action.script);
        output.actionResults.push({ idx, type: "executeJavascript", result: { return: value } });
        break;
      }
      case "screenshot": {
        const path = await screenshot(runtime, action);
        output.screenshots.push(path);
        output.actionResults.push({ idx, type: "screenshot", result: { path } });
        break;
      }
      case "pdf": {
        const buffer = await page.pdf({
          format: action.format ?? "Letter",
          landscape: action.landscape ?? false,
          scale: action.scale ?? 1,
          printBackground: true,
        });
        output.actionResults.push({
          idx,
          type: "pdf",
          result: { link: `data:application/pdf;base64,${buffer.toString("base64")}` },
        });
        break;
      }
      case "getCookies": {
        const cookies = await context.cookies();
        output.actionResults.push({
          idx,
          type: "getCookies",
          result: { cookies: cookies as unknown as Array<Record<string, unknown>> },
        });
        break;
      }
    }
  }
  return output;
}
