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

function chatHtml(webview: vscode.Webview): string {
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
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size)/1.45 var(--vscode-font-family); }
    #app { height: 100%; display: grid; grid-template-rows: auto 1fr auto; }
    header { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); display: grid; gap: 7px; }
    .toolbar { display: flex; align-items: center; gap: 6px; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 4px 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #status { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    #meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #messages { padding: 12px 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
    .message { border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user { align-self: flex-end; max-width: 92%; background: var(--vscode-inputOption-activeBackground); border: 1px solid var(--vscode-inputOption-activeBorder); }
    .assistant { align-self: stretch; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
    .thinking { color: var(--vscode-descriptionForeground); font-style: italic; border-left: 2px solid var(--vscode-focusBorder); padding-left: 8px; margin-bottom: 7px; white-space: pre-wrap; }
    .tool { align-self: stretch; background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-charts-blue); padding: 7px 9px; }
    .tool.error { border-left-color: var(--vscode-errorForeground); }
    .tool-title { font-weight: 600; margin-bottom: 4px; }
    .tool-body { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); white-space: pre-wrap; max-height: 220px; overflow: auto; }
    .error-message { color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
    footer { border-top: 1px solid var(--vscode-panel-border); padding: 8px 10px; display: grid; gap: 6px; }
    textarea { width: 100%; min-height: 68px; max-height: 220px; resize: vertical; padding: 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); font: inherit; }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .send-row { display: flex; justify-content: flex-end; gap: 6px; }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <div class="toolbar">
        <button id="new" class="secondary" type="button">New</button>
        <button id="history" class="secondary" type="button">History</button>
        <span id="status">Starting…</span>
      </div>
      <div id="meta">Pi</div>
    </header>
    <main id="messages" aria-live="polite"></main>
    <footer>
      <textarea id="input" aria-label="Message Pi" placeholder="Ask Pi… (Shift+Enter for a new line)" disabled></textarea>
      <div class="send-row">
        <button id="stop" class="secondary" type="button">Stop</button>
        <button id="send" type="button" disabled>Send</button>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const status = document.getElementById('status');
    const meta = document.getElementById('meta');
    const tools = new Map();
    let busy = false;
    let ready = false;
    let assistant = null;
    let assistantText = null;
    let assistantThinking = null;

    function scrollDown() { messages.scrollTop = messages.scrollHeight; }
    function node(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = String(text);
      return element;
    }
    function addMessage(role, text, thinking, toolName, isError) {
      if (role === 'tool') {
        const box = node('section', 'tool' + (isError ? ' error' : ''));
        box.append(node('div', 'tool-title', toolName || 'Tool'), node('div', 'tool-body', text || ''));
        messages.append(box);
        return;
      }
      const box = node('section', 'message ' + role);
      if (thinking) box.append(node('div', 'thinking', thinking));
      box.append(node('div', '', text || ''));
      messages.append(box);
    }
    function ensureAssistant() {
      if (assistant) return;
      assistant = node('section', 'message assistant');
      assistantThinking = node('div', 'thinking', '');
      assistantThinking.hidden = true;
      assistantText = node('div', '', '');
      assistant.append(assistantThinking, assistantText);
      messages.append(assistant);
    }
    function setBusy(next, label) {
      busy = Boolean(next);
      send.textContent = busy ? 'Queue follow-up' : 'Send';
      status.textContent = label || (busy ? 'Agent is working…' : 'Ready');
    }
    function setReady(next) {
      ready = Boolean(next);
      input.disabled = !ready;
      send.disabled = !ready;
      if (ready) input.focus();
    }
    function submit() {
      if (!ready) return;
      const text = input.value.trim();
      if (!text) return;
      addMessage('user', text);
      input.value = '';
      if (!busy) assistant = assistantText = assistantThinking = null;
      scrollDown();
      vscode.postMessage({ type: 'send', text });
    }
    document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    document.getElementById('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));
    document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    });
    window.addEventListener('message', (event) => {
      const value = event.data || {};
      if (value.type === 'reset') {
        messages.replaceChildren(); tools.clear(); assistant = assistantText = assistantThinking = null;
        setReady(false);
        setBusy(false, value.status || 'Starting…');
      } else if (value.type === 'hydrate') {
        messages.replaceChildren(); tools.clear(); assistant = assistantText = assistantThinking = null;
        for (const item of value.messages || []) addMessage(item.role, item.text, item.thinking, item.toolName, item.isError);
        const state = value.state || {};
        const parts = [state.model, state.thinking && ('thinking: ' + state.thinking), state.session].filter(Boolean);
        meta.textContent = parts.join(' • ') || 'Pi';
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
          assistantThinking.textContent += String(value.delta || '');
        } else assistantText.textContent += String(value.delta || '');
      } else if (value.type === 'toolStart') {
        const box = node('section', 'tool');
        const body = node('div', 'tool-body', value.text || '');
        box.append(node('div', 'tool-title', value.name || 'Tool'), body);
        tools.set(String(value.id), { box, body }); messages.append(box);
      } else if (value.type === 'toolUpdate' || value.type === 'toolEnd') {
        const tool = tools.get(String(value.id));
        if (tool) { tool.body.textContent = String(value.text || ''); if (value.isError) tool.box.classList.add('error'); }
      } else if (value.type === 'sessionName') {
        meta.textContent = String(value.value || 'Pi');
      } else if (value.type === 'status') {
        setBusy(value.busy, value.status);
        if (typeof value.ready === 'boolean') setReady(value.ready);
      } else if (value.type === 'error') {
        addMessage('assistant', value.message || 'Starling chat error');
        messages.lastElementChild.classList.add('error-message');
        setBusy(false, 'Error');
      }
      scrollDown();
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
