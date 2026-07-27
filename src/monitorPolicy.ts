const DEFAULT_MONITOR_TIMEOUT_MS = 60_000;
const MIN_MONITOR_INTERVAL_MS = 1_000;
const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

export function monitorTimeoutMs(configuredSeconds: unknown): number {
  const seconds = Number(configuredSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_MONITOR_TIMEOUT_MS;
  return Math.max(MIN_MONITOR_INTERVAL_MS, Math.floor(seconds * 1000));
}

export function monitorRetryDelayMs(failureCount: number, random = Math.random): number {
  const exponent = Math.max(0, Math.floor(failureCount) - 1);
  const base = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** exponent));
  return Math.min(MAX_RETRY_DELAY_MS, Math.floor(base * (1 + 0.2 * boundedRandom(random))));
}

export function monitorRefreshDelayMs(baseMs: number, random = Math.random): number {
  const normalized = Math.max(MIN_MONITOR_INTERVAL_MS, Math.floor(baseMs));
  return Math.floor(normalized * (1 + 0.2 * boundedRandom(random)));
}

function boundedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
