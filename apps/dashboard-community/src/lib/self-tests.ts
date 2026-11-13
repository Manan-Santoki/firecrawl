/** Self-tests offered on the feature matrix, keyed to capability ids in community/capabilities.yml. */
export const SELF_TESTS = {
  scrape: { label: "Scrape markdown", capability: "scrape" },
  screenshot: { label: "Screenshot", capability: "screenshots-branding" },
  branding: { label: "Branding", capability: "screenshots-branding" },
  actions: { label: "Actions", capability: "actions" },
  search: { label: "Search", capability: "search" },
  map: { label: "Map", capability: "map" },
  crawl: { label: "Crawl", capability: "crawl" },
  json: { label: "Extract / JSON", capability: "json-format" },
  summary: { label: "Summary", capability: "ai-formats" },
  audio: { label: "Audio", capability: "media" },
  redact_pii: { label: "Redact PII", capability: "pii-redaction" },
  max_age: { label: "maxAge cache hit", capability: "scrape-index" },
  lockdown: { label: "Lockdown", capability: "scrape-index" },
  agent: { label: "Agent", capability: "agent" },
  interact: { label: "Interact", capability: "browser-interact" },
} as const;

export type SelfTestId = keyof typeof SELF_TESTS;

export function testsForCapability(capabilityId: string): SelfTestId[] {
  return (Object.keys(SELF_TESTS) as SelfTestId[]).filter((id) => SELF_TESTS[id].capability === capabilityId);
}
