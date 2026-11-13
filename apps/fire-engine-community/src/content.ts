export type BodyKind = "html" | "xml" | "text" | "binary";

export function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Decides how a main-document response is returned to the API. */
export function classifyBody(contentType: string | undefined): BodyKind {
  const type = mediaType(contentType);
  if (type === "" || type === "text/html" || type === "application/xhtml+xml") return "html";
  if (
    type === "text/xml" ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/rss" ||
    type === "application/atom"
  ) {
    return "xml";
  }
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/javascript" ||
    type === "application/x-javascript" ||
    type === "application/ld+json"
  ) {
    return "text";
  }
  return "binary";
}

export function charsetOf(contentType: string | undefined): string {
  const match = /charset=["']?([^;"'\s]+)/i.exec(contentType ?? "");
  return match?.[1]?.toLowerCase() ?? "utf-8";
}

export function decodeBody(buffer: Buffer, contentType: string | undefined): string {
  let charset = charsetOf(contentType);
  if (charset === "utf8") charset = "utf-8";
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

export function fileNameFor(url: string, fallback = "download"): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last).slice(0, 200) : fallback;
  } catch {
    return fallback;
  }
}

export function flattenHeaders(headers: Record<string, string> | Array<{ name: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Array.isArray(headers) ? headers.map(h => [h.name, h.value] as const) : Object.entries(headers);
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    out[key] = out[key] !== undefined ? `${out[key]}, ${value}` : value;
  }
  return out;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
