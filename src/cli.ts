import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { logError } from "./logging";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;
const DEFAULT_JSON_TIMEOUT = 60_000;
const DEFAULT_TEXT_TIMEOUT = 30_000;
const DEFAULT_CACHE_TTL_SECONDS = 30;
const DEFAULT_SESSION_ALL_FALLBACK_LIMIT = 10000;

type CliExecOptions = {
  timeout: number;
  maxBuffer?: number;
};

export class StarlingCliNotFoundError extends Error {
  constructor(public readonly cliPath: string) {
    super(`Starling CLI was not found: ${cliPath}`);
    this.name = "StarlingCliNotFoundError";
  }
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_tokens?: number;
}

export interface SessionMeta {
  session_id: string;
  provider: string;
  model: string | null;
  project_path: string | null;
  file_path: string;
  created_at: string;
  modified_at: string;
  first_prompt: string | null;
  custom_title?: string | null;
  token_usage?: TokenUsage;
  catalogs?: Array<{ id: string; name: string }>;
  latest_run?: RunRecord;
}

export interface RunRecord {
  run_id: string;
  session_id?: string;
  provider: string;
  project_path?: string;
  catalog_id?: string;
  setting?: string;
  pid?: number;
  status: string;
  exit_code?: number;
  started_at: string;
  ended_at?: string;
  source: string;
}

export interface Note {
  id: string;
  content: string;
  created_at: string;
}

export interface Bookmark {
  id: string;
  provider: string;
  session_id: string;
  title: string;
  category: string;
  tags: string[];
  project_path: string;
  first_prompt: string;
  notes: Note[];
  space_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface Space {
  id: string;
  name: string;
  description: string;
  parent_id: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  pin_count?: number;
  session_count?: number;
}

export interface SpaceWithPins extends Space {
  pins?: Bookmark[];
  session_count?: number;
  pin_count?: number;
}

export interface ProjectSummary {
  project_path: string;
  session_count: number;
  agents: Record<string, number>;
  models: Record<string, number>;
  first_active: string;
  last_active: string;
}

export interface ProjectDetails extends ProjectSummary {
  sessions: SessionMeta[];
}

export interface ModelConfigSummary {
  agent: "claude" | "codex";
  scope: "current" | "profile";
  name: string;
  source: string;
  exists: boolean;
  model?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: string;
  wireApi?: string;
  auth?: string;
  error?: string;
}

/**
 * Live per-session status (7 states, mirrors starling top). Sent by the CLI as the
 * `status` field on every MonitorRow.
 */
export type LiveStatus =
  | "waiting"
  | "idle"
  | "running"
  | "stale_running"
  | "aborted"
  | "failure"
  | "stopped"
  | "unknown";

export interface MonitorToolCall {
  name: string;
  arg: string;
  duration_ms: number;
}

export interface MonitorChatMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Live per-session metrics from `starling top --json`. Mirrors the CLI's
 * MonitorRow shape (Starling/src/commands/monitor.ts).
 */
export interface MonitorRow {
  session_id: string;
  canonical_session_id: string;
  pinned: boolean;
  catalog?: string;
  title: string;
  provider: string;
  model: string;
  status: LiveStatus;
  pid?: number;
  cpu_pct?: number;
  mem_kb?: number;
  rss_kb?: number;
  ctx_pct: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache: number;
  last_tool: string | null;
  tool_count: number;
  project_path: string;
  file_path?: string;
  last_activity_ms: number;
  // Tier 1 enrichment
  started_at_ms: number;
  elapsed_secs: number;
  pending_since_ms: number;
  thinking_since_ms: number;
  token_history: number[];
  context_history: number[];
  compaction_count: number;
  current_task: string;
  tool_calls_tail: MonitorToolCall[];
  chat_tail: MonitorChatMessage[];
}

export interface MonitorSnapshot {
  pinned_total: number;
  recent_total: number;
  active: number;
  pinned: MonitorRow[];
  recent: MonitorRow[];
}

type CacheEntry = {
  expiresAt: number;
  value: Promise<unknown>;
};

const commandCache = new Map<string, CacheEntry>();
const monitorCache = new Map<string, { expiresAt: number; value?: MonitorSnapshot; inFlight?: Promise<MonitorSnapshot> }>();

function cacheTtlMs(): number {
  const configured = vscode.workspace.getConfiguration("starling").get<number>("cacheTtlSeconds", DEFAULT_CACHE_TTL_SECONDS);
  const normalized = Number(configured);
  if (!Number.isFinite(normalized) || normalized < 0) return DEFAULT_CACHE_TTL_SECONDS * 1000;
  return normalized * 1000;
}

function getCachedResult<T>(cacheKey: string, fetcher: () => Promise<T>): Promise<T> {
  const ttl = cacheTtlMs();
  if (ttl <= 0) {
    return fetcher();
  }

  const cached = commandCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as Promise<T>;
  }

  const promise = fetcher();
  const expiresAt = Date.now() + ttl;
  const value = promise as Promise<unknown>;
  commandCache.set(cacheKey, { expiresAt, value });

  promise.catch(() => {
    const entry = commandCache.get(cacheKey);
    if (entry && entry.value === value) {
      commandCache.delete(cacheKey);
    }
  });

  return promise;
}

function cacheKeyForCommand(args: string[]): string {
  const command = starlingCommand(args);
  return [command.file, starlingHomePath() ?? "", ...command.args].join("\u0000");
}

export function clearCliCache(prefix?: string): void {
  if (!prefix) {
    commandCache.clear();
    monitorCache.clear();
    return;
  }
  for (const key of monitorCache.keys()) {
    if (key.startsWith(prefix)) {
      monitorCache.delete(key);
    }
  }
  for (const key of commandCache.keys()) {
    if (key.startsWith(prefix)) {
      commandCache.delete(key);
    }
  }
}

function starlingBin(): string {
  return vscode.workspace.getConfiguration("starling").get<string>("cliPath", "starling");
}

export function starlingHomePath(): string | undefined {
  const configured = vscode.workspace.getConfiguration("starling").get<string>("homePath", "");
  const trimmed = configured.trim();
  return trimmed ? trimmed : undefined;
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Resolve the Starling home directory the same way the CLI does, so direct
 * file writes land where `starling` will find them.
 * Order: VS Code `starling.homePath` → STARLING_HOME env → CLI config.json
 * homePath → ~/.starling default. Mirrors src/constants.ts in the CLI.
 */
export function starlingHomeRoot(): string {
  const configured = starlingHomePath();
  if (configured) return expandHomePath(configured);
  const envHome = process.env.STARLING_HOME?.trim();
  if (envHome) return expandHomePath(envHome);
  const configPath = process.env.STARLING_CLI_CONFIG?.trim() || join(homedir(), ".config", "starling", "config.json");
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as { homePath?: unknown };
      if (typeof parsed.homePath === "string" && parsed.homePath.trim()) {
        return expandHomePath(parsed.homePath.trim());
      }
    } catch {
      // ignore malformed config
    }
  }
  return join(homedir(), ".starling");
}

function starlingCommand(args: string[]): { file: string; args: string[] } {
  const configured = process.env.STARLING_BIN;
  if (configured) {
    return { file: configured, args };
  }
  return { file: starlingBin(), args };
}

async function execStarlingRaw(args: string[], options: Partial<CliExecOptions> = {}): Promise<string> {
  const command = starlingCommand(args);
  const starlingHome = starlingHomePath();
  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      env: starlingHome ? { ...process.env, STARLING_HOME: starlingHome } : process.env,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      timeout: options.timeout ?? DEFAULT_TEXT_TIMEOUT,
      // On Windows, npm installs three shims for global bins: `starling` (bash),
      // `starling.cmd` (cmd.exe), `starling.ps1` (PowerShell). Without a shell,
      // child_process does not consult PATHEXT, so `execFile("starling", ...)`
      // fails with ENOENT because the literal `starling` file is not the cmd.exe
      // shim. Routing through cmd.exe lets PATHEXT resolve to `starling.cmd`.
      // POSIX is unchanged. Args are constructed internally from CLI subcommands
      // and user-supplied catalog/session/model names; Node's default Windows
      // argument quoting handles spaces and most metacharacters.
      shell: process.platform === "win32",
    });
    return stdout as string;
  } catch (err) {
    if (isCommandNotFoundError(err)) {
      logError(`Starling CLI not found while running: ${command.file} ${command.args.join(" ")}`, err);
      throw new StarlingCliNotFoundError(command.file);
    }
    const message = err instanceof Error ? err.message : String(err);
    const anyError = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const stdout = sanitizeCliOutput(anyError?.stdout);
    const stderr = sanitizeCliOutput(anyError?.stderr);
    const commandText = `${command.file} ${command.args.join(" ")}`;
    const details: string[] = [];
    if (stdout) details.push(`stdout=${stdout}`);
    if (stderr) details.push(`stderr=${stderr}`);
    if (anyError?.code !== undefined) details.push(`code=${anyError.code}`);
    const wrapped = new Error(`starling command failed: ${commandText}${details.length ? `: ${details.join(" | ")}` : ""}`);
    logError("Starling CLI command failed.", wrapped);
    throw wrapped;
  }
}

function isCommandNotFoundError(err: unknown): boolean {
  const anyError = err as { code?: unknown; errno?: unknown; syscall?: unknown; path?: unknown; message?: unknown };
  if (anyError?.code === "ENOENT") return true;
  const message = typeof anyError?.message === "string" ? anyError.message : "";
  return message.includes("ENOENT") || message.includes("not found");
}

function sanitizeCliOutput(value: string | undefined): string {
  if (!value) return "";
  const trimmed = String(value).replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trim();
  if (!trimmed) return "";
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}…` : trimmed;
}

function parseJsonOutput<T>(stdout: string, commandLabel: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`${commandLabel} returned empty output`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const jsonText = extractJsonText(trimmed);
    if (!jsonText) {
      throw new Error(`${commandLabel} returned invalid JSON. Output preview: ${trimmed.slice(0, 300)}`);
    }
    try {
      return JSON.parse(jsonText) as T;
    } catch {
      throw new Error(`${commandLabel} returned invalid JSON. Output preview: ${trimmed.slice(0, 300)}`);
    }
  }
}

function extractJsonText(text: string): string | undefined {
  const start = Math.min(indexOfAny(text, "{"), indexOfAny(text, "["));
  if (start === Number.POSITIVE_INFINITY) return undefined;
  const open = text[start] as "{" | "[";
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === open) {
      depth += 1;
      continue;
    }

    if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

function indexOfAny(text: string, targets: "{" | "["): number {
  const index = text.indexOf(targets);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

async function execStarlingJson<T>(args: string[], options: Partial<CliExecOptions> = {}): Promise<T> {
  const stdout = await execStarlingRaw(args, options);
  const commandLabel = `starling ${args.join(" ")}`;
  return parseJsonOutput<T>(stdout, commandLabel);
}

export async function listSessions(
  limit = 50,
  agent?: string,
  options: { all?: boolean } = {}
): Promise<SessionMeta[]> {
  const baseArgs = ["session", "list", "--json"];
  if (options.all) {
    const allArgs = [...baseArgs, "--all"];
    if (agent) allArgs.push("-a", agent);

    const cacheKeyAll = `sessionList:${cacheKeyForCommand(allArgs)}`;
    return getCachedResult<SessionMeta[]>(cacheKeyAll, async () => {
      try {
        return await execStarlingJson<SessionMeta[]>(allArgs, { timeout: DEFAULT_JSON_TIMEOUT });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/invalid JSON|not found|failed|timed out|ENOBUFS/i.test(message)) {
          throw err;
        }
        const fallbackLimit = Math.max(limit || DEFAULT_SESSION_ALL_FALLBACK_LIMIT, 1);
        const fallbackArgs = [...baseArgs, "-n", String(fallbackLimit)];
        if (agent) fallbackArgs.push("-a", agent);
        return execStarlingJson<SessionMeta[]>(fallbackArgs, { timeout: DEFAULT_JSON_TIMEOUT });
      }
    });
  } else {
    const args = [...baseArgs, "-n", String(limit)];
    if (agent) args.push("--agent", agent);
    return getCachedResult<SessionMeta[]>(`sessionList:${cacheKeyForCommand(args)}`, () => execStarlingJson<SessionMeta[]>(args));
  }
}

function monitorCacheTtlMs(): number {
  const configured = vscode.workspace.getConfiguration("starling").get<number>("monitorCacheTtlSeconds", 2);
  const normalized = Number(configured);
  if (!Number.isFinite(normalized) || normalized < 0) return 2000;
  return normalized * 1000;
}

function normalizeMonitorSnapshot(raw: unknown): MonitorSnapshot {
  if (Array.isArray(raw)) {
    const rows = raw.map((row) => normalizeMonitorRow(row));
    const pinned = rows.filter((row) => row.pinned);
    const recent = rows.filter((row) => !row.pinned);
    return {
      pinned_total: pinned.length,
      recent_total: recent.length,
      active: rows.filter(isActiveMonitorRow).length,
      pinned,
      recent,
    };
  }

  const obj = (raw && typeof raw === "object" ? raw : {}) as Partial<MonitorSnapshot>;
  const pinned = Array.isArray(obj.pinned) ? obj.pinned.map((row) => normalizeMonitorRow(row)) : [];
  const recent = Array.isArray(obj.recent) ? obj.recent.map((row) => normalizeMonitorRow(row)) : [];
  return {
    pinned_total: Number.isFinite(obj.pinned_total) ? Number(obj.pinned_total) : pinned.length,
    recent_total: Number.isFinite(obj.recent_total) ? Number(obj.recent_total) : recent.length,
    active: [...pinned, ...recent].filter(isActiveMonitorRow).length,
    pinned,
    recent,
  };
}

function normalizeMonitorRow(raw: unknown): MonitorRow {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const status = normalizeLiveStatus(row.status);
  const memKb = toNumber(row.mem_kb ?? row.rss_kb, 0);
  return {
    session_id: String(row.session_id ?? ""),
    canonical_session_id: String(row.canonical_session_id ?? row.session_id ?? ""),
    pinned: Boolean(row.pinned),
    catalog: typeof row.catalog === "string" ? row.catalog : undefined,
    title: String(row.title ?? ""),
    provider: String(row.provider ?? ""),
    model: String(row.model ?? ""),
    status,
    pid: typeof row.pid === "number" ? row.pid : undefined,
    cpu_pct: typeof row.cpu_pct === "number" ? row.cpu_pct : undefined,
    mem_kb: memKb,
    rss_kb: typeof row.rss_kb === "number" ? row.rss_kb : undefined,
    ctx_pct: toNumber(row.ctx_pct, -1),
    tokens_in: toNumber(row.tokens_in, 0),
    tokens_out: toNumber(row.tokens_out, 0),
    tokens_cache: toNumber(row.tokens_cache, 0),
    last_tool: typeof row.last_tool === "string" && row.last_tool ? row.last_tool : null,
    tool_count: toNumber(row.tool_count, 0),
    project_path: String(row.project_path ?? row.project ?? ""),
    file_path: typeof row.file_path === "string" ? row.file_path : undefined,
    last_activity_ms: toNumber(row.last_activity_ms, 0),
    started_at_ms: toNumber(row.started_at_ms, 0),
    elapsed_secs: toNumber(row.elapsed_secs, 0),
    pending_since_ms: toNumber(row.pending_since_ms, 0),
    thinking_since_ms: toNumber(row.thinking_since_ms, 0),
    token_history: Array.isArray(row.token_history) ? row.token_history.map((n) => toNumber(n, 0)) : [],
    context_history: Array.isArray(row.context_history) ? row.context_history.map((n) => toNumber(n, 0)) : [],
    compaction_count: toNumber(row.compaction_count, 0),
    current_task: String(row.current_task ?? ""),
    tool_calls_tail: Array.isArray(row.tool_calls_tail) ? row.tool_calls_tail.map(normalizeMonitorToolCall) : [],
    chat_tail: Array.isArray(row.chat_tail) ? row.chat_tail.map(normalizeMonitorChatMessage) : [],
  };
}

function normalizeLiveStatus(value: unknown): LiveStatus {
  const status = String(value ?? "").toLowerCase();
  if (status === "permission" || status === "permission_approval" || status === "approval" || status === "needs_attention") return "waiting";
  if (status === "waiting" || status === "waiting_input" || status === "waiting_for_input") return "waiting";
  if (status === "busy" || status === "thinking" || status === "executing" || status === "rate_limited") return "running";
  if (status === "stale_running" || status === "stale-running" || status === "running_stale" || status === "running-stale") return "stale_running";
  if (status === "aborted" || status === "abort" || status === "interrupted" || status === "interrupt" || status === "cancelled" || status === "canceled" || status === "terminated") return "aborted";
  if (status === "idle") return "idle";
  if (status === "running") return "running";
  if (status === "failure" || status === "failed" || status === "error") return "failure";
  if (status === "stopped" || status === "done") return "stopped";
  return "unknown";
}

function isActiveMonitorRow(row: MonitorRow): boolean {
  return row.pid !== undefined;
}

function normalizeMonitorToolCall(raw: unknown): MonitorToolCall {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    name: String(row.name ?? ""),
    arg: String(row.arg ?? ""),
    duration_ms: toNumber(row.duration_ms, 0),
  };
}

function normalizeMonitorChatMessage(raw: unknown): MonitorChatMessage {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const role = row.role === "assistant" ? "assistant" : "user";
  return {
    role,
    text: String(row.text ?? ""),
  };
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Fetch the live monitor snapshot (`starling top --json`). Uses a short
 * live-data cache with stale-on-error behavior so background polling does not
 * hammer the CLI or blank the UI during transient command failures.
 */
export async function getMonitorSnapshot(
  opts: { recent?: boolean; force?: boolean; allowStale?: boolean } = {}
): Promise<MonitorSnapshot> {
  const args = ["top", "--json"];
  if (opts.recent) args.push("--recent");
  const cacheKey = `monitor:${cacheKeyForCommand(args)}`;
  const cached = monitorCache.get(cacheKey);
  const now = Date.now();
  if (!opts.force && cached?.value && cached.expiresAt > now) {
    return cached.value;
  }
  if (!opts.force && cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = execStarlingJson<unknown>(args, { timeout: 30_000 })
    .then((raw) => {
      const value = normalizeMonitorSnapshot(raw);
      monitorCache.set(cacheKey, {
        expiresAt: Date.now() + monitorCacheTtlMs(),
        value,
      });
      return value;
    })
    .catch((err) => {
      const stale = monitorCache.get(cacheKey)?.value;
      if (stale && opts.allowStale !== false) {
        monitorCache.set(cacheKey, {
          expiresAt: Date.now() + Math.min(monitorCacheTtlMs(), 1000),
          value: stale,
        });
        return stale;
      }
      monitorCache.delete(cacheKey);
      throw err;
    });

  monitorCache.set(cacheKey, {
    expiresAt: cached?.expiresAt ?? 0,
    value: cached?.value,
    inFlight,
  });
  return inFlight;
}

export async function checkStarlingAvailable(): Promise<void> {
  await execStarlingRaw(["--version"], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function listSessionsText(opts: {
  limit?: number;
  all?: boolean;
  agent?: string;
} = {}): Promise<string> {
  const args = ["session", "list"];
  if (opts.all) {
    args.push("--all");
  } else {
    args.push("-n", String(opts.limit ?? 20));
  }
  if (opts.agent) args.push("--agent", opts.agent);
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function sessionIndexStatusText(): Promise<string> {
  return execStarlingRaw(["session", "index", "status"], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function sessionIndexRebuildText(agent?: string): Promise<string> {
  const args = ["session", "index", "rebuild"];
  if (agent) args.push("-a", agent);
  clearCliCache();
  return execStarlingRaw(args, { timeout: DEFAULT_JSON_TIMEOUT });
}

export async function sessionIndexClearText(): Promise<string> {
  clearCliCache();
  return execStarlingRaw(["session", "index", "clear"], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function getSession(id: string): Promise<SessionMeta> {
  const args = ["session", "show", id, "--json"];
  return getCachedResult<SessionMeta>(`sessionGet:${cacheKeyForCommand(args)}`, () => execStarlingJson<SessionMeta>(args));
}

// Latch flipped on when the running starling CLI predates `session lookup`,
// so we fall back to the per-id `getSession` loop instead of erroring.
let legacySessionLookup = false;

/**
 * Resolve many sessions in a single `starling session lookup <id...> --json`
 * subprocess. Falls back to per-id `getSession` calls if the CLI lacks the
 * subcommand. Result is keyed by canonical session_id.
 */
export async function getSessions(sessionIds: string[]): Promise<Map<string, SessionMeta>> {
  const result = new Map<string, SessionMeta>();
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0) return result;

  if (legacySessionLookup) {
    return resolveSessionsLegacy(unique);
  }

  const sorted = [...unique].sort();
  const cacheKey = `sessionLookup:${sorted.join("\u0000")}`;
  try {
    const sessions = await getCachedResult<SessionMeta[]>(cacheKey, async () => {
      const args = ["session", "lookup", ...sorted, "--json"];
      return execStarlingJson<SessionMeta[]>(args, { timeout: DEFAULT_JSON_TIMEOUT });
    });
    for (const session of sessions) {
      if (session?.session_id) result.set(session.session_id, session);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/"lookup"|unknown command|invalid JSON/i.test(message)) {
      legacySessionLookup = true;
      return resolveSessionsLegacy(unique);
    }
    throw err;
  }
}

async function resolveSessionsLegacy(sessionIds: string[]): Promise<Map<string, SessionMeta>> {
  const result = new Map<string, SessionMeta>();
  const outcomes = await Promise.allSettled(sessionIds.map((id) => getSession(id)));
  for (let index = 0; index < sessionIds.length; index += 1) {
    const outcome = outcomes[index];
    if (outcome.status === "fulfilled") {
      result.set(sessionIds[index], outcome.value);
    }
  }
  return result;
}

export async function getSessionText(id: string): Promise<string> {
  return execStarlingRaw(["session", "show", id]);
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<string> {
  clearCliCache();
  return execStarlingRaw(["session", "meta", sessionId, "--title", title], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function resumeSession(id: string): Promise<string> {
  return execStarlingRaw(["session", "resume", id], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function pinSession(
  sessionId: string,
  opts: {
    title?: string;
    tags?: string;
    to?: string;
    current?: boolean;
  } = {}
): Promise<string> {
  const args = ["pin", sessionId];
  if (opts.title) args.push("--title", opts.title);
  if (opts.tags) args.push("--tags", opts.tags);
  if (opts.to) args.push("--to", opts.to);
  if (opts.current) args.push("--current");
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function unpinSession(sessionId: string): Promise<string> {
  clearCliCache();
  return execStarlingRaw(["session", "unpin", sessionId], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function deleteSession(sessionId: string): Promise<string> {
  clearCliCache();
  return execStarlingRaw(["session", "delete", sessionId, "--yes"], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function listPins(space?: string): Promise<Bookmark[]> {
  const args = ["catalog", "list", "--pins", "--json"];
  const cacheKey = `pinList:${space ?? "all"}:${cacheKeyForCommand(args)}`;
  return getCachedResult<Bookmark[]>(cacheKey, async () => {
    const catalogs = await execStarlingJson<SpaceWithPins[]>(args);
    const pins = space
      ? catalogs
        .filter((catalog) => catalog.id === space || catalog.name === space)
        .flatMap((catalog) => catalog.pins ?? [])
      : catalogs.flatMap((catalog) => catalog.pins ?? []);
    const uniquePins = new Map<string, Bookmark>();
    for (const pin of pins) {
      uniquePins.set(pin.id, pin);
    }
    return [...uniquePins.values()];
  });
}

export async function listSpaces(withPins = false): Promise<Space[] | SpaceWithPins[]> {
  const args = ["catalog", "list", "--json"];
  if (withPins) args.push("--pins");
  return getCachedResult<Space[] | SpaceWithPins[]>(`spaceList:${cacheKeyForCommand(args)}`, () => execStarlingJson<Space[] | SpaceWithPins[]>(args));
}

export async function catalogListText(opts: { pins?: boolean } = {}): Promise<string> {
  const args = ["catalog", "list"];
  if (opts.pins) args.push("--pins");
  return execStarlingRaw(args);
}

export async function catalogTreeText(opts: { sessions?: boolean } = {}): Promise<string> {
  const args = ["catalog", "tree"];
  if (opts.sessions) args.push("--sessions");
  return execStarlingRaw(args);
}

export async function modelListText(agent?: string): Promise<string> {
  const args = ["model", "ls"];
  if (agent) args.push("--agent", agent);
  return execStarlingRaw(args);
}

export async function listModels(agent?: string): Promise<ModelConfigSummary[]> {
  const args = ["model", "ls", "--json"];
  if (agent) args.push("--agent", agent);
  return getCachedResult<ModelConfigSummary[]>(`modelList:${cacheKeyForCommand(args)}`, () =>
    execStarlingJson<ModelConfigSummary[]>(args, { timeout: DEFAULT_JSON_TIMEOUT })
  );
}

export async function deleteModelProfile(model: ModelConfigSummary): Promise<void> {
  await execStarlingRaw(["model", "delete", model.name, "--agent", model.agent], {
    timeout: DEFAULT_TEXT_TIMEOUT,
  });
  clearCliCache("modelList:");
}

export async function catalogShowText(name: string): Promise<string> {
  return execStarlingRaw(["catalog", "show", name]);
}

export async function getSpace(name: string): Promise<SpaceWithPins> {
  const args = ["catalog", "show", name, "--json"];
  return getCachedResult<SpaceWithPins>(`spaceGet:${cacheKeyForCommand(args)}`, async () => {
    try {
      return await execStarlingJson<SpaceWithPins>(args, {
        maxBuffer: DEFAULT_MAX_BUFFER,
        timeout: DEFAULT_TEXT_TIMEOUT,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/unexpected argument '--json'|Usage: starling catalog show/i.test(message)) {
        throw err;
      }
      const catalogs = await listSpaces(true) as SpaceWithPins[];
      const found = catalogs.find((catalog) => catalog.id === name || catalog.name === name);
      if (!found) throw err;
      return found;
    }
  });
}

export async function createCatalog(name: string, opts: { description?: string; tags?: string; parent?: string } = {}): Promise<string> {
  const args = ["catalog", "create", name];
  if (opts.description) args.push("-d", opts.description);
  if (opts.tags) args.push("--tags", opts.tags);
  if (opts.parent) args.push("--parent", opts.parent);
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function removeCatalog(name: string): Promise<string> {
  return execStarlingRaw(["catalog", "delete", name, "--yes"], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function renameCatalog(name: string, newName: string): Promise<string> {
  return execStarlingRaw(["catalog", "rename", name, newName], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function removeSessionFromCatalog(name: string, sessionId: string): Promise<string> {
  return execStarlingRaw(["catalog", "detach", name, sessionId], { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function tagCatalog(name: string, tags: string[]): Promise<string> {
  const args = ["catalog", "tag", name, ...tags];
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function editCatalog(
  name: string,
  opts: {
    description?: string;
    rename?: string;
    parent?: string;
  }
): Promise<string> {
  const args = ["catalog", "edit", name];
  if (opts.description) args.push("-d", opts.description);
  if (opts.rename) args.push("--rename", opts.rename);
  if (opts.parent) args.push("--parent", opts.parent);
  return execStarlingRaw(args, { timeout: DEFAULT_TEXT_TIMEOUT });
}

export async function projectListText(opts: {
  agent?: string;
  limit?: number;
  all?: boolean;
  refreshIndex?: boolean;
  noIndex?: boolean;
} = {}): Promise<string> {
  const args = ["project", "list"];
  if (opts.agent) args.push("-a", opts.agent);
  if (opts.refreshIndex) args.push("--refresh-index");
  if (opts.noIndex) args.push("--no-index");
  if (opts.all) {
    args.push("--all");
  } else {
    args.push("-n", String(opts.limit ?? 100));
  }
  return execStarlingRaw(args);
}

export async function projectShowText(path: string, agent?: string): Promise<string> {
  const args = ["project", "show", path];
  if (agent) args.push("-a", agent);
  return execStarlingRaw(args);
}

export async function listProjects(opts: {
  agent?: string;
  limit?: number;
  all?: boolean;
  refreshIndex?: boolean;
  noIndex?: boolean;
} = {}): Promise<ProjectSummary[]> {
  const args = ["project", "list", "--json"];
  if (opts.agent) args.push("-a", opts.agent);
  if (opts.refreshIndex) args.push("--refresh-index");
  if (opts.noIndex) args.push("--no-index");
  if (opts.all) {
    args.push("--all");
  } else {
    args.push("-n", String(opts.limit ?? 100));
  }
  const timeout = DEFAULT_JSON_TIMEOUT;
  return getCachedResult<ProjectSummary[]>(`projectList:${cacheKeyForCommand(args)}`, async () => {
    const stdout = await execStarlingRaw(args, { timeout });
    const trimmed = stdout.trim();
    if (trimmed === "No projects found.") return [];
    if (trimmed === "[]") return [];
    return parseJsonOutput<ProjectSummary[]>(stdout, "starling project list --json");
  });
}

export async function projectShowJson(path: string, agent?: string): Promise<ProjectDetails> {
  const args = ["project", "show", path, "--json"];
  if (agent) args.push("-a", agent);
  return getCachedResult<ProjectDetails>(`projectShow:${cacheKeyForCommand(args)}`, async () => {
    const stdout = await execStarlingRaw(args, { timeout: DEFAULT_JSON_TIMEOUT });
    const trimmed = stdout.trim();
    if (trimmed === "Project not found.") {
      throw new Error(`Project not found: ${path}`);
    }
    return parseJsonOutput<ProjectDetails>(stdout, `starling project show ${path} --json`);
  });
}
