import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A URL-safe single-use token and the hash stored for it. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time string comparison that also hides length differences. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/** The API's client-facing form of a key UUID: `fc-` plus 32 hex digits. */
export function formatApiKey(uuid: string): string {
  return `fc-${uuid.replace(/-/g, "")}`;
}

/** What the dashboard shows after creation: never the full key. */
export function maskApiKey(uuid: string): string {
  const compact = uuid.replace(/-/g, "");
  return `fc-${compact.slice(0, 4)}…${compact.slice(-4)}`;
}
