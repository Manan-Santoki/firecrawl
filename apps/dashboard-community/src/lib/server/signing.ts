import { createHmac, randomBytes } from "node:crypto";

/** HMAC-SHA256 over `timestamp.body`, sent as `X-Firecrawl-Dashboard-Signature: t=…,v1=…`. */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export type DeliveryResult = { success: boolean; statusCode: number | null; latencyMs: number; error: string | null };

/** POSTs a signed JSON payload; never throws. */
export async function deliverSigned(url: string, secret: string, event: string, payload: unknown): Promise<DeliveryResult> {
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), data: payload });
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "firecrawl-community-dashboard",
        "X-Firecrawl-Dashboard-Event": event,
        ...(secret ? { "X-Firecrawl-Dashboard-Signature": signPayload(secret, body) } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    return {
      success: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      latencyMs: Math.round(performance.now() - started),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      success: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
