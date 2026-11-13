// Okapi BM25 over the spans of a single page. Each span is a "document"; IDF is
// computed within the page, which rewards spans that contain the query's
// page-distinctive terms rather than terms repeated on every line.

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have how i in into is it its of on or " +
    "that the their there these this those to was were what when where which who why " +
    "will with you your do does did can could should would about vs not no"
  ).split(" "),
);

/** Light English suffix stripping so "pricing"/"prices"/"priced" share a stem. */
function stem(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  for (const suffix of ["ingly", "edly", "ing", "ies", "ied", "ed", "es", "ly", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      const base = token.slice(0, -suffix.length);
      return suffix === "ies" || suffix === "ied" ? base + "y" : base;
    }
  }
  return token;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const matches = text
    .normalize("NFKC")
    .toLowerCase()
    // Drop link targets so URLs do not dominate lexical matches.
    .replace(/\]\([^)]*\)/g, "]")
    .match(/[\p{L}\p{N}]+(?:[._+#-][\p{L}\p{N}]+)*/gu);
  if (!matches) return out;
  for (const raw of matches) {
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
    // Also index the parts of compound tokens ("gpt-4o", "node.js").
    if (/[._+#-]/.test(raw)) {
      for (const part of raw.split(/[._+#-]+/)) {
        if (part && part !== raw && !STOPWORDS.has(part)) out.push(stem(part));
      }
    }
  }
  return out;
}

export function bm25Scores(
  query: string,
  documents: string[],
  k1 = 1.2,
  b = 0.75,
): number[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || documents.length === 0) {
    return documents.map(() => 0);
  }

  const docs = documents.map(tokenize);
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      if (queryTerms.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const n = docs.length;
  return docs.map(doc => {
    if (doc.length === 0) return 0;
    const tf = new Map<string, number>();
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const d = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgLen));
    }
    return score;
  });
}
