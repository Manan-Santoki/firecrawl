import { z } from "zod";

/**
 * Body the Firecrawl API sends to `POST {EXTRACT_V3_BETA_URL}/internal/extracts`
 * (apps/api/src/controllers/v2/agent.ts, upstream v2.11.739). Unknown fields
 * are kept so newer gateways do not break an older service.
 */
export const createExtractSchema = z.looseObject({
  id: z.string().min(1).max(64),
  urls: z.array(z.string()).max(100).optional(),
  schema: z.any().optional(),
  prompt: z.string().max(10_000),
  apiKey: z.string().optional(),
  apiKeyId: z.union([z.number(), z.string()]).optional(),
  teamId: z.string().min(1),
  isFreeRequest: z.boolean().optional(),
  maxCredits: z.number().optional(),
  stopOnInsufficientCredits: z.boolean().optional(),
  strictConstrainToURLs: z.boolean().optional(),
  webhook: z
    .looseObject({
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      events: z.array(z.string()).optional(),
    })
    .optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  auditMetadata: z.any().optional(),
  threadId: z.string().optional(),
  mode: z.enum(["extract", "chat"]).optional(),
  exchange: z.any().optional(),
  location: z
    .looseObject({ country: z.string().optional(), languages: z.array(z.string()).optional() })
    .optional(),
  safe: z.boolean().optional(),
  hostedMcp: z.boolean().optional(),
  zeroDataRetention: z.boolean().optional(),
  zeroDataRetentionMinutes: z.number().positive().optional(),
  usOnly: z.boolean().optional(),
});

export type CreateExtractRequest = z.infer<typeof createExtractSchema>;

/** Internal run state. Mapped to the API's ExtractV3AgentStatus by `toStatus`. */
export type RunState =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "credit_limit_reached";

export type AgentRun = {
  id: string;
  teamId: string;
  threadId: string;
  threadTurn: number;
  mode: "extract" | "chat";
  prompt: string;
  urls?: string[];
  schema?: unknown;
  model: string;
  effort?: "low" | "medium" | "high";
  safe?: boolean;
  location?: { country?: string; languages?: string[] };
  strictConstrainToURLs?: boolean;
  maxCredits: number;
  stopOnInsufficientCredits?: boolean;
  isFreeRequest?: boolean;
  webhook?: CreateExtractRequest["webhook"];
  exchangeRequested?: boolean;
  zeroDataRetention?: boolean;
  zeroDataRetentionMinutes?: number;
  /** Key used for tool calls; never returned by any endpoint. */
  apiKey?: string;
  state: RunState;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  cancelRequested?: boolean;
  data?: unknown;
  partial?: unknown;
  partialSchemaValid?: boolean;
  message?: string;
  error?: string;
  creditsUsed: number;
  firecrawlCredits: number;
  tokensUsed: number;
  steps: number;
  sources: string[];
};

export type AgentThread = {
  id: string;
  teamId: string;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  activeRunId?: string;
};

export type TraceEvent = {
  type: string;
  timestamp: string;
  [key: string]: unknown;
};

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "credit_limit_reached",
]);

export function isTerminal(run: Pick<AgentRun, "state">): boolean {
  return TERMINAL_STATES.has(run.state);
}
