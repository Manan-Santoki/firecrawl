import assert from "node:assert/strict";
import test from "node:test";
import { detectBlock } from "../src/antibot.js";
import { loadConfig, resolveProxy } from "../src/config.js";
import { classifyBody, decodeBody, fileNameFor, flattenHeaders } from "../src/content.js";
import { CapacityError, classifyFetchError, classifyNavigationError, sanitize } from "../src/errors.js";
import { resolveLocation } from "../src/geo.js";
import { Limiter } from "../src/limiter.js";
import { isBlockedUrl, isPrivateAddress } from "../src/net-guard.js";
import { scrapeRequestSchema } from "../src/schema.js";
import { alignChromeVersion, clientHints, navigatorOverrider, normalizeUserAgent, platformFromUserAgent } from "../src/stealth.js";
import { buildIdentity } from "../src/cdp-engine.js";

test("anti-bot detection: vendor markers, status rules and clean pages", () => {
  assert.equal(detectBlock(429, "<html></html>").blocked, true);
  assert.equal(
    detectBlock(200, '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>').blocked,
    true,
  );
  assert.equal(detectBlock(200, "<html><body>Incapsula incident ID: 123</body></html>").blocked, true);
  assert.equal(detectBlock(403, "<html><body><h1>Forbidden</h1><p>nope</p></body></html>").blocked, true);
  assert.equal(detectBlock(503, "<html><head><title>Just a moment...</title></head></html>").blocked, true);
  assert.equal(detectBlock(200, "<html><head><title>Just a moment...</title></head><body></body></html>").blocked, true);
  // Data responses and ordinary pages are not blocks.
  assert.equal(detectBlock(403, '{"error":"forbidden"}').blocked, false);
  assert.equal(detectBlock(200, "<html><body><h1>Hello</h1><p>Access denied is a phrase in this article.</p></body></html>").blocked, false);
  assert.equal(detectBlock(404, "<html><body>Not found</body></html>").blocked, false);
  // Long legitimate article mentioning "Access Denied" with 200 status.
  assert.equal(detectBlock(200, `<html><body>${"<p>text</p>".repeat(2000)}Access Denied</body></html>`).blocked, false);
});

test("config parsing and {country} proxy substitution", () => {
  const config = loadConfig({
    PROXY_SERVER: "http://proxy:8080",
    PROXY_USERNAME: "user-country-{country}",
    PROXY_PASSWORD: "secret",
    STEALTH_PROXY_SERVER: "http://stealth:9000",
    MAX_CONCURRENT_SCRAPES: "3",
    BLOCK_PRIVATE_NETWORKS: "false",
  });
  assert.equal(config.maxConcurrentScrapes, 3);
  assert.equal(config.blockPrivateNetworks, false);
  assert.equal(config.stealthProxy?.server, "http://stealth:9000");
  assert.deepEqual(resolveProxy(config.proxy, "de"), {
    server: "http://proxy:8080",
    username: "user-country-de",
    password: "secret",
    bypass: undefined,
  });
  assert.equal(resolveProxy(config.proxy, undefined)?.username, "user-country-");
  assert.throws(() => loadConfig({ MAX_CONCURRENT_SCRAPES: "0" }));
  assert.throws(() => loadConfig({ BLOCK_ADS: "maybe" }));
});

test("location profiles", () => {
  assert.deepEqual(resolveLocation({ country: "us-generic" }), {
    country: "us",
    locale: "en-US",
    languages: ["en-US", "en"],
    acceptLanguage: "en-US,en;q=0.9",
    timezone: "America/New_York",
  });
  const de = resolveLocation({ country: "DE", languages: ["de-DE", "en"] });
  assert.equal(de.locale, "de-DE");
  assert.equal(de.timezone, "Europe/Berlin");
  assert.equal(de.acceptLanguage, "de-DE,en;q=0.9");
  assert.equal(resolveLocation(undefined).timezone, undefined);
  assert.equal(resolveLocation({ languages: ["bad value!"] }).locale, "en-US");
});

test("error vocabulary matches the API's classifier", () => {
  assert.equal(
    classifyNavigationError(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at http://x.invalid/"), "http://x.invalid/").message,
    "Dns resolution error for hostname: x.invalid",
  );
  assert.equal(
    classifyNavigationError(new Error("page.goto: net::ERR_CERT_DATE_INVALID at https://a/"), "https://a/").message,
    "Chrome error: net::ERR_CERT_DATE_INVALID",
  );
  assert.match(classifyNavigationError(new Error("page.goto: Timeout 3000ms exceeded."), "http://a/").message, /failed to finish without timing out/);
  const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  assert.match(classifyFetchError(dns, "http://h.invalid/").message, /^Dns resolution error for hostname: h.invalid$/);
  const cert = Object.assign(new TypeError("fetch failed"), { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
  assert.match(classifyFetchError(cert, "https://a/").message, /ERR_CERT_/);
  assert.equal(sanitize("connect via http://user:pass@proxy:1\nstack"), "connect via http://***:***@proxy:1");
  assert.equal(new CapacityError("x").httpStatus, 429);
});

test("content classification and helpers", () => {
  assert.equal(classifyBody("text/html; charset=utf-8"), "html");
  assert.equal(classifyBody(undefined), "html");
  assert.equal(classifyBody("application/xml"), "xml");
  assert.equal(classifyBody("application/rss+xml"), "xml");
  assert.equal(classifyBody("application/json"), "text");
  assert.equal(classifyBody("text/plain"), "text");
  assert.equal(classifyBody("application/pdf"), "binary");
  assert.equal(classifyBody("image/png"), "binary");
  assert.equal(decodeBody(Buffer.from([0xe9]), "text/html; charset=iso-8859-1"), "é");
  assert.equal(fileNameFor("https://a.test/docs/report%20final.pdf?x=1"), "report final.pdf");
  assert.deepEqual(flattenHeaders([{ name: "Set-Cookie", value: "a=1" }, { name: "set-cookie", value: "b=2" }]), {
    "set-cookie": "a=1, b=2",
  });
});

test("limiter bounds concurrency and queue", async () => {
  const limiter = new Limiter(1, 1, 200);
  const first = await limiter.acquire();
  const second = limiter.acquire();
  await assert.rejects(limiter.acquire(), CapacityError);
  assert.equal(limiter.queuedCount, 1);
  first();
  const releaseSecond = await second;
  assert.equal(limiter.activeCount, 1);
  releaseSecond();
  releaseSecond(); // idempotent
  assert.equal(limiter.activeCount, 0);

  const timed = new Limiter(1, 5, 50);
  const hold = await timed.acquire();
  await assert.rejects(timed.acquire(), /queue wait timeout/);
  const controller = new AbortController();
  const aborted = timed.acquire(controller.signal);
  controller.abort();
  await assert.rejects(aborted, /aborted/);
  hold();
  assert.equal(timed.activeCount, 0);
});

test("private network guard", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  assert.equal(await isBlockedUrl("http://localhost:3000/", true), true);
  assert.equal(await isBlockedUrl("http://169.254.169.254/latest/meta-data", true), true);
  assert.equal(await isBlockedUrl("http://localhost:3000/", false), false);
  assert.equal(await isBlockedUrl("http://93.184.215.14/", true), false);
});

test("request schema accepts the API's chrome-cdp and tlsclient payloads", () => {
  const cdp = scrapeRequestSchema.parse({
    url: "https://example.com",
    scrapeId: "x",
    team_id: "t",
    engine: "chrome-cdp",
    instantReturn: false,
    headers: { a: "b" },
    actions: [
      { type: "wait", milliseconds: 1000 },
      { type: "screenshot", fullPage: false, viewport: { width: 1280, height: 720 }, quality: 70, metadata: { __firecrawl_internal: true } },
      { type: "executeJavascript", script: "1", realViewport: true, metadata: { __firecrawl_internal: true } },
      { type: "getCookies", metadata: { __firecrawl_internal: true } },
    ],
    priority: 10,
    geolocation: { country: "us-generic" },
    mobile: false,
    timeout: 30000,
    mobileProxy: false,
    autoProxy: true,
    maxAge: 0,
    saveScrapeResultToGCS: false,
    zeroDataRetention: false,
    pdfMaxSize: 1000,
    forceNonRender: true,
    behaviorOverrides: { disableSiteHandling: true },
    futureField: 1,
  });
  assert.equal(cdp.actions?.length, 4);
  const tls = scrapeRequestSchema.parse({ url: "https://example.com", engine: "tlsclient", atsv: false, disableJsDom: true });
  assert.equal(tls.engine, "tlsclient");
  assert.equal(scrapeRequestSchema.parse({ url: "https://example.com" }).engine, "chrome-cdp");
  assert.throws(() => scrapeRequestSchema.parse({ url: "https://x", actions: [{ type: "teleport" }] }));
});

test("stealth identity: UA, client hints and platform stay consistent", () => {
  assert.equal(
    normalizeUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36"),
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36",
  );
  assert.equal(alignChromeVersion("Chrome/120.0.0.0 Mobile", "151.0.0.0"), "Chrome/151.0.0.0 Mobile");
  const hints = clientHints("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36");
  assert.equal(hints["sec-ch-ua"], '"Chromium";v="151", "Not_A Brand";v="8", "Google Chrome";v="151"');
  assert.equal(hints["sec-ch-ua-platform"], '"Windows"');
  assert.equal(hints["sec-ch-ua-mobile"], "?0");
  assert.deepEqual(platformFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile"), { platform: "Android", mobile: true });

  const desktop = buildIdentity("151.0.7922.34", false);
  assert.match(desktop.userAgent, /Chrome\/151\.0\.0\.0 Safari/);
  assert.doesNotMatch(desktop.userAgent, /Headless/);
  assert.equal(platformFromUserAgent(desktop.userAgent).platform, desktop.chPlatform);
  const mobile = buildIdentity("151.0.7922.34", true);
  assert.match(mobile.userAgent, /Android .*Chrome\/151\.0\.0\.0 Mobile/);
  assert.equal(mobile.chPlatform, "Android");

  const script = navigatorOverrider(["de-DE", "de"]);
  assert.match(script, /"de-DE","de"/);
  assert.doesNotMatch(script, /\[1, 2, 3, 4, 5\]/, "plugins are never replaced by a plain array");
});
