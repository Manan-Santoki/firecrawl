# Firecrawl Community highlight service

Provider-neutral implementation of the query-highlight contract that upstream Firecrawl calls through `HIGHLIGHT_MODEL_URL`. Upstream points that variable at a private model service. This service ranks page passages against the query with BM25 and, optionally, any OpenAI-compatible embeddings endpoint. It returns verbatim spans in the response shape the API expects.

## Implemented contract

The contract source is upstream tag `v2.11.739`, `apps/api/src/search/highlight-model.ts` and `apps/api/src/search/highlights.ts`. Those files are byte-identical on this fork's `main`.

| Endpoint | Request | Response | Upstream caller |
| --- | --- | --- | --- |
| `POST /batch_highlight_indexed` | `{query, pages: [{id, url, indexObject}]}` | `{pages: [{id, output: {highlights, markdown}}]}` | `/v2/search` result excerpts (`runIndexedSearchHighlights`) |
| `POST /batch_highlight` | `{query, pages: [{id, markdown}]}` | same as above | `generateHighlightsBatch` (exported; no production caller at v2.11.739) |
| `POST /highlight` | `{query, markdown}` | `{highlights, markdown}` | legacy per-page fallback after a 400/404 from `/batch_highlight` |
| `GET /health/liveness`, `GET /health/readiness` | | ranking mode, embeddings model, indexed endpoint enabled | Compose health check |

- **Auth:** when `HIGHLIGHT_SERVICE_TOKEN` is set, every route except the health routes requires `Authorization: Bearer <token>`. The API sends this header when `HIGHLIGHT_MODEL_TOKEN` is set. `X-Request-ID` is logged.
- **Highlight entries:** `{block_index, kind, via, score, span_md}`.
  - `block_index` indexes the output of upstream's `parseMarkdownToSentences`. That splitter is ported unchanged in `src/spans.ts`.
  - `kind` is `heading | text | code | table`.
  - `via` is `bm25 | embedding | hybrid`.
  - `score` is in `0..1`.
  - `span_md` is the span text.
- **Reassembled markdown:** `markdown` holds the selected spans reassembled in document order by upstream's `assembleAnswer`. A selected table row brings in its table header, adjacent code lines are rebuilt as a fenced block, and same-paragraph sentences are joined. The API copies `markdown` into the search result's `description` (or `snippet` for news results).
- **When pages are left out:** a page is omitted from the response if it has no index object, its index entry recorded a non-2xx status, or it fails to load. An empty `markdown` is returned when nothing is relevant enough. In either case the API keeps that result's provider snippet.
- **Failure responses:** the whole request fails with `502` only when no index object at all can be loaded, and with `503` when `/batch_highlight_indexed` is called without an index bucket configured. The API then keeps every provider snippet.

## Ranking

1. **Split the page.** Markdown is split into upstream's candidate spans: sentences of paragraphs and list items, headings, individual table rows (each with its header) and individual code lines.
2. **Lexical score.** Each span gets an Okapi BM25 score (k1 = 1.2, b = 0.75) against the query, computed within its page. The tokenizer is Unicode-aware, drops stopwords and does light stemming.
3. **Semantic score (optional).** When an embeddings endpoint is configured, the query and a bounded set of candidate spans are embedded in one request.
   - Candidates are the strongest lexical matches first, then the remaining substantive spans in document order. Duplicate text is skipped.
   - Each span is embedded with its nearest heading as context.
   - Cosine similarity is standardised against every candidate in the request: a span two standard deviations above the request mean scores 1. Raw cosine ranges are model-specific. Because search sends all result pages in one call, a page that is unrelated to the query scores low as a whole.
4. **Blend.** `score = EMBEDDINGS_WEIGHT × semantic + (1 − EMBEDDINGS_WEIGHT) × BM25`. Without embeddings, the score is BM25 normalised per page. Headings and very short spans are down-weighted.
5. **Select.** Spans are taken in score order until one of these stops it: `MAX_HIGHLIGHTS` is reached, the score drops below `MIN_RELATIVE_SCORE` × the page's top score, the score drops below `MIN_SCORE`, or the total text would exceed `MAX_OUTPUT_CHARS`.
6. **Fall back to BM25 when embeddings fail.** If the embeddings call fails, times out or runs past `REQUEST_BUDGET_MS`, the request is answered with BM25 only. The warning is logged and `via` reports `bm25`.

## Index objects (`/batch_highlight_indexed`)

The API does not send page content to this endpoint. It sends the name of an index object, `{indexId}.json`. The API's scrape index writes these objects with `saveIndexToGCS` into `GCS_INDEX_BUCKET_NAME`, each containing `{url, html, statusCode, ...}`.

This service reads them through the public GCS JSON API (`GET /storage/v1/b/{bucket}/o/{object}?alt=media`), converts the HTML to markdown with Turndown plus GFM tables, and ranks the result. Supported storage:

- **Google Cloud Storage:** set `GCS_CREDENTIALS` to a base64 service-account JSON. This is the same format the API uses. Access tokens come from a read-only `devstorage.read_only` JWT exchange and are cached.
- **Emulators and gateways:** `fake-gcs-server` or any GCS-JSON-compatible gateway, via `STORAGE_EMULATOR_HOST` or `GCS_STORAGE_ENDPOINT`, with an optional static `GCS_STORAGE_TOKEN`.

## Turning the feature on in Firecrawl

`/v2/search` calls this service only when `highlightsEnvReady()` is true. That needs all three of the following on the API:

1. `HIGHLIGHT_MODEL_URL`: the URL of this service. The overlay sets it.
2. `INDEX_DATABASE_URL`: the scrape-index Postgres. The API looks up recent index rows through the `index_get_recent_5(...)` SQL function. The Drizzle table definitions are public in `apps/api/src/db/schema/index-db.ts`, but upstream does not publish that function or a migration for the index database. `community/docker-compose.index.yaml` provides both, plus a GCS-compatible bucket; see `community/migrations/index-db/README.md`.
3. `GCS_INDEX_BUCKET_NAME`: the bucket the API's index engine writes to and this service reads from. Set `GCS_CREDENTIALS` and/or `STORAGE_EMULATOR_HOST` on both the API and this service.

Each search request is also handled according to these rules:

- Highlights are applied when the request sets `"highlights": true`.
- They are always applied for MCP/CLI origins.
- For other requests, a stable `HIGHLIGHT_ROLLOUT_PERCENT` cohort applies them. The overlay defaults this to `100`.
- `"highlights": false` keeps provider snippets, and the service is still called in shadow mode.
- Zero-data-retention requests never call the service.

The scrape `highlights` format does **not** use this service. At v2.11.739 it is generated by the configured LLM (`performDirectQuoteQuery`).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HIGHLIGHT_SERVICE_TOKEN` | required | Bearer secret. Set the API's `HIGHLIGHT_MODEL_TOKEN` to the same value. |
| `ALLOW_INSECURE_NO_AUTH` | unset | `true` allows starting without a token (local development only). |
| `PORT` / `HOST` | `3007` / `0.0.0.0` | Listen address. |
| `EMBEDDINGS_BASE_URL` | unset | OpenAI-compatible base URL, e.g. `http://embeddings:8080/v1`; `POST {base}/embeddings` is called. Unset means BM25-only. |
| `EMBEDDINGS_MODEL` | required with base URL | Model name sent in the request. |
| `EMBEDDINGS_API_KEY` | unset | Optional bearer key for the embeddings endpoint. |
| `EMBEDDINGS_QUERY_PREFIX` / `EMBEDDINGS_DOCUMENT_PREFIX` | empty | Instruction prefixes for asymmetric models (e.g. `query: ` / `passage: ` for E5; `Represent this sentence for searching relevant passages: ` for BGE queries). |
| `EMBEDDINGS_DIMENSIONS` | unset | Optional `dimensions` request field. |
| `EMBEDDINGS_TIMEOUT_MS` | `2000` | Per embeddings HTTP call. |
| `EMBEDDINGS_BATCH_SIZE` | `64` | Inputs per embeddings call (calls run in parallel). |
| `EMBEDDINGS_MAX_INPUTS` | `256` | Maximum spans embedded per request, across all pages. |
| `EMBEDDINGS_MAX_INPUT_CHARS` | `1000` | Truncation per embedded input. |
| `EMBEDDINGS_WEIGHT` | `0.65` | Semantic weight in the hybrid blend. |
| `EMBEDDINGS_MIN_SIMILARITY` | `0` | Absolute cosine floor for semantic credit (model-specific). |
| `REQUEST_BUDGET_MS` | `2500` | Deadline for the embeddings stage; afterwards BM25 answers. Keep it below the API's 3000 ms indexed-highlight timeout. |
| `MAX_PAGES_PER_REQUEST` | `32` | Further pages are omitted (they keep provider snippets). |
| `MAX_BODY_BYTES` | `16777216` | JSON body limit. |
| `MAX_QUERY_CHARS` | `2000` | Longer queries are rejected with `400`. |
| `MAX_MARKDOWN_CHARS` | `300000` | Per page; longer pages are truncated at a line boundary. |
| `MAX_SPANS_PER_PAGE` | `4000` | Spans considered per page. |
| `MAX_HIGHLIGHTS` / `MAX_OUTPUT_CHARS` | `5` / `1500` | Output bounds per page. |
| `MIN_RELATIVE_SCORE` / `MIN_SCORE` | `0.5` / `0.3` | Selection thresholds (see Ranking). |
| `GCS_INDEX_BUCKET_NAME` | unset | Enables `/batch_highlight_indexed`. |
| `GCS_CREDENTIALS` | unset | Base64 service-account JSON for Google Cloud Storage. |
| `STORAGE_EMULATOR_HOST` / `GCS_STORAGE_ENDPOINT` | `https://storage.googleapis.com` | GCS-compatible endpoint override. |
| `GCS_STORAGE_TOKEN` | unset | Static bearer token for the storage endpoint. |
| `INDEX_FETCH_TIMEOUT_MS` / `INDEX_FETCH_CONCURRENCY` / `INDEX_MAX_OBJECT_BYTES` | `1500` / `8` / `8388608` | Index object read bounds. |

The service never contacts Firecrawl Cloud. It makes outbound calls only to the configured embeddings endpoint and storage endpoint.

## Development

```bash
pnpm install
pnpm test        # unit tests + in-process contract tests (fake embeddings and GCS servers)
pnpm build
docker build -t firecrawl-highlight-service-community:dev .
HIGHLIGHT_IMAGE=firecrawl-highlight-service-community:dev pnpm test:container
```

`test/contract-cases.mjs` reproduces the API client's request headers, request bodies and response acceptance rules. The same cases run in-process and against the built image. They cover hybrid, BM25-only and failed-embeddings modes, with and without an index bucket. `test/smoke.mjs` prints excerpts from a running instance so you can judge quality against a real embeddings model.
