/**
 * Contract tests against a running fire-engine-community (normally the Docker
 * image). Requests are shaped exactly as the Firecrawl API v2.11.739 client
 * builds them, and responses are validated with the API's own schemas.
 *
 * The fixture site (test/fixtures/site.mjs) must run where the service can
 * reach it; run-docker.sh starts it inside the service container so that it
 * is http://localhost (a secure context, required for client hints).
 *
 * Environment:
 *   FIRE_ENGINE_URL     service base URL (default http://127.0.0.1:3010)
 *   FIXTURE_BASE_URL    fixture URL as seen by the service (default http://localhost:4580)
 *   EXPECT_SEARXNG=1    the service's SEARXNG_ENDPOINT points at the fixture
 *   BRANDING_SCRIPT     optional path to the bundled upstream branding script
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, test } from "node:test";
import {
  checkFailedSchema,
  checkProcessingSchema,
  checkSuccessSchema,
  chromeCdpRequest,
  classifyFailure,
  parseJavascriptReturn,
  scrapeFailedSchema,
  scrapeSuccessSchema,
  tlsClientRequest,
} from "./api-contract.js";

const SERVICE = (process.env.FIRE_ENGINE_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const SITE = (process.env.FIXTURE_BASE_URL ?? "http://localhost:4580").replace(/\/$/, "");
const FIXTURE_HOST = new URL(SITE).hostname;

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${SERVICE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function scrapeOk(body: Record<string, unknown>) {
  const { status, json } = await post("/scrape", body);
  const parsed = scrapeSuccessSchema.safeParse(json);
  assert.ok(parsed.success, `expected success schema, got HTTP ${status}: ${JSON.stringify(json).slice(0, 500)}`);
  return parsed.data;
}

async function scrapeFail(body: Record<string, unknown>) {
  const { json } = await post("/scrape", body);
  assert.equal(scrapeSuccessSchema.safeParse(json).success, false, `expected failure, got success`);
  const parsed = scrapeFailedSchema.safeParse(json);
  assert.ok(parsed.success, `expected failed schema: ${JSON.stringify(json).slice(0, 300)}`);
  return parsed.data;
}

function jsReturns(result: { actionResults?: Array<{ type: string; result: any }> }) {
  return (result.actionResults ?? [])
    .filter(r => r.type === "executeJavascript")
    .map(r => parseJavascriptReturn(r.result.return));
}

before(async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${SERVICE}/health/liveness`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`fire-engine-community not reachable at ${SERVICE}`);
});

describe("chrome-cdp", () => {
  test("plain HTML scrape returns rendered content, status and headers", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/` }));
    assert.equal(result.pageStatusCode, 200);
    assert.match(result.content, /Fixture Heading/);
    assert.match(result.content, /late-ready/, "smart wait should let delayed DOM updates land");
    assert.equal(result.responseHeaders?.["x-fixture"], "index");
    assert.match(result.responseHeaders?.["content-type"] ?? "", /text\/html/);
    assert.equal(result.url, `${SITE}/`);
    assert.equal(result.jobId, undefined, "synchronous responses must not ask the API to DELETE");
    assert.equal(result.actionResults, undefined);
  });

  test("redirects report the final URL", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/redirect` }));
    assert.equal(result.url, `${SITE}/`);
  });

  test("non-2xx pages are returned as successful scrapes with their status", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/missing` }));
    assert.equal(result.pageStatusCode, 404);
    assert.match(result.content, /Not here/);
  });

  test("screenshot format becomes a screenshot action and returns a data URL", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/`, formats: [{ type: "screenshot" }] }));
    assert.equal(result.screenshots?.length, 1);
    const shot = result.screenshots![0]!;
    assert.match(shot, /^data:image\/png;base64,/);
    const png = Buffer.from(shot.split(",")[1]!, "base64");
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
    assert.equal(png.readUInt32BE(16), 1920, "default desktop viewport width");
    assert.equal(png.readUInt32BE(20), 1080, "viewport (not full page) height");
    const action = result.actionResults?.find(r => r.type === "screenshot");
    assert.ok(action && action.type === "screenshot");
    assert.equal(action.result.path, shot, "API matches branding screenshots by path");
  });

  test("full-page screenshot with custom viewport", async () => {
    const result = await scrapeOk(
      chromeCdpRequest({
        url: `${SITE}/`,
        formats: [{ type: "screenshot", fullPage: true, viewport: { width: 800, height: 600 } }],
      }),
    );
    const png = Buffer.from(result.screenshots![0]!.split(",")[1]!, "base64");
    assert.equal(png.readUInt32BE(16), 800);
    assert.ok(png.readUInt32BE(20) > 3000, "full page should include the 3000px spacer");
  });

  test("action sequence: wait, click, wait selector, write, press, scroll, scrape, executeJavascript, screenshot", async () => {
    const result = await scrapeOk(
      chromeCdpRequest({
        url: `${SITE}/`,
        waitFor: 200,
        actions: [
          { type: "wait", milliseconds: 100 },
          { type: "click", selector: "#reveal", all: false },
          { type: "wait", selector: "#revealed" },
          { type: "click", selector: "#q", all: false },
          { type: "write", text: "firecrawl" },
          { type: "press", key: "Enter" },
          { type: "scroll", direction: "down" },
          { type: "scrape" },
          { type: "executeJavascript", script: "document.getElementById('echo').textContent" },
          { type: "executeJavascript", script: "return { scrolled: window.scrollY > 0, global: window.fixtureGlobal }" },
          { type: "screenshot", fullPage: false, quality: 60 },
          { type: "pdf", format: "A4", landscape: false, scale: 1 },
        ],
      }),
    );
    // waitFor is prepended as action 0, so user actions start at idx 1.
    const scrape = result.actionResults?.find(r => r.type === "scrape");
    assert.ok(scrape && scrape.type === "scrape" && "html" in scrape.result);
    assert.equal(scrape.idx, 8);
    assert.match(scrape.result.html, /Revealed after click/);
    assert.equal(result.actionContent?.length, 1);

    const returns = jsReturns(result);
    assert.deepEqual(returns[0], { type: "string", value: "typed:firecrawl" });
    assert.deepEqual(returns[1], { type: "object", value: { scrolled: true, global: 42 } });

    assert.equal(result.screenshots?.length, 1);
    assert.match(result.screenshots![0]!, /^data:image\/jpeg;base64,/);
    const pdf = result.actionResults?.find(r => r.type === "pdf");
    assert.ok(pdf && pdf.type === "pdf");
    assert.match(Buffer.from(pdf.result.link.split(",")[1]!, "base64").subarray(0, 5).toString("latin1"), /%PDF-/);
    assert.match(result.content, /typed:firecrawl/, "final content reflects actions");
  });

  test("mobile emulation", async () => {
    const result = await scrapeOk(
      chromeCdpRequest({
        url: `${SITE}/fingerprint`,
        mobile: true,
        actions: [
          {
            type: "executeJavascript",
            script:
              "({ width: screen.width, touch: navigator.maxTouchPoints, ua: navigator.userAgent, mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null, platform: navigator.userAgentData ? navigator.userAgentData.platform : null })",
          },
        ],
      }),
    );
    const [fp] = jsReturns(result);
    const value = fp!.value as Record<string, unknown>;
    assert.ok((value.width as number) < 500, `mobile viewport expected, got ${value.width}`);
    assert.ok((value.touch as number) > 0);
    assert.match(String(value.ua), /Android .*Mobile/);
    assert.equal(value.mobile, true);
    assert.equal(value.platform, "Android");
  });

  test("location emulation sets locale, Accept-Language and timezone", async () => {
    const result = await scrapeOk(
      chromeCdpRequest({
        url: `${SITE}/echo-page`,
        location: { country: "de", languages: ["de-DE"] },
        actions: [{ type: "executeJavascript", script: "({ lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })" }],
      }),
    );
    const [fp] = jsReturns(result);
    assert.deepEqual(fp!.value, { lang: "de-DE", tz: "Europe/Berlin" });
    assert.equal(result.timezone, "Europe/Berlin");
    assert.match(result.content, /"accept-language":"de-DE/);
  });

  test("custom headers are forwarded", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/echo-page`, headers: { "X-Contract": "yes" } }));
    assert.match(result.content, /"x-contract":"yes"/);
  });

  test("PDF navigation is handed back as a base64 file for the API's PDF engine", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/file.pdf` }));
    assert.equal(result.responseHeaders?.["content-type"], "application/pdf");
    assert.ok(result.file?.content);
    assert.equal(Buffer.from(result.file.content, "base64").subarray(0, 5).toString("latin1"), "%PDF-");
  });

  test("attachment downloads are captured", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/download.bin` }));
    assert.ok(result.file?.content);
    assert.equal(Buffer.from(result.file.content, "base64").subarray(0, 5).toString("latin1"), "%PDF-");
  });

  test("XML is returned raw and JSON through the browser document", async () => {
    const xml = await scrapeOk(chromeCdpRequest({ url: `${SITE}/sitemap.xml` }));
    assert.match(xml.content, /^<\?xml/);
    const json = await scrapeOk(chromeCdpRequest({ url: `${SITE}/data.json` }));
    assert.match(json.responseHeaders?.["content-type"] ?? "", /application\/json/);
    assert.match(json.content, /hello/);
  });

  test("rawBase64 returns the original body", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/`, formats: [{ type: "rawBase64" }] }));
    assert.ok(result.file?.content);
    assert.match(Buffer.from(result.file.content, "base64").toString("utf8"), /<!doctype html>/i);
  });

  test("branding format runs the API-supplied script and returns an object with branding", async () => {
    const scriptPath = process.env.BRANDING_SCRIPT;
    const script = scriptPath
      ? readFileSync(scriptPath, "utf8")
      : "(function(){ return { branding: { colors: { primary: getComputedStyle(document.querySelector('.btn-primary')).backgroundColor } } }; })();";
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/`, formats: [{ type: "branding" }], brandingScript: script }));
    const branding = jsReturns(result).find(r => r.type === "object" && r.value && "branding" in (r.value as object));
    assert.ok(branding, "API looks for a {type:'object', value:{branding}} return");
    if (!scriptPath) {
      assert.equal((branding.value as any).branding.colors.primary, "rgb(255, 79, 0)");
    }
  });
});

describe("failure paths map to the API's error classes", () => {
  test("missing click target -> ActionError", async () => {
    const failure = await scrapeFail(
      chromeCdpRequest({ url: `${SITE}/`, actions: [{ type: "click", selector: "#does-not-exist", all: false }] }),
    );
    assert.equal(classifyFailure(failure.error), "ActionError");
  });

  test("throwing script -> ActionError", async () => {
    const failure = await scrapeFail(
      chromeCdpRequest({ url: `${SITE}/`, actions: [{ type: "executeJavascript", script: "throw new Error('boom')" }] }),
    );
    assert.equal(classifyFailure(failure.error), "ActionError");
    assert.match(failure.error, /boom/);
  });

  test("unresolvable host -> DNSResolutionError", async () => {
    const failure = await scrapeFail(chromeCdpRequest({ url: "http://does-not-exist.invalid/" }));
    assert.equal(classifyFailure(failure.error), "DNSResolutionError");
  });

  test("connection refused -> SiteError", async () => {
    const failure = await scrapeFail(chromeCdpRequest({ url: `http://${FIXTURE_HOST}:1/` }));
    assert.equal(classifyFailure(failure.error), "SiteError");
  });

  test("timeout -> FEPageLoadFailed", async () => {
    const started = Date.now();
    const failure = await scrapeFail(chromeCdpRequest({ url: `${SITE}/slow`, timeout: 3000 }));
    assert.equal(classifyFailure(failure.error), "FEPageLoadFailed");
    assert.ok(Date.now() - started < 10_000, "timeout must be enforced");
  });

  test("invalid request -> EngineError (falls back to the next engine)", async () => {
    const { status, json } = await post("/scrape", { engine: "chrome-cdp" });
    assert.equal(status, 400);
    assert.equal(classifyFailure(scrapeFailedSchema.parse(json).error), "EngineError");
  });
});

describe("stealth / enhanced path", () => {
  test("fingerprint is consistent and free of common automation tells", async () => {
    const result = await scrapeOk(
      chromeCdpRequest({
        url: `${SITE}/echo-page`,
        proxy: "stealth",
        actions: [
          {
            type: "executeJavascript",
            script: `(async () => {
              const canvas = document.createElement('canvas');
              const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
              let vendor = null, renderer = null;
              if (gl) {
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
                renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
              }
              const uad = navigator.userAgentData;
              const high = uad ? await uad.getHighEntropyValues(['platform', 'fullVersionList']) : null;
              return {
                webdriver: navigator.webdriver,
                plugins: navigator.plugins.length,
                pluginsIsArray: Object.prototype.toString.call(navigator.plugins),
                languages: navigator.languages,
                ua: navigator.userAgent,
                platform: navigator.platform,
                brands: uad ? uad.brands.map(b => b.brand + ':' + b.version) : null,
                chPlatform: uad ? uad.platform : null,
                fullVersionList: high ? high.fullVersionList.map(b => b.brand + ':' + b.version) : null,
                webgl: !!gl, vendor, renderer,
                chrome: typeof window.chrome,
                hidden: document.hidden,
              };
            })()`,
          },
        ],
      }),
    );
    const fp = jsReturns(result)[0]!.value as Record<string, any>;
    assert.notEqual(fp.webdriver, true, "navigator.webdriver must not be true");
    assert.ok(fp.plugins > 0, "plugins must not be empty");
    assert.equal(fp.pluginsIsArray, "[object PluginArray]", "plugins must remain a real PluginArray");
    assert.ok(Array.isArray(fp.languages) && fp.languages.length > 0);
    assert.doesNotMatch(fp.ua, /Headless/i);
    assert.equal(fp.chrome, "object");
    assert.equal(fp.hidden, false);
    assert.equal(fp.webgl, true, "WebGL context must exist in stealth mode");
    assert.ok(fp.vendor && fp.renderer, "WebGL vendor/renderer must be readable");

    const uaMajor = /Chrome\/(\d+)/.exec(fp.ua)?.[1];
    assert.ok(uaMajor);
    assert.ok(fp.brands.some((b: string) => b === `Chromium:${uaMajor}`), `brands ${fp.brands} vs UA ${uaMajor}`);
    assert.ok(fp.brands.every((b: string) => !/Headless/i.test(b)));
    const uaPlatform = /Windows/.test(fp.ua) ? "Windows" : /Mac OS X/.test(fp.ua) ? "macOS" : /Android/.test(fp.ua) ? "Android" : "Linux";
    assert.equal(fp.chPlatform, uaPlatform, "client-hint platform must match the UA");
    assert.ok(String(fp.platform).toLowerCase().includes(uaPlatform === "Windows" ? "win" : uaPlatform === "macOS" ? "mac" : "linux"));

    // Server-side view of the same request.
    const headers = JSON.parse(/<pre id="headers">([\s\S]*?)<\/pre>/.exec(result.content)![1]!.replace(/&lt;/g, "<"));
    assert.match(headers["user-agent"], new RegExp(`Chrome/${uaMajor}\\.`));
    assert.match(headers["sec-ch-ua"], new RegExp(`"Chromium";v="${uaMajor}"`));
    assert.equal(headers["sec-ch-ua-platform"], `"${uaPlatform}"`);
    assert.equal(headers["sec-ch-ua-mobile"], "?0");
  });

  test("anti-bot block on the basic path is retried once in stealth mode", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/challenge`, proxy: "auto" }));
    assert.equal(result.pageStatusCode, 200);
    assert.match(result.content, /Welcome, human/);
  });

  test("explicit stealth requests go straight to the stealth browser", async () => {
    const result = await scrapeOk(chromeCdpRequest({ url: `${SITE}/challenge`, proxy: "stealth" }));
    assert.match(result.content, /Welcome, human/);
  });
});

describe("tlsclient", () => {
  test("plain HTTP fetch with Chrome-consistent client hints", async () => {
    const result = await scrapeOk(tlsClientRequest({ url: `${SITE}/echo-headers`, headers: { "X-Contract": "tls" } }));
    assert.equal(result.pageStatusCode, 200);
    const headers = JSON.parse(result.content);
    assert.equal(headers["x-contract"], "tls");
    const major = /Chrome\/(\d+)/.exec(headers["user-agent"])?.[1];
    assert.match(headers["sec-ch-ua"], new RegExp(`v="${major}"`));
  });

  test("sitemap XML and PDF files", async () => {
    const xml = await scrapeOk(tlsClientRequest({ url: `${SITE}/sitemap.xml` }));
    assert.match(xml.content, /<urlset/);
    const pdf = await scrapeOk(tlsClientRequest({ url: `${SITE}/file.pdf` }));
    assert.ok(pdf.file?.content);
  });

  test("DNS failure is classified", async () => {
    const failure = await scrapeFail(tlsClientRequest({ url: "http://does-not-exist.invalid/" }));
    assert.equal(classifyFailure(failure.error), "DNSResolutionError");
  });
});

describe("job API", () => {
  test("instantReturn, poll until completed, then delete", async () => {
    const { status, json } = await post("/scrape", { ...chromeCdpRequest({ url: `${SITE}/` }), instantReturn: true });
    assert.equal(status, 202);
    assert.ok(json.jobId && json.processing === true);
    let final: any;
    for (let i = 0; i < 60; i++) {
      final = await (await fetch(`${SERVICE}/scrape/${json.jobId}`)).json();
      if (!checkProcessingSchema.safeParse(final).success) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const parsed = checkSuccessSchema.safeParse(final);
    assert.ok(parsed.success, JSON.stringify(final).slice(0, 300));
    assert.match(parsed.data.content, /Fixture Heading/);
    assert.equal((await fetch(`${SERVICE}/scrape/${json.jobId}`, { method: "DELETE" })).status, 200);
    const gone = await (await fetch(`${SERVICE}/scrape/${json.jobId}`)).json();
    assert.ok(checkFailedSchema.safeParse(gone).success);
  });
});

describe("search and map", () => {
  test("v2 search shapes and domain filters", async () => {
    const { status, json } = await post("/v2/search", {
      query: "firecrawl",
      numResults: 5,
      page: 1,
      type: ["web", "news", "images"],
      excludeDomains: ["other.test"],
    });
    assert.equal(status, 200);
    if (process.env.EXPECT_SEARXNG === "1") {
      assert.equal(json.web.length, 5);
      assert.ok(json.web.every((r: any) => r.url.startsWith("https://example.org/") && r.title && "description" in r));
      assert.ok(json.news.length > 0 && json.images.length > 0);
      assert.ok(json.images[0].imageUrl);
    } else {
      assert.equal(typeof json, "object");
    }
  });

  test("v1 search and map return SearchResult arrays", async () => {
    const search = await post("/search", { query: "firecrawl", numResults: 3, page: 1 });
    assert.ok(Array.isArray(search.json));
    const map = await post("/map", { query: "site:example.org", numResults: 100, page: 1 });
    assert.ok(Array.isArray(map.json));
    if (process.env.EXPECT_SEARXNG === "1") {
      assert.equal(search.json.length, 3);
      assert.equal(map.json.length, 20, "fixture SearXNG serves two pages of 10");
    }
  });
});
