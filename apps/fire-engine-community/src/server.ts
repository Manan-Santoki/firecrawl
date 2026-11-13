import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { ScrapeError, sanitize } from "./errors.js";
import { scrapeRequestSchema, searchRequestSchema } from "./schema.js";
import type { ScrapeService } from "./scrape-service.js";
import type { SearchService } from "./search.js";

export interface CreateAppOptions {
  scrapes: Pick<ScrapeService, "run" | "startJob" | "jobStatus" | "deleteJob" | "limiter" | "jobCount">;
  search: Pick<SearchService, "web" | "v2" | "backend">;
  apiKey: string;
  stats?: () => Record<string, unknown>;
}

function sameSecret(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorMessage(error: unknown): string {
  if (error instanceof ScrapeError) return error.message;
  if (error instanceof ZodError) {
    return `Invalid request: ${error.issues
      .slice(0, 5)
      .map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ")}`;
  }
  return `Scrape failed: ${sanitize(error instanceof Error ? error.message : String(error))}`;
}

export function createApp({ scrapes, search, apiKey, stats }: CreateAppOptions) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health/liveness", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/health/readiness", (_req, res) =>
    res.status(200).json({
      ok: true,
      activeScrapes: scrapes.limiter.activeCount,
      queuedScrapes: scrapes.limiter.queuedCount,
      jobs: scrapes.jobCount,
      searchBackend: search.backend,
      ...(stats ? { browsers: stats() } : {}),
    }),
  );

  // Optional shared secret. The Firecrawl API's fire-engine client does not
  // send credentials, so the key can also be embedded as a path prefix in
  // FIRE_ENGINE_BETA_URL (http://fire-engine:3010/key/<secret>).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!apiKey) return next();
    const prefix = /^\/key\/([^/]+)(\/.*)?$/.exec(req.url);
    let provided = "";
    if (prefix) {
      provided = decodeURIComponent(prefix[1]!);
      req.url = prefix[2] ?? "/";
    } else if (req.headers.authorization?.startsWith("Bearer ")) {
      provided = req.headers.authorization.slice(7);
    } else if (typeof req.headers["x-api-key"] === "string") {
      provided = req.headers["x-api-key"];
    }
    if (!provided || !sameSecret(provided, apiKey)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  app.use(express.json({ limit: "8mb" }));

  app.post("/scrape", async (req, res) => {
    let request;
    try {
      request = scrapeRequestSchema.parse(req.body);
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) });
    }
    if (request.instantReturn === true) {
      const jobId = scrapes.startJob(request);
      return res.status(202).json({ jobId, processing: true });
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const result = await scrapes.run(request, controller.signal);
      if (!res.headersSent) res.status(200).json(result);
    } catch (error) {
      if (res.headersSent) return;
      const status = error instanceof ScrapeError ? error.httpStatus : 500;
      res.status(status).json({ error: errorMessage(error) });
    }
  });

  // Job polling. Failed jobs must answer HTTP 200: the API's poller treats
  // non-2xx as transport errors rather than as a terminal job state.
  app.get("/scrape/:jobId", (req, res) => {
    const status = scrapes.jobStatus(req.params.jobId);
    if (!status) {
      return res.status(200).json({
        jobId: req.params.jobId,
        state: "failed",
        processing: false,
        error: "Job not found or expired",
      });
    }
    res.status(200).json(status);
  });

  app.delete("/scrape/:jobId", (req, res) => {
    const deleted = scrapes.deleteJob(req.params.jobId);
    res.status(200).json({ success: true, deleted });
  });

  app.post("/search", async (req, res) => {
    try {
      const request = searchRequestSchema.parse(req.body);
      res.status(200).json(await search.web(request));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ error: errorMessage(error) });
      res.status(200).json([]);
    }
  });

  app.post("/v2/search", async (req, res) => {
    try {
      const request = searchRequestSchema.parse(req.body);
      res.status(200).json(await search.v2(request));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ error: errorMessage(error) });
      res.status(200).json({});
    }
  });

  app.post("/map", async (req, res) => {
    try {
      const request = searchRequestSchema.parse(req.body);
      res.status(200).json(await search.web(request));
    } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ error: errorMessage(error) });
      res.status(200).json([]);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number })?.status ?? 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: errorMessage(error) });
  });

  return app;
}
