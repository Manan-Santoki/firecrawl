import { readFile, stat } from "node:fs/promises";
import { devices, type BrowserContext, type BrowserContextOptions, type Download, type Page, type Response } from "patchright";
import { runActions, type ActionOutput } from "./actions.js";
import { isAdHost } from "./adblock.js";
import type { BrowserMode, BrowserPool } from "./browser-pool.js";
import { resolveProxy, type ServiceConfig } from "./config.js";
import { classifyBody, decodeBody, fileNameFor, flattenHeaders } from "./content.js";
import {
  ScrapeError,
  TIMEOUT_MESSAGE,
  chromeError,
  classifyNavigationError,
  fileTooLarge,
} from "./errors.js";
import { resolveLocation } from "./geo.js";
import { isBlockedUrl, isPrivateHost } from "./net-guard.js";
import type { ScrapeRequest, ScrapeSuccess } from "./schema.js";
import { alignChromeVersion, navigatorOverrider, normalizeUserAgent, simulateUser } from "./stealth.js";

const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };
const MOBILE_DEVICE = "Pixel 7";
const VISUAL_ACTIONS = new Set(["screenshot", "pdf"]);

function desktopPlatformToken(): { token: string; navigatorPlatform: string; chPlatform: string } {
  switch (process.platform) {
    case "win32":
      return { token: "Windows NT 10.0; Win64; x64", navigatorPlatform: "Win32", chPlatform: "Windows" };
    case "darwin":
      return { token: "Macintosh; Intel Mac OS X 10_15_7", navigatorPlatform: "MacIntel", chPlatform: "macOS" };
    default:
      return { token: "X11; Linux x86_64", navigatorPlatform: "Linux x86_64", chPlatform: "Linux" };
  }
}

export interface Identity {
  userAgent: string;
  navigatorPlatform: string;
  chPlatform: string;
  mobile: boolean;
  majorVersion: string;
  fullVersion: string;
}

/**
 * A consistent browser identity derived from the running Chromium build:
 * Chrome's reduced UA format (`Chrome/<major>.0.0.0`), with the real platform
 * of the host so navigator.platform, the UA string and client hints agree.
 */
export function buildIdentity(browserVersion: string, mobile: boolean): Identity {
  const fullVersion = browserVersion;
  const majorVersion = fullVersion.split(".")[0] ?? "0";
  const reduced = `${majorVersion}.0.0.0`;
  if (mobile) {
    const descriptor = devices[MOBILE_DEVICE]!;
    return {
      userAgent: normalizeUserAgent(alignChromeVersion(descriptor.userAgent, reduced)),
      navigatorPlatform: "Linux armv81",
      chPlatform: "Android",
      mobile: true,
      majorVersion,
      fullVersion,
    };
  }
  const platform = desktopPlatformToken();
  return {
    userAgent: `Mozilla/5.0 (${platform.token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reduced} Safari/537.36`,
    navigatorPlatform: platform.navigatorPlatform,
    chPlatform: platform.chPlatform,
    mobile: false,
    majorVersion,
    fullVersion,
  };
}

interface Budget {
  deadline: number;
  remaining: () => number;
}

export class ChromeCdpEngine {
  constructor(
    private readonly config: ServiceConfig,
    private readonly pool: BrowserPool,
  ) {}

  timeoutFor(request: ScrapeRequest): number {
    return Math.min(request.timeout ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs);
  }

  async scrape(request: ScrapeRequest, mode: BrowserMode, signal: AbortSignal, startedAt = Date.now()): Promise<ScrapeSuccess> {
    if (request.profile) {
      throw new ScrapeError("Persistent browser profiles are not supported by fire-engine-community");
    }
    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      throw chromeError("net::ERR_INVALID_URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw chromeError("net::ERR_DISALLOWED_URL_SCHEME");
    }
    if (await isBlockedUrl(request.url, this.config.blockPrivateNetworks)) {
      throw chromeError("net::ERR_ACCESS_DENIED (private network targets are blocked)");
    }

    const deadline = startedAt + this.timeoutFor(request);
    const budget: Budget = { deadline, remaining: () => deadline - Date.now() };
    const stealth = mode === "stealth";
    const location = resolveLocation(request.geolocation);
    const mobile = request.mobile === true;
    const identity = buildIdentity(await this.pool.browserVersion(mode), mobile);

    const userHeaders = { ...(request.headers ?? {}) };
    // Safe Mode (behaviorOverrides) asks for an honest, self-identifying browser.
    let userAgent =
      request.behaviorOverrides?.useHeadlessUserAgent === true
        ? identity.userAgent.replace(/Chrome\/[\d.]+/, `HeadlessChrome/${identity.fullVersion}`)
        : identity.userAgent;
    for (const name of Object.keys(userHeaders)) {
      const lower = name.toLowerCase();
      if (lower === "user-agent") {
        userAgent = userHeaders[name]!;
        delete userHeaders[name];
      } else if (lower === "host" || lower === "content-length" || lower === "connection") {
        delete userHeaders[name];
      }
    }
    const hasAcceptLanguage = Object.keys(userHeaders).some(name => name.toLowerCase() === "accept-language");
    const extraHTTPHeaders: Record<string, string> = {
      ...(hasAcceptLanguage ? {} : { "Accept-Language": location.acceptLanguage }),
      ...userHeaders,
    };

    const proxySettings = resolveProxy(
      stealth ? (this.config.stealthProxy ?? this.config.proxy) : this.config.proxy,
      location.country,
    );
    const usedStealthProxy = stealth && this.config.stealthProxy !== undefined;

    const device = mobile ? devices[MOBILE_DEVICE]! : undefined;
    const viewport = device ? device.viewport : DESKTOP_VIEWPORT;
    const options: BrowserContextOptions = {
      ...(device
        ? {
            viewport: device.viewport,
            deviceScaleFactor: device.deviceScaleFactor,
            isMobile: true,
            hasTouch: true,
          }
        : { viewport: DESKTOP_VIEWPORT, screen: DESKTOP_VIEWPORT }),
      userAgent,
      locale: location.locale,
      ...(location.timezone ? { timezoneId: location.timezone } : {}),
      extraHTTPHeaders,
      ignoreHTTPSErrors: request.skipTlsVerification === true,
      acceptDownloads: true,
      serviceWorkers: "block",
      bypassCSP: false,
      ...(proxySettings ? { proxy: proxySettings } : {}),
    };

    const wantsRawBase64 = request.format === "rawBase64";
    const actions = wantsRawBase64 ? [] : (request.actions ?? []);
    const visual = actions.some(action => VISUAL_ACTIONS.has(action.type));
    const blockMedia = request.blockMedia !== false;

    return this.pool.withContext(mode, options, async context => {
      let timedOut = false;
      const kill = () => {
        context.close().catch(() => undefined);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, Math.max(1, budget.remaining()));
      const onAbort = () => kill();
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        await this.installRouting(context, { blockMedia, visual });
        const page = await context.newPage();
        if (stealth) await page.addInitScript(navigatorOverrider(location.languages));
        if (stealth || mobile) {
          await this.alignClientHints(context, page, userAgent, identity, location.acceptLanguage);
        }
        return await this.run(page, context, request, {
          budget,
          stealth,
          wantsRawBase64,
          actions,
          defaultViewport: viewport,
          startedAt,
          usedStealthProxy,
          timezone: location.timezone,
        });
      } catch (error) {
        if (signal.aborted) throw new ScrapeError("Scrape cancelled by client");
        if (timedOut) throw new ScrapeError(TIMEOUT_MESSAGE);
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    });
  }

  /**
   * Keeps navigator.userAgentData and Sec-CH-UA consistent with the UA string
   * (Chromium otherwise derives them from the real, headless build).
   */
  private async alignClientHints(
    context: BrowserContext,
    page: Page,
    userAgent: string,
    identity: Identity,
    acceptLanguage: string,
  ) {
    const major = /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? identity.majorVersion;
    try {
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setUserAgentOverride", {
        userAgent,
        acceptLanguage,
        platform: identity.navigatorPlatform,
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: major },
            { brand: "Not_A Brand", version: "8" },
            { brand: "Google Chrome", version: major },
          ],
          fullVersionList: [
            { brand: "Chromium", version: identity.fullVersion },
            { brand: "Not_A Brand", version: "8.0.0.0" },
            { brand: "Google Chrome", version: identity.fullVersion },
          ],
          fullVersion: identity.fullVersion,
          platform: identity.chPlatform,
          platformVersion: identity.mobile ? "14.0.0" : identity.chPlatform === "Windows" ? "10.0.0" : "6.5.0",
          architecture: identity.mobile ? "" : "x86",
          model: identity.mobile ? MOBILE_DEVICE : "",
          mobile: identity.mobile,
          bitness: identity.mobile ? "" : "64",
          wow64: false,
        },
      });
    } catch {
      // Not fatal: the context-level user agent still applies.
    }
  }

  private async installRouting(context: BrowserContext, opts: { blockMedia: boolean; visual: boolean }) {
    const blockPrivate = this.config.blockPrivateNetworks;
    const blockAds = this.config.blockAds;
    if (!blockPrivate && !blockAds && !opts.blockMedia) return;
    await context.route("**/*", async route => {
      const req = route.request();
      const url = req.url();
      if (!url.startsWith("http:") && !url.startsWith("https:")) return route.continue();
      let hostname = "";
      try {
        hostname = new URL(url).hostname;
      } catch {
        return route.abort("addressunreachable");
      }
      if (blockPrivate && (await isPrivateHost(hostname))) return route.abort("accessdenied");
      const isNavigation = req.isNavigationRequest();
      if (!isNavigation) {
        if (blockAds && isAdHost(hostname)) return route.abort("blockedbyclient");
        if (opts.blockMedia) {
          const type = req.resourceType();
          if (type === "media") return route.abort("blockedbyclient");
          if (!opts.visual && (type === "image" || type === "font")) return route.abort("blockedbyclient");
        }
      }
      return route.continue();
    });
  }

  /**
   * Intercepts the top-level document at the response stage (Chrome's own
   * network stack, so TLS and proxy behaviour are unchanged) and keeps the
   * original bytes when the document is a file or when rawBase64 is wanted.
   */
  private async captureMainDocument(context: BrowserContext, page: Page, wantsRawBase64: boolean) {
    type Captured = { body: Buffer; status: number; headers: Record<string, string>; url: string; tooLarge: boolean };
    let captured: Captured | undefined;
    const maxBytes = this.config.maxFileBytes;
    try {
      const session = await context.newCDPSession(page);
      const tree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      const mainFrameId = tree.frameTree.frame.id;
      session.on("Fetch.requestPaused", async (event: any) => {
        try {
          const status: number | undefined = event.responseStatusCode;
          if (
            event.frameId === mainFrameId &&
            event.resourceType === "Document" &&
            status !== undefined &&
            !(status >= 300 && status < 400) &&
            !captured
          ) {
            const headers = flattenHeaders((event.responseHeaders ?? []) as Array<{ name: string; value: string }>);
            const kind = classifyBody(headers["content-type"]);
            if (wantsRawBase64 || kind === "binary") {
              const declared = Number(headers["content-length"] ?? "0");
              if (declared > maxBytes) {
                captured = { body: Buffer.alloc(0), status, headers, url: event.request.url, tooLarge: true };
              } else {
                const response = (await session.send("Fetch.getResponseBody", { requestId: event.requestId })) as {
                  body: string;
                  base64Encoded: boolean;
                };
                const body = Buffer.from(response.body, response.base64Encoded ? "base64" : "utf8");
                captured = { body, status, headers, url: event.request.url, tooLarge: body.length > maxBytes };
              }
            }
          }
        } catch {
          // Leave the response to the normal (rendered/download) handling.
        } finally {
          await session.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined);
        }
      });
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }],
      });
    } catch {
      // Interception unavailable: fall back to response.body()/download handling.
    }
    return { result: () => captured };
  }

  private async run(
    page: Page,
    context: BrowserContext,
    request: ScrapeRequest,
    state: {
      budget: Budget;
      stealth: boolean;
      wantsRawBase64: boolean;
      actions: NonNullable<ScrapeRequest["actions"]>;
      defaultViewport: { width: number; height: number };
      startedAt: number;
      usedStealthProxy: boolean;
      timezone: string | undefined;
    },
  ): Promise<ScrapeSuccess> {
    const { budget } = state;
    let mainResponse: Response | null = null;
    page.on("response", response => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          mainResponse = response;
        }
      } catch {
        // detached frame
      }
    });
    let download: Download | undefined;
    const downloadSeen = new Promise<Download>(resolve => {
      page.on("download", d => {
        download = d;
        resolve(d);
      });
    });
    const capture = await this.captureMainDocument(context, page, state.wantsRawBase64);

    let navError: unknown;
    try {
      const response = await page.goto(request.url, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1, budget.remaining()),
      });
      if (response) mainResponse = response;
    } catch (error) {
      navError = error;
    }

    // A captured binary (or rawBase64) main document wins: Chromium's PDF
    // viewer and download handling would otherwise hide the original bytes.
    const captured = capture.result();
    if (captured) {
      if (captured.tooLarge) throw fileTooLarge(this.config.maxFileBytes);
      const kind = classifyBody(captured.headers["content-type"]);
      return this.success(state, {
        content: kind === "binary" ? "" : decodeBody(captured.body, captured.headers["content-type"]),
        url: captured.url,
        status: captured.status,
        headers: captured.headers,
        file: {
          name: fileNameFor(captured.url),
          content: captured.body.toString("base64"),
          size_bytes: captured.body.length,
        },
      });
    }

    if (navError) {
      const message = navError instanceof Error ? navError.message : String(navError);
      if (/Download is starting|net::ERR_ABORTED/.test(message)) {
        const pending = download ?? (await Promise.race([downloadSeen, delay(1_500).then(() => undefined)]));
        if (pending) return this.fromDownload(pending, mainResponse, request, state);
      }
      throw classifyNavigationError(navError, request.url);
    }

    const response = mainResponse as Response | null;
    const headers = response ? flattenHeaders(await response.headersArray().catch(() => [])) : {};
    const status = response?.status() ?? 200;
    const contentType = headers["content-type"];
    const kind = classifyBody(contentType);

    if (state.wantsRawBase64 || kind === "binary" || kind === "xml") {
      const body = response ? await response.body().catch(() => undefined) : undefined;
      if (body === undefined) {
        const pending = download ?? (await Promise.race([downloadSeen, delay(1_500).then(() => undefined)]));
        if (pending) return this.fromDownload(pending, response, request, state);
        if (state.wantsRawBase64) throw new ScrapeError("Original response body is unavailable for rawBase64");
      } else {
        if (body.length > this.config.maxFileBytes) throw fileTooLarge(this.config.maxFileBytes);
        if (state.wantsRawBase64 || kind === "binary") {
          return this.success(state, {
            content: kind === "binary" ? "" : decodeBody(body, contentType),
            url: page.url(),
            status,
            headers,
            file: { name: fileNameFor(page.url()), content: body.toString("base64"), size_bytes: body.length },
          });
        }
        return this.success(state, { content: decodeBody(body, contentType), url: page.url(), status, headers });
      }
    }

    // Rendered HTML (or a text body Chromium wrapped in a <pre> document).
    if (this.config.navigationLoadCapMs > 0) {
      await page
        .waitForLoadState("load", { timeout: Math.max(1, Math.min(this.config.navigationLoadCapMs, budget.remaining() - 250)) })
        .catch(() => undefined);
    }
    if (this.config.networkIdleCapMs > 0 && budget.remaining() > 500) {
      await page
        .waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(this.config.networkIdleCapMs, budget.remaining() - 250)) })
        .catch(() => undefined);
    }
    if (state.stealth) await simulateUser(page);

    let output: ActionOutput | undefined;
    if (state.actions.length > 0) {
      output = await runActions(
        {
          page,
          context,
          remaining: budget.remaining,
          stealth: state.stealth,
          defaultViewport: state.defaultViewport,
        },
        state.actions,
      );
    }

    const content = await page.content();
    return this.success(state, {
      content,
      url: page.url(),
      status,
      headers,
      output,
    });
  }

  private async fromDownload(
    download: Download,
    response: Response | null,
    request: ScrapeRequest,
    state: { usedStealthProxy: boolean; startedAt: number; timezone: string | undefined; budget: Budget },
  ): Promise<ScrapeSuccess> {
    const failure = await Promise.race([
      download.failure(),
      delay(Math.max(1, state.budget.remaining())).then(() => "timeout"),
    ]);
    if (failure === "timeout") throw new ScrapeError(TIMEOUT_MESSAGE);
    if (failure) throw new ScrapeError(`File download failed: ${failure}`);
    const path = await download.path();
    const { size } = await stat(path);
    if (size > this.config.maxFileBytes) throw fileTooLarge(this.config.maxFileBytes);
    const body = await readFile(path);
    const headers = response ? flattenHeaders(await response.headersArray().catch(() => [])) : {};
    if (!headers["content-type"]) {
      const name = download.suggestedFilename().toLowerCase();
      if (name.endsWith(".pdf")) headers["content-type"] = "application/pdf";
    }
    return this.success(state, {
      content: "",
      url: download.url() || request.url,
      status: response?.status() ?? 200,
      headers,
      file: { name: download.suggestedFilename() || fileNameFor(request.url), content: body.toString("base64"), size_bytes: size },
    });
  }

  private success(
    state: { usedStealthProxy: boolean; startedAt: number; timezone: string | undefined },
    data: {
      content: string;
      url: string;
      status: number;
      headers: Record<string, string>;
      output?: ActionOutput;
      file?: ScrapeSuccess["file"];
    },
  ): ScrapeSuccess {
    return {
      timeTaken: Date.now() - state.startedAt,
      content: data.content,
      url: data.url,
      pageStatusCode: data.status,
      responseHeaders: data.headers,
      ...(data.output
        ? {
            screenshots: data.output.screenshots,
            actionContent: data.output.actionContent,
            actionResults: data.output.actionResults,
          }
        : {}),
      ...(data.file ? { file: data.file } : {}),
      usedMobileProxy: state.usedStealthProxy,
      ...(state.timezone ? { timezone: state.timezone } : {}),
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
