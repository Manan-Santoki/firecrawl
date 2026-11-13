import assert from "node:assert/strict";
import test from "node:test";
import { bm25Scores, tokenize } from "../src/bm25.js";
import { loadConfig } from "../src/config.js";
import { cosine, type Embedder } from "../src/embeddings.js";
import { htmlToMarkdown } from "../src/index-store.js";
import { rankPages, type RankerOptions } from "../src/ranker.js";
import { parseMarkdownToSentences } from "../src/spans.js";
import { fakeVector, PAGE_HTML, PAGE_MARKDOWN } from "./fakes.mjs";

const base: RankerOptions = {
  maxMarkdownChars: 300_000,
  maxSpansPerPage: 4000,
  maxHighlights: 3,
  maxOutputChars: 1500,
  minRelativeScore: 0.5,
  minScore: 0.3,
};

const fakeEmbedder: Embedder = {
  description: "fake",
  async embed(inputs) {
    return inputs.map(fakeVector);
  },
};

function withEmbeddings(embedder: Embedder, overrides: Partial<NonNullable<RankerOptions["embeddings"]>> = {}) {
  return {
    ...base,
    embeddings: {
      embedder,
      maxInputs: 256,
      maxInputChars: 1000,
      queryPrefix: "",
      documentPrefix: "",
      weight: 0.65,
      minSimilarity: 0,
      ...overrides,
    },
  };
}

const signal = () => AbortSignal.timeout(5000);

test("splitter yields upstream span kinds for paragraphs, lists, tables and code", () => {
  const spans = parseMarkdownToSentences(PAGE_MARKDOWN);
  const kinds = new Set(spans.map(s => s.source));
  assert.deepEqual([...kinds].sort(), ["code", "heading", "table", "text"]);
  assert.ok(spans.some(s => s.text === "Download the installer from the releases page."));
  assert.ok(spans.some(s => s.source === "table" && s.isHeader && s.text === "Plan | Monthly fee | Widgets"));
  assert.ok(spans.some(s => s.source === "code" && s.text === "npm install acme-widgets"));
});

test("tokenizer stems, drops stopwords and splits compounds", () => {
  assert.deepEqual(tokenize("How is the pricing?"), ["pric"]);
  assert.ok(tokenize("acme-widgets").includes("widget"));
});

test("bm25 favours the span containing rare query terms", () => {
  const scores = bm25Scores("founded ohio", ["Acme sells widgets.", "Acme was founded in Ohio.", "Widgets everywhere."]);
  assert.equal(scores.indexOf(Math.max(...scores)), 1);
  assert.deepEqual(bm25Scores("", ["x"]), [0]);
});

test("BM25-only mode returns verbatim spans, contract fields and reassembled markdown", async () => {
  const { outputs, mode } = await rankPages("when was acme founded", [PAGE_MARKDOWN], base, signal());
  assert.equal(mode, "bm25");
  const output = outputs[0]!;
  const spans = parseMarkdownToSentences(PAGE_MARKDOWN);
  assert.ok(output.highlights.length >= 1);
  for (const h of output.highlights) {
    assert.equal(spans[h.block_index]!.text, h.span_md, "block_index addresses the returned span");
    assert.equal(h.kind, spans[h.block_index]!.source);
    assert.equal(h.via, "bm25");
    assert.ok(h.score > 0 && h.score <= 1);
  }
  assert.match(output.markdown, /founded in 1952 in Ohio/);
  const sorted = [...output.highlights].sort((a, b) => a.block_index - b.block_index);
  assert.deepEqual(output.highlights, sorted, "highlights are in document order");
});

test("table rows pull in their header when reassembled", async () => {
  const { outputs } = await rankPages("growth tier widgets", [PAGE_MARKDOWN], { ...base, maxHighlights: 1 }, signal());
  assert.match(outputs[0]!.markdown, /^\| Plan \| Monthly fee \| Widgets \|\n\| --- \| --- \| --- \|\n\| Growth \| \$99 \| 10,000 \|$/);
});

test("no lexical match in BM25-only mode yields an empty result so the API keeps its snippet", async () => {
  const { outputs } = await rankPages("quantum chromodynamics", [PAGE_MARKDOWN, ""], base, signal());
  assert.deepEqual(outputs, [
    { highlights: [], markdown: "" },
    { highlights: [], markdown: "" },
  ]);
});

test("hybrid mode finds semantic matches with no shared terms", async () => {
  const query = "how expensive is it";
  const lexical = await rankPages(query, [PAGE_MARKDOWN], base, signal());
  assert.equal(lexical.outputs[0]!.highlights.length, 0);

  const semantic = await rankPages(query, [PAGE_MARKDOWN], withEmbeddings(fakeEmbedder), signal());
  assert.equal(semantic.mode, "hybrid");
  const output = semantic.outputs[0]!;
  assert.ok(output.highlights.length > 0);
  assert.ok(output.highlights.every(h => h.via === "embedding"));
  assert.match(output.markdown, /\$19|\$99|billed/);
  assert.doesNotMatch(output.markdown, /1952/);
});

test("embeddings failure degrades the request to BM25 instead of failing", async () => {
  const failing: Embedder = {
    description: "failing",
    async embed() {
      throw new Error("connection refused");
    },
  };
  const result = await rankPages("when was acme founded", [PAGE_MARKDOWN], withEmbeddings(failing), signal());
  assert.equal(result.mode, "bm25");
  assert.match(result.embeddingsError ?? "", /connection refused/);
  assert.match(result.outputs[0]!.markdown, /1952/);
});

test("embedding inputs are bounded across all pages of a request", async () => {
  let seen = 0;
  const counting: Embedder = {
    description: "counting",
    async embed(inputs) {
      seen = inputs.length;
      return inputs.map(fakeVector);
    },
  };
  const pages = Array.from({ length: 10 }, (_, i) => PAGE_MARKDOWN + `\nUnique paragraph number ${i} about widgets.\n`);
  await rankPages("widget pricing", pages, withEmbeddings(counting, { maxInputs: 21 }), signal());
  assert.ok(seen <= 21, `sent ${seen} inputs`);
});

test("output size and highlight count are bounded", async () => {
  const long = Array.from({ length: 50 }, (_, i) => `Widget fact ${i}: widgets are useful and widgets are durable.`).join("\n\n");
  const { outputs } = await rankPages("widgets", [long], { ...base, maxHighlights: 4, maxOutputChars: 150 }, signal());
  const output = outputs[0]!;
  assert.ok(output.highlights.length >= 1 && output.highlights.length <= 4);
  assert.ok(output.highlights.reduce((n, h) => n + h.span_md.length, 0) <= 150);
});

test("html index objects convert to markdown without scripts or navigation", () => {
  const markdown = htmlToMarkdown(PAGE_HTML);
  assert.match(markdown, /^# Rate limits/m);
  assert.match(markdown, /500 requests per minute/);
  assert.doesNotMatch(markdown, /var x|Home \| About/);
});

test("cosine similarity", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("config requires auth unless explicitly disabled and validates embeddings", () => {
  assert.throws(() => loadConfig({}), /HIGHLIGHT_SERVICE_TOKEN/);
  assert.equal(loadConfig({ ALLOW_INSECURE_NO_AUTH: "true" }).embeddings, null);
  assert.throws(
    () => loadConfig({ HIGHLIGHT_SERVICE_TOKEN: "t", EMBEDDINGS_BASE_URL: "http://e/v1" }),
    /EMBEDDINGS_MODEL/,
  );
  const config = loadConfig({
    HIGHLIGHT_SERVICE_TOKEN: "t",
    EMBEDDINGS_BASE_URL: "http://embeddings:8080/v1/",
    EMBEDDINGS_MODEL: "bge-small",
    GCS_INDEX_BUCKET_NAME: "index",
    STORAGE_EMULATOR_HOST: "fake-gcs:4443",
  });
  assert.equal(config.embeddings?.baseUrl, "http://embeddings:8080/v1");
  assert.equal(config.indexStore?.endpoint, "http://fake-gcs:4443");
  assert.throws(() => loadConfig({ HIGHLIGHT_SERVICE_TOKEN: "t", MAX_HIGHLIGHTS: "0" }), /MAX_HIGHLIGHTS/);
});
