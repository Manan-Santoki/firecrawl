const number = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const credits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : number.format(value);
}

export function formatCompact(value: number): string {
  return compact.format(value);
}

export function formatCredits(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : credits.format(value);
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function statusTone(status: number): "success" | "warning" | "error" | "info" {
  if (status >= 500) return "error";
  if (status >= 400) return "warning";
  if (status >= 300) return "info";
  return "success";
}
