import * as vscode from "vscode";
import { readFileSync } from "fs";
import { join } from "path";
import type * as cli from "../cli";
import { LiveStatusStore, monitorIdentityKey } from "../providers/liveStatus";
import { getConfiguredMonitorAgentMode, monitorAgentLabel } from "../monitorAgent";
import { getConfiguredMonitorSort, monitorSortLabel } from "../monitorSort";
import { TRAJECTORY_MD_JS } from "./trajectoryMarkdown";

const PANEL_TITLE = "Starling Monitor";

/**
 * Editor-panel webview dashboard for the live monitor.
 *
 * Layout: header stat cards → toolbar (search, status pills, agent filter,
 * pinned toggle) → session card grid with status pills, ctx meters, and
 * token sparklines. Clicking a card opens a detail drawer with full metrics,
 * skill usage, recent tools/chat tail, and Resume/Details/Trajectory actions.
 *
 * Live data comes from the shared LiveStatusStore (the same background poll
 * that drives the sidebar Monitor tree); the panel only listens and pushes
 * snapshots into the webview, which re-renders in place preserving filters,
 * scroll, and the open drawer.
 */
export class MonitorPanel {
  public static currentPanel: MonitorPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _disposed = false;
  private _lastToken = "";

  private constructor(panel: vscode.WebviewPanel, private readonly store: LiveStatusStore) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage((msg: unknown) => this.onMessage(msg), null, this._disposables);
    this._disposables.push(
      store.onDidChange((snapshot) => this.pushSnapshot(snapshot)),
      store.onDidStatusChange((snapshot) => this.pushSnapshot(snapshot))
    );
  }

  public static async createOrShow(store: LiveStatusStore): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MonitorPanel.currentPanel) {
      MonitorPanel.currentPanel._panel.reveal(column);
      await MonitorPanel.currentPanel.pushLatest(store);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starling-monitor",
      PANEL_TITLE,
      column || vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const instance = new MonitorPanel(panel, store);
    MonitorPanel.currentPanel = instance;
    panel.webview.html = renderMonitorHtml();
    await instance.pushLatest(store);
  }

  private async pushLatest(store: LiveStatusStore): Promise<void> {
    const snapshot = await store.ensureSnapshot();
    if (snapshot) this.pushSnapshot(snapshot);
  }

  private pushSnapshot(snapshot: cli.MonitorSnapshot): void {
    if (this._disposed) return;
    const payload = buildPayload(snapshot);
    const token = payload.rows.map((r) => `${r.k}:${r.st}:${r.pid ?? ""}:${r.ctx}:${r.tin}:${r.tout}:${r.lastAct}:${r.task}`).join("|");
    if (token === this._lastToken) return;
    this._lastToken = token;
    void this._panel.webview.postMessage({ type: "update", payload });
  }

  private onMessage(msg: unknown): void {
    const m = msg as { type?: string; action?: string; sid?: string; text?: string; row?: PanelRow };
    if (!m || typeof m.type !== "string") return;
    switch (m.type) {
      case "refresh":
        void this.store.refresh({ force: true });
        break;
      case "copy":
        if (typeof m.text === "string") void vscode.env.clipboard.writeText(m.text);
        break;
      case "action": {
        const row = m.row;
        if (!row || typeof row.sid !== "string") return;
        // Shape accepted by pickSessionId()/extractSessionHint(): the meta
        // carries the id, the monitor block refines ambiguous id matches.
        const node = {
          meta: { session_id: row.sid },
          monitor: {
            session_id: row.sid,
            canonical_session_id: row.csid || row.sid,
            provider: row.provider,
            project_path: row.project,
            file_path: row.file,
            title: row.title,
            current_task: row.task,
          },
        };
        if (m.action === "resume") void vscode.commands.executeCommand("starling.resume", node);
        else if (m.action === "show") void vscode.commands.executeCommand("starling.showSession", node);
        else if (m.action === "trajectory") void vscode.commands.executeCommand("starling.sessionTrajectory", node);
        break;
      }
    }
  }

  private dispose(): void {
    this._disposed = true;
    MonitorPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }
}

// ---------------------------------------------------------------------------
// Data model shipped to the webview
// ---------------------------------------------------------------------------

interface PanelRow {
  k: string;            // identity key
  sid: string;          // session id (source)
  csid: string;         // canonical session id
  title: string;
  provider: string;
  model: string;
  st: cli.LiveStatus;   // status
  pid?: number;
  cpu?: number;
  mem?: number;
  ctx: number;          // ctx pct (-1 unknown)
  tin: number;
  tout: number;
  tcache: number;
  tool: string | null;
  tcnt: number;
  skill: string | null;
  scnt: number;
  project: string;
  file?: string;
  cat?: string;
  pinned: boolean;
  started: number;      // started_at_ms
  elapsed: number;      // elapsed_secs
  lastAct: number;      // last_activity_ms
  comp: number;         // compaction count
  task: string;
  tokHist: number[];
  ctxHist: number[];
  tools: Array<{ n: string; a: string; d: number }>;
  skills: Array<{ n: string; c: number; e: number; i: number }>;
  chat: Array<{ r: string; t: string }>;
}

function buildPayload(snapshot: cli.MonitorSnapshot) {
  const all = snapshot.rows ?? [...snapshot.pinned, ...snapshot.recent];
  const seen = new Set<string>();
  const rows: PanelRow[] = [];
  for (const r of all) {
    const key = monitorIdentityKey(r);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      k: key,
      sid: r.session_id,
      csid: r.canonical_session_id || r.session_id,
      title: r.title,
      provider: r.provider,
      model: r.model,
      st: r.status,
      pid: r.pid,
      cpu: r.cpu_pct,
      mem: r.mem_kb,
      ctx: r.ctx_pct,
      tin: r.tokens_in,
      tout: r.tokens_out,
      tcache: r.tokens_cache,
      tool: r.last_tool,
      tcnt: r.tool_count,
      skill: r.last_skill,
      scnt: r.skill_count,
      project: r.project_path,
      file: r.file_path,
      cat: r.catalog,
      pinned: r.pinned,
      started: r.started_at_ms,
      elapsed: r.elapsed_secs,
      lastAct: r.last_activity_ms,
      comp: r.compaction_count,
      task: r.current_task,
      tokHist: r.token_history ?? [],
      ctxHist: r.context_history ?? [],
      tools: (r.tool_calls_tail ?? []).map((t) => ({ n: t.name, a: t.arg, d: t.duration_ms })),
      skills: (r.skill_usage ?? []).map((s) => ({ n: s.name, c: s.count, e: s.explicit, i: s.implicit })),
      chat: (r.chat_tail ?? []).map((c) => ({ r: c.role, t: c.text })),
    });
  }
  return {
    ts: Date.now(),
    agentLabel: monitorAgentLabel(getConfiguredMonitorAgentMode()),
    sortLabel: monitorSortLabel(getConfiguredMonitorSort()),
    rows,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** JSON-embed: escape so the payload can never close its <script> tag. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/** marked + hljs vendored from pi's export-html template, same as the
 *  trajectory panel; chat tail then renders as markdown, not raw text. */
let markdownBundleCache: string | null | undefined;
function markdownItInlineScript(): string {
  if (markdownBundleCache === undefined) {
    try {
      const markedJs = readFileSync(join(__dirname, "..", "..", "assets", "vendor", "marked.min.js"), "utf-8");
      const hljsJs = readFileSync(join(__dirname, "..", "..", "assets", "vendor", "highlight.min.js"), "utf-8");
      markdownBundleCache = `<script>${markedJs}</script><script>${hljsJs}</script>`;
    } catch {
      markdownBundleCache = null;
    }
  }
  return markdownBundleCache ?? "";
}

function renderMonitorHtml(): string {
  const payload = { ts: 0, agentLabel: "", sortLabel: "", rows: [] };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --line: var(--vscode-widget-border);
    --card: var(--vscode-editor-background);
    --cardbg: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; font-size: 13px; }

  /* Header */
  header { position: sticky; top: 0; z-index: 30; background: var(--vscode-editor-background);
           border-bottom: 1px solid var(--line); padding: 12px 18px 10px; }
  .htop { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 16px; letter-spacing: .2px; }
  .live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
          color: var(--vscode-descriptionForeground); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-charts-green, #89d185);
         animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  .spacer { flex: 1; }
  button.hbtn { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                border: none; border-radius: 4px; padding: 4px 12px; font: inherit; font-size: 12px;
                cursor: pointer; }
  button.hbtn:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }

  /* Stat cards */
  .stats { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .stat { min-width: 108px; flex: 1 1 108px; max-width: 170px; border: 1px solid var(--line);
          border-radius: 8px; padding: 8px 12px 7px; background: var(--cardbg); }
  .stat .v { font-size: 21px; font-weight: 650; line-height: 1.15; }
  .stat .l { font-size: 10.5px; color: var(--vscode-descriptionForeground); text-transform: uppercase;
             letter-spacing: .5px; margin-top: 1px; }
  .stat.warn .v { color: var(--vscode-charts-yellow, #cca700); }
  .stat.err .v { color: var(--vscode-charts-red, #f14c4c); }
  .stat.ok .v { color: var(--vscode-charts-green, #89d185); }
  .stat.blue .v { color: var(--vscode-charts-blue, #3794ff); }

  /* Toolbar */
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
  .search { flex: 1 1 220px; min-width: 180px; display: flex; align-items: center; gap: 6px;
            background: var(--vscode-input-background); border: 1px solid var(--line); border-radius: 5px; padding: 4px 9px; }
  .search input { flex: 1; background: none; border: none; outline: none; color: var(--vscode-input-foreground); font: inherit; }
  .filters { display: flex; gap: 4px; flex-wrap: wrap; }
  .fbtn { font-size: 11px; padding: 3px 9px; border: 1px solid var(--line); border-radius: 11px;
          background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; }
  .fbtn.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background);
             border-color: var(--vscode-button-background); }
  select.mini { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
                border: 1px solid var(--line); border-radius: 4px; font-size: 11.5px; padding: 3px 5px; }
  .count { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }

  /* Card grid */
  main { padding: 12px 18px 40vh; display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
         gap: 10px; align-items: start; }
  .card { border: 1px solid var(--line); border-radius: 10px; background: var(--cardbg); padding: 10px 12px;
          cursor: pointer; transition: border-color .12s ease; position: relative; }
  .card:hover { border-color: var(--vscode-focusBorder, var(--line)); }
  .card.sel { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }
  .card.attn { border-color: var(--vscode-charts-yellow, #cca700); }
  .chead { display: flex; align-items: center; gap: 8px; }
  .sdot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .st-running { background: var(--vscode-charts-green, #89d185); animation: pulse 1.6s ease-in-out infinite; }
  .st-waiting { background: var(--vscode-charts-yellow, #cca700); }
  .st-stale_running { background: var(--vscode-charts-orange, #d18616); }
  .st-idle { background: var(--vscode-charts-blue, #3794ff); }
  .st-aborted { background: var(--vscode-charts-orange, #d18616); }
  .st-failure { background: var(--vscode-charts-red, #f14c4c); }
  .st-stopped { background: var(--vscode-descriptionForeground); }
  .st-orphaned { background: var(--vscode-charts-orange, #d18616); opacity: .7; }
  .st-unknown { background: var(--vscode-disabledForeground); }
  .ctitle { font-weight: 600; font-size: 12.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill { font-size: 10px; padding: 1px 8px; border-radius: 9px; border: 1px solid var(--line);
          color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .pill.pin { color: var(--vscode-charts-blue, #3794ff); }
  .cmeta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 11px;
           color: var(--vscode-descriptionForeground); }
  .badge { border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; font-size: 10.5px; }
  .badge.ag { color: var(--vscode-charts-purple, #c586c0); }
  /* ctx meter */
  .meter { height: 4px; border-radius: 2px; background: var(--vscode-input-background); overflow: hidden;
           margin-top: 8px; position: relative; }
  .meter i { display: block; height: 100%; border-radius: 2px; background: var(--vscode-charts-blue, #3794ff); }
  .meter i.hot { background: var(--vscode-charts-yellow, #cca700); }
  .meter i.crit { background: var(--vscode-charts-red, #f14c4c); }
  .mrow { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  /* task + footer */
  .task { margin-top: 7px; font-size: 11px; color: var(--vscode-foreground); opacity: .85;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic; }
  .cfoot { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 10.5px;
           color: var(--vscode-descriptionForeground); }
  .sp { width: 84px; height: 18px; }
  .sp polyline { stroke: var(--vscode-charts-green, #89d185); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .sp.ctx polyline { stroke: var(--vscode-charts-blue, #3794ff); }
  .empty { grid-column: 1 / -1; color: var(--vscode-descriptionForeground); padding: 40px 0; text-align: center; }

  /* Drawer */
  #insp { position: fixed; right: -48%; top: 0; bottom: 0; width: 47%; z-index: 40;
          background: var(--cardbg); border-left: 1px solid var(--line); padding: 14px 18px;
          overflow-y: auto; transition: right .18s ease; }
  #insp.open { right: 0; }
  #insp h3 { margin: 0 0 6px; font-size: 14px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  #insp .x { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 4px; }
  .abtn { font-size: 11.5px; padding: 3px 11px; border-radius: 4px; border: 1px solid var(--line);
          background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  .abtn.sec { background: transparent; color: var(--vscode-foreground); }
  .abtn:hover { opacity: .88; }
  .kv { display: grid; grid-template-columns: 108px 1fr; gap: 3px 10px; font-size: 12px; margin: 8px 0 12px; }
  .kv dt { color: var(--vscode-descriptionForeground); }
  .kv dd { margin: 0; word-break: break-all; }
  #insp h4 { margin: 14px 0 4px; font-size: 12.5px; }
  .bigsp { padding: 2px 6px; background: var(--vscode-textBlockQuote-background); border-radius: 6px; }
  .bigsp .sp { width: 100%; height: 40px; display: block; }
  .msg { margin: 5px 0; padding: 6px 9px; border-radius: 6px; background: var(--vscode-textBlockQuote-background);
         font-size: 11.5px; max-height: 220px; overflow: auto; }
  .msg .who { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--vscode-descriptionForeground); }
  .msg.user .who { color: var(--vscode-charts-green, #89d185); }
  .msg.assistant .who { color: var(--vscode-charts-blue, #3794ff); }
  /* markdown inside chat messages (same pipeline as trajectory panel) */
  .msg pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0; padding: 8px;
             background: var(--vscode-input-background); border-radius: 4px; }
  .msg .md { font-size: 11.5px; line-height: 1.5; }
  .msg .md > :first-child { margin-top: 0; } .msg .md > :last-child { margin-bottom: 0; }
  .msg .md p { margin: 4px 0; }
  .msg .md ul, .msg .md ol { margin: 4px 0; padding-left: 20px; }
  .msg .md li { margin: 1px 0; }
  .msg .md li::marker { color: var(--vscode-charts-blue, #3794ff); }
  .msg .md blockquote { margin: 4px 0; padding: 1px 8px; border-left: 3px solid var(--vscode-textLink-foreground);
                        color: var(--vscode-descriptionForeground); }
  .msg .md code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
                  background: var(--vscode-input-background); padding: 1px 4px; border-radius: 3px; }
  .msg .md pre code { background: none; padding: 0; display: block; }
  .msg .md table { border-collapse: collapse; margin: 6px 0; }
  .msg .md th, .msg .md td { border: 1px solid var(--line); padding: 2px 7px; font-size: 11px; text-align: left; }
  .msg .md th { background: var(--vscode-input-background); font-weight: 600; }
  .msg .md hr { border: none; border-top: 1px solid var(--line); margin: 8px 0; }
  .msg .md a { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .msg .md img { max-width: 100%; }
  .hljs { background: transparent; }
  .hljs-comment, .hljs-quote { color: var(--vscode-gitDecoration-untrackedResourceForeground, #6a9955); font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-meta { color: var(--vscode-charts-pink, #c586c0); }
  .hljs-number, .hljs-literal { color: var(--vscode-charts-orange, #b5cea8); }
  .hljs-string, .hljs-doctag { color: var(--vscode-terminal-ansiGreen, #ce9178); }
  .hljs-function, .hljs-title, .hljs-title.function_, .hljs-section, .hljs-name { color: var(--vscode-charts-yellow, #dcdcaa); }
  .hljs-type, .hljs-class, .hljs-title.class_, .hljs-built_in { color: var(--vscode-charts-blue, #4ec9b0); }
  .hljs-attr, .hljs-variable, .hljs-variable.language_, .hljs-params, .hljs-property { color: var(--vscode-charts-blue, #9cdcfe); }
  .trow { display: flex; gap: 8px; font-size: 11.5px; padding: 2px 0; }
  .trow .tn { color: var(--vscode-terminal-ansiYellow, #cca700); min-width: 130px; overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
  .trow .ta { color: var(--vscode-descriptionForeground); flex: 1; overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
  .trow .td { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <div class="htop">
    <h2>Starling Monitor</h2>
    <span class="live"><span class="dot"></span><span id="ts">connecting…</span></span>
    <span class="count" id="cfg"></span>
    <span class="spacer"></span>
    <button class="hbtn" id="refresh">⟳ Refresh</button>
  </div>
  <div class="stats" id="stats"></div>
  <div class="toolbar">
    <div class="search">🔎 <input id="q" placeholder="Search title, model, project, task, id…" spellcheck="false"></div>
    <div class="filters" id="stf"></div>
    <select class="mini" id="agent"><option value="">all agents</option></select>
    <button class="fbtn" id="pinned">📌 pinned</button>
    <span class="count" id="count"></span>
  </div>
</header>
<main id="main"><div class="empty">Loading monitor snapshot…</div></main>
<div id="insp"><div id="inspbody"></div></div>
<script id="data" type="application/json">${embedJson(payload)}</script>
${markdownItInlineScript()}
<script>
(function () {
${TRAJECTORY_MD_JS}
  const D = JSON.parse(document.getElementById("data").textContent);
  const $ = (id) => document.getElementById(id);
  const state = { q: "", hidden: new Set(), agent: "", pinned: false, sel: null };
  const ST_LABEL = { waiting: "waiting", idle: "idle", running: "running", stale_running: "stale",
                     aborted: "aborted", failure: "failure", stopped: "stopped", orphaned: "orphaned",
                     unknown: "unknown" };

  // ---- helpers ----
  function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function kfmt(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }
  function dur(s) {
    s = Number(s) || 0;
    if (s <= 0) return "—";
    if (s < 60) return Math.floor(s) + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  }
  function ago(ms) {
    if (!ms || ms <= 0) return "—";
    const d = Math.max(0, (Date.now() - ms) / 1000);
    if (d < 5) return "just now";
    if (d < 60) return Math.floor(d) + "s ago";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
  }
  function mem(kb) {
    kb = Number(kb) || 0;
    if (!kb || kb <= 0) return "—";
    if (kb < 1024) return kb + "K";
    const mb = kb / 1024;
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + "M";
    return (mb / 1024).toFixed(2) + "G";
  }
  function spark(arr, w, h, cls, style) {
    if (!arr || arr.length < 2) return "";
    const mx = Math.max.apply(null, arr);
    const mn = Math.min.apply(null, arr);
    const span = (mx - mn) || 1;
    const pts = arr.map(function (v, i) {
      return (i / (arr.length - 1) * w).toFixed(1) + "," + (h - ((v - mn) / span) * (h - 2) - 1).toFixed(1);
    });
    return "<svg class='sp " + (cls || "") + "'" + (style ? " style='" + style + "'" : "") +
      "' viewBox='0 0 " + w + " " + h + "' preserveAspectRatio='none'><polyline points='" + pts.join(" ") + "' fill='none'/></svg>";
  }
  function ctxCls(pct) { return pct >= 90 ? "crit" : pct >= 70 ? "hot" : ""; }
  function send(m) { vscode.postMessage(m); }
  const vscode = acquireVsCodeApi();

  // ---- header stats ----
  function renderStats(rows) {
    const c = { active: 0, running: 0, waiting: 0, failure: 0, pinned: 0 };
    for (const r of rows) {
      if (r.pid != null) c.active++;
      if (r.st === "running") c.running++;
      if (r.st === "waiting") c.waiting++;
      if (r.st === "failure") c.failure++;
      if (r.pinned) c.pinned++;
    }
    $("stats").innerHTML = [
      ["Active", c.active, "blue"], ["Running", c.running, "ok"], ["Waiting", c.waiting, "warn"],
      ["Failures", c.failure, "err"], ["Pinned", c.pinned, ""], ["Sessions", rows.length, ""],
    ].map(function (s) {
      return "<div class='stat " + s[2] + "'><div class='v'>" + s[1] + "</div><div class='l'>" + s[0] + "</div></div>";
    }).join("");
  }

  // ---- status filter pills (only non-empty statuses); track hidden so a
  // status appearing after load is visible by default ----
  let lastStatusKey = "";
  function renderStatusFilters(rows) {
    const present = {};
    rows.forEach(function (r) { present[r.st] = (present[r.st] || 0) + 1; });
    const key = Object.keys(present).sort().join(",");
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    const bar = $("stf");
    bar.innerHTML = "";
    Object.keys(present).forEach(function (st) {
      const b = document.createElement("button");
      b.className = "fbtn" + (state.hidden.has(st) ? "" : " on");
      b.textContent = (ST_LABEL[st] || st) + " " + present[st];
      b.onclick = function () {
        if (state.hidden.has(st)) { state.hidden.delete(st); b.classList.add("on"); }
        else { state.hidden.add(st); b.classList.remove("on"); }
        render();
      };
      bar.appendChild(b);
    });
  }

  // ---- agent select ----
  function renderAgentFilter(rows) {
    const agents = {};
    rows.forEach(function (r) { if (r.provider) agents[r.provider] = (agents[r.provider] || 0) + 1; });
    const sel = $("agent");
    const current = sel.value;
    sel.innerHTML = "<option value=''>all agents</option>" + Object.keys(agents).sort().map(function (a) {
      return "<option value='" + esc(a) + "'>" + esc(a) + " (" + agents[a] + ")</option>";
    }).join("");
    if (current) sel.value = current;
  }

  // ---- filter + sort ----
  function isActive(r) { return r.pid != null; }
  const ST_W = { waiting: 0, failure: 1, running: 2, stale_running: 3, aborted: 4, orphaned: 4, idle: 5, stopped: 6, unknown: 7 };
  function match(r) {
    if (state.hidden.has(r.st)) return false;
    if (state.agent && r.provider !== state.agent) return false;
    if (state.pinned && !r.pinned) return false;
    if (!state.q) return true;
    return (r.title + " " + r.model + " " + r.project + " " + r.task + " " + r.sid + " " + r.csid + " " + (r.cat || ""))
      .toLowerCase().includes(state.q);
  }
  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      const w = (ST_W[a.st] ?? 9) - (ST_W[b.st] ?? 9);
      if (w !== 0) return w;
      return (b.lastAct || 0) - (a.lastAct || 0);
    });
  }

  // ---- cards ----
  function cardHtml(r) {
    const sid = r.csid || r.sid;
    const title = r.title && r.title !== sid ? r.title : sid.slice(0, 13);
    const ctx = r.ctx != null && r.ctx >= 0 ? r.ctx : null;
    const ctxMeter = ctx != null
      ? "<div class='meter'><i class='" + ctxCls(ctx) + "' style='width:" + Math.min(100, ctx) + "%'></i></div>" +
        "<div class='mrow'><span>ctx " + ctx.toFixed(0) + "%</span><span>" + (r.comp ? "comp ×" + r.comp : "") + "</span></div>"
      : "";
    const meta = [
      r.provider ? "<span class='badge ag'>" + esc(r.provider) + "</span>" : "",
      r.model ? "<span class='badge'>" + esc(r.model) + "</span>" : "",
      r.cat ? "<span class='badge'>📚 " + esc(r.cat) + "</span>" : "",
    ].filter(Boolean).join(" ");
    const task = r.task ? "<div class='task'>▸ " + esc(r.task) + "</div>" : "";
    const tok = "↑" + kfmt(r.tin) + " ↓" + kfmt(r.tout) + " R" + kfmt(r.tcache);
    return "<div class='chead'><span class='sdot st-" + esc(r.st) + "'></span>" +
      "<span class='ctitle' title='" + esc(title) + "'>" + esc(title) + "</span>" +
      (r.pinned ? "<span class='pill pin'>📌 pinned</span>" : "") +
      "<span class='pill'>" + esc(ST_LABEL[r.st] || r.st) + "</span></div>" +
      (meta ? "<div class='cmeta'>" + meta + "</div>" : "") +
      ctxMeter + task +
      "<div class='cfoot'>" + spark(r.tokHist, 84, 18) +
      "<span>" + tok + "</span><span style='flex:1'></span>" +
      (isActive(r) ? "<span title='pid " + esc(r.pid) + "'>" + esc(r.cpu != null ? r.cpu.toFixed(0) + "% " : "") + mem(r.mem) + "</span>" : "") +
      "<span>" + esc(dur(r.elapsed)) + "</span><span>" + esc(ago(r.lastAct)) + "</span></div>";
  }

  function render() {
    const matched = sortRows(D.rows.filter(match));
    $("count").textContent = matched.length + " / " + D.rows.length + " shown";
    const main = $("main");
    main.innerHTML = "";
    if (!matched.length) {
      main.innerHTML = "<div class='empty'>No sessions match the current filters.</div>";
      return;
    }
    for (const r of matched) {
      const card = document.createElement("div");
      card.className = "card" + (r.st === "waiting" ? " attn" : "") + (state.sel === r.k ? " sel" : "");
      card.dataset.k = r.k;
      card.innerHTML = cardHtml(r);
      card.onclick = function () { inspect(r, card); };
      main.appendChild(card);
    }
    if (state.sel != null) {
      const r = D.rows.find(function (x) { return x.k === state.sel; });
      const el = r ? document.querySelector(".card[data-k='" + cssEsc(state.sel) + "']") : null;
      if (r && el) inspect(r, el);
      else closeInsp();
    }
  }

  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

  // ---- drawer ----
  function inspect(r, cardEl) {
    state.sel = r.k;
    document.querySelectorAll(".card.sel").forEach(function (el) { el.classList.remove("sel"); });
    cardEl.classList.add("sel");
    const sid = r.csid || r.sid;
    let html = "<h3><span>● " + esc(ST_LABEL[r.st] || r.st) + " · " + esc(sid.slice(0, 13)) + "</span>" +
      "<span class='x' id='inspx'>✕ esc</span></h3>" +
      "<div class='actions'>" +
      "<button class='abtn' data-a='resume'>▶ Resume</button>" +
      "<button class='abtn sec' data-a='show'>Details</button>" +
      "<button class='abtn sec' data-a='trajectory'>Trajectory</button>" +
      "<button class='abtn sec' data-a='copy'>Copy ID</button>" +
      "</div>" +
      "<dl class='kv'>" + kvPairs(r, sid).map(function (p) {
        return "<dt>" + esc(p[0]) + "</dt><dd>" + esc(p[1]) + "</dd>";
      }).join("") + "</dl>";
    if (r.tokHist && r.tokHist.length > 1) {
      html += "<h4>Tokens ↑" + kfmt(r.tin) + " ↓" + kfmt(r.tout) + "</h4>" +
        "<div class='bigsp'>" + spark(r.tokHist, 400, 44) + "</div>";
    }
    if (r.ctxHist && r.ctxHist.length > 1) {
      html += "<h4>Context %</h4>" +
        "<div class='bigsp'>" + spark(r.ctxHist, 400, 44, "ctx") + "</div>";
    }
    if (r.skills && r.skills.length) {
      html += "<h4>Skills</h4>" + r.skills.slice(0, 8).map(function (s) {
        return "<div class='trow'><span class='tn'>" + esc(s.n) + "</span><span class='ta'>×" + s.c +
          (s.e || s.i ? " (" + s.e + " explicit / " + s.i + " implicit)" : "") + "</span></div>";
      }).join("");
    }
    if (r.tools && r.tools.length) {
      html += "<h4>Recent tools</h4>" + r.tools.slice(-8).reverse().map(function (t) {
        return "<div class='trow'><span class='tn'>" + esc(t.n) + "</span><span class='ta'>" + esc(t.a) +
          "</span><span class='td'>" + (t.d ? t.d + "ms" : "") + "</span></div>";
      }).join("");
    }
    if (r.chat && r.chat.length) {
      html += "<h4>Chat tail</h4>" + r.chat.slice(-8).map(function (c) {
        return "<div class='msg " + esc(c.r) + "'><div class='who'>" + esc(c.r) + "</div>" + mdOrPre(c.t) + "</div>";
      }).join("");
    }
    $("inspbody").innerHTML = html;
    $("insp").classList.add("open");
    $("inspx").onclick = closeInsp;
    document.querySelectorAll("#inspbody .abtn").forEach(function (b) {
      b.onclick = function () {
        const a = b.dataset.a;
        if (a === "copy") send({ type: "copy", text: sid });
        else send({ type: "action", action: a, row: r });
      };
    });
  }

  function kvPairs(r, sid) {
    const pairs = [
      ["Session", sid],
      ["Status", ST_LABEL[r.st] || r.st],
      ["Agent", r.provider],
      ["Model", r.model || "—"],
      ["Project", r.project || "—"],
      ["Catalog", r.cat || "—"],
      ["Pinned", r.pinned ? "yes" : "no"],
    ];
    if (r.pid != null) pairs.push(["PID", String(r.pid)]);
    if (r.cpu != null) pairs.push(["CPU", r.cpu.toFixed(0) + "%"]);
    if (r.mem) pairs.push(["Memory", mem(r.mem)]);
    if (r.started > 0) pairs.push(["Elapsed", dur(r.elapsed)]);
    pairs.push(["CTX", r.ctx != null && r.ctx >= 0 ? r.ctx.toFixed(0) + "%" : "—"]);
    pairs.push(["Tokens", "↑" + kfmt(r.tin) + " ↓" + kfmt(r.tout) + " cache " + kfmt(r.tcache)]);
    if (r.tool) pairs.push(["Last tool", r.tool + " ×" + r.tcnt]);
    if (r.scnt > 0) pairs.push(["Skill calls", String(r.scnt)]);
    if (r.comp > 0) pairs.push(["Compactions", String(r.comp)]);
    if (r.task) pairs.push(["Task", r.task]);
    pairs.push(["Last activity", ago(r.lastAct)]);
    return pairs;
  }

  function closeInsp() {
    $("insp").classList.remove("open");
    state.sel = null;
    document.querySelectorAll(".card.sel").forEach(function (el) { el.classList.remove("sel"); });
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeInsp(); });

  // ---- toolbar wiring ----
  $("q").addEventListener("input", function (e) { state.q = e.target.value.trim().toLowerCase(); render(); });
  $("agent").addEventListener("change", function (e) { state.agent = e.target.value; render(); });
  $("pinned").addEventListener("click", function () {
    state.pinned = !state.pinned;
    $("pinned").classList.toggle("on", state.pinned);
    render();
  });
  $("refresh").addEventListener("click", function () { send({ type: "refresh" }); });

  // ---- live updates from the extension host ----
  function applyUpdate(msg) {
    D.rows = msg.payload.rows || [];
    D.ts = msg.payload.ts;
    D.agentLabel = msg.payload.agentLabel;
    D.sortLabel = msg.payload.sortLabel;
    $("ts").textContent = "updated " + new Date(D.ts).toLocaleTimeString();
    $("cfg").textContent = "agent: " + (D.agentLabel || "all") + " · sort: " + (D.sortLabel || "default");
    renderStats(D.rows);
    renderStatusFilters(D.rows);
    renderAgentFilter(D.rows);
    render();
  }
  window.addEventListener("message", function (e) {
    const m = e.data;
    if (m && m.type === "update" && m.payload) applyUpdate(m);
  });

  renderStats(D.rows);
  if (D.rows.length) render(); // keep the "Loading…" placeholder until the first snapshot
})();
</script>
</body>
</html>`;
}
