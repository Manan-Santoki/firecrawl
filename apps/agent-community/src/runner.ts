import { randomUUID } from "node:crypto";
import type { AgentServiceConfig } from "./config.js";
import { FirecrawlClient, type ScrapeResult } from "./firecrawl.js";
import { LlmClient, LlmError, type ChatMessage, type ResponseFormat, type ToolDefinition } from "./llm.js";
import type { Logger } from "./logger.js";
import { buildSystemPrompt, buildTaskMessage, FINALIZE_INSTRUCTION } from "./prompts.js";
import { parseJsonLoose, validateData } from "./schema.js";
import { findSitePlaybook, type Skill } from "./skills.js";
import type { JobStore } from "./store.js";
import { isTerminal, type AgentRun, type RunState, type TraceEvent } from "./types.js";
import { sendAgentWebhook, type AgentWebhookEvent } from "./webhook.js";

const EFFORT_STEPS = { low: 8, medium: 16, high: 30 } as const;
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 60_000;
const MAX_HISTORY_TURNS = 5;

type StopReason = "done" | "steps" | "credits" | "tokens" | "timeout" | "cancelled";

class StopRun extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

export type RunnerDeps = {
  config: AgentServiceConfig;
  store: JobStore;
  skills: Skill[];
  logger: Logger;
};

export function maxStepsFor(run: Pick<AgentRun, "effort">, config: AgentServiceConfig): number {
  if (config.limits.maxStepsOverride > 0) return config.limits.maxStepsOverride;
  return EFFORT_STEPS[run.effort ?? "medium"];
}

export function urlAllowed(url: string, allowed: string[] | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!allowed) return true;
  return allowed.some(a => {
    try {
      const base = new URL(a);
      const basePath = base.pathname.replace(/\/$/, "");
      return (
        base.hostname.replace(/^www\./, "") === parsed.hostname.replace(/^www\./, "") &&
        (basePath === "" || parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`))
      );
    } catch {
      return false;
    }
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} characters]`;
}

export class AgentRunner {
  private active = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pumping = false;

  constructor(private deps: RunnerDeps) {}

  get activeCount() {
    return this.active.size;
  }

  start(pollMs = 500) {
    this.stopped = false;
    this.timer = setInterval(() => void this.pump(), pollMs);
    this.recoveryTimer = setInterval(() => void this.recoverStale(), STALE_AFTER_MS / 2);
    void this.recoverStale();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const controller of this.active.values()) controller.abort(new StopRun("cancelled"));
  }

  /** Pull queued runs while there is spare capacity. */
  async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (this.active.size < this.deps.config.limits.maxConcurrentRuns) {
        const id = await this.deps.store.dequeue();
        if (!id) break;
        const controller = new AbortController();
        this.active.set(id, controller);
        void this.execute(id, controller).finally(() => this.active.delete(id));
      }
    } catch (error) {
      this.deps.logger.error("queue poll failed", { error: String(error) });
    } finally {
      this.pumping = false;
    }
  }

  /** Fail runs whose worker died (no heartbeat), so callers never poll forever. */
  async recoverStale(): Promise<void> {
    try {
      for (const id of await this.deps.store.staleActive(STALE_AFTER_MS)) {
        if (this.active.has(id)) continue;
        const run = await this.deps.store.getRun(id);
        await this.deps.store.clearActive(id);
        if (!run || isTerminal(run)) continue;
        await this.finish(run, "failed", { error: "Agent run was interrupted by a service restart." });
      }
    } catch (error) {
      this.deps.logger.error("stale run recovery failed", { error: String(error) });
    }
  }

  /** Cancel a run that no worker has picked up yet, without waiting for the queue. */
  async cancelQueued(id: string): Promise<boolean> {
    const run = await this.deps.store.getRun(id);
    if (!run || run.state !== "queued") return false;
    await this.finish(run, "cancelled", { error: "Agent run was cancelled." });
    return true;
  }

  private async event(run: AgentRun, event: Omit<TraceEvent, "timestamp">, contentFree = false) {
    if (run.zeroDataRetention && !contentFree) return;
    await this.deps.store.appendEvent(run.id, { ...event, timestamp: new Date().toISOString() } as TraceEvent);
  }

  private webhook(run: AgentRun, event: AgentWebhookEvent, payload: { success: boolean; data?: unknown; error?: string }) {
    return sendAgentWebhook(run, event, payload, {
      secret: this.deps.config.webhookSecret,
      allowLocal: this.deps.config.allowLocalWebhooks,
    });
  }

  private credits(run: AgentRun): number {
    const tokenCredits = Math.ceil((run.tokensUsed / 1000) * this.deps.config.limits.creditsPer1kTokens);
    return run.firecrawlCredits + tokenCredits;
  }

  private async finish(run: AgentRun, state: RunState, fields: Partial<AgentRun>) {
    Object.assign(run, fields, { state, completedAt: new Date().toISOString() });
    run.creditsUsed = this.credits(run);
    await this.deps.store.saveRun(run);
    await this.deps.store.clearActive(run.id);
    await this.deps.store.unlockThread(run.threadId, run.id);
    const thread = await this.deps.store.getThread(run.threadId);
    if (thread) {
      thread.updatedAt = run.completedAt!;
      if (thread.activeRunId === run.id) delete thread.activeRunId;
      await this.deps.store.saveThread(thread);
    }
    const lifecycle = state === "succeeded" ? "completed" : state === "cancelled" ? "cancelled" : "failed";
    await this.event(
      run,
      { type: lifecycle, state, creditsUsed: run.creditsUsed, steps: run.steps, ...(run.error ? { error: run.error } : {}) },
      true,
    );
    await this.webhook(run, lifecycle, {
      success: state === "succeeded",
      data: state === "succeeded" ? (run.mode === "chat" ? { message: run.message, data: run.data } : run.data) : undefined,
      error: run.error,
    });
    this.deps.logger.info("agent run finished", { id: run.id, state, steps: run.steps, creditsUsed: run.creditsUsed });
  }

  async execute(id: string, controller: AbortController): Promise<void> {
    const { store, config, logger } = this.deps;
    const run = await store.getRun(id);
    if (!run || isTerminal(run)) return;
    if (await store.isCancelRequested(id)) {
      await this.finish(run, "cancelled", { error: "Agent run was cancelled." });
      return;
    }

    run.state = "processing";
    run.startedAt = new Date().toISOString();
    await store.saveRun(run);
    await store.heartbeat(id);
    await this.event(run, { type: "started", mode: run.mode, threadTurn: run.threadTurn }, true);
    void this.webhook(run, "started", { success: true });

    const deadline = Date.now() + config.limits.maxRuntimeMs;
    const watchdog = setInterval(async () => {
      try {
        await store.heartbeat(id);
        if (await store.isCancelRequested(id)) controller.abort(new StopRun("cancelled"));
        else if (Date.now() > deadline) controller.abort(new StopRun("timeout"));
      } catch {
        // keep the run going; the next tick retries
      }
    }, Math.min(HEARTBEAT_MS, 1000));
    const hardTimeout = setTimeout(() => controller.abort(new StopRun("timeout")), config.limits.maxRuntimeMs);

    const fc = new FirecrawlClient({
      apiUrl: config.firecrawl.apiUrl,
      apiKey: run.apiKey && !["bypass", "preview"].includes(run.apiKey) ? run.apiKey : config.firecrawl.apiKey,
      timeoutMs: config.firecrawl.timeoutMs,
      interop: config.firecrawl.interop
        ? { secret: config.interopSecret, requestId: run.id, shouldBill: !run.isFreeRequest }
        : undefined,
    });
    const llm = new LlmClient(config.llm);
    const interactSessions = new Set<string>();

    const messages: ChatMessage[] = [];
    let finalText: string | null = null;
    let stop: StopReason = "done";

    try {
      messages.push({
        role: "system",
        content: buildSystemPrompt({
          today: new Date().toISOString().slice(0, 10),
          skills: this.deps.skills,
          interact: config.firecrawl.enableInteract,
          strictUrls: run.strictConstrainToURLs && run.urls?.length ? run.urls : undefined,
          mode: run.mode,
        }),
      });
      messages.push(...(await this.history(run)));
      messages.push({ role: "user", content: buildTaskMessage(run) });

      const tools = this.toolDefinitions(run);
      const maxSteps = maxStepsFor(run, config);
      const scrapeCache = new Map<string, ScrapeResult>();

      for (let step = 0; step < maxSteps; step++) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (run.tokensUsed >= config.limits.maxTotalTokens) throw new StopRun("tokens");
        const result = await llm.chat({ messages, tools }, controller.signal);
        run.steps = step + 1;
        run.tokensUsed += result.usage.total;
        await this.event(run, { type: "model_step", step: run.steps, tokens: result.usage.total }, true);

        const calls = result.message.tool_calls ?? [];
        if (calls.length === 0) {
          finalText = result.message.content ?? "";
          break;
        }
        messages.push({ role: "assistant", content: result.message.content, tool_calls: calls });
        for (const call of calls) {
          const output = await this.runTool(run, fc, call.function.name, call.function.arguments, {
            signal: controller.signal,
            scrapeCache,
            interactSessions,
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: truncate(output, config.limits.maxToolResultChars) });
          run.creditsUsed = this.credits(run);
          if (run.creditsUsed >= run.maxCredits) throw new StopRun("credits");
        }
        await store.saveRun(run);
        if (step === maxSteps - 1) stop = "steps";
      }
    } catch (error) {
      const reason = error instanceof StopRun ? error.reason : controller.signal.reason instanceof StopRun ? controller.signal.reason.reason : null;
      if (!reason) {
        clearInterval(watchdog);
        clearTimeout(hardTimeout);
        await this.closeInteract(fc, run, interactSessions);
        const message = error instanceof LlmError ? `Model request failed: ${error.message}` : `Agent run failed: ${String((error as Error)?.message ?? error)}`;
        logger.error("agent run error", { id, error: message });
        await this.finish(run, "failed", { error: message });
        return;
      }
      stop = reason;
    }

    clearInterval(watchdog);
    clearTimeout(hardTimeout);
    await this.closeInteract(fc, run, interactSessions);

    if (stop === "cancelled") {
      await this.finish(run, "cancelled", { error: "Agent run was cancelled." });
      return;
    }

    // A fresh, short budget for the formatting step so a run that hit its
    // wall-clock limit can still return its partial findings.
    const finalizeSignal = AbortSignal.timeout(Math.min(config.llm.timeoutMs, 90_000));
    const succeeded = stop === "done" || stop === "steps";
    try {
      if (run.mode === "chat" && run.schema === undefined) {
        let message = finalText;
        if (!message || stop !== "done") {
          const res = await llm.chat(
            {
              messages: [
                ...messages,
                { role: "user", content: "Answer the task now using only the research above. Cite source URLs." },
              ],
            },
            finalizeSignal,
          );
          run.tokensUsed += res.usage.total;
          message = res.message.content ?? "";
        }
        if (succeeded) await this.finish(run, "succeeded", { message, data: null });
        else await this.finishStopped(run, stop, { message });
        return;
      }

      if (finalText) messages.push({ role: "assistant", content: finalText });
      const structured = await this.finalizeJson(llm, run, messages, finalizeSignal);
      if (run.mode === "chat") run.message = finalText ?? undefined;

      if (!succeeded) {
        await this.finishStopped(run, stop, { partial: structured.value, partialSchemaValid: run.schema !== undefined ? structured.valid : undefined });
        return;
      }
      if (!structured.parsed) {
        await this.finish(run, "failed", { error: "The model did not return valid JSON for the result." });
        return;
      }
      if (!structured.valid) {
        await this.finish(run, "failed", {
          error: `The result did not match the requested schema: ${structured.errors.join("; ")}`,
          partial: structured.value,
          partialSchemaValid: false,
        });
        return;
      }
      await this.finish(run, "succeeded", { data: structured.value });
    } catch (error) {
      const message = `Agent run failed while formatting the result: ${String((error as Error)?.message ?? error)}`;
      if (succeeded) await this.finish(run, "failed", { error: message });
      else await this.finishStopped(run, stop, {});
    }
  }

  private async finishStopped(run: AgentRun, stop: StopReason, fields: Partial<AgentRun>) {
    if (stop === "credits") {
      await this.finish(run, "credit_limit_reached", {
        ...fields,
        error: `The run reached its credit limit of ${run.maxCredits} credits.`,
      });
    } else if (stop === "tokens") {
      await this.finish(run, "failed", { ...fields, error: "The run reached its model token budget." });
    } else {
      await this.finish(run, "failed", { ...fields, error: "The run exceeded its time limit." });
    }
  }

  private async finalizeJson(
    llm: LlmClient,
    run: AgentRun,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<{ parsed: boolean; valid: boolean; value: unknown; errors: string[] }> {
    const mode = this.deps.config.llm.structuredOutput;
    const schema = run.schema;
    const instruction =
      schema !== undefined
        ? `${FINALIZE_INSTRUCTION}\nThe JSON must validate against this JSON Schema:\n${JSON.stringify(schema)}`
        : `${FINALIZE_INSTRUCTION}\nReturn a JSON object whose keys describe the requested information.`;
    let format: ResponseFormat | undefined =
      mode === "prompt"
        ? undefined
        : schema !== undefined && mode === "json_schema"
          ? { type: "json_schema", json_schema: { name: "agent_result", schema, strict: false } }
          : { type: "json_object" };

    const convo: ChatMessage[] = [...messages, { role: "user", content: instruction }];
    let last = { parsed: false, valid: false, value: undefined as unknown, errors: ["no output"] };
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await llm.chat({ messages: convo, responseFormat: format }, signal);
      } catch (error) {
        // Some OpenAI-compatible servers reject response_format; degrade once.
        if (error instanceof LlmError && error.status === 400 && format) {
          format = format.type === "json_schema" ? { type: "json_object" } : undefined;
          continue;
        }
        throw error;
      }
      run.tokensUsed += res.usage.total;
      const parsed = parseJsonLoose(res.message.content);
      if (!parsed.ok) {
        last = { parsed: false, valid: false, value: undefined, errors: ["output was not JSON"] };
        convo.push({ role: "assistant", content: res.message.content ?? "" });
        convo.push({ role: "user", content: "That was not valid JSON. Output only the JSON value." });
        continue;
      }
      const validation = validateData(schema, parsed.value);
      last = { parsed: true, valid: validation.ok, value: parsed.value, errors: validation.errors };
      if (validation.ok) return last;
      convo.push({ role: "assistant", content: res.message.content ?? "" });
      convo.push({
        role: "user",
        content: `The JSON does not match the schema: ${validation.errors.join("; ")}. Fix it using only facts from the research and output only the corrected JSON.`,
      });
    }
    return last;
  }

  private async history(run: AgentRun): Promise<ChatMessage[]> {
    if (run.threadTurn <= 1) return [];
    const thread = await this.deps.store.getThread(run.threadId);
    if (!thread) return [];
    const out: ChatMessage[] = [];
    const prior = thread.runIds.filter(r => r !== run.id).slice(-MAX_HISTORY_TURNS);
    for (const priorId of prior) {
      const p = await this.deps.store.getRun(priorId);
      if (!p || p.state !== "succeeded") continue;
      out.push({ role: "user", content: buildTaskMessage(p) });
      const answer = p.message ?? (p.data !== undefined ? JSON.stringify(p.data) : "");
      out.push({ role: "assistant", content: truncate(answer, 8000) });
    }
    return out;
  }

  toolDefinitions(run: AgentRun): ToolDefinition[] {
    const strict = !!(run.strictConstrainToURLs && run.urls?.length);
    const defs: ToolDefinition[] = [];
    if (!strict) {
      defs.push({
        type: "function",
        function: {
          name: "search",
          description: "Search the web. Returns result URLs with titles and snippets.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              limit: { type: "integer", minimum: 1, maximum: 10, description: "Number of results (default 5)" },
            },
            required: ["query"],
          },
        },
      });
    }
    defs.push(
      {
        type: "function",
        function: {
          name: "scrape",
          description: "Fetch one page and return its main content as markdown.",
          parameters: {
            type: "object",
            properties: { url: { type: "string", description: "Absolute http(s) URL" } },
            required: ["url"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "map",
          description: "List URLs on a website, optionally filtered by a search term. Does not return page content.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Site URL" },
              search: { type: "string", description: "Optional term to rank/filter URLs" },
            },
            required: ["url"],
          },
        },
      },
    );
    if (this.deps.config.firecrawl.enableInteract) {
      defs.push({
        type: "function",
        function: {
          name: "interact",
          description:
            "Drive a browser on a page that was already scraped (pass its scrapeId). Use a natural-language prompt describing data to extract or a concrete action to perform.",
          parameters: {
            type: "object",
            properties: {
              scrapeId: { type: "string" },
              prompt: { type: "string" },
            },
            required: ["scrapeId", "prompt"],
          },
        },
      });
    }
    if (this.deps.skills.length > 0) {
      defs.push(
        {
          type: "function",
          function: {
            name: "load_skill",
            description: "Load a skill playbook by name from the skill catalog in the system prompt.",
            parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          },
        },
        {
          type: "function",
          function: {
            name: "lookup_site_playbook",
            description: "Return site-specific navigation hints for a URL, if a playbook exists.",
            parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          },
        },
      );
    }
    return defs;
  }

  private async runTool(
    run: AgentRun,
    fc: FirecrawlClient,
    name: string,
    rawArgs: string,
    ctx: { signal: AbortSignal; scrapeCache: Map<string, ScrapeResult>; interactSessions: Set<string> },
  ): Promise<string> {
    let args: Record<string, any>;
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return JSON.stringify({ error: "Tool arguments were not valid JSON." });
    }
    await this.event(run, { type: "tool_call", tool: name, input: args });
    const allowed = run.strictConstrainToURLs && run.urls?.length ? run.urls : undefined;
    const started = Date.now();
    try {
      let output: unknown;
      let credits = 0;
      let snapshotId: string | undefined;
      switch (name) {
        case "search": {
          if (allowed) throw new Error("Search is disabled because the task is constrained to the provided URLs.");
          const res = await fc.search(
            { query: String(args.query ?? ""), limit: Number(args.limit ?? 5), country: run.location?.country, safe: run.safe },
            ctx.signal,
          );
          credits = res.creditsUsed;
          output = { results: res.hits };
          break;
        }
        case "scrape": {
          const url = String(args.url ?? "");
          if (!urlAllowed(url, allowed)) throw new Error(`URL not allowed: ${url}`);
          let page = ctx.scrapeCache.get(url);
          if (!page) {
            page = await fc.scrape({ url, location: run.location }, ctx.signal);
            ctx.scrapeCache.set(url, page);
            credits = page.creditsUsed;
            if (!run.sources.includes(page.url)) run.sources.push(page.url);
            if (!run.zeroDataRetention) {
              snapshotId = randomUUID();
              await this.deps.store.saveSnapshot(run.id, snapshotId, page.markdown);
            }
          }
          output = {
            url: page.url,
            title: page.title,
            statusCode: page.statusCode,
            ...(this.deps.config.firecrawl.enableInteract && page.scrapeId ? { scrapeId: page.scrapeId } : {}),
            markdown: page.markdown,
          };
          break;
        }
        case "map": {
          const url = String(args.url ?? "");
          if (!urlAllowed(url, allowed)) throw new Error(`URL not allowed: ${url}`);
          const links = await fc.map({ url, search: args.search ? String(args.search) : undefined }, ctx.signal);
          credits = this.deps.config.limits.mapCredits;
          output = { links: links.filter(l => urlAllowed(l, allowed)).slice(0, 200) };
          break;
        }
        case "interact": {
          if (!this.deps.config.firecrawl.enableInteract) throw new Error("interact is not enabled");
          const scrapeId = String(args.scrapeId ?? "");
          ctx.interactSessions.add(scrapeId);
          output = await fc.interact({ scrapeId, prompt: String(args.prompt ?? "") }, ctx.signal);
          break;
        }
        case "load_skill": {
          const skill = this.deps.skills.find(s => s.name === args.name);
          output = skill ? { name: skill.name, playbook: skill.body } : { error: `Unknown skill: ${args.name}` };
          break;
        }
        case "lookup_site_playbook": {
          output = findSitePlaybook(this.deps.skills, String(args.url ?? "")) ?? { result: "No site playbook for this URL." };
          break;
        }
        default:
          output = { error: `Unknown tool: ${name}` };
      }
      run.firecrawlCredits += credits;
      await this.event(run, {
        type: "tool_result",
        tool: name,
        ok: true,
        durationMs: Date.now() - started,
        creditsUsed: credits,
        ...(snapshotId ? { snapshotId, url: args.url } : {}),
      });
      if (["search", "scrape", "map", "interact"].includes(name)) {
        void this.webhook(run, "action", { success: true, data: { tool: name, input: args } });
      }
      return typeof output === "string" ? output : JSON.stringify(output);
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
      const message = String((error as Error)?.message ?? error);
      await this.event(run, { type: "tool_result", tool: name, ok: false, durationMs: Date.now() - started, error: message });
      return JSON.stringify({ error: message });
    }
  }

  private async closeInteract(fc: FirecrawlClient, run: AgentRun, sessions: Set<string>) {
    for (const scrapeId of sessions) {
      run.firecrawlCredits += await fc.stopInteract(scrapeId);
    }
    sessions.clear();
  }
}
