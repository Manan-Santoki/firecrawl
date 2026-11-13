import "server-only";
import { z } from "zod";
import { ForbiddenError } from "./authz";
import { FirecrawlApiError } from "./firecrawl-api";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code?: "agent_unavailable" };

/**
 * Runs a server action body and turns expected failures into a message the
 * UI can show. Unexpected errors are logged and reported generically so no
 * internal detail (SQL, stack, secrets) reaches the browser.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: error.message };
    if (error instanceof Error && error.name === "AgentUnavailableError") {
      return { ok: false, code: "agent_unavailable", error: "The agent backend is not available on this deployment." };
    }
    if (error instanceof z.ZodError) return { ok: false, error: error.issues[0]?.message ?? "Invalid input." };
    if (error instanceof FirecrawlApiError) return { ok: false, error: `Firecrawl API: ${error.message}` };
    if (error instanceof Error && error.name === "AccountError") return { ok: false, error: error.message };
    if (error instanceof Error && /session has expired/.test(error.message)) return { ok: false, error: error.message };
    console.error("Dashboard action failed", error);
    return { ok: false, error: "Something went wrong. Check the dashboard logs." };
  }
}
