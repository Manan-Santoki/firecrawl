import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AgentRun } from "./types.js";

export type AgentWebhookEvent = "started" | "action" | "completed" | "failed" | "cancelled";

function isPrivateAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

/** Refuse webhook targets on loopback/private networks unless the operator allows them. */
export async function assertPublicWebhookUrl(url: string, allowLocal: boolean): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Webhook URL must use http or https");
  }
  if (allowLocal) return;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("Webhook URL resolves to a private or loopback address");
  }
}

export async function sendAgentWebhook(
  run: AgentRun,
  event: AgentWebhookEvent,
  payload: { success: boolean; data?: unknown; error?: string },
  opts: { secret?: string; allowLocal: boolean },
): Promise<void> {
  const webhook = run.webhook;
  if (!webhook) return;
  const events = webhook.events ?? ["started", "action", "completed", "failed", "cancelled"];
  if (!events.includes(event)) return;

  try {
    await assertPublicWebhookUrl(webhook.url, opts.allowLocal);
    const body = JSON.stringify({
      success: payload.success,
      type: `agent.${event}`,
      webhookId: randomUUID(),
      id: run.id,
      jobId: run.id,
      data: run.zeroDataRetention && event === "action" ? undefined : payload.data,
      ...(payload.error ? { error: payload.error } : {}),
      metadata: webhook.metadata ?? {},
    });
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(webhook.headers ?? {}) };
    if (opts.secret) {
      headers["X-Firecrawl-Signature"] = `sha256=${createHmac("sha256", opts.secret).update(body).digest("hex")}`;
    }
    await fetch(webhook.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Webhook delivery is best effort and never fails the run.
  }
}
