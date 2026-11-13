import type { EmbeddingsConfig } from "./config.js";

export interface Embedder {
  /** Returns one vector per input, in input order. Throws on any failure. */
  embed(inputs: string[], signal: AbortSignal): Promise<number[][]>;
  readonly description: string;
}

export class EmbeddingsError extends Error {}

interface OpenAIEmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
}

/**
 * Client for any OpenAI-compatible `POST {base}/embeddings` endpoint (OpenAI,
 * vLLM, Ollama's /v1, text-embeddings-inference, infinity, LocalAI, ...).
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly description: string;

  constructor(private readonly config: EmbeddingsConfig) {
    this.description = `${config.model} via ${new URL(config.baseUrl).host}`;
  }

  async embed(inputs: string[], signal: AbortSignal): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const batches: string[][] = [];
    for (let i = 0; i < inputs.length; i += this.config.batchSize) {
      batches.push(inputs.slice(i, i + this.config.batchSize));
    }
    const results = await Promise.all(batches.map(batch => this.embedBatch(batch, signal)));
    return results.flat();
  }

  private async embedBatch(inputs: string[], parentSignal: AbortSignal): Promise<number[][]> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = AbortSignal.any([parentSignal, timeout]);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      input: inputs,
      encoding_format: "float",
    };
    if (this.config.dimensions) body.dimensions = this.config.dimensions;

    const response = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new EmbeddingsError(`embeddings HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = (await response.json()) as OpenAIEmbeddingsResponse;
    if (!Array.isArray(data.data) || data.data.length !== inputs.length) {
      throw new EmbeddingsError("embeddings response did not contain one vector per input");
    }
    const vectors: number[][] = new Array(inputs.length);
    data.data.forEach((item, position) => {
      const index = typeof item.index === "number" ? item.index : position;
      if (
        index < 0 ||
        index >= inputs.length ||
        !Array.isArray(item.embedding) ||
        item.embedding.length === 0 ||
        !item.embedding.every(v => typeof v === "number" && Number.isFinite(v))
      ) {
        throw new EmbeddingsError("embeddings response contained an invalid vector");
      }
      vectors[index] = item.embedding as number[];
    });
    for (let i = 0; i < vectors.length; i++) {
      if (!vectors[i]) throw new EmbeddingsError("embeddings response omitted an input");
    }
    return vectors;
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new EmbeddingsError("embedding dimensions differ");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
