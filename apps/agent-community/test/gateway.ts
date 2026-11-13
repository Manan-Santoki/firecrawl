/**
 * The exact calls the Firecrawl API gateway makes to EXTRACT_V3_BETA_URL,
 * transcribed from upstream tag v2.11.739 (URL construction, method, headers
 * and body shape). Keep in sync when the upstream contract moves.
 */
import { randomUUID } from "node:crypto";

export function makeGateway(base: string, secret: string) {
  const auth = { Authorization: `Bearer ${secret}` };
  return {
    /** apps/api/src/controllers/v2/agent.ts (passthrough) */
    start(params: {
      id?: string;
      teamId: string;
      prompt: string;
      urls?: string[];
      schema?: unknown;
      maxCredits?: number;
      strictConstrainToURLs?: boolean;
      webhook?: unknown;
      effort?: "low" | "medium" | "high";
      threadId?: string;
      mode?: "extract" | "chat";
      exchange?: unknown;
      location?: unknown;
      safe?: boolean;
      zeroDataRetention?: boolean;
      zeroDataRetentionMinutes?: number;
      apiKey?: string;
    }) {
      const agentId = params.id ?? randomUUID();
      const zeroDataRetention = params.zeroDataRetention === true;
      return fetch(base + "/internal/extracts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          id: agentId,
          urls: params.urls,
          schema: params.schema,
          prompt: params.prompt,
          apiKey: params.apiKey ?? "fc-team-key",
          apiKeyId: 7,
          teamId: params.teamId,
          isFreeRequest: true,
          maxCredits: params.maxCredits ?? undefined,
          stopOnInsufficientCredits: undefined,
          strictConstrainToURLs: params.strictConstrainToURLs ?? undefined,
          webhook: params.webhook ?? undefined,
          // agentRequestSchema always rewrites the model to spark-2.
          model: "spark-2",
          effort: params.effort,
          auditMetadata: undefined,
          threadId: params.threadId,
          mode: params.mode,
          exchange: params.exchange,
          location: params.location,
          safe: params.safe,
          ...(zeroDataRetention ? { zeroDataRetention: true } : {}),
          ...(params.zeroDataRetentionMinutes !== undefined ? { zeroDataRetentionMinutes: params.zeroDataRetentionMinutes } : {}),
        }),
      }).then(async r => ({ status: r.status, body: (await r.json().catch(() => null)) as any, id: agentId }));
    },

    /** apps/api/src/lib/extract-v3-status.ts */
    status(id: string) {
      const url = new URL(`${base.replace(/\/$/, "")}/internal/extracts/${encodeURIComponent(id)}`);
      return fetch(url, { headers: auth, signal: AbortSignal.timeout(10_000) }).then(async r => ({
        status: r.status,
        body: (await r.json().catch(() => null)) as any,
      }));
    },

    /** apps/api/src/controllers/v2/agent-cancel.ts */
    cancel(id: string) {
      return fetch(base + "/internal/extracts/" + id, { method: "DELETE", headers: auth }).then(async r => ({
        status: r.status,
        body: (await r.json().catch(() => null)) as any,
      }));
    },

    /** apps/api/src/controllers/v2/agent-trace.ts */
    trace(id: string) {
      return fetch(`${base}/internal/extracts/${id}/trace`, { headers: auth }).then(async r => ({
        status: r.status,
        body: (await r.json()) as any,
      }));
    },

    /** apps/api/src/controllers/v2/agent-skill.ts */
    skill(id: string, refresh = false) {
      const query = refresh ? "?refresh=1" : "";
      return fetch(`${base}/internal/extracts/${id}/skill${query}`, { headers: auth }).then(async r => ({
        status: r.status,
        body: (await r.json()) as any,
      }));
    },

    /** apps/api/src/controllers/v2/agent-snapshot.ts */
    snapshot(id: string, snapshotId: string, teamId: string) {
      return fetch(`${base}/internal/extracts/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}`, {
        headers: { ...auth, "x-team-id": teamId },
      }).then(async r => ({ status: r.status, body: (await r.json()) as any }));
    },

    /** apps/api/src/controllers/v2/agent-thread.ts (fetchAgentThread) */
    thread(threadId: string, teamId: string, options: { includeData?: boolean } = {}) {
      const query = new URLSearchParams({ teamId });
      if (options.includeData !== undefined) query.set("includeData", String(options.includeData));
      return fetch(`${base}/internal/threads/${encodeURIComponent(threadId)}?${query}`, { headers: auth }).then(
        async r => ({ status: r.status, body: (await r.json().catch(() => null)) as any }),
      );
    },

    /** apps/api/src/controllers/v2/agent-list.ts */
    recent(teamId: string) {
      return fetch(base + "/internal/recent-agents-for-team?teamId=" + teamId, { method: "GET", headers: auth }).then(
        async r => ({ status: r.status, body: (await r.json()) as any }),
      );
    },

    /** community main (upstream v2.11.289) apps/api/src/controllers/v2/agent-status.ts */
    legacyOptions(id: string) {
      return fetch(base + "/v2/extract/" + id + "/options", { headers: auth }).then(async r => ({
        status: r.status,
        body: (await r.json()) as any,
      }));
    },
  };
}

export async function pollTerminal(gw: ReturnType<typeof makeGateway>, id: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await gw.status(id);
    if (s.status !== 200) throw new Error(`status ${s.status}: ${JSON.stringify(s.body)}`);
    if (s.body.status !== "processing") return s.body;
    if (Date.now() > deadline) throw new Error(`run ${id} did not finish`);
    await new Promise(r => setTimeout(r, 25));
  }
}
