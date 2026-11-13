/** Playground definitions shared by the server and the browser. */

export const PLAYGROUND_KINDS = ["scrape", "search", "map", "crawl", "batch_scrape", "extract", "agent"] as const;
export type PlaygroundKind = (typeof PLAYGROUND_KINDS)[number];

export const PATHS: Record<PlaygroundKind, string> = {
  scrape: "/v2/scrape",
  search: "/v2/search",
  map: "/v2/map",
  crawl: "/v2/crawl",
  batch_scrape: "/v2/batch/scrape",
  extract: "/v2/extract",
  agent: "/v2/agent",
};


/** Kinds that answer with a job id and are then polled for status. */
export const ASYNC_KINDS: readonly PlaygroundKind[] = ["crawl", "batch_scrape", "extract", "agent"];

export function endpointPath(kind: PlaygroundKind): string {
  return PATHS[kind];
}

/** Copy-as snippets. `baseUrl` is the public API URL; the key is a placeholder. */
export function snippets(kind: PlaygroundKind, body: Record<string, unknown>, baseUrl: string) {
  const path = PATHS[kind];
  const json = JSON.stringify(body, null, 2);
  const curl = `curl -X POST '${baseUrl}${path}' \\\n  -H 'Authorization: Bearer $FIRECRAWL_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '${json.replace(/'/g, "'\\''")}'`;
  const method: Record<PlaygroundKind, [string, string]> = {
    scrape: ["scrape", "scrape"],
    search: ["search", "search"],
    map: ["map", "map"],
    crawl: ["crawl", "crawl"],
    batch_scrape: ["batch_scrape", "batchScrape"],
    extract: ["extract", "extract"],
    agent: ["agent", "agent"],
  };
  const [py, js] = method[kind];
  const first = kind === "batch_scrape" ? "urls" : kind === "search" ? "query" : kind === "extract" || kind === "agent" ? null : "url";
  const { [first ?? "__none"]: primary, ...rest } = body as Record<string, unknown>;
  const pyArgs = [
    first ? JSON.stringify(primary) : null,
    ...Object.entries(first ? rest : body).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}=${toPython(v)}`),
  ].filter(Boolean);
  const python = `from firecrawl import Firecrawl\n\nfirecrawl = Firecrawl(api_key="fc-YOUR-KEY", api_url="${baseUrl}")\nresult = firecrawl.${py}(${pyArgs.join(", ")})\nprint(result)`;
  const jsArgs = first ? `${JSON.stringify(primary)}, ${JSON.stringify(rest, null, 2)}` : JSON.stringify(body, null, 2);
  const javascript = `import Firecrawl from "@mendable/firecrawl-js";\n\nconst firecrawl = new Firecrawl({ apiKey: "fc-YOUR-KEY", apiUrl: "${baseUrl}" });\nconst result = await firecrawl.${js}(${jsArgs});\nconsole.log(result);`;
  return { curl, python, javascript };
}

function toPython(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return `[${value.map(toPython).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${toPython(v)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}
