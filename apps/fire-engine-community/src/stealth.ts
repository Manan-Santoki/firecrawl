/**
 * Stealth-mode helpers for the hardened (patchright) browser path.
 *
 * Portions ported from Crawl4AI (https://github.com/unclecode/crawl4ai, commit
 * cae74b203a33994f7e13b9052c3b0d5c93daa0e6), Copyright the Crawl4AI authors,
 * Apache License 2.0 (see third_party/crawl4ai/LICENSE):
 *
 *  - STEALTH_LAUNCH_ARGS: from `crawl4ai/browser_manager.py`
 *    (`BrowserManager.build_browser_flags`), including the rule that stealth
 *    keeps GPU/WebGL enabled (SwiftShader) because anti-bot sensors treat a
 *    missing WebGL context as headless, while basic mode disables the GPU.
 *  - NAVIGATOR_OVERRIDER: adapted from `crawl4ai/js_snippet/navigator_overrider.js`.
 *    Modified so each override only applies when the property actually leaks
 *    automation (patchright already fixes most of them, and blindly replacing
 *    `navigator.plugins` with a plain array is itself a fingerprint), and
 *    languages come from the request locale rather than a fixed en-US.
 *  - simulateUser: from the `simulate_user`/`magic` branch of
 *    `crawl4ai/async_crawler_strategy.py` (two mouse moves and a wheel scroll,
 *    deliberately no keyboard input or clicks).
 *  - clientHints: from `UAGen.generate_client_hints` in
 *    `crawl4ai/user_agent_generator.py`, extended with the
 *    sec-ch-ua-mobile/platform headers.
 *  - Stealth evaluations default to patchright's isolated world, mirroring
 *    Crawl4AI's `UndetectedAdapter.evaluate` in `crawl4ai/browser_adapter.py`.
 *
 * Unlike Crawl4AI's random user-agent generator, the user agent is derived
 * from the real Chromium build so the UA string, Sec-CH-UA brands,
 * navigator.userAgentData and navigator.platform stay mutually consistent.
 */
import type { Page } from "patchright";

export const BASE_LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  "--disable-features=MediaRouter,DialMediaRouteProvider,Translate",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--force-color-profile=srgb",
  "--mute-audio",
];

export const BASIC_LAUNCH_ARGS = [
  ...BASE_LAUNCH_ARGS,
  "--disable-gpu",
  "--disable-gpu-compositing",
];

export const STEALTH_LAUNCH_ARGS = [
  ...BASE_LAUNCH_ARGS,
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--disable-ipc-flooding-protection",
  // Keep a software WebGL context available in GPU-less containers.
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
];

export function navigatorOverrider(languages: string[]): string {
  const langs = JSON.stringify(languages.length > 0 ? languages : ["en-US", "en"]);
  return `(() => {
  try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery.call(window.navigator.permissions, parameters);
    }
  } catch (e) {}
  try {
    if (navigator.webdriver) {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
    }
  } catch (e) {}
  try {
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", { value: { runtime: {} }, configurable: true, writable: true });
    } else if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  } catch (e) {}
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      const langs = ${langs};
      Object.defineProperty(Navigator.prototype, "languages", { get: () => langs.slice(), configurable: true });
    }
  } catch (e) {}
  try {
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
  } catch (e) {}
})();`;
}

export async function simulateUser(page: Page): Promise<void> {
  const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));
  try {
    await page.mouse.move(rand(100, 300), rand(150, 300), { steps: rand(4, 10) });
    await page.mouse.move(rand(300, 600), rand(200, 400), { steps: rand(4, 10) });
    await page.mouse.wheel(0, rand(200, 400));
  } catch {
    // Best effort only: some pages (e.g. downloads) have no input target.
  }
}

/** Removes the "Headless" marker from a real Chromium user agent. */
export function normalizeUserAgent(ua: string): string {
  return ua.replace(/HeadlessChrome\//g, "Chrome/");
}

/**
 * Rewrites the Chrome major/full version inside a (device descriptor) user
 * agent to the running browser's version, so the UA string cannot disagree
 * with navigator.userAgentData.
 */
export function alignChromeVersion(ua: string, fullVersion: string): string {
  return ua.replace(/(Chrome|CriOS)\/[\d.]+/g, `$1/${fullVersion}`);
}

export function platformFromUserAgent(ua: string): { platform: string; mobile: boolean } {
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  if (/Android/i.test(ua)) return { platform: "Android", mobile };
  if (/iPhone|iPad|iOS/i.test(ua)) return { platform: "iOS", mobile };
  if (/Windows/i.test(ua)) return { platform: "Windows", mobile };
  if (/Macintosh|Mac OS X/i.test(ua)) return { platform: "macOS", mobile };
  if (/CrOS/i.test(ua)) return { platform: "Chrome OS", mobile };
  return { platform: "Linux", mobile };
}

/** Sec-CH-UA header set consistent with a Chrome/Chromium user agent. */
export function clientHints(ua: string): Record<string, string> {
  const chrome = /Chrome\/(\d+)/.exec(ua)?.[1];
  if (!chrome) return {};
  const edge = /Edg\/(\d+)/.exec(ua)?.[1];
  const brands = [`"Chromium";v="${chrome}"`, `"Not_A Brand";v="8"`];
  brands.push(edge ? `"Microsoft Edge";v="${edge}"` : `"Google Chrome";v="${chrome}"`);
  const { platform, mobile } = platformFromUserAgent(ua);
  return {
    "sec-ch-ua": brands.join(", "),
    "sec-ch-ua-mobile": mobile ? "?1" : "?0",
    "sec-ch-ua-platform": `"${platform}"`,
  };
}
