// Shared fixtures (plain JS so the in-process tests and the container contract
// runner use the same code): a realistic page, a deterministic
// OpenAI-compatible embeddings server and a minimal GCS JSON API server.
import { once } from "node:events";
import http from "node:http";

export const PAGE_MARKDOWN = `# Acme Widgets

Acme builds industrial widgets for factories around the world.

## Pricing

The Starter plan costs $19 per month and includes 1,000 widgets.
The Enterprise plan is billed annually with volume discounts.

| Plan | Monthly fee | Widgets |
| --- | --- | --- |
| Starter | $19 | 1,000 |
| Growth | $99 | 10,000 |

## Installation

- Download the installer from the releases page.
- Run the installer with administrator rights.

\`\`\`bash
npm install acme-widgets
acme init --region eu
\`\`\`

## Company history

Acme was founded in 1952 in Ohio by two engineers.
`;

export const PAGE_HTML = `<!doctype html><html><head><title>Docs</title><script>var x = 1;</script></head>
<body><nav>Home | About</nav><main>
<h1>Rate limits</h1>
<p>Each API key may send 500 requests per minute. Bursts above that receive HTTP 429.</p>
<h2>Retries</h2>
<p>Clients should retry with exponential backoff after a 429 response.</p>
<p>Our office dog is named Biscuit.</p>
</main></body></html>`;

// Concept table for the fake embedding model: words in the same group map to
// the same dimension, so "cost" and "price" are semantically close even though
// BM25 sees no shared term.
const CONCEPTS = [
  ["cost", "costs", "price", "pricing", "fee", "billed", "plan", "monthly", "$19", "$99", "expensive", "cheap"],
  ["install", "installer", "installation", "setup", "npm", "download", "init"],
  ["founded", "history", "1952", "origin", "started"],
  ["limit", "limits", "throttle", "throttling", "429", "requests", "minute", "quota"],
  ["retry", "retries", "backoff", "again"],
  ["dog", "pet", "biscuit"],
];

export function fakeVector(text) {
  const vector = new Array(CONCEPTS.length + 1).fill(0);
  vector[CONCEPTS.length] = 0.05; // small shared component, avoids zero vectors
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}$]+/gu) ?? []) {
    CONCEPTS.forEach((group, dim) => {
      if (group.includes(word)) vector[dim] += 1;
    });
  }
  return vector;
}

async function listen(handler, host) {
  const server = http.createServer(handler);
  server.listen(0, host);
  await once(server, "listening");
  const { port } = server.address();
  return { server, port };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * @param {{ failWith?: number, delayMs?: number, apiKey?: string, host?: string }} options
 */
export async function startFakeEmbeddings(options = {}) {
  const requests = [];
  const { server, port } = await listen(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url ?? "", headers: req.headers, body });
    if (options.delayMs) await new Promise(r => setTimeout(r, options.delayMs));
    if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (options.failWith) {
      res.writeHead(options.failWith, { "content-type": "application/json" }).end('{"error":"boom"}');
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404).end();
      return;
    }
    const inputs = body.input;
    // Respond out of order to prove the client honours `index`.
    const data = inputs.map((input, index) => ({ object: "embedding", index, embedding: fakeVector(input) })).reverse();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", model: body.model, data }));
  }, options.host ?? "127.0.0.1");
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

export const INDEX_BUCKET = "community-index";
export const INDEX_OBJECTS = {
  "11111111-1111-4111-8111-111111111111.json": {
    url: "https://acme.test/",
    html: "<html><body><main><h1>Acme Widgets</h1><p>Acme was founded in 1952 in Ohio by two engineers.</p><p>Widgets ship worldwide.</p></main></body></html>",
    statusCode: 200,
  },
  "22222222-2222-4222-8222-222222222222.json": {
    url: "https://docs.test/rate-limits",
    html: PAGE_HTML,
    statusCode: 200,
  },
  "33333333-3333-4333-8333-333333333333.json": {
    url: "https://gone.test/",
    html: "<html><body>Not found</body></html>",
    statusCode: 404,
  },
};

/**
 * Minimal `GET /storage/v1/b/{bucket}/o/{object}?alt=media` implementation.
 * `server-error.json` always returns HTTP 500.
 * @param {{ token?: string, host?: string }} options
 */
export async function startFakeGcs(options = {}) {
  const requests = [];
  const { server, port } = await listen((req, res) => {
    requests.push({ path: req.url ?? "", headers: req.headers });
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401).end();
      return;
    }
    const match = /^\/storage\/v1\/b\/([^/]+)\/o\/([^?]+)\?alt=media$/.exec(req.url ?? "");
    if (!match || decodeURIComponent(match[1]) !== INDEX_BUCKET) {
      res.writeHead(404).end();
      return;
    }
    const name = decodeURIComponent(match[2]);
    if (name === "server-error.json") {
      res.writeHead(500).end("broken");
      return;
    }
    if (!(name in INDEX_OBJECTS)) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"code":404,"message":"No such object"}}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(INDEX_OBJECTS[name]));
  }, options.host ?? "127.0.0.1");
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
