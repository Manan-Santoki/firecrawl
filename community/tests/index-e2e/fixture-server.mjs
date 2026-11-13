// Fixture origin for the scrape-index end-to-end check. Serves two HTML pages,
// a SearXNG-compatible /search endpoint, and /__hits so the runner can prove
// that a cache hit did not reach the origin.
import http from "node:http";

const port = Number(process.env.PORT ?? 8080);
const publicOrigin = process.env.FIXTURE_ORIGIN ?? "http://fixture.index-e2e.test:8080";
const hits = new Map();

const page = (title, paragraphs) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${title} fixture page"></head>
<body><main><article><h1>${title}</h1>
${paragraphs.map(text => `<p>${text}</p>`).join("\n")}
</article></main></body></html>`;

const pages = {
  "/article": () => page("Basalt column formation", [
    "Columnar basalt forms when a thick lava flow cools slowly and contracts, cracking into regular polygonal columns.",
    "The cracks start at the cooling surfaces and propagate inward, so most columns are hexagonal in cross section.",
    "Famous examples include the Giant's Causeway in Northern Ireland and Devils Postpile in California.",
    `Origin request number ${hits.get("/article") ?? 0} served this copy.`,
  ]),
  "/uncached": () => page("Never scraped", [
    "This page must never be fetched while the index runs in lockdown mode.",
  ]),
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", publicOrigin);
  hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

  if (url.pathname === "/__hits") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(Object.fromEntries(hits)));
    return;
  }
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (url.pathname === "/search") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      query: url.searchParams.get("q"),
      results: url.searchParams.get("pageno") === "1" ? [{
        url: `${publicOrigin}/article`,
        title: "Basalt column formation",
        content: "PROVIDER SNIPPET",
      }] : [],
    }));
    return;
  }
  const render = pages[url.pathname];
  if (render) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(render());
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, "0.0.0.0", () => console.log(`index e2e fixture listening on ${port}`));
