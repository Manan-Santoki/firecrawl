import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AgentServiceConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { AgentRunner } from "./runner.js";
import { compileSchema } from "./schema.js";
import { exportSkill } from "./skill-export.js";
import type { JobStore } from "./store.js";
import { createExtractSchema, isTerminal, type AgentRun, type AgentThread } from "./types.js";

export type AppDeps = {
  config: AgentServiceConfig;
  store: JobStore;
  runner: Pick<AgentRunner, "pump" | "activeCount" | "cancelQueued">;
  logger: Logger;
};

const ZDR_EXPIRED = {
  success: false,
  code: "zdr_expired",
  error: "This run used zero data retention; its result has expired",
};

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf16le");
  const b = Buffer.from(expected, "utf16le");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ExtractV3AgentStatus as read by apps/api/src/lib/extract-v3-status.ts. */
export function toStatus(run: AgentRun) {
  const status = isTerminal(run) ? (run.state === "succeeded" ? "success" : "failed") : "processing";
  return {
    success: true as const,
    id: run.id,
    status,
    ...(status === "success" ? { data: run.data ?? null } : {}),
    ...(status === "failed"
      ? {
          error: run.error,
          ...(run.partial !== undefined ? { partial: run.partial } : {}),
          ...(run.partialSchemaValid !== undefined ? { partialSchemaValid: run.partialSchemaValid } : {}),
          ...(run.state === "credit_limit_reached" ? { stopReason: "credit_limit_reached" as const } : {}),
        }
      : {}),
    model: run.model,
    ...(run.effort ? { effort: run.effort } : {}),
    ...(run.safe !== undefined ? { safe: run.safe } : {}),
    threadId: run.threadId,
    threadTurn: run.threadTurn,
    mode: run.mode,
    ...(run.message !== undefined ? { message: run.message } : {}),
    ...(run.exchangeRequested ? { exchange: { enabled: false, paidCalls: 0, creditsUsed: null } } : {}),
    creditsUsed: run.creditsUsed,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    // Community additions: owner and start time, so a gateway without the
    // hosted job-access store can authorize status reads from this service.
    teamId: run.teamId,
    createdAt: run.createdAt,
    ...(run.zeroDataRetention && run.zeroDataRetentionMinutes
      ? { zeroDataRetentionMinutes: run.zeroDataRetentionMinutes }
      : {}),
  };
}

function threadRunStatus(run: AgentRun) {
  return run.state === "queued" ? "processing" : run.state;
}

async function renderThread(store: JobStore, thread: AgentThread, includeData: boolean) {
  const runs = [];
  for (const id of thread.runIds) {
    const run = await store.getRun(id);
    if (!run) continue;
    runs.push({
      id: run.id,
      turn: run.threadTurn,
      mode: run.mode,
      prompt: run.zeroDataRetention ? "" : run.prompt,
      ...(run.urls ? { urls: run.urls } : {}),
      ...(run.schema !== undefined ? { schema: run.schema } : {}),
      ...(run.effort ? { effort: run.effort } : {}),
      ...(run.safe !== undefined ? { safe: run.safe } : {}),
      status: threadRunStatus(run),
      createdAt: run.createdAt,
      finishedAt: run.completedAt ?? null,
      creditsUsed: isTerminal(run) ? run.creditsUsed : null,
      message: run.message ?? null,
      ...(includeData
        ? {
            data: run.data,
            ...(run.partial !== undefined ? { partial: run.partial, partialSchemaValid: run.partialSchemaValid } : {}),
            ...(run.state === "credit_limit_reached" ? { stopReason: "credit_limit_reached" } : {}),
          }
        : {}),
      suggestions: null,
      pendingApproval: null,
      exchange: run.exchangeRequested ? { enabled: false, paidCalls: 0, creditsUsed: null } : null,
    });
  }
  return {
    id: thread.id,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.activeRunId ? ("running" as const) : ("idle" as const),
    runs,
  };
}

export function createApp(deps: AppDeps) {
  const { config, store, logger } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/health/liveness", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/health/readiness", async (_req, res) => {
    const redis = await store.kv.ping();
    res.status(redis ? 200 : 503).json({ ok: redis, activeRuns: deps.runner.activeCount });
  });

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !secretMatches(token, config.interopSecret)) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }
    next();
  };

  const loadRun = async (req: Request, res: Response): Promise<AgentRun | null> => {
    const id = String(req.params.id);
    const run = await store.getRun(id);
    if (run) return run;
    if (await store.isZdrExpired(id)) res.status(410).json(ZDR_EXPIRED);
    else res.status(404).json({ success: false, error: "Agent job not found" });
    return null;
  };

  // POST /internal/extracts: start a run (apps/api/src/controllers/v2/agent.ts).
  app.post("/internal/extracts", auth, async (req, res) => {
    const parsed = createExtractSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid agent request", details: parsed.error.issues.slice(0, 10) });
      return;
    }
    const body = parsed.data;

    const existing = await store.getRun(body.id);
    if (existing) {
      if (existing.teamId !== body.teamId) {
        res.status(409).json({ success: false, error: "Run id already exists" });
        return;
      }
      res.json({ success: true, id: existing.id, threadId: existing.threadId, threadTurn: existing.threadTurn });
      return;
    }

    if (body.schema !== undefined && body.schema !== null) {
      try {
        compileSchema(body.schema);
      } catch (error) {
        res.status(400).json({ success: false, error: `Invalid JSON schema: ${(error as Error).message}` });
        return;
      }
    }
    if (body.zeroDataRetention && body.threadId) {
      res.status(400).json({ success: false, code: "zdr_threads_unsupported", error: "Agent threads are not supported with zero data retention." });
      return;
    }

    const now = new Date().toISOString();
    let thread: AgentThread;
    let previousMode: "extract" | "chat" | undefined;
    if (body.threadId) {
      const t = await store.getThread(body.threadId);
      if (!t || t.teamId !== body.teamId) {
        const expired = t === null && (await store.isThreadExpired(body.threadId));
        res.status(expired ? 410 : 404).json({ success: false, error: expired ? "Agent thread has expired" : "Agent thread not found" });
        return;
      }
      thread = t;
      const last = thread.runIds.length ? await store.getRun(thread.runIds[thread.runIds.length - 1]!) : null;
      previousMode = last?.mode;
    } else {
      thread = { id: randomUUID(), teamId: body.teamId, createdAt: now, updatedAt: now, runIds: [] };
    }

    const holder = await store.lockThread(thread.id, body.id);
    if (holder) {
      res.status(409).json({ success: false, error: "This thread already has a run in progress", runId: holder });
      return;
    }

    const run: AgentRun = {
      id: body.id,
      teamId: body.teamId,
      threadId: thread.id,
      threadTurn: thread.runIds.length + 1,
      mode: body.mode ?? previousMode ?? "extract",
      prompt: body.prompt,
      urls: body.urls,
      schema: body.schema ?? undefined,
      model: body.model ?? "spark-2",
      effort: body.effort,
      safe: body.safe,
      location: body.location,
      strictConstrainToURLs: body.strictConstrainToURLs,
      maxCredits: body.maxCredits ?? config.limits.defaultMaxCredits,
      stopOnInsufficientCredits: body.stopOnInsufficientCredits,
      isFreeRequest: body.isFreeRequest,
      webhook: body.webhook,
      exchangeRequested: !!body.exchange,
      zeroDataRetention: body.zeroDataRetention,
      zeroDataRetentionMinutes: body.zeroDataRetentionMinutes,
      apiKey: body.apiKey,
      state: "queued",
      createdAt: now,
      creditsUsed: 0,
      firecrawlCredits: 0,
      tokensUsed: 0,
      steps: 0,
      sources: [],
    };

    if (!(await store.createRun(run))) {
      await store.unlockThread(thread.id, body.id);
      res.status(409).json({ success: false, error: "Run id already exists" });
      return;
    }
    thread.runIds.push(run.id);
    thread.activeRunId = run.id;
    thread.updatedAt = now;
    await store.saveThread(thread);
    await store.markThreadKnown(thread.id);
    await store.enqueue(run.id);
    logger.info("agent run queued", { id: run.id, threadId: thread.id, threadTurn: run.threadTurn });
    void deps.runner.pump();

    res.json({ success: true, id: run.id, threadId: thread.id, threadTurn: run.threadTurn });
  });

  // GET /internal/extracts/:id: status (apps/api/src/lib/extract-v3-status.ts).
  app.get("/internal/extracts/:id", auth, async (req, res) => {
    const run = await loadRun(req, res);
    if (run) res.json(toStatus(run));
  });

  // DELETE /internal/extracts/:id: cancel (apps/api/src/controllers/v2/agent-cancel.ts).
  app.delete("/internal/extracts/:id", auth, async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    if (isTerminal(run)) {
      res.status(409).json({
        success: false,
        error: run.state === "cancelled" ? "Agent is already cancelled" : "Agent already finished",
      });
      return;
    }
    await store.requestCancel(run.id);
    await deps.runner.cancelQueued(run.id);
    res.json({ success: true });
  });

  // GET /internal/extracts/:id/trace (apps/api/src/controllers/v2/agent-trace.ts).
  app.get("/internal/extracts/:id/trace", auth, async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    res.json({
      success: true,
      id: run.id,
      events: await store.getEvents(run.id),
      creditsUsed: run.creditsUsed,
      ...(run.zeroDataRetention ? { zeroDataRetention: true } : {}),
    });
  });

  // GET /internal/extracts/:id/skill (apps/api/src/controllers/v2/agent-skill.ts).
  app.get("/internal/extracts/:id/skill", auth, async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    if (!isTerminal(run)) {
      res.status(409).json({ success: false, error: "Agent run is still in progress" });
      return;
    }
    if (run.state !== "succeeded" || run.data === undefined || run.zeroDataRetention) {
      res.status(409).json({ success: false, error: "Agent run produced no data to turn into a skill" });
      return;
    }
    const cached = req.query.refresh === "1" ? null : await store.getSkill(run.id);
    if (cached) {
      res.json({ ...JSON.parse(cached), generated: false });
      return;
    }
    const value = {
      success: true,
      id: run.id,
      ...exportSkill(run, await store.getEvents(run.id)),
      generatedAt: new Date().toISOString(),
    };
    await store.saveSkill(run.id, JSON.stringify(value));
    res.json({ ...value, generated: true });
  });

  // GET /internal/extracts/:id/snapshots/:snapshotId (agent-snapshot.ts). The
  // gateway passes the caller's team in x-team-id.
  app.get("/internal/extracts/:id/snapshots/:snapshotId", auth, async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const team = req.header("x-team-id");
    const snapshot = team === run.teamId ? await store.getSnapshot(run.id, String(req.params.snapshotId)) : null;
    if (snapshot === null) {
      res.status(404).json({ success: false, error: "Snapshot not found" });
      return;
    }
    res.json({ success: true, id: run.id, snapshotId: req.params.snapshotId, snapshot });
  });

  // GET /internal/threads/:threadId?teamId=&includeData= (agent-thread.ts).
  app.get("/internal/threads/:threadId", auth, async (req, res) => {
    const threadId = String(req.params.threadId);
    const teamId = typeof req.query.teamId === "string" ? req.query.teamId : "";
    const thread = await store.getThread(threadId);
    if (!thread) {
      const expired = await store.isThreadExpired(threadId);
      res.status(expired ? 410 : 404).json({ success: false, error: expired ? "Agent thread has expired" : "Agent thread not found" });
      return;
    }
    if (thread.teamId !== teamId) {
      res.status(404).json({ success: false, error: "Agent thread not found" });
      return;
    }
    if (thread.activeRunId) {
      const active = await store.getRun(thread.activeRunId);
      if (!active || isTerminal(active)) delete thread.activeRunId;
    }
    res.json({ thread: await renderThread(store, thread, req.query.includeData === "true") });
  });

  // GET /internal/recent-agents-for-team?teamId= (agent-list.ts).
  app.get("/internal/recent-agents-for-team", auth, async (req, res) => {
    const teamId = typeof req.query.teamId === "string" ? req.query.teamId : "";
    if (!teamId) {
      res.status(400).json({ success: false, error: "teamId is required" });
      return;
    }
    const runs = await store.listTeamRuns(teamId, 50);
    res.json(
      runs.map(run => ({
        id: run.id,
        createdAt: run.createdAt,
        status: threadRunStatus(run),
        options: run.zeroDataRetention
          ? { modelPreset: run.model, effort: run.effort, safe: run.safe, zeroDataRetention: true }
          : {
              urls: run.urls,
              prompt: run.prompt,
              schema: run.schema,
              modelPreset: run.model,
              effort: run.effort,
              safe: run.safe,
              threadId: run.threadId,
              threadTurn: run.threadTurn,
            },
      })),
    );
  });

  // Legacy gateway (community main before the upstream v2.11.739 sync) reads
  // run options here while no `agents` row exists.
  app.get("/v2/extract/:id/options", auth, async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    res.json({ model: run.model, effort: run.effort, threadId: run.threadId, threadTurn: run.threadTurn, mode: run.mode });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("request failed", { error: String((err as Error)?.message ?? err) });
    if (!res.headersSent) res.status(500).json({ success: false, error: "Internal error" });
  });

  return app;
}
