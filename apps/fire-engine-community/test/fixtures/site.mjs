// Local fixture site for the contract tests. Plain JavaScript with no
// dependencies so it can run inside the service container (`docker cp` +
// `docker exec node`), where it is reachable as http://localhost — a secure
// context, which Chromium requires before exposing client hints.
import http from "node:http";

const INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Fire Engine Community Fixture</title>
  <style>
    :root { --brand: #ff4f00; }
    body { font-family: Georgia, serif; margin: 0; background: #fafafa; color: #111; }
    header { background: var(--brand); color: white; padding: 16px; }
    .btn-primary { background: var(--brand); color: #fff; border-radius: 8px; padding: 10px 18px; border: 0; }
    #spacer { height: 3000px; }
  </style>
</head>
<body>
  <header><img id="logo" alt="Fixture logo" src="/logo.svg" width="120" height="32"><h1>Fixture Heading</h1></header>
  <main>
    <p id="intro">Static paragraph for markdown conversion.</p>
    <button id="reveal" class="btn-primary" onclick="document.getElementById('hidden').innerHTML='<p id=revealed>Revealed after click</p>'">Reveal</button>
    <div id="hidden"></div>
    <form id="search" onsubmit="event.preventDefault(); document.getElementById('echo').textContent='typed:' + document.getElementById('q').value;">
      <input id="q" name="q" type="text">
    </form>
    <p id="echo"></p>
    <div id="late"></div>
    <div id="spacer"></div>
    <p id="bottom">Bottom of page</p>
  </main>
  <script>
    window.fixtureGlobal = 42;
    setTimeout(function () { document.getElementById('late').innerHTML = '<span id="late-ready">late content</span>'; }, 300);
  </script>
</body>
</html>`;

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" fill="#ff4f00"/></svg>`;

const CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><div id="challenge-form">Checking your browser before accessing the site.</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>`;

// Minimal single-page PDF with real text and a valid xref table.
function buildPdf(text) {
  const stream = `BT /F1 18 Tf 40 150 Td (${text}) Tj ET`;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PDF = buildPdf("Fire engine fixture PDF text");

export function createFixtureServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
      res.end(body);
    };
    switch (url.pathname) {
      case "/":
        return send(200, "text/html; charset=utf-8", INDEX, { "x-fixture": "index" });
      case "/logo.svg":
        return send(200, "image/svg+xml", LOGO);
      case "/echo-headers":
        return send(200, "application/json", JSON.stringify(req.headers));
      case "/echo-page":
        return send(
          200,
          "text/html; charset=utf-8",
          `<!doctype html><html><body><pre id="headers">${JSON.stringify(req.headers).replace(/</g, "&lt;")}</pre></body></html>`,
        );
      case "/fingerprint":
        return send(200, "text/html; charset=utf-8", "<!doctype html><html><head><title>fp</title></head><body><p>fingerprint</p></body></html>");
      case "/challenge": {
        // Answers like a bot wall unless the client presents Chrome-branded
        // client hints, which only the stealth path sends.
        const brands = String(req.headers["sec-ch-ua"] ?? "");
        if (brands.includes('"Google Chrome";v=')) {
          return send(200, "text/html; charset=utf-8", "<!doctype html><html><body><h1>Welcome, human</h1><p>Real content after challenge.</p></body></html>");
        }
        return send(403, "text/html; charset=utf-8", CHALLENGE);
      }
      case "/file.pdf":
        return send(200, "application/pdf", PDF, { "content-disposition": 'inline; filename="file.pdf"' });
      case "/download.bin":
        return send(200, "application/octet-stream", PDF, { "content-disposition": 'attachment; filename="report.pdf"' });
      case "/sitemap.xml":
        return send(200, "application/xml", '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://fixture/a</loc></url></urlset>');
      case "/data.json":
        return send(200, "application/json", JSON.stringify({ hello: "world", tag: "<b>" }));
      case "/redirect":
        return send(302, "text/plain", "", { location: "/" });
      case "/missing":
        return send(404, "text/html", "<!doctype html><html><body><h1>Not here</h1></body></html>");
      case "/slow":
        setTimeout(() => send(200, "text/html", "<html><body>finally</body></html>"), 20_000);
        return;
      case "/searxng/search": {
        const q = url.searchParams.get("q") ?? "";
        const page = Number(url.searchParams.get("pageno") ?? "1");
        const category = url.searchParams.get("categories");
        const results =
          page > 2
            ? []
            : Array.from({ length: 10 }, (_, i) => ({
                url: i % 2 === 0 ? `https://example.org/${page}-${i}` : `https://other.test/${page}-${i}`,
                title: `${q} result ${page}-${i}`,
                content: `snippet ${i}`,
                ...(category === "images" ? { img_src: `https://img.example.org/${i}.png` } : {}),
                ...(category === "news" ? { publishedDate: "2026-11-01T00:00:00Z" } : {}),
              }));
        return send(200, "application/json", JSON.stringify({ query: q, results }));
      }
      default:
        return send(404, "text/plain", "not found");
    }
  });
}

if (process.argv[1] && /site\.mjs$/.test(process.argv[1])) {
  const port = Number(process.env.FIXTURE_PORT ?? "4580");
  // Default bind is dual-stack so `localhost` works whether it resolves to
  // 127.0.0.1 or ::1.
  createFixtureServer().listen({ port, host: process.env.FIXTURE_BIND }, () => {
    console.log(`fixture site listening on ${port}`);
  });
}
