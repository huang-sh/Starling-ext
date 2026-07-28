import {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  SpawnOptions,
  SpawnOptionsWithoutStdio,
} from "child_process";
import { existsSync } from "fs";
import { isAbsolute, win32 as windowsPath } from "path";
import { PiChatMessage, StrictJsonlDecoder, isRecord, normalizePiMessages, serializeJsonLine } from "./piChatProtocol";

export type PiChatSendBehavior = "steer" | "followUp";

// The Starling supervisor gives an uncooperative Pi child up to two seconds
// to stop before escalating and then performs its own cleanup. Keep the
// extension's final supervisor kill comfortably outside that window.
export const STARLING_CHAT_TERM_GRACE_MS = 3_000;

export interface PiChatStartOptions {
  cwd: string;
  sessionPath?: string;
  setting?: string;
}

export interface PiChatStartResult {
  state: Record<string, unknown>;
  messages: PiChatMessage[];
}

export type PiExtensionUiRequest = Record<string, unknown> & {
  type: "extension_ui_request";
  id: string;
  method: string;
};

export type PiExtensionUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export type PiChatEvent =
  | { type: "ready"; state: Record<string, unknown>; messages: PiChatMessage[] }
  | { type: "rpc"; value: Record<string, unknown> }
  | { type: "extension_ui_request"; request: PiExtensionUiRequest; respond: (response: PiExtensionUiResponse) => void }
  | { type: "stderr"; text: string }
  | { type: "error"; error: Error }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export class PiChatEvents {
  private readonly listeners = new Set<(event: PiChatEvent) => void>();

  on(listener: (event: PiChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PiChatEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

type SpawnUtilityProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface PiChatSpawnCommand {
  file: string;
  args: string[];
}

export interface PiChatCommandResolverOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fileExists?: (file: string) => boolean;
}

export class PiChatCliPathError extends Error {
  constructor(public readonly cliPath: string, reason: string) {
    super(
      `Cannot safely launch Starling from starling.cliPath "${cliPath}" on Windows: ${reason}. `
      + "Set starling.cliPath to starling.exe or to an npm-installed starling.cmd.",
    );
    this.name = "PiChatCliPathError";
  }
}

export interface PiChatSessionConfig {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  spawnUtilityProcess?: SpawnUtilityProcess;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  terminateTimeoutMs?: number;
}

interface PendingRequest {
  command: string;
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export function buildPiChatArguments(options: PiChatStartOptions): string[] {
  const cwd = options.cwd.trim();
  if (!cwd) throw new Error("Pi chat requires a working directory.");
  const args = ["chat", "--cwd", cwd];
  const setting = options.setting?.trim();
  if (setting) args.push("--setting", setting);
  args.push("pi");
  if (options.sessionPath) {
    if (!isAbsolute(options.sessionPath)) {
      throw new Error("Pi chat sessionPath must be absolute.");
    }
    args.push("--session", options.sessionPath);
  }
  return args;
}

/**
 * Resolve a Starling command without invoking a command shell.
 *
 * POSIX can execute the configured command directly. Windows needs special
 * handling because npm exposes a `.cmd` shim. We never execute that shim:
 * instead, locate the package entry point in the same npm installation tree
 * and run it with a real `node.exe`. This also keeps user arguments out of
 * cmd.exe parsing.
 */
export function resolvePiChatSpawnCommand(
  executable: string,
  args: readonly string[],
  options: PiChatCommandResolverOptions = {},
): PiChatSpawnCommand {
  const configured = executable.trim();
  if (!configured) throw new Error("starling.cliPath must not be empty.");
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { file: configured, args: [...args] };

  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fileExists = options.fileExists ?? existsSync;
  const resolved = resolveWindowsStarlingCommand(configured, cwd, env, fileExists);
  if (resolved.toLowerCase().endsWith(".exe")) {
    if (!env.STARLING_PI_SDK_HOST?.trim() || !env.STARLING_PI_SDK_NODE?.trim()) {
      throw new PiChatCliPathError(
        configured,
        "a native starling.exe needs STARLING_PI_SDK_HOST and STARLING_PI_SDK_NODE; prefer the npm starling.cmd wrapper",
      );
    }
    return { file: resolved, args: [...args] };
  }

  if (windowsPath.basename(resolved).toLowerCase() !== "starling.cmd") {
    throw new PiChatCliPathError(configured, "only native .exe files and the npm starling.cmd shim are supported");
  }
  const shimDirectory = windowsPath.dirname(resolved);
  const packageEntries = windowsPath.basename(shimDirectory).toLowerCase() === ".bin"
    ? [
      windowsPath.join(shimDirectory, "..", "starling-ai", "bin", "starling.js"),
      windowsPath.join(shimDirectory, "node_modules", "starling-ai", "bin", "starling.js"),
    ]
    : [
      windowsPath.join(shimDirectory, "node_modules", "starling-ai", "bin", "starling.js"),
      windowsPath.join(shimDirectory, "..", "starling-ai", "bin", "starling.js"),
    ];
  const packageEntry = packageEntries.find(fileExists);
  if (!packageEntry) {
    throw new PiChatCliPathError(configured, "the matching starling-ai/bin/starling.js was not found beside the npm shim");
  }

  const nodeCandidates = [
    windowsPath.join(shimDirectory, "node.exe"),
    ...windowsSearchDirectories(env).map((directory) => windowsPath.join(directory, "node.exe")),
  ];
  const nodeExecutable = uniqueWindowsPaths(nodeCandidates).find(fileExists);
  if (!nodeExecutable) {
    throw new PiChatCliPathError(configured, "node.exe was not found beside the npm shim or on PATH");
  }
  return { file: nodeExecutable, args: [packageEntry, ...args] };
}

function resolveWindowsStarlingCommand(
  configured: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  fileExists: (file: string) => boolean,
): string {
  const extension = windowsPath.extname(configured).toLowerCase();
  if (extension && extension !== ".exe" && extension !== ".cmd") {
    throw new PiChatCliPathError(configured, `unsupported file type ${extension}`);
  }

  const hasPathSeparator = configured.includes("\\") || configured.includes("/");
  const isExplicitPath = windowsPath.isAbsolute(configured) || hasPathSeparator;
  const baseCandidates = isExplicitPath
    ? [windowsPath.resolve(cwd, configured)]
    : windowsSearchDirectories(env).map((directory) => windowsPath.join(directory, configured));

  let candidates: string[];
  if (extension) {
    candidates = baseCandidates;
  } else {
    // Preserve PATH directory precedence while preferring the npm wrapper:
    // it owns the SDK Host path and Node runtime required by Starling Chat.
    candidates = baseCandidates.flatMap((candidate) => [`${candidate}.cmd`, `${candidate}.exe`]);
  }
  const resolved = uniqueWindowsPaths(candidates).find(fileExists);
  if (!resolved) {
    throw new PiChatCliPathError(configured, "no matching executable was found");
  }
  return resolved;
}

function windowsSearchDirectories(env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.Path ?? env.PATH ?? env.path ?? "";
  return pathValue
    .split(windowsPath.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function uniqueWindowsPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    const key = windowsPath.normalize(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Owns one Starling/Pi RPC child and exposes only session-level operations. */
export class PiChatSession {
  readonly events = new PiChatEvents();

  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnProcess: SpawnProcess;
  private readonly spawnUtilityProcess: SpawnUtilityProcess;
  private readonly platform: NodeJS.Platform;
  private readonly fileExists: (file: string) => boolean;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly terminateTimeoutMs: number;
  private decoder = new StrictJsonlDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingUi = new Set<string>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private stopping = false;
  private ready = false;

  constructor(config: PiChatSessionConfig = {}) {
    this.executable = config.executable || process.env.STARLING_BIN || "starling";
    this.env = config.env || process.env;
    this.spawnProcess = config.spawnProcess || ((file, args, options) =>
      nodeSpawn(file, args, { ...options, stdio: "pipe" }));
    this.spawnUtilityProcess = config.spawnUtilityProcess || ((file, args, options) =>
      nodeSpawn(file, args, options));
    this.platform = config.platform ?? process.platform;
    this.fileExists = config.fileExists ?? existsSync;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
    this.stopTimeoutMs = config.stopTimeoutMs ?? 2_000;
    this.terminateTimeoutMs = config.terminateTimeoutMs ?? STARLING_CHAT_TERM_GRACE_MS;
  }

  async start(options: PiChatStartOptions): Promise<PiChatStartResult> {
    if (this.child) throw new Error("Pi chat session is already started.");
    const args = buildPiChatArguments(options);
    this.stopping = false;
    this.ready = false;
    this.decoder = new StrictJsonlDecoder();

    const command = resolvePiChatSpawnCommand(this.executable, args, {
      platform: this.platform,
      env: this.env,
      cwd: options.cwd,
      fileExists: this.fileExists,
    });
    const child = this.spawnProcess(command.file, command.args, {
      cwd: options.cwd,
      env: this.env,
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    this.attachChild(child);
    try {
      await waitForSpawn(child);
      const [stateResponse, messagesResponse] = await Promise.all([
        // SDK startup can pause for a project-trust confirmation emitted on
        // this same stream. VS Code owns that decision, so startup hydration
        // must not time out while the response is pending.
        this.request("get_state", {}, false),
        this.request("get_messages", {}, false),
      ]);
      const state = isRecord(stateResponse.data) ? stateResponse.data : {};
      const messageData = isRecord(messagesResponse.data) ? messagesResponse.data : {};
      const messages = normalizePiMessages(messageData.messages);
      const result = { state, messages };
      if (this.child !== child || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Pi chat process exited during startup.");
      }
      this.ready = true;
      this.events.emit({ type: "ready", ...result });
      return result;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async send(text: string, behavior?: PiChatSendBehavior): Promise<void> {
    if (!this.ready) throw new Error("Pi chat session is still starting.");
    const message = text.trim();
    if (!message) return;
    const command: Record<string, unknown> = { type: "prompt", message };
    if (behavior) command.streamingBehavior = behavior;
    await this.request("prompt", command);
  }

  async abort(): Promise<void> {
    if (!this.child) return;
    await this.request("abort");
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.ready = false;

    for (const id of [...this.pendingUi]) {
      this.write({ type: "extension_ui_response", id, cancelled: true });
      this.pendingUi.delete(id);
    }
    if (child.stdin.writable) this.write({ type: "abort" });
    child.stdin.end();

    const exited = await Promise.race([
      onceClosed(child).then(() => true),
      delay(this.stopTimeoutMs).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      if (this.platform === "win32") {
        if (child.pid === undefined) {
          throw new Error("Could not stop Pi chat: the Windows process has no PID.");
        }
        await terminateWindowsProcessTree(child.pid, this.spawnUtilityProcess);
        await Promise.race([onceClosed(child), delay(500)]);
        return;
      }
      child.kill("SIGTERM");
      const terminated = await Promise.race([
        onceClosed(child).then(() => true),
        delay(this.terminateTimeoutMs).then(() => false),
      ]);
      if (!terminated && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([onceClosed(child), delay(500)]);
      }
    }
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: string | Buffer) => {
      for (const line of this.decoder.push(chunk)) this.handleLine(line);
    });
    child.stdout.on("end", () => {
      for (const line of this.decoder.end()) this.handleLine(line);
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      this.events.emit({ type: "stderr", text: chunk.toString("utf8") });
    });
    child.on("error", (error) => this.events.emit({ type: "error", error }));
    child.on("close", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.ready = false;
      this.pendingUi.clear();
      this.rejectPending(new Error(`Pi chat process exited${code === null ? "" : ` with code ${code}`}.`));
      this.events.emit({ type: "exit", code, signal });
    });
  }

  private handleLine(line: string): void {
    if (!line) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.events.emit({ type: "error", error: new Error(`Invalid Pi RPC JSON: ${line.slice(0, 200)}`) });
      return;
    }
    if (!isRecord(value)) return;

    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id);
      if (pending) {
        this.pending.delete(value.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (value.success === false) {
          pending.reject(new Error(String(value.error ?? `${pending.command} failed`)));
        } else if (typeof value.command === "string" && value.command !== pending.command) {
          pending.reject(new Error(`Pi RPC response mismatch: expected ${pending.command}, received ${value.command}.`));
        } else {
          pending.resolve(value);
        }
        return;
      }
    }

    if (
      value.type === "extension_ui_request"
      && typeof value.id === "string"
      && typeof value.method === "string"
    ) {
      const request = value as PiExtensionUiRequest;
      const waitsForResponse = ["select", "confirm", "input", "editor"].includes(request.method);
      if (waitsForResponse) this.pendingUi.add(request.id);
      let responded = false;
      const respond = (response: PiExtensionUiResponse) => {
        if (responded || !waitsForResponse) return;
        responded = true;
        this.pendingUi.delete(request.id);
        this.write({ type: "extension_ui_response", id: request.id, ...response });
      };
      this.events.emit({ type: "extension_ui_request", request, respond });
      return;
    }

    this.events.emit({ type: "rpc", value });
  }

  private request(
    command: string,
    body: Record<string, unknown> = {},
    useTimeout = true,
  ): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || !child.stdin.writable || this.stopping) {
      return Promise.reject(new Error("Pi chat session is not running."));
    }
    const id = `starling-chat-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      // Prompt acceptance may legitimately wait for authentication, project
      // trust, or automatic compaction. Timing it out locally is unsafe: the
      // SDK could accept it later and a retry would execute the prompt twice.
      const timer = !useTimeout || command === "prompt" || command === "compact"
        ? undefined
        : setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Starling SDK ${command} timed out after ${this.requestTimeoutMs}ms.`));
        }, this.requestTimeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      try {
        this.write({ ...body, id, type: command });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  private write(value: unknown): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(serializeJsonLine(value), "utf8");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function terminateWindowsProcessTree(
  pid: number,
  spawnUtilityProcess: SpawnUtilityProcess = (file, args, options) => nodeSpawn(file, args, options),
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new Error(`Invalid Pi chat process PID: ${pid}.`));
  }
  const taskkill = spawnUtilityProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    taskkill.once("error", onError);
    taskkill.once("close", (code) => {
      taskkill.off("error", onError);
      if (code === 0) resolve();
      else reject(new Error(`taskkill.exe failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function onceClosed(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
