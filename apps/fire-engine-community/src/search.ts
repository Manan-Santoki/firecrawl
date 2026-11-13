import * as cheerio from "cheerio";
import { fetch } from "undici";
import type { ServiceConfig } from "./config.js";
import type { SearchRequest } from "./schema.js";

/**
 * When FIRE_ENGINE_BETA_URL is set, the Firecrawl API sends *all* search and
 * map-discovery traffic to fire-engine (POST /search, /v2/search, /map) and
 * no longer consults its own SEARXNG_ENDPOINT or DuckDuckGo fallback. These
 * endpoints keep that behaviour available: SearXNG when configured on this
 * service, then (optionally) DuckDuckGo's HTML endpoint.
 */

export interface WebResult {
  url: string;
  title: string;
  description: string;
  position?: number;
}

interface SearchV2Response {
  web?: WebResult[];
  news?: Array<{ title?: string; url?: string; snippet?: string; date?: string; imageUrl?: string; position?: number }>;
  images?: Array<{ title?: string; imageUrl?: string; url?: string; position?: number }>;
}

const DDG_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function hostMatches(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some(raw => {
    const domain = raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!;
    return host === domain || host.endsWith(`.${domain}`) || host === `www.${domain}`;
  });
}

function filterDomains<T extends { url?: string }>(items: T[], request: SearchRequest): T[] {
  const include = request.includeDomains ?? [];
  const exclude = request.excludeDomains ?? [];
  return items.filter(item => {
    if (!item.url) return false;
    if (include.length > 0 && !hostMatches(item.url, include)) return false;
    if (exclude.length > 0 && hostMatches(item.url, exclude)) return false;
    return true;
  });
}

export class SearchService {
  constructor(private readonly config: ServiceConfig) {}

  get backend(): string {
    if (this.config.searxngEndpoint) return "searxng";
    if (this.config.searchDuckDuckGoFallback) return "duckduckgo";
    return "none";
  }

  private async searxngPage(request: SearchRequest, page: number, category?: string): Promise<any[]> {
    const base = this.config.searxngEndpoint!.replace(/\/+$/, "");
    const params = new URLSearchParams({ q: request.query, format: "json", pageno: String(page) });
    if (request.lang) params.set("language", request.lang);
    if (this.config.searxngEngines) params.set("engines", this.config.searxngEngines);
    const categories = category ?? this.config.searxngCategories;
    if (categories) params.set("categories", categories);
    if (request.safe) params.set("safesearch", "2");
    const timeRange = { d: "day", w: "week", m: "month", y: "year" }[
      (/^(?:qdr:)?([dwmy])$/.exec(request.tbs ?? "")?.[1] ?? "") as "d"
    ];
    if (timeRange) params.set("time_range", timeRange);
    const response = await fetch(`${base}/search?${params}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.config.searchTimeoutMs),
    });
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
    const data = (await response.json()) as { results?: any[] };
    return Array.isArray(data.results) ? data.results : [];
  }

  private async searxng(request: SearchRequest, wanted: number, category?: string): Promise<any[]> {
    const out: any[] = [];
    const seen = new Set<string>();
    const maxPages = Math.min(10, Math.max(1, Math.ceil(wanted / 10)));
    for (let offset = 0; offset < maxPages && out.length < wanted; offset++) {
      const results = await this.searxngPage(request, request.page + offset, category);
      if (results.length === 0) break;
      for (const result of results) {
        if (typeof result?.url !== "string" || seen.has(result.url)) continue;
        seen.add(result.url);
        out.push(result);
      }
    }
    return out;
  }

  private async duckduckgo(request: SearchRequest, wanted: number): Promise<WebResult[]> {
    const params = new URLSearchParams({ q: request.query, kp: request.safe ? "1" : "-1" });
    if (request.location) params.set("kl", request.location);
    else if (request.country && request.lang) params.set("kl", `${request.country.toLowerCase()}-${request.lang.toLowerCase()}`);
    const df = /^(?:qdr:)?([dwmy])$/.exec(request.tbs ?? "")?.[1];
    if (df) params.set("df", df);
    const headers = {
      "user-agent": DDG_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.5",
    };
    const results: WebResult[] = [];
    const seen = new Set<string>();
    let form: URLSearchParams | null = null;
    for (let page = 0; page < 5 && results.length < wanted; page++) {
      const response = form
        ? await fetch("https://html.duckduckgo.com/html/", {
            method: "POST",
            body: form.toString(),
            headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
            signal: AbortSignal.timeout(this.config.searchTimeoutMs),
          })
        : await fetch(`https://html.duckduckgo.com/html/?${params}`, {
            headers,
            signal: AbortSignal.timeout(this.config.searchTimeoutMs),
          });
      const $ = cheerio.load(await response.text());
      if ($(".anomaly-modal__modal").length > 0) throw new Error("DuckDuckGo anti-bot challenge");
      let added = 0;
      $(".result.web-result").each((_, element) => {
        const link = $(element).find(".result__a").first();
        const href = link.attr("href")?.trim();
        const title = link.text().trim();
        const description = $(element).find(".result__snippet").first().text().trim();
        if (!href || !title) return;
        let url = href;
        if (href.includes("uddg=")) {
          const decoded = new URL(href, "https://duckduckgo.com").searchParams.get("uddg");
          if (decoded) url = decoded;
        }
        if (seen.has(url)) return;
        seen.add(url);
        results.push({ url, title, description });
        added++;
      });
      if (added === 0) break;
      const next = $('input[type="submit"][value="Next"]').closest("form");
      if (next.length === 0) break;
      form = new URLSearchParams();
      next.find("input").each((_, input) => {
        const name = $(input).attr("name");
        const value = $(input).attr("value");
        if (name && value !== undefined) form!.set(name, value);
      });
    }
    return results;
  }

  async web(request: SearchRequest): Promise<WebResult[]> {
    const wanted = request.numResults;
    if (wanted === 0) return [];
    let results: WebResult[] = [];
    if (this.config.searxngEndpoint) {
      try {
        results = (await this.searxng(request, wanted)).map(r => ({
          url: r.url,
          title: String(r.title ?? ""),
          description: String(r.content ?? ""),
        }));
      } catch {
        results = [];
      }
    }
    if (results.length === 0 && this.config.searchDuckDuckGoFallback) {
      try {
        results = await this.duckduckgo(request, wanted);
      } catch {
        results = [];
      }
    }
    return filterDomains(results, request)
      .slice(0, wanted)
      .map((result, index) => ({ ...result, position: index + 1 }));
  }

  async v2(request: SearchRequest): Promise<SearchV2Response> {
    const types = new Set(
      (Array.isArray(request.type) ? request.type : [request.type ?? "web"]).map(t =>
        typeof t === "string" ? t : (t as { type?: string })?.type ?? "web",
      ),
    );
    const out: SearchV2Response = {};
    if (types.has("web")) {
      const web = await this.web(request);
      if (web.length > 0) out.web = web;
    }
    if (this.config.searxngEndpoint && types.has("news")) {
      const news = await this.searxng(request, request.numResults, "news").catch(() => []);
      const filtered = filterDomains(news, request).slice(0, request.numResults);
      if (filtered.length > 0) {
        out.news = filtered.map((r, index) => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
          date: r.publishedDate ?? undefined,
          imageUrl: r.thumbnail ?? r.img_src ?? undefined,
          position: index + 1,
        }));
      }
    }
    if (this.config.searxngEndpoint && types.has("images")) {
      const images = await this.searxng(request, request.numResults, "images").catch(() => []);
      const filtered = filterDomains(images, request).slice(0, request.numResults);
      if (filtered.length > 0) {
        out.images = filtered.map((r, index) => ({
          title: r.title,
          imageUrl: r.img_src,
          url: r.url,
          position: index + 1,
        }));
      }
    }
    return out;
  }
}
