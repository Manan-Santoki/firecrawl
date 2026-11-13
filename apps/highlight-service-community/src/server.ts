import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { ServiceConfig } from "./config.js";
import type { Embedder } from "./embeddings.js";
import { IndexObjectError, type IndexStore } from "./index-store.js";
import { rankPages, type HighlightOutput, type RankerOptions } from "./ranker.js";

// HTTP surface matching upstream `apps/api/src/search/highlight-model.ts`:
//   POST /highlight                {query, markdown}            -> {highlights, markdown}
//   POST /batch_highlight          {query, pages:[{id,markdown}]} -> {pages:[{id, output}]}
//   POST /batch_highlight_indexed  {query, pages:[{id,url,indexObject}]} -> {pages:[{id, output}]}
// Pages that cannot be processed are omitted, which the API treats as "keep the
// provider snippet" for that result only.

export interface AppDependencies {
  config: ServiceConfig;
  embedder: Embedder | null;
  indexStore: IndexStore | null;
  log?: (entry: Record<string, unknown>) => void;
}

const defaultLog = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));

function sameSecret(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApp({ config, embedder, indexStore, log = defaultLog }: AppDependencies) {
  const query = z.string().trim().min(1).max(config.maxQueryChars);
  const markdown = z.string().max(config.maxMarkdownChars * 4);
  const pageId = z.string().min(1).max(256);
  const singleSchema = z.object({ query, markdown });
  const batchSchema = z.object({
    query,
    pages: z.array(z.object({ id: pageId, markdown })).max(1000),
  });
  const indexedSchema = z.object({
    query,
    pages: z
      .array(z.object({ id: pageId, url: z.string().max(8192).optional(), indexObject: z.string().min(1).max(1024) }))
      .max(1000),
  });

  const rankerOptions: RankerOptions = {
    maxMarkdownChars: config.maxMarkdownChars,
    maxSpansPerPage: config.maxSpansPerPage,
    maxHighlights: config.maxHighlights,
    maxOutputChars: config.maxOutputChars,
    minRelativeScore: config.minRelativeScore,
    minScore: config.minScore,
    embeddings:
      embedder && config.embeddings
        ? {
            embedder,
            maxInputs: config.embeddings.maxInputs,
            maxInputChars: config.embeddings.maxInputChars,
            queryPrefix: config.embeddings.queryPrefix,
            documentPrefix: config.embeddings.documentPrefix,
            weight: config.embeddings.weight,
            minSimilarity: config.embeddings.minSimilarity,
          }
        : undefined,
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.maxBodyBytes }));

  app.get("/health/liveness", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/health/readiness", (_req, res) =>
    res.status(200).json({
      ok: true,
      ranking: embedder ? "hybrid" : "bm25",
      embeddings: embedder?.description ?? null,
      indexedEndpoint: indexStore !== null,
    }),
  );

  app.use((req, res, next) => {
    if (!config.token) return next();
    const authorization = req.headers.authorization;
    const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!provided || !sameSecret(provided, config.token)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  async function rank(
    req: Request,
    endpoint: string,
    queryText: string,
    markdowns: string[],
    signal: AbortSignal,
    extra: Record<string, unknown> = {},
  ): Promise<HighlightOutput[]> {
    const start = Date.now();
    const result = await rankPages(queryText, markdowns, rankerOptions, signal);
    log({
      level: result.embeddingsError ? "warn" : "info",
      message: "highlights ranked",
      endpoint,
      requestId: req.get("x-request-id"),
      pages: markdowns.length,
      returned: result.outputs.filter(o => o.highlights.length > 0).length,
      mode: result.mode,
      ...(result.embeddingsError ? { embeddingsError: result.embeddingsError } : {}),
      ...extra,
      elapsedMs: Date.now() - start,
    });
    return result.outputs;
  }

  function budgetSignal(res: Response): AbortSignal {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("request budget exhausted")), config.requestBudgetMs);
    res.on("close", () => {
      clearTimeout(timer);
      controller.abort(new Error("client closed request"));
    });
    return controller.signal;
  }

  app.post("/highlight", async (req, res, next) => {
    try {
      const body = singleSchema.parse(req.body);
      const [output] = await rank(req, "/highlight", body.query, [body.markdown], budgetSignal(res));
      res.status(200).json(output);
    } catch (error) {
      next(error);
    }
  });

  app.post("/batch_highlight", async (req, res, next) => {
    try {
      const body = batchSchema.parse(req.body);
      const pages = body.pages.slice(0, config.maxPages);
      const outputs = await rank(
        req,
        "/batch_highlight",
        body.query,
        pages.map(p => p.markdown),
        budgetSignal(res),
        { dropped: body.pages.length - pages.length },
      );
      res.status(200).json({ pages: pages.map((page, i) => ({ id: page.id, output: outputs[i] })) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/batch_highlight_indexed", async (req, res, next) => {
    try {
      const body = indexedSchema.parse(req.body);
      if (!indexStore) {
        throw new HttpError(503, "indexed highlights require GCS_INDEX_BUCKET_NAME");
      }
      const signal = budgetSignal(res);
      const pages = body.pages.slice(0, config.maxPages);
      const loaded = await mapLimit(pages, config.indexStore?.concurrency ?? 8, async page => {
        try {
          return { page, markdown: await indexStore.loadMarkdown(page.indexObject, signal) };
        } catch (error) {
          return { page, markdown: null, error };
        }
      });
      const errors = loaded.filter(l => l.error !== undefined);
      if (pages.length > 0 && errors.length === pages.length) {
        const first = errors[0]!.error;
        log({
          level: "error",
          message: "index objects could not be loaded",
          requestId: req.get("x-request-id"),
          error: first instanceof Error ? first.message : String(first),
        });
        throw new HttpError(502, "index objects could not be loaded");
      }
      const available = loaded.filter((l): l is { page: (typeof pages)[number]; markdown: string } =>
        typeof l.markdown === "string" && l.markdown.trim() !== "",
      );
      const outputs = await rank(
        req,
        "/batch_highlight_indexed",
        body.query,
        available.map(l => l.markdown),
        signal,
        {
          requested: body.pages.length,
          indexMisses: loaded.length - available.length - errors.length,
          indexErrors: errors.length,
        },
      );
      res.status(200).json({
        pages: available.map((l, i) => ({ id: l.page.id, output: outputs[i] })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", issues: error.issues.slice(0, 10) });
    }
    const status =
      error instanceof HttpError
        ? error.status
        : typeof (error as { status?: unknown })?.status === "number" &&
            (error as { status: number }).status >= 400 &&
            (error as { status: number }).status < 500 &&
            !(error instanceof IndexObjectError)
          ? (error as { status: number }).status
          : 500;
    if (status >= 500) {
      log({
        level: "error",
        message: "highlight request failed",
        path: req.path,
        requestId: req.get("x-request-id"),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    res.status(status).json({ error: status >= 500 && !(error instanceof HttpError) ? "Internal error" : (error as Error).message });
  });

  return app;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
