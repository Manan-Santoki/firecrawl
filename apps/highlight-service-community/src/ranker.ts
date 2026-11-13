import { bm25Scores } from "./bm25.js";
import { cosine, type Embedder } from "./embeddings.js";
import { assembleAnswer, parseMarkdownToSentences, type Sentence, type SentenceSource } from "./spans.js";

/** One entry of the upstream highlight contract (`Highlight` in highlight-model.ts). */
export interface Highlight {
  block_index: number;
  kind: SentenceSource;
  via: "bm25" | "embedding" | "hybrid";
  score: number;
  span_md: string;
}

/** Per-page output of the upstream contract (`HighlightResponse`). */
export interface HighlightOutput {
  highlights: Highlight[];
  markdown: string;
}

export interface RankerOptions {
  maxMarkdownChars: number;
  maxSpansPerPage: number;
  maxHighlights: number;
  maxOutputChars: number;
  minRelativeScore: number;
  minScore: number;
  embeddings?: {
    embedder: Embedder;
    maxInputs: number;
    maxInputChars: number;
    queryPrefix: string;
    documentPrefix: string;
    weight: number;
    minSimilarity: number;
  };
}

export interface RankResult {
  outputs: HighlightOutput[];
  mode: "hybrid" | "bm25";
  embeddingsError?: string;
}

interface PreparedPage {
  sentences: Sentence[];
  /** Nearest preceding heading per span, used as embedding context. */
  headings: Array<string | undefined>;
  bm25: number[];
  bm25Max: number;
  candidates: number[];
}

const EMPTY: HighlightOutput = { highlights: [], markdown: "" };

function truncateMarkdown(markdown: string, max: number): string {
  if (markdown.length <= max) return markdown;
  const cut = markdown.lastIndexOf("\n", max);
  return markdown.slice(0, cut > max * 0.8 ? cut : max);
}

/** Spans that make poor standalone excerpts are down-weighted, not excluded. */
function shapeWeight(sentence: Sentence): number {
  if (sentence.source === "heading") return 0.6;
  if (sentence.source !== "table" && sentence.text.length < 20) return 0.6;
  return 1;
}

function prepare(query: string, markdown: string, options: RankerOptions): PreparedPage {
  const sentences = parseMarkdownToSentences(truncateMarkdown(markdown, options.maxMarkdownChars)).slice(
    0,
    options.maxSpansPerPage,
  );
  const headings: Array<string | undefined> = [];
  let currentHeading: string | undefined;
  for (const sentence of sentences) {
    if (sentence.source === "heading") currentHeading = sentence.text;
    headings.push(sentence.source === "heading" ? undefined : currentHeading);
  }
  const bm25 = bm25Scores(
    query,
    sentences.map(s => s.text),
  );
  return { sentences, headings, bm25, bm25Max: Math.max(0, ...bm25), candidates: [] };
}

/**
 * Choose which spans of a page get embedded: the strongest lexical matches
 * first (they are the likeliest answers), then the remaining substantive spans
 * in document order so purely semantic matches are still discoverable.
 */
function chooseCandidates(page: PreparedPage, budget: number): number[] {
  if (budget <= 0) return [];
  const chosen = new Set<number>();
  // Repeated boilerplate (menus, repeated headings) must not consume the budget.
  const seenText = new Set<string>();
  const take = (index: number) => {
    const text = page.sentences[index]!.text;
    if (seenText.has(text)) return;
    seenText.add(text);
    chosen.add(index);
  };
  const lexical = page.bm25
    .map((score, index) => ({ score, index }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const { index } of lexical) {
    if (chosen.size >= budget) break;
    take(index);
  }
  for (let index = 0; index < page.sentences.length && chosen.size < budget; index++) {
    const sentence = page.sentences[index]!;
    if (sentence.source === "heading" || sentence.text.length < 30) continue;
    take(index);
  }
  return [...chosen].sort((a, b) => a - b);
}

function select(
  page: PreparedPage,
  scores: Array<{ index: number; score: number; via: Highlight["via"] }>,
  options: RankerOptions,
): HighlightOutput {
  const ranked = scores.filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const top = ranked[0];
  if (!top) return EMPTY;

  const picked: typeof ranked = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const candidate of ranked) {
    if (picked.length >= options.maxHighlights) break;
    if (candidate.score < top.score * options.minRelativeScore || candidate.score < options.minScore) break;
    const text = page.sentences[candidate.index]!.text;
    if (seen.has(text)) continue;
    if (picked.length > 0 && chars + text.length > options.maxOutputChars) continue;
    seen.add(text);
    picked.push(candidate);
    chars += text.length;
  }

  picked.sort((a, b) => a.index - b.index);
  return {
    highlights: picked.map(p => {
      const sentence = page.sentences[p.index]!;
      return {
        block_index: p.index,
        kind: sentence.source,
        via: p.via,
        score: Math.round(p.score * 10_000) / 10_000,
        span_md: sentence.text,
      };
    }),
    markdown: assembleAnswer(
      page.sentences,
      picked.map(p => p.index),
    ),
  };
}

function lexicalOnly(page: PreparedPage, options: RankerOptions): HighlightOutput {
  if (page.bm25Max <= 0) return EMPTY;
  return select(
    page,
    page.bm25.map((score, index) => ({
      index,
      score: (score / page.bm25Max) * shapeWeight(page.sentences[index]!),
      via: "bm25" as const,
    })),
    options,
  );
}

interface SimilarityStats {
  mean: number;
  std: number;
  count: number;
}

/**
 * Raw cosine values are model specific (many models place every passage in
 * 0.5..0.9), so similarity is standardised against all candidates of the
 * request: a span two standard deviations above the request mean scores 1.
 * Because search sends every result page in one request, a page that is
 * unrelated to the query scores low as a whole instead of having its "least
 * bad" span promoted to a highlight.
 */
function semanticScore(similarity: number, stats: SimilarityStats): number {
  if (stats.count < 3) return 0.5;
  if (stats.std < 1e-6) return 0;
  return Math.min(1, Math.max(0, (similarity - stats.mean) / (2 * stats.std)));
}

function hybrid(
  page: PreparedPage,
  similarities: Map<number, number>,
  stats: SimilarityStats,
  options: RankerOptions,
  weight: number,
  minSimilarity: number,
): HighlightOutput {
  if (similarities.size === 0) return lexicalOnly(page, options);

  const scores = page.sentences.map((sentence, index) => {
    const lexical = page.bm25Max > 0 ? page.bm25[index]! / page.bm25Max : 0;
    const similarity = similarities.get(index);
    let semantic = 0;
    // An absolute cosine floor (EMBEDDINGS_MIN_SIMILARITY, default off) lets
    // operators reject spans that are unrelated for their specific model.
    if (similarity !== undefined && similarity >= minSimilarity) {
      semantic = semanticScore(similarity, stats);
    }
    const score = (weight * semantic + (1 - weight) * lexical) * shapeWeight(sentence);
    const via: Highlight["via"] = semantic > 0 && lexical > 0 ? "hybrid" : semantic > 0 ? "embedding" : "bm25";
    return { index, score, via };
  });
  return select(page, scores, options);
}

/**
 * Rank every page of one request. All embedding work for the request is sent
 * as one bounded set of inputs; any embeddings failure degrades the whole
 * request to BM25 rather than failing it.
 */
export async function rankPages(
  query: string,
  markdowns: string[],
  options: RankerOptions,
  signal: AbortSignal,
): Promise<RankResult> {
  const pages = markdowns.map(markdown => prepare(query, markdown, options));
  const embeddings = options.embeddings;
  if (!embeddings || pages.every(p => p.sentences.length === 0)) {
    return { outputs: pages.map(p => lexicalOnly(p, options)), mode: "bm25" };
  }

  const perPage = Math.max(1, Math.floor((embeddings.maxInputs - 1) / Math.max(1, pages.length)));
  const inputs: string[] = [embeddings.queryPrefix + query.slice(0, embeddings.maxInputChars)];
  const inputIndex = new Map<string, number>();
  const refs: Array<Array<{ span: number; input: number }>> = pages.map(page => {
    page.candidates = chooseCandidates(page, perPage);
    return page.candidates.map(span => {
      const sentence = page.sentences[span]!;
      const heading = page.headings[span];
      const text = (
        embeddings.documentPrefix + (heading ? `${heading}: ${sentence.text}` : sentence.text)
      ).slice(0, embeddings.maxInputChars);
      let input = inputIndex.get(text);
      if (input === undefined) {
        input = inputs.length;
        inputs.push(text);
        inputIndex.set(text, input);
      }
      return { span, input };
    });
  });

  try {
    const vectors = await embeddings.embedder.embed(inputs, signal);
    const queryVector = vectors[0]!;
    const similarity = vectors.map(v => cosine(queryVector, v));
    const documentSims = similarity.slice(1);
    const mean = documentSims.reduce((a, b) => a + b, 0) / Math.max(1, documentSims.length);
    const variance = documentSims.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, documentSims.length);
    const stats: SimilarityStats = { mean, std: Math.sqrt(variance), count: documentSims.length };
    return {
      mode: "hybrid",
      outputs: pages.map((page, p) =>
        hybrid(
          page,
          new Map(refs[p]!.map(ref => [ref.span, similarity[ref.input]!])),
          stats,
          options,
          embeddings.weight,
          embeddings.minSimilarity,
        ),
      ),
    };
  } catch (error) {
    return {
      outputs: pages.map(p => lexicalOnly(p, options)),
      mode: "bm25",
      embeddingsError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}
