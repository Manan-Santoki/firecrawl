// End-to-end smoke through a real Firecrawl API configured with
// FIRE_ENGINE_BETA_URL pointing at this service. The target site is the
// fixture (test/fixtures/site.mjs) reachable from the service as $SITE.
//
//   API=http://localhost:3002 SITE=http://fixture:4580 node test/e2e/api-smoke.mjs [case,case]
//
// Exits non-zero when an expectation fails.
const API = process.env.API ?? "http://localhost:3002";
const SITE = process.env.SITE ?? "http://fixture:4580";
// Chromium only sends client hints to secure contexts (https, localhost,
// 127.0.0.1); the fixture bot wall keys on them, so the stealth cases need a
// secure fixture URL, e.g. the fixture started inside the service container.
const SECURE_SITE = process.env.SECURE_SITE ?? SITE;
const KEY = process.env.FIRECRAWL_API_KEY ?? "fc-selfhost";
let failures = 0;

function expect(name, condition, detail) {
  if (!condition) {
    failures++;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  } else {
    console.log(`  ok   ${name}`);
  }
}

async function call(path, body) {
  const started = Date.now();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json, ms: Date.now() - started };
}

const scrape = body => call("/v2/scrape", body);

const cases = {
  async basic() {
    const { json, ms } = await scrape({ url: `${SITE}/`, formats: ["markdown"] });
    expect(`markdown (${ms}ms)`, json.success && /Static paragraph/.test(json.data.markdown), json.error);
    expect("late DOM content", /late content/.test(json.data?.markdown ?? ""));
  },
  async screenshot() {
    const { json } = await scrape({ url: `${SITE}/`, formats: ["markdown", "screenshot"] });
    expect("screenshot data URL", typeof json.data?.screenshot === "string" && json.data.screenshot.startsWith("data:image/"), json.error ?? json.data?.warning);
    expect("no unsupported-engine warning", !/does not support/i.test(json.data?.warning ?? ""), json.data?.warning);
  },
  async fullpage() {
    const { json } = await scrape({ url: `${SITE}/`, formats: [{ type: "screenshot", fullPage: true }] });
    expect("full-page screenshot", json.data?.screenshot?.startsWith("data:image/png"), json.error ?? json.data?.warning);
  },
  async actions() {
    const { status, json } = await scrape({
      url: `${SITE}/`,
      formats: ["markdown"],
      waitFor: 500,
      actions: [
        { type: "click", selector: "#reveal" },
        { type: "wait", selector: "#revealed" },
        { type: "click", selector: "#q" },
        { type: "write", text: "hello" },
        { type: "press", key: "Enter" },
        { type: "scroll", direction: "down" },
        { type: "scrape" },
        { type: "executeJavascript", script: "document.getElementById('echo').textContent" },
        { type: "screenshot" },
        { type: "pdf" },
      ],
    });
    expect(`actions accepted (HTTP ${status})`, json.success, json.error);
    const a = json.data?.actions ?? {};
    expect("action scrape", a.scrapes?.length === 1 && /Revealed after click/.test(a.scrapes[0].html));
    expect("action js return", a.javascriptReturns?.[0]?.value === "typed:hello", JSON.stringify(a.javascriptReturns));
    expect("action screenshot", a.screenshots?.length === 1);
    expect("action pdf", a.pdfs?.length === 1);
    expect("markdown after actions", /typed:hello/.test(json.data?.markdown ?? ""));
  },
  async actionfail() {
    const { status, json } = await scrape({ url: `${SITE}/`, actions: [{ type: "click", selector: "#nope" }] });
    expect(`missing element surfaces an action error (HTTP ${status})`, !json.success && /Element|#nope/.test(json.error ?? ""), json.error);
  },
  async mobile() {
    const { json } = await scrape({
      url: `${SITE}/echo-page`,
      formats: ["markdown"],
      mobile: true,
      actions: [{ type: "executeJavascript", script: "navigator.userAgent + ' | ' + screen.width" }],
    });
    const value = String(json.data?.actions?.javascriptReturns?.[0]?.value ?? "");
    expect("mobile UA and screen", /Android.*Mobile.*\| \d{3}$/.test(value), value || json.error);
  },
  async location() {
    const { json } = await scrape({
      url: `${SITE}/echo-page`,
      formats: ["markdown"],
      location: { country: "DE", languages: ["de-DE"] },
      actions: [{ type: "executeJavascript", script: "Intl.DateTimeFormat().resolvedOptions().timeZone" }],
    });
    expect("timezone", json.data?.actions?.javascriptReturns?.[0]?.value === "Europe/Berlin", json.error);
    expect("accept-language", /de-DE/.test(json.data?.markdown ?? ""));
  },
  async stealth() {
    const { json } = await scrape({ url: `${SECURE_SITE}/challenge`, formats: ["markdown"], proxy: "stealth" });
    expect("proxy: stealth succeeds", json.success && /Welcome, human/.test(json.data?.markdown ?? ""), json.error);
  },
  async enhanced() {
    const { json } = await scrape({ url: `${SITE}/`, formats: ["markdown"], proxy: "enhanced" });
    expect("proxy: enhanced succeeds", json.success && /Static paragraph/.test(json.data?.markdown ?? ""), json.error);
  },
  async auto() {
    const { json } = await scrape({ url: `${SECURE_SITE}/challenge`, formats: ["markdown"], proxy: "auto" });
    expect("proxy: auto escapes the bot wall", json.success && /Welcome, human/.test(json.data?.markdown ?? ""), json.error);
  },
  async branding() {
    const { json } = await scrape({ url: `${SITE}/`, formats: ["branding"] });
    expect("branding profile", json.success && json.data?.branding && Object.keys(json.data.branding).length > 0, json.error);
    console.log("       branding keys:", Object.keys(json.data?.branding ?? {}).join(", "));
  },
  async pdf() {
    const { json } = await scrape({ url: `${SITE}/file.pdf`, formats: ["markdown"] });
    expect("PDF handed to the PDF engine", json.success && /Fire engine fixture PDF text/.test(json.data?.markdown ?? ""), json.error);
  },
  async raw() {
    const { json } = await scrape({ url: `${SITE}/`, formats: ["rawBase64"] });
    expect("rawBase64", json.success && Buffer.from(json.data?.rawBase64 ?? "", "base64").toString().includes("Fixture Heading"), json.error);
  },
  async dns() {
    const { json } = await scrape({ url: "http://does-not-exist.invalid/", formats: ["markdown"] });
    expect("DNS failure reported", !json.success && /resolve|DNS/i.test(json.error ?? ""), json.error);
  },
  async search() {
    const { status, json } = await call("/v2/search", { query: "firecrawl", limit: 3 });
    expect(`v2 search answered by the fire-engine search backend (HTTP ${status})`, json.success && json.data?.web?.length === 3, JSON.stringify(json).slice(0, 200));
  },
  async map() {
    const { status, json } = await call("/v2/map", { url: "https://example.org", limit: 10, sitemap: "skip" });
    expect(`map (HTTP ${status})`, json.success && json.links?.length > 0, JSON.stringify(json).slice(0, 200));
  },
};

const only = process.argv[2]?.split(",");
for (const [name, fn] of Object.entries(cases)) {
  if (only && !only.includes(name)) continue;
  console.log(`- ${name}`);
  try {
    await fn();
  } catch (error) {
    failures++;
    console.log(`  FAIL threw ${error}`);
  }
}
console.log(failures === 0 ? "\nall API smoke checks passed" : `\n${failures} API smoke check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
