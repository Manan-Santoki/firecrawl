import type { PlaygroundKind } from "./playground-shared";

/** Builds request bodies for the v2 API from the playground form state. Pure and unit-tested. */

export type SchemaField = { name: string; type: "string" | "number" | "boolean" | "array" | "object"; required: boolean; description: string };

export type ActionRow =
  | { type: "wait"; milliseconds: string; selector: string }
  | { type: "click"; selector: string; all: boolean }
  | { type: "write"; text: string }
  | { type: "press"; key: string }
  | { type: "scroll"; direction: "up" | "down"; selector: string }
  | { type: "screenshot"; fullPage: boolean }
  | { type: "executeJavascript"; script: string }
  | { type: "scrape" }
  | { type: "pdf"; landscape: boolean };

export type FormState = {
  url: string;
  urls: string;
  query: string;
  prompt: string;
  formats: string[];
  screenshotFullPage: boolean;
  jsonPrompt: string;
  schemaMode: "builder" | "raw";
  schemaFields: SchemaField[];
  schemaRaw: string;
  highlightsQuery: string;
  question: string;
  brandingMode: string;
  actions: ActionRow[];
  country: string;
  languages: string;
  mobile: boolean;
  proxy: string;
  maxAge: string;
  lockdown: boolean;
  redactPII: boolean;
  redactMode: string;
  onlyMainContent: boolean;
  includeTags: string;
  excludeTags: string;
  waitFor: string;
  timeout: string;
  // search
  limit: string;
  sources: string[];
  searchScrape: boolean;
  // map / crawl
  mapSearch: string;
  sitemap: string;
  includeSubdomains: boolean;
  maxDiscoveryDepth: string;
  includePaths: string;
  excludePaths: string;
  crawlEntireDomain: boolean;
  allowSubdomains: boolean;
  webhookUrl: string;
  // extract / agent
  enableWebSearch: boolean;
  maxCredits: string;
  effort: string;
};

export const DEFAULT_FORM: FormState = {
  url: "https://example.com",
  urls: "https://example.com\nhttps://example.org",
  query: "firecrawl self-hosted",
  prompt: "Extract the page title and a one-sentence description.",
  formats: ["markdown"],
  screenshotFullPage: false,
  jsonPrompt: "",
  schemaMode: "builder",
  schemaFields: [
    { name: "title", type: "string", required: true, description: "" },
    { name: "description", type: "string", required: false, description: "" },
  ],
  schemaRaw: '{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" }\n  }\n}',
  highlightsQuery: "",
  question: "",
  brandingMode: "auto",
  actions: [],
  country: "",
  languages: "",
  mobile: false,
  proxy: "auto",
  maxAge: "",
  lockdown: false,
  redactPII: false,
  redactMode: "accurate",
  onlyMainContent: true,
  includeTags: "",
  excludeTags: "",
  waitFor: "",
  timeout: "",
  limit: "5",
  sources: ["web"],
  searchScrape: false,
  mapSearch: "",
  sitemap: "include",
  includeSubdomains: true,
  maxDiscoveryDepth: "",
  includePaths: "",
  excludePaths: "",
  crawlEntireDomain: false,
  allowSubdomains: false,
  webhookUrl: "",
  enableWebSearch: false,
  maxCredits: "",
  effort: "medium",
};

function list(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function int(text: string): number | undefined {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0) && v !== ""),
  ) as Partial<T>;
}

export function schemaFromFields(fields: SchemaField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.name.trim()) continue;
    const base: Record<string, unknown> =
      field.type === "array" ? { type: "array", items: { type: "string" } } : { type: field.type };
    if (field.description.trim()) base.description = field.description.trim();
    properties[field.name.trim()] = base;
  }
  const required = fields.filter((field) => field.required && field.name.trim()).map((field) => field.name.trim());
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

export function currentSchema(state: FormState): Record<string, unknown> | undefined {
  if (state.schemaMode === "builder") return schemaFromFields(state.schemaFields);
  try {
    const parsed = JSON.parse(state.schemaRaw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function action(row: ActionRow): Record<string, unknown> {
  switch (row.type) {
    case "wait":
      return row.selector.trim() ? { type: "wait", selector: row.selector.trim() } : { type: "wait", milliseconds: int(row.milliseconds) ?? 1000 };
    case "click":
      return { type: "click", selector: row.selector, ...(row.all ? { all: true } : {}) };
    case "write":
      return { type: "write", text: row.text };
    case "press":
      return { type: "press", key: row.key };
    case "scroll":
      return compact({ type: "scroll", direction: row.direction, selector: row.selector.trim() || undefined });
    case "screenshot":
      return { type: "screenshot", ...(row.fullPage ? { fullPage: true } : {}) };
    case "executeJavascript":
      return { type: "executeJavascript", script: row.script };
    case "pdf":
      return { type: "pdf", ...(row.landscape ? { landscape: true } : {}) };
    default:
      return { type: "scrape" };
  }
}

export function newAction(type: ActionRow["type"]): ActionRow {
  switch (type) {
    case "wait":
      return { type, milliseconds: "1000", selector: "" };
    case "click":
      return { type, selector: "", all: false };
    case "write":
      return { type, text: "" };
    case "press":
      return { type, key: "Enter" };
    case "scroll":
      return { type, direction: "down", selector: "" };
    case "screenshot":
      return { type, fullPage: false };
    case "executeJavascript":
      return { type, script: "" };
    case "pdf":
      return { type, landscape: false };
    default:
      return { type: "scrape" };
  }
}

/** The `formats` array, expanding the option-carrying formats into objects. */
export function buildFormats(state: FormState): unknown[] {
  return state.formats.map((format) => {
    switch (format) {
      case "screenshot":
        return state.screenshotFullPage ? { type: "screenshot", fullPage: true } : "screenshot";
      case "json":
        return compact({ type: "json", schema: currentSchema(state), prompt: state.jsonPrompt.trim() || undefined });
      case "highlights":
        return { type: "highlights", query: state.highlightsQuery.trim() || state.query };
      case "question":
        return { type: "question", question: state.question.trim() || "What is this page about?" };
      case "branding":
        return state.brandingMode === "auto" ? "branding" : { type: "branding", mode: state.brandingMode };
      default:
        return format;
    }
  });
}

export function buildScrapeOptions(state: FormState): Record<string, unknown> {
  const languages = list(state.languages);
  return compact({
    formats: buildFormats(state),
    actions: state.actions.length ? state.actions.map(action) : undefined,
    location: state.country.trim() || languages.length ? compact({ country: state.country.trim().toUpperCase() || undefined, languages }) : undefined,
    mobile: state.mobile || undefined,
    proxy: state.proxy !== "auto" ? state.proxy : undefined,
    maxAge: int(state.maxAge),
    lockdown: state.lockdown || undefined,
    redactPII: state.redactPII ? (state.redactMode === "accurate" ? true : { mode: state.redactMode }) : undefined,
    onlyMainContent: state.onlyMainContent ? undefined : false,
    includeTags: list(state.includeTags),
    excludeTags: list(state.excludeTags),
    waitFor: int(state.waitFor),
    timeout: int(state.timeout),
  });
}

export function buildBody(kind: PlaygroundKind, state: FormState): Record<string, unknown> {
  const webhook = state.webhookUrl.trim() || undefined;
  switch (kind) {
    case "scrape":
      return { url: state.url.trim(), ...buildScrapeOptions(state) };
    case "search":
      return compact({
        query: state.query.trim(),
        limit: int(state.limit),
        sources: state.sources.length && !(state.sources.length === 1 && state.sources[0] === "web") ? state.sources : undefined,
        location: state.country.trim() || undefined,
        scrapeOptions: state.searchScrape ? buildScrapeOptions(state) : undefined,
      });
    case "map":
      return compact({
        url: state.url.trim(),
        search: state.mapSearch.trim() || undefined,
        limit: int(state.limit),
        sitemap: state.sitemap !== "include" ? state.sitemap : undefined,
        includeSubdomains: state.includeSubdomains ? undefined : false,
      });
    case "crawl":
      return compact({
        url: state.url.trim(),
        limit: int(state.limit),
        maxDiscoveryDepth: int(state.maxDiscoveryDepth),
        includePaths: list(state.includePaths),
        excludePaths: list(state.excludePaths),
        crawlEntireDomain: state.crawlEntireDomain || undefined,
        allowSubdomains: state.allowSubdomains || undefined,
        sitemap: state.sitemap !== "include" ? state.sitemap : undefined,
        webhook,
        scrapeOptions: buildScrapeOptions(state),
      });
    case "batch_scrape":
      return compact({ urls: list(state.urls), webhook, ...buildScrapeOptions(state) });
    case "extract":
      return compact({
        urls: list(state.urls),
        prompt: state.prompt.trim() || undefined,
        schema: currentSchema(state),
        enableWebSearch: state.enableWebSearch || undefined,
      });
    case "agent":
      return compact({
        prompt: state.prompt.trim(),
        urls: list(state.urls),
        schema: state.schemaMode === "raw" || state.schemaFields.length ? currentSchema(state) : undefined,
        maxCredits: int(state.maxCredits),
        effort: state.effort !== "medium" ? state.effort : undefined,
      });
  }
}
