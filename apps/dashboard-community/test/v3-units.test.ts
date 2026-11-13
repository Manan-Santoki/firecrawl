import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import bundled from "@/generated/capabilities.json";
import { parseEntries } from "@/lib/server/blocklist";
import { defaultSettings, SETTING_SCHEMAS } from "@/lib/server/settings";
import { newWebhookSecret, signPayload } from "@/lib/server/signing";
import { SELF_TESTS, testsForCapability } from "@/lib/self-tests";

describe("feature matrix bundle", () => {
  it("matches community/capabilities.yml", () => {
    const source = JSON.parse(readFileSync(path.resolve(__dirname, "../../../community/capabilities.yml"), "utf8"));
    expect(bundled).toEqual(source);
  });

  it("maps every self-test to a real capability", () => {
    const ids = new Set(bundled.capabilities.map((capability) => capability.id));
    for (const test of Object.values(SELF_TESTS)) expect(ids.has(test.capability)).toBe(true);
    expect(testsForCapability("scrape-index")).toEqual(["max_age", "lockdown"]);
  });
});

describe("blocklist entries", () => {
  it("normalizes, de-duplicates and drops blanks", () => {
    expect(parseEntries("Example.com\n\n example.com , evil.test\n")).toEqual(["example.com", "evil.test"]);
  });
});

describe("webhook signatures", () => {
  it("signs timestamp.body with HMAC-SHA256 so receivers can verify", () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_/);
    const body = JSON.stringify({ event: "webhook.test" });
    const header = signPayload(secret, body, 1_700_000_000);
    const expected = createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex");
    expect(header).toBe(`t=1700000000,v1=${expected}`);
  });
});

describe("settings", () => {
  it("has valid defaults for every stored setting", () => {
    const defaults = defaultSettings();
    for (const key of Object.keys(SETTING_SCHEMAS) as (keyof typeof SETTING_SCHEMAS)[]) {
      expect(SETTING_SCHEMAS[key].safeParse(defaults[key]).success).toBe(true);
    }
    expect(defaults.retention.requestLogDays).toBe(30);
  });

  it("rejects out-of-range retention and invalid webhook URLs", () => {
    expect(SETTING_SCHEMAS.retention.safeParse({ requestLogDays: 0, playgroundDays: 1, alertEventDays: 1, notificationDays: 1 }).success).toBe(false);
    expect(SETTING_SCHEMAS.alertWebhook.safeParse({ url: "not a url", secret: "" }).success).toBe(false);
  });
});
