import type { TokenUsage } from "./cli";

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
