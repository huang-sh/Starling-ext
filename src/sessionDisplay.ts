import type { TokenUsage, LiveStatus } from "./cli";

export const SHORT_SESSION_ID_LENGTH = 13;

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
}

/**
 * Format a token count with K (thousands) / M (millions) suffixes.
 * Examples: 842 -> "842", 12345 -> "12.3K", 1500000 -> "1.5M".
 */
export function formatTokenCount(value?: number): string {
  if (value == null) return "-";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${compact(value / 1000)}K`;
  return `${compact(value / 1_000_000)}M`;
}

function compact(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatTokenUsage(tokenUsage?: TokenUsage): string {
  if (!tokenUsage) {
    return "unknown";
  }
  const input = formatTokenCount(tokenUsage.input_tokens);
  const output = formatTokenCount(tokenUsage.output_tokens);
  const total = formatTokenCount(tokenUsage.total_tokens);
  const cache = formatTokenCount(tokenUsage.cache_tokens);
  return `input: ${input}, output: ${output}, total: ${total}, cache: ${cache}`;
}

// --- live monitor formatters (mirror Starling/src/commands/monitor.ts) ---

const LIVE_GLYPH: Record<LiveStatus, string> = {
  waiting: "⏸",
  idle: "○",
  running: "●",
  stale_running: "◐",
  aborted: "×",
  failure: "×",
  stopped: "·",
  unknown: "?",
};

const LIVE_LABEL: Record<LiveStatus, string> = {
  waiting: "Waiting",
  idle: "Idle",
  running: "Running",
  stale_running: "Running?",
  aborted: "Aborted",
  failure: "Failure",
  stopped: "Stopped",
  unknown: "Unknown",
};

export function formatStatusGlyph(status: LiveStatus): string {
  return `${LIVE_GLYPH[status] ?? "?"} ${LIVE_LABEL[status] ?? status}`;
}

/** Elapsed seconds → "1h 5m" / "12m" / "45s". */
export function formatElapsedSecs(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "-";
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatCpuPct(pct?: number): string {
  if (pct == null || !Number.isFinite(pct)) return "-";
  return `${pct.toFixed(0)}%`;
}

export function formatMemKb(kb?: number): string {
  if (!kb || kb <= 0 || !Number.isFinite(kb)) return "-";
  if (kb < 1024) return `${kb}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)}M`;
  return `${(mb / 1024).toFixed(2)}G`;
}

export function formatCtxPct(pct: number): string {
  if (pct == null || !Number.isFinite(pct) || pct < 0) return "-";
  return `${pct.toFixed(0)}%`;
}

export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return formatTokenCount(n);
}

/**
 * Render `ms` (absolute epoch ms, matching MonitorRow.last_activity_ms) as a
 * relative time string. Falls back to absolute time for anything older than a day.
 */
export function formatRelativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const now = Date.now();
  const deltaSec = Math.max(0, (now - ms) / 1000);
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${Math.floor(deltaSec)}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}
