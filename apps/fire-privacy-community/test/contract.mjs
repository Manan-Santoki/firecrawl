// Black-box contract test for a running fire-privacy-community instance.
//
// Sends requests exactly as apps/api/src/lib/fire-privacy-client.ts (upstream
// v2.11.739) does and applies that client's response handling, ported
// verbatim, so JavaScript string semantics (UTF-16 offsets) are exercised for
// real. No dependencies; Node >= 20.
//
//   FIRE_PRIVACY_URL=http://127.0.0.1:3010 [PRIVACY_API_KEY=...] node test/contract.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const BASE = (process.env.FIRE_PRIVACY_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const API_KEY = process.env.PRIVACY_API_KEY;
const TIMEOUT_MS = Number(process.env.FIRE_PRIVACY_TIMEOUT_MS ?? 30000);

// ---- verbatim from the API client ------------------------------------------
const MODE_MAP = { accurate: "model", aggressive: "both", fast: "heuristics" };
const REPLACE_MAP = { tag: "replace", mask: "mask", remove: "redact" };
const KIND_TO_ENTITY = {
  PRIVATE_PERSON: "PERSON", PERSON: "PERSON",
  PRIVATE_EMAIL: "EMAIL", EMAIL_ADDRESS: "EMAIL",
  PRIVATE_PHONE: "PHONE", PHONE_NUMBER: "PHONE", PHONEIMEI: "PHONE",
  PRIVATE_ADDRESS: "LOCATION", LOCATION: "LOCATION",
  ACCOUNT_NUMBER: "FINANCIAL", CREDIT_CARD: "FINANCIAL", IBAN_CODE: "FINANCIAL",
  US_BANK_NUMBER: "FINANCIAL", US_SSN: "FINANCIAL", US_ITIN: "FINANCIAL", CRYPTO: "FINANCIAL",
  SECRET: "SECRET", API_KEY: "SECRET", PASSWORD: "SECRET",
  US_DRIVER_LICENSE: "SECRET", US_PASSPORT: "SECRET", MEDICAL_LICENSE: "SECRET",
};
function classifySource(raw) {
  if (typeof raw !== "string") return "unknown";
  if (raw === "openai-privacy-filter") return "model";
  if (raw.endsWith("Recognizer")) return "heuristics";
  return "unknown";
}
function coerceSpans(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const r of value) {
    if (typeof r !== "object" || r === null) continue;
    if (typeof r.start !== "number" || typeof r.end !== "number" || typeof r.kind !== "string") continue;
    const span = { start: r.start, end: r.end, kind: r.kind, source: classifySource(r.source) };
    if (KIND_TO_ENTITY[r.kind] !== undefined) span.entity = KIND_TO_ENTITY[r.kind];
    if (typeof r.score === "number") span.score = r.score;
    out.push(span);
  }
  return out;
}
function renderRedacted(text, spans, replaceStyle) {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    if (span.start > text.length) break;
    out += text.slice(cursor, span.start);
    if (replaceStyle === "tag") out += `<${span.kind}>`;
    else if (replaceStyle === "mask") out += "*".repeat(Math.max(0, span.end - span.start));
    cursor = Math.min(span.end, text.length);
  }
  return out + text.slice(cursor);
}
function isRegionUnavailable(parsed) {
  if (typeof parsed !== "object" || parsed === null) return false;
  return ["code", "error_code", "error_class", "error"].some(k => parsed[k] === "region_unavailable");
}
// ----------------------------------------------------------------------------

async function redact(text, { mode = "accurate", replaceStyle = "tag", usOnly = false, headers = {} } = {}) {
  const auth = API_KEY ? { authorization: `Bearer ${API_KEY}` } : {};
  const response = await fetch(`${BASE}/redact`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth, ...headers },
    body: JSON.stringify({
      text,
      mode: MODE_MAP[mode],
      operator: REPLACE_MAP[replaceStyle],
      language: "en",
      ...(usOnly && { data_region: "us" }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function assertCompatible(text, body, replaceStyle) {
  assert.equal(typeof body.redacted_text, "string");
  assert.ok(["ok", "skipped"].includes(body.model_status));
  assert.ok(Array.isArray(body.spans));
  const spans = coerceSpans(body.spans);
  assert.equal(spans.length, body.spans.length, "no span may be dropped as malformed");
  let prevEnd = 0;
  for (const s of spans) {
    assert.ok(s.entity, `kind ${s.kind} must map to an entity bucket`);
    assert.equal(s.source, "heuristics");
    assert.ok(s.start >= prevEnd && s.end > s.start && s.end <= text.length);
    prevEnd = s.end;
  }
  // The API re-renders from spans whenever an entity filter prunes spans.
  assert.equal(renderRedacted(text, spans, replaceStyle), body.redacted_text);
  return spans;
}

const SAMPLE =
  "# Team\n\nHi, my name is Alice Smith. Email me at alice@example.com or call (415) 555-0132.\n\n" +
  "\u{1F600} Billing: card 4111 1111 1111 1111, key AKIAIOSFODNN7EXAMPLE \u{1F389}, password: hunter22secret.";

test("liveness and readiness", async () => {
  assert.equal((await fetch(`${BASE}/health/liveness`)).status, 200);
  assert.equal((await fetch(`${BASE}/health/readiness`)).status, 200);
});

for (const mode of ["accurate", "aggressive", "fast"]) {
  for (const replaceStyle of ["tag", "mask", "remove"]) {
    test(`redacts with mode=${mode} replaceStyle=${replaceStyle}`, async () => {
      const { status, body } = await redact(SAMPLE, { mode, replaceStyle });
      assert.equal(status, 200);
      const spans = assertCompatible(SAMPLE, body, replaceStyle);
      const found = new Map(spans.map(s => [SAMPLE.slice(s.start, s.end), s.entity]));
      assert.equal(found.get("alice@example.com"), "EMAIL");
      assert.equal(found.get("(415) 555-0132"), "PHONE");
      assert.equal(found.get("4111 1111 1111 1111"), "FINANCIAL");
      assert.equal(found.get("AKIAIOSFODNN7EXAMPLE"), "SECRET");
      assert.equal(found.get("hunter22secret"), "SECRET");
      assert.equal(found.get("Alice Smith"), mode === "fast" ? undefined : "PERSON");
      for (const secret of found.keys()) assert.ok(!body.redacted_text.includes(secret));
    });
  }
}

test("upstream fixture: person + email offsets", async () => {
  const text = "Hi, my name is Alice Smith. Email me at alice@example.com.";
  const { body } = await redact(text);
  assert.equal(body.redacted_text, "Hi, my name is <PERSON>. Email me at <EMAIL_ADDRESS>.");
  assert.deepEqual(
    coerceSpans(body.spans).map(s => [s.start, s.end, s.entity]),
    [[15, 26, "PERSON"], [40, 57, "EMAIL"]],
  );
});

test("whitespace-only input reports skipped", async () => {
  const { status, body } = await redact("  \n ");
  assert.equal(status, 200);
  assert.equal(body.model_status, "skipped");
});

test("a 28K-character chunk completes within the client budget", async () => {
  const para = "Lorem ipsum dolor sit amet. Please contact Alice Carter today at alice@example.com.\n\n";
  const text = para.repeat(Math.ceil(28_000 / para.length)).slice(0, 28_000);
  const started = Date.now();
  const { status, body } = await redact(text, { mode: "aggressive" });
  const elapsed = Date.now() - started;
  assert.equal(status, 200);
  assertCompatible(text, body, "tag");
  console.log(`# 28K chars aggressive: ${elapsed} ms, ${body.spans.length} spans`);
});

test("oversized text is rejected with a non-503 error (client: failed/error)", async () => {
  const { status } = await redact("x".repeat(150_000));
  assert.equal(status, 413);
});

test("region pin is refused or echoed, never silently ignored", async () => {
  const { status, body } = await redact("Hi Alice Smith", { usOnly: true });
  if (status === 200) assert.equal(body.data_region, "us");
  else assert.ok(isRegionUnavailable(body));
});

test("auth is enforced when PRIVACY_API_KEY is configured", { skip: !API_KEY }, async () => {
  const res = await fetch(`${BASE}/redact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "x", mode: "model", operator: "replace", language: "en" }),
  });
  assert.equal(res.status, 401);
});

test("parallel chunks (client concurrency 3) all succeed", async () => {
  const results = await Promise.all(
    [0, 1, 2].map(i => redact(`Chunk ${i}: write to bob${i}@example.org now.`)),
  );
  for (const { status, body } of results) {
    assert.equal(status, 200);
    assert.equal(coerceSpans(body.spans)[0]?.entity, "EMAIL");
  }
});
