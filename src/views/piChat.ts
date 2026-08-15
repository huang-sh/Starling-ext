import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import * as cli from "../cli";
import { logError, logInfo } from "../logging";
import {
  PiChatEvent,
  PiChatSession,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
} from "../piChatSession";
import { isRecord, printable } from "../piChatProtocol";

export const PI_CHAT_VIEW_ID = "starling-pi-chat";

interface PendingUi {
  tokenSource: vscode.CancellationTokenSource;
  respond: (response: PiExtensionUiResponse) => void;
  timeout?: NodeJS.Timeout;
}

export class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private session: PiChatSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly pendingUi = new Map<string, PendingUi>();
  private generation = 0;
  private busy = false;
  private ready = false;
  private disposed = false;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = chatHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleWebviewMessage(message);
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.cancelPendingUi();
      void this.closeSession();
    });
    this.post({ type: "status", status: "Starting Starling…", busy: false });
    if (!this.session) void this.startSession();
  }

  async open(): Promise<void> {
    await focusChatView();
    if (this.view && !this.session) await this.startSession();
  }

  async newSession(): Promise<void> {
    await focusChatView();
    await this.startSession();
  }

  async chooseHistoricalSession(): Promise<void> {
    const sessions = (await cli.listSessions(200, "pi"))
      .filter((session) => Boolean(session.file_path) && path.isAbsolute(session.file_path));
    if (sessions.length === 0) {
      vscode.window.showInformationMessage("No Pi sessions with an absolute session file were found.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: session.custom_title || session.first_prompt?.slice(0, 80) || session.session_id,
        description: session.model || "SDK default model",
        detail: `${session.project_path || "(no project)"} • ${session.file_path}`,
        session,
      })),
      { title: "Resume Starling chat", placeHolder: "Select a historical Pi-backed session" },
    );
    if (!selected) return;
    await focusChatView();
    await this.startSession(selected.session.file_path, selected.session.project_path || undefined);
  }

  async abort(): Promise<void> {
    if (!this.session) return;
    this.post({ type: "status", status: "Stopping turn…", busy: this.busy });
    try {
      await this.session.abort();
    } catch (error) {
      this.reportError("Could not stop the Pi turn", error);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPendingUi();
    void this.closeSession();
  }

  private async startSession(sessionPath?: string, projectPath?: string): Promise<void> {
    const generation = ++this.generation;
    await this.closeSession(false);
    if (this.disposed || generation !== this.generation) return;

    const cwd = projectPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const configuration = vscode.workspace.getConfiguration("starling");
    const setting = configuration.get<string>("chatPiSetting", "").trim() || undefined;
    const executable = process.env.STARLING_BIN?.trim()
      || configuration.get<string>("cliPath", "starling").trim()
      || "starling";
    const starlingHome = cli.starlingHomePath();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // VS Code's workspace trust decision is authoritative for the embedded
      // chat. The SDK Host still prompts in the standalone TUI when this
      // explicit override is absent.
      STARLING_PROJECT_TRUST: vscode.workspace.isTrusted ? "always" : "never",
    };
    if (starlingHome) env.STARLING_HOME = starlingHome;
    const session = new PiChatSession({ executable, env });
    this.session = session;
    this.unsubscribe = session.events.on((event) => {
      if (this.session === session) void this.handleSessionEvent(session, event);
    });
    this.busy = false;
    this.ready = false;
    this.post({ type: "reset", status: sessionPath ? "Resuming Starling…" : "Starting Starling chat…" });

    try {
      await session.start({ cwd, sessionPath, setting });
      logInfo(`Starling chat started in ${cwd}${sessionPath ? ` from ${sessionPath}` : ""}.`);
    } catch (error) {
      await session.stop();
      if (this.session === session) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.session = undefined;
      }
      this.reportError("Starling chat failed to start", error);
    }
  }

  private async closeSession(invalidate = true): Promise<void> {
    if (invalidate) this.generation += 1;
    this.cancelPendingUi();
    const session = this.session;
    this.session = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.busy = false;
    this.ready = false;
    if (session) {
      try {
        await session.stop();
      } catch (error) {
        logError("Failed to close Starling chat session.", error);
      }
    }
  }

  private async handleWebviewMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "ready") {
      if (!this.session) await this.startSession();
      return;
    }
    if (value.type === "newSession") {
      await this.newSession();
      return;
    }
    if (value.type === "history") {
      try {
        await this.chooseHistoricalSession();
      } catch (error) {
        this.reportError("Could not list Pi sessions", error);
      }
      return;
    }
    if (value.type === "abort") {
      await this.abort();
      return;
    }
    if (value.type === "send" && typeof value.text === "string") {
      const text = value.text.trim();
      if (!text) return;
      const session = this.session;
      if (!session) {
        this.ready = false;
        this.busy = false;
        this.post({ type: "status", status: "Starling stopped — start a new session", busy: false, ready: false });
        return;
      }
      if (!this.ready) {
        this.post({ type: "status", status: "Starling is still starting…", busy: false });
        return;
      }
      const behavior = this.busy ? "followUp" as const : undefined;
      this.busy = true;
      this.post({ type: "busy", busy: true, status: behavior ? "Follow-up queued" : "Agent is working…" });
      try {
        await session.send(text, behavior);
      } catch (error) {
        this.busy = false;
        this.reportError("Could not send message to Starling", error);
      }
    }
  }

  private async handleSessionEvent(session: PiChatSession, event: PiChatEvent): Promise<void> {
    if (event.type === "ready") {
      this.ready = true;
      this.post({ type: "hydrate", messages: event.messages, state: presentState(event.state) });
      this.busy = Boolean(event.state.isStreaming);
      this.post({ type: "busy", busy: this.busy, status: this.busy ? "Agent is working…" : "Ready" });
      return;
    }
    if (event.type === "stderr") {
      const text = event.text.trim();
      if (text) logInfo(`[Starling chat] ${text}`);
      return;
    }
    if (event.type === "error") {
      this.reportError("Starling chat protocol error", event.error, false);
      return;
    }
    if (event.type === "exit") {
      this.busy = false;
      this.ready = false;
      this.post({
        type: "status",
        busy: false,
        ready: false,
        status: event.code === 0 ? "Stopped" : `Stopped (${event.code ?? event.signal ?? "unknown"})`,
      });
      if (this.session === session) {
        this.session = undefined;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
      return;
    }
    if (event.type === "extension_ui_request") {
      await this.handleExtensionUi(event.request, event.respond);
      return;
    }

    const rpc = event.value;
    switch (rpc.type) {
      case "agent_start":
        this.busy = true;
        this.post({ type: "turnStart" });
        this.post({ type: "busy", busy: true, status: "Agent is working…" });
        break;
      case "agent_settled":
        this.busy = false;
        this.post({ type: "busy", busy: false, status: "Ready" });
        break;
      case "message_update": {
        const update = isRecord(rpc.assistantMessageEvent) ? rpc.assistantMessageEvent : {};
        if ((update.type === "text_delta" || update.type === "thinking_delta") && typeof update.delta === "string") {
          this.post({ type: "assistantDelta", kind: update.type === "thinking_delta" ? "thinking" : "text", delta: update.delta });
        }
        break;
      }
      case "message_start": {
        const message = isRecord(rpc.message) ? rpc.message : {};
        if (message.role === "assistant") this.post({ type: "assistantStart" });
        break;
      }
      case "tool_execution_start":
        this.post({
          type: "toolStart",
          id: String(rpc.toolCallId ?? "tool"),
          name: String(rpc.toolName ?? "tool"),
          text: printable(rpc.args),
        });
        break;
      case "tool_execution_update":
        this.post({ type: "toolUpdate", id: String(rpc.toolCallId ?? "tool"), text: printable(rpc.partialResult) });
        break;
      case "tool_execution_end":
        this.post({
          type: "toolEnd",
          id: String(rpc.toolCallId ?? "tool"),
          text: printable(rpc.result),
          isError: rpc.isError === true,
        });
        break;
      case "session_info_changed":
        if (typeof rpc.name === "string") this.post({ type: "sessionName", value: rpc.name });
        break;
    }
  }

  private async handleExtensionUi(
    request: PiExtensionUiRequest,
    respond: (response: PiExtensionUiResponse) => void,
  ): Promise<void> {
    if (request.method === "notify") {
      const message = String(request.message ?? "");
      if (request.notifyType === "error") await vscode.window.showErrorMessage(message);
      else if (request.notifyType === "warning") await vscode.window.showWarningMessage(message);
      else await vscode.window.showInformationMessage(message);
      return;
    }
    if (!["select", "confirm", "input", "editor"].includes(request.method)) return;

    const tokenSource = new vscode.CancellationTokenSource();
    const timeout = typeof request.timeout === "number" && request.timeout > 0
      ? setTimeout(() => tokenSource.cancel(), request.timeout)
      : undefined;
    this.pendingUi.set(request.id, { tokenSource, respond, timeout });

    try {
      if (request.method === "select") {
        const options = Array.isArray(request.options) ? request.options.map(String) : [];
        const selected = await vscode.window.showQuickPick(options, {
          title: String(request.title ?? "Pi"),
          placeHolder: "The agent needs a selection",
          ignoreFocusOut: true,
        }, tokenSource.token);
        respond(selected === undefined ? { cancelled: true } : { value: selected });
      } else if (request.method === "confirm") {
        const selected = await vscode.window.showQuickPick([
          { label: "No", value: false },
          { label: "Yes", value: true },
        ], {
          title: String(request.title ?? "Agent confirmation"),
          placeHolder: String(request.message ?? "Confirm?"),
          ignoreFocusOut: true,
        }, tokenSource.token);
        respond(selected === undefined ? { cancelled: true } : { confirmed: selected.value });
      } else {
        const selected = await vscode.window.showInputBox({
          title: String(request.title ?? (request.method === "editor" ? "Agent editor" : "Agent input")),
          prompt: request.method === "editor" ? "Edit the value requested by Pi" : undefined,
          placeHolder: typeof request.placeholder === "string" ? request.placeholder : undefined,
          value: request.method === "editor" && typeof request.prefill === "string" ? request.prefill : undefined,
          ignoreFocusOut: true,
        }, tokenSource.token);
        respond(selected === undefined ? { cancelled: true } : { value: selected });
      }
    } catch (error) {
      respond({ cancelled: true });
      logError(`Pi extension UI request ${request.method} failed.`, error);
    } finally {
      const pending = this.pendingUi.get(request.id);
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.tokenSource.dispose();
        this.pendingUi.delete(request.id);
      }
    }
  }

  private cancelPendingUi(): void {
    for (const pending of this.pendingUi.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.tokenSource.cancel();
      pending.respond({ cancelled: true });
      pending.tokenSource.dispose();
    }
    this.pendingUi.clear();
  }

  private reportError(title: string, error: unknown, notify = true): void {
    const message = error instanceof Error ? error.message : String(error);
    logError(`${title}: ${message}`, error);
    this.post({ type: "error", message: `${title}: ${message}` });
    if (notify) vscode.window.showErrorMessage(`${title}: ${message}`);
  }

  private post(value: unknown): void {
    void this.view?.webview.postMessage(value);
  }
}

async function focusChatView(): Promise<void> {
  await vscode.commands.executeCommand(`${PI_CHAT_VIEW_ID}.focus`);
}

function presentState(state: Record<string, unknown>): Record<string, string> {
  const model = isRecord(state.model) ? state.model : {};
  const provider = typeof model.provider === "string" ? model.provider : "";
  const modelId = typeof model.id === "string" ? model.id : typeof model.modelId === "string" ? model.modelId : "";
  const modelLabel = [provider, modelId].filter(Boolean).join("/") || "SDK default";
  return {
    model: modelLabel,
    thinking: typeof state.thinkingLevel === "string" ? state.thinkingLevel : "",
    session: typeof state.sessionName === "string" && state.sessionName
      ? state.sessionName
      : typeof state.sessionId === "string" ? state.sessionId : "",
    sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : "",
  };
}

export function chatHtml(webview: Pick<vscode.Webview, "cspSource">): string {
  const nonce = randomBytes(18).toString("base64");
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --chat-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --surface: var(--vscode-editorWidget-background, var(--vscode-input-background));
      --border: var(--vscode-widget-border, var(--vscode-panel-border));
      --muted: var(--vscode-descriptionForeground);
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--chat-bg);
      font: var(--vscode-font-size)/1.5 var(--vscode-font-family);
    }
    button, textarea { font: inherit; }
    button { color: inherit; }
    #app { height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
    .thread-header {
      min-width: 0;
      min-height: 48px;
      padding: 8px 10px 6px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .thread-heading { min-width: 0; flex: 1; display: flex; align-items: center; gap: 8px; }
    .brand-mark {
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--vscode-textLink-foreground);
      background: var(--surface);
      font-size: 13px;
    }
    .thread-copy { min-width: 0; }
    #thread-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    #status { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; }
    .status-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    body.is-busy .status-dot { background: var(--vscode-progressBar-background); animation: pulse 1.4s ease-in-out infinite; }
    #status.error .status-dot { background: var(--vscode-errorForeground); }
    .toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; }
    .icon-button {
      width: 28px;
      height: 28px;
      padding: 0;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 7px;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      background: transparent;
      cursor: pointer;
    }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .icon-button svg { width: 16px; height: 16px; }
    #messages {
      min-height: 0;
      padding: 10px 12px 20px;
      overflow-y: auto;
      scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .empty-state {
      width: 100%;
      max-width: 330px;
      margin: auto;
      padding: 24px 12px 18vh;
      text-align: center;
      color: var(--muted);
    }
    .empty-mark {
      width: 42px;
      height: 42px;
      margin: 0 auto 15px;
      display: grid;
      place-items: center;
      border: 1px solid var(--border);
      border-radius: 14px;
      color: var(--vscode-textLink-foreground);
      background: var(--surface);
      box-shadow: 0 6px 20px color-mix(in srgb, var(--vscode-widget-shadow) 22%, transparent);
      font-size: 20px;
    }
    .empty-state h1 { margin: 0 0 7px; color: var(--vscode-foreground); font-size: 17px; line-height: 1.3; font-weight: 600; }
    .empty-state p { margin: 0; font-size: 12px; line-height: 1.55; }
    .conversation-item { width: 100%; max-width: 760px; margin-inline: auto; overflow-wrap: anywhere; }
    .message { white-space: pre-wrap; }
    .user {
      align-self: flex-end;
      width: fit-content;
      max-width: min(88%, 680px);
      margin-left: auto;
      padding: 9px 12px;
      border: 1px solid var(--vscode-chat-requestBorder, transparent);
      border-radius: 15px 15px 4px 15px;
      background: var(--vscode-chat-requestBackground, var(--vscode-input-background));
    }
    .assistant { align-self: stretch; padding: 0 2px; }
    .message-label { margin-bottom: 6px; display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 600; }
    .message-label .spark { color: var(--vscode-textLink-foreground); font-size: 12px; }
    .message-body { line-height: 1.58; }
    .thinking {
      margin: 0 0 10px;
      color: var(--muted);
      border-left: 2px solid var(--border);
      padding-left: 9px;
      font-size: 12px;
    }
    .thinking-summary { padding: 1px 0; cursor: pointer; user-select: none; }
    .thinking-summary::marker { color: var(--muted); }
    .thinking-body { margin-top: 6px; max-height: 180px; overflow: auto; white-space: pre-wrap; }
    .tool {
      align-self: stretch;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--surface) 72%, transparent);
      overflow: hidden;
    }
    .tool-summary {
      min-height: 34px;
      padding: 7px 9px;
      display: flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    .tool-summary::-webkit-details-marker { display: none; }
    .tool-icon { width: 17px; height: 17px; display: grid; place-items: center; border-radius: 5px; background: var(--vscode-textCodeBlock-background); color: var(--muted); font: 600 13px var(--vscode-editor-font-family); }
    .tool-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
    .tool-state { color: var(--muted); font-size: 11px; }
    .tool.running .tool-state { color: var(--vscode-textLink-foreground); }
    .tool.error .tool-state { color: var(--vscode-errorForeground); }
    .tool-body {
      margin: 0;
      padding: 9px 10px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      background: var(--vscode-textCodeBlock-background);
      font: 11px/1.5 var(--vscode-editor-font-family);
      white-space: pre-wrap;
      max-height: 240px;
      overflow: auto;
    }
    .error-message { padding: 10px; border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 55%, transparent); border-radius: 10px; color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent); }
    .composer-wrap { padding: 20px 10px 8px; background: linear-gradient(to bottom, transparent, var(--chat-bg) 18px); }
    .composer-shell {
      max-width: 760px;
      margin-inline: auto;
      padding: 8px 8px 7px 11px;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 16px;
      background: var(--vscode-input-background);
      box-shadow: 0 5px 18px color-mix(in srgb, var(--vscode-widget-shadow) 24%, transparent);
    }
    .composer-shell:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
    textarea {
      width: 100%;
      height: 44px;
      min-height: 44px;
      max-height: 160px;
      padding: 4px 5px 6px 0;
      resize: none;
      overflow-y: auto;
      border: 0;
      outline: 0;
      color: var(--vscode-input-foreground);
      background: transparent;
      line-height: 1.5;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    textarea:disabled { opacity: .65; }
    .composer-row { min-height: 28px; display: flex; align-items: center; gap: 8px; }
    .context { min-width: 0; flex: 1; display: flex; align-items: center; gap: 5px; overflow: hidden; }
    .context-pill { max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
    .context-pill + .context-pill::before { content: '·'; margin-right: 5px; }
    .composer-actions { display: flex; align-items: center; gap: 5px; }
    .composer-action {
      width: 28px;
      height: 28px;
      padding: 0;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 50%;
      cursor: pointer;
    }
    .composer-action svg { width: 15px; height: 15px; }
    #stop { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    #stop:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #send { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    #send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    #send:disabled { cursor: default; opacity: .42; }
    .composer-action:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    @keyframes pulse { 50% { opacity: .35; transform: scale(.8); } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; } }
  </style>
</head>
<body>
  <div id="app">
    <header class="thread-header">
      <div class="thread-heading">
        <span class="brand-mark" aria-hidden="true">✦</span>
        <div class="thread-copy">
          <div id="thread-name" title="New chat">New chat</div>
          <div id="status" role="status" aria-live="polite"><span class="status-dot" aria-hidden="true"></span><span id="status-label">Starting…</span></div>
        </div>
      </div>
      <div class="toolbar">
        <button id="history" class="icon-button" type="button" aria-label="Chat history" title="Chat history">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>
        </button>
        <button id="new" class="icon-button" type="button" aria-label="New chat" title="New chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </header>
    <main id="messages" aria-live="polite">
      <section id="empty-state" class="empty-state">
        <div class="empty-mark" aria-hidden="true">✦</div>
        <h1>What are we working on?</h1>
        <p>Ask Starling to build, review, or explain code in this workspace.</p>
      </section>
    </main>
    <footer class="composer-wrap">
      <div class="composer-shell">
        <textarea id="input" rows="1" aria-label="Message Starling" placeholder="Ask Starling to build, review, or explain…" disabled></textarea>
        <div class="composer-row">
          <div class="context" aria-label="Chat context">
            <span id="model" class="context-pill">Pi</span>
            <span id="thinking-level" class="context-pill" hidden></span>
          </div>
          <div class="composer-actions">
            <button id="stop" class="composer-action" type="button" aria-label="Stop agent" title="Stop agent" hidden>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
            </button>
            <button id="send" class="composer-action" type="button" aria-label="Send message" title="Send message" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg>
            </button>
          </div>
        </div>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const emptyState = document.getElementById('empty-state');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const stop = document.getElementById('stop');
    const status = document.getElementById('status');
    const statusLabel = document.getElementById('status-label');
    const threadName = document.getElementById('thread-name');
    const model = document.getElementById('model');
    const thinkingLevel = document.getElementById('thinking-level');
    const tools = new Map();
    let busy = false;
    let ready = false;
    let assistant = null;
    let assistantText = null;
    let assistantThinking = null;

    function scrollDown() { messages.scrollTop = messages.scrollHeight; }
    function resizeInput() {
      input.style.height = '0';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
    function node(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = String(text);
      return element;
    }
    function setEmptyState() {
      emptyState.hidden = Boolean(messages.querySelector('.conversation-item'));
    }
    function clearMessages() {
      messages.replaceChildren(emptyState);
      tools.clear();
      assistant = assistantText = assistantThinking = null;
      setEmptyState();
    }
    function thinkingBlock(text, open) {
      const details = node('details', 'thinking');
      details.open = Boolean(open);
      details.append(node('summary', 'thinking-summary', 'Thought process'), node('div', 'thinking-body', text || ''));
      return details;
    }
    function toolBlock(name, text, state, isError, open) {
      const box = node('details', 'conversation-item tool' + (isError ? ' error' : '') + (state === 'Running' ? ' running' : ''));
      box.open = Boolean(open);
      const summary = node('summary', 'tool-summary');
      summary.append(node('span', 'tool-icon', '>'), node('span', 'tool-title', name || 'Tool'), node('span', 'tool-state', state));
      const body = node('pre', 'tool-body', text || '');
      box.append(summary, body);
      return { box, body, state: summary.lastElementChild };
    }
    function addMessage(role, text, thinking, toolName, isError) {
      if (role === 'tool') {
        const tool = toolBlock(toolName, text, isError ? 'Failed' : 'Done', isError, Boolean(isError));
        messages.append(tool.box);
        setEmptyState();
        return tool.box;
      }
      const box = node('section', 'conversation-item message ' + role);
      if (role === 'assistant') {
        const label = node('div', 'message-label');
        label.append(node('span', 'spark', '✦'), document.createTextNode('Starling'));
        box.append(label);
        if (thinking) box.append(thinkingBlock(thinking, false));
      }
      box.append(node('div', 'message-body', text || ''));
      messages.append(box);
      setEmptyState();
      return box;
    }
    function ensureAssistant() {
      if (assistant) return;
      assistant = node('section', 'conversation-item message assistant');
      const label = node('div', 'message-label');
      label.append(node('span', 'spark', '✦'), document.createTextNode('Starling'));
      assistantThinking = thinkingBlock('', true);
      assistantThinking.hidden = true;
      assistantText = node('div', 'message-body', '');
      assistant.append(label, assistantThinking, assistantText);
      messages.append(assistant);
      setEmptyState();
    }
    function refreshComposer() {
      const actionLabel = busy ? 'Queue follow-up' : 'Send message';
      send.disabled = !ready || !input.value.trim();
      send.setAttribute('aria-label', actionLabel);
      send.title = actionLabel;
      stop.hidden = !busy;
    }
    function setThreadTitle(value, file) {
      const title = String(value || 'New chat');
      threadName.textContent = title;
      threadName.title = String(file || title);
    }
    function setBusy(next, label) {
      busy = Boolean(next);
      document.body.classList.toggle('is-busy', busy);
      status.classList.toggle('error', label === 'Error');
      statusLabel.textContent = label || (busy ? 'Agent is working…' : 'Ready');
      refreshComposer();
    }
    function setReady(next) {
      ready = Boolean(next);
      input.disabled = !ready;
      refreshComposer();
      if (ready) input.focus();
    }
    function submit() {
      if (!ready) return;
      const text = input.value.trim();
      if (!text) return;
      addMessage('user', text);
      input.value = '';
      resizeInput();
      refreshComposer();
      if (!busy) assistant = assistantText = assistantThinking = null;
      scrollDown();
      vscode.postMessage({ type: 'send', text });
    }
    document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    document.getElementById('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));
    stop.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
    send.addEventListener('click', submit);
    input.addEventListener('input', () => { resizeInput(); refreshComposer(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    });
    window.addEventListener('message', (event) => {
      const value = event.data || {};
      if (value.type === 'reset') {
        clearMessages();
        setThreadTitle('New chat');
        model.textContent = 'Pi';
        thinkingLevel.hidden = true;
        setReady(false);
        setBusy(false, value.status || 'Starting…');
      } else if (value.type === 'hydrate') {
        clearMessages();
        for (const item of value.messages || []) addMessage(item.role, item.text, item.thinking, item.toolName, item.isError);
        const state = value.state || {};
        model.textContent = String(state.model || 'Pi');
        thinkingLevel.textContent = state.thinking ? 'thinking ' + state.thinking : '';
        thinkingLevel.hidden = !state.thinking;
        setThreadTitle(state.session, state.sessionFile);
        setReady(true);
      } else if (value.type === 'busy') {
        setBusy(value.busy, value.status);
      } else if (value.type === 'turnStart') {
        assistant = assistantText = assistantThinking = null;
      } else if (value.type === 'assistantStart') {
        assistant = assistantText = assistantThinking = null;
      } else if (value.type === 'assistantDelta') {
        ensureAssistant();
        if (value.kind === 'thinking') {
          assistantThinking.hidden = false;
          assistantThinking.open = true;
          assistantThinking.lastElementChild.textContent += String(value.delta || '');
        } else {
          assistantThinking.open = false;
          assistantText.textContent += String(value.delta || '');
        }
      } else if (value.type === 'toolStart') {
        const tool = toolBlock(value.name, value.text, 'Running', false, true);
        tools.set(String(value.id), tool);
        messages.append(tool.box);
        setEmptyState();
      } else if (value.type === 'toolUpdate' || value.type === 'toolEnd') {
        const tool = tools.get(String(value.id));
        if (tool) {
          tool.body.textContent = String(value.text || '');
          if (value.type === 'toolEnd') {
            tool.box.classList.remove('running');
            tool.box.classList.toggle('error', Boolean(value.isError));
            tool.state.textContent = value.isError ? 'Failed' : 'Done';
            tool.box.open = Boolean(value.isError);
          }
        }
      } else if (value.type === 'sessionName') {
        setThreadTitle(value.value);
      } else if (value.type === 'status') {
        setBusy(value.busy, value.status);
        if (typeof value.ready === 'boolean') setReady(value.ready);
      } else if (value.type === 'error') {
        addMessage('assistant', value.message || 'Starling chat error').classList.add('error-message');
        setBusy(false, 'Error');
      }
      scrollDown();
    });
    resizeInput();
    refreshComposer();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
