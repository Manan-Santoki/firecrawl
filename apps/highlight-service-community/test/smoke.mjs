// Manual smoke check against a running service, e.g. one configured with a
// real embeddings backend. Prints the excerpts so a human can judge quality.
//
//   HIGHLIGHT_URL=http://127.0.0.1:3007 HIGHLIGHT_TOKEN=... node test/smoke.mjs
import { PAGE_MARKDOWN } from "./fakes.mjs";

const base = (process.env.HIGHLIGHT_URL ?? "http://127.0.0.1:3007").replace(/\/$/, "");
const token = process.env.HIGHLIGHT_TOKEN ?? "";

const PYTHON = `# Python (programming language)

Python is a high-level, general-purpose programming language. Its design philosophy emphasizes code readability with the use of significant indentation.

## History

Python was conceived in the late 1980s by Guido van Rossum at Centrum Wiskunde & Informatica (CWI) in the Netherlands. Python 2.0 was released in 2000. Python 3.0, released in 2008, was a major revision not completely backward-compatible with earlier versions.

## Design

Python is dynamically typed and garbage-collected. It supports multiple programming paradigms, including structured, object-oriented and functional programming.

## Popularity

Python consistently ranks as one of the most popular programming languages and has gained widespread use in the machine learning community.
`;

async function call(query, pages, show = pages.length) {
  const started = Date.now();
  const headers = { "Content-Type": "application/json", "X-Request-ID": "smoke" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/batch_highlight`, { method: "POST", headers, body: JSON.stringify({ query, pages }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log(`\n### ${query}  (${Date.now() - started} ms, ${pages.length} pages)`);
  for (const page of data.pages.slice(0, show)) {
    const marks = page.output.highlights.map(h => `${h.via}:${h.score}`).join(" ");
    console.log(`[${page.id}] ${marks}\n${page.output.markdown || "(empty: API keeps provider snippet)"}`);
  }
}

const pages = [
  { id: "acme", markdown: PAGE_MARKDOWN },
  { id: "python", markdown: PYTHON },
];
await call("how much does it cost", pages);
await call("who created python and when", pages);
await call("is python good for AI", pages);
await call("how do I set it up", pages);
const large = Array.from({ length: 20 }, (_, i) => ({ id: String(i), markdown: `${PYTHON}\n\n${PAGE_MARKDOWN}`.repeat(20) }));
await call("who created python", large, 1);
