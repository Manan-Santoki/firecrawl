// Environment configuration. Every limit has a bounded default so a single
// request cannot monopolise CPU, memory or the embeddings backend.

export interface ServiceConfig {
  host: string;
  port: number;
  /** Bearer secret shared with the API's HIGHLIGHT_MODEL_TOKEN. Empty disables auth. */
  token: string;
  maxBodyBytes: number;
  maxPages: number;
  maxQueryChars: number;
  maxMarkdownChars: number;
  maxSpansPerPage: number;
  maxHighlights: number;
  maxOutputChars: number;
  minRelativeScore: number;
  minScore: number;
  requestBudgetMs: number;
  embeddings: EmbeddingsConfig | null;
  indexStore: IndexStoreConfig | null;
}

export interface EmbeddingsConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  batchSize: number;
  maxInputs: number;
  maxInputChars: number;
  dimensions?: number;
  queryPrefix: string;
  documentPrefix: string;
  /** Weight of the semantic score in the hybrid blend; BM25 gets 1 - weight. */
  weight: number;
  minSimilarity: number;
}

export interface IndexStoreConfig {
  bucket: string;
  endpoint: string;
  /** Base64-encoded Google service-account JSON (same format as the API's GCS_CREDENTIALS). */
  credentials?: string;
  /** Static bearer token, e.g. for a proxy or emulator that requires one. */
  staticToken?: string;
  timeoutMs: number;
  maxObjectBytes: number;
  concurrency: number;
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function num(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): ServiceConfig {
  const token = str(env, "HIGHLIGHT_SERVICE_TOKEN") ?? "";
  if (!token && env.ALLOW_INSECURE_NO_AUTH !== "true") {
    throw new Error("HIGHLIGHT_SERVICE_TOKEN is required unless ALLOW_INSECURE_NO_AUTH=true");
  }

  const embeddingsBaseUrl = str(env, "EMBEDDINGS_BASE_URL");
  const embeddingsModel = str(env, "EMBEDDINGS_MODEL");
  if (embeddingsBaseUrl && !embeddingsModel) {
    throw new Error("EMBEDDINGS_MODEL is required when EMBEDDINGS_BASE_URL is set");
  }

  const bucket = str(env, "GCS_INDEX_BUCKET_NAME");
  const endpoint =
    str(env, "GCS_STORAGE_ENDPOINT") ??
    (str(env, "STORAGE_EMULATOR_HOST") ? normaliseEmulatorHost(str(env, "STORAGE_EMULATOR_HOST")!) : undefined) ??
    "https://storage.googleapis.com";

  return {
    host: str(env, "HOST") ?? "0.0.0.0",
    port: int(env, "PORT", 3007, 1, 65535),
    token,
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 16 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    maxPages: int(env, "MAX_PAGES_PER_REQUEST", 32, 1, 1000),
    maxQueryChars: int(env, "MAX_QUERY_CHARS", 2000, 16, 100_000),
    maxMarkdownChars: int(env, "MAX_MARKDOWN_CHARS", 300_000, 1000, 10_000_000),
    maxSpansPerPage: int(env, "MAX_SPANS_PER_PAGE", 4000, 10, 100_000),
    maxHighlights: int(env, "MAX_HIGHLIGHTS", 5, 1, 100),
    maxOutputChars: int(env, "MAX_OUTPUT_CHARS", 1500, 100, 100_000),
    minRelativeScore: num(env, "MIN_RELATIVE_SCORE", 0.5, 0, 1),
    minScore: num(env, "MIN_SCORE", 0.3, 0, 1),
    requestBudgetMs: int(env, "REQUEST_BUDGET_MS", 2500, 100, 600_000),
    embeddings:
      embeddingsBaseUrl && embeddingsModel
        ? {
            baseUrl: embeddingsBaseUrl.replace(/\/+$/, ""),
            model: embeddingsModel,
            apiKey: str(env, "EMBEDDINGS_API_KEY"),
            timeoutMs: int(env, "EMBEDDINGS_TIMEOUT_MS", 2000, 50, 600_000),
            batchSize: int(env, "EMBEDDINGS_BATCH_SIZE", 64, 1, 2048),
            maxInputs: int(env, "EMBEDDINGS_MAX_INPUTS", 256, 1, 100_000),
            maxInputChars: int(env, "EMBEDDINGS_MAX_INPUT_CHARS", 1000, 16, 100_000),
            dimensions: str(env, "EMBEDDINGS_DIMENSIONS")
              ? int(env, "EMBEDDINGS_DIMENSIONS", 0, 1, 100_000)
              : undefined,
            queryPrefix: env.EMBEDDINGS_QUERY_PREFIX ?? "",
            documentPrefix: env.EMBEDDINGS_DOCUMENT_PREFIX ?? "",
            weight: num(env, "EMBEDDINGS_WEIGHT", 0.65, 0, 1),
            minSimilarity: num(env, "EMBEDDINGS_MIN_SIMILARITY", 0, -1, 1),
          }
        : null,
    indexStore: bucket
      ? {
          bucket,
          endpoint: endpoint.replace(/\/+$/, ""),
          credentials: str(env, "GCS_CREDENTIALS"),
          staticToken: str(env, "GCS_STORAGE_TOKEN"),
          timeoutMs: int(env, "INDEX_FETCH_TIMEOUT_MS", 1500, 50, 600_000),
          maxObjectBytes: int(env, "INDEX_MAX_OBJECT_BYTES", 8 * 1024 * 1024, 1024, 512 * 1024 * 1024),
          concurrency: int(env, "INDEX_FETCH_CONCURRENCY", 8, 1, 256),
        }
      : null,
  };
}

function normaliseEmulatorHost(host: string): string {
  return /^https?:\/\//.test(host) ? host : `http://${host}`;
}
