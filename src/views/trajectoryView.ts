import * as vscode from "vscode";
import * as cli from "../cli";
import { formatCompactTokens, shortSessionId } from "../sessionDisplay";

const PANEL_TITLE = "Session Trajectory";
const LIVE_POLL_MS = 4_000;

/**
 * Editor-panel webview for the trajectory-v1 ledger.
 *
 * Layout: header stats → sticky toolbar (search, kind/status filters, range
 * slider) → turn sections with a step-proportional timeline gutter and a
 * record table. Clicking a record opens an inspector drawer with the full
 * input/output text (when --full data is present).
 *
 * While the panel is visible it polls the CLI for changes and pushes updated
 * rows to the webview; the webview re-renders in place, preserving filters,
 * scroll position, and the open inspector.
 */
export class TrajectoryPanel {
  public static currentPanel: TrajectoryPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _currentSessionId: string | undefined;
  private _pendingUpdate: Promise<void> = Promise.resolve();
  private _disposed = false;
  private _full = false;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _lastToken = "";

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.onDidChangeViewState(
      () => {
        // Poll only while the panel is actually on screen.
        if (this._panel.visible) {
          this.refresh();
          this.startPolling();
        } else {
          this.stopPolling();
        }
      },
      null,
      this._disposables
    );
  }

  public static async createOrShow(sessionRef: string, full = false): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (TrajectoryPanel.currentPanel) {
      TrajectoryPanel.currentPanel._panel.reveal(column);
      await TrajectoryPanel.currentPanel.update(sessionRef, full);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starling-trajectory",
      PANEL_TITLE,
      column || vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    TrajectoryPanel.currentPanel = new TrajectoryPanel(panel);
    await TrajectoryPanel.currentPanel.update(sessionRef, full);
  }

  private update(sessionRef: string, full: boolean): Promise<void> {
    // Serialize updates: a slow CLI call for a previous session must not
    // overwrite the render of a newer request.
    this._pendingUpdate = this._pendingUpdate.then(() => this.doUpdate(sessionRef, full));
    return this._pendingUpdate;
  }

  private startPolling(): void {
    if (this._timer != null || this._disposed) return;
    this._timer = setInterval(() => {
      if (this._disposed || !this._panel.visible) return;
      this.refresh();
    }, LIVE_POLL_MS);
  }

  private stopPolling(): void {
    if (this._timer != null) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /** Poll tick: fetch and push only when the trajectory actually changed. */
  private refresh(): void {
    const sessionRef = this._currentSessionId;
    if (!sessionRef || this._disposed) return;
    this._pendingUpdate = this._pendingUpdate.then(async () => {
      if (this._disposed) return;
      try {
        const trajectory = await cli.getTrajectory(sessionRef, { full: this._full, maxRecords: 1000 });
        const token = trajectoryToken(trajectory);
        if (token === this._lastToken) return;
        this._lastToken = token;
        await this._panel.webview.postMessage({ type: "update", token, payload: trajectory });
      } catch {
        // Transient CLI failure during live polling; keep the current view.
      }
    });
  }

  private async doUpdate(sessionRef: string, full: boolean): Promise<void> {
    this._currentSessionId = sessionRef;
    this._full = full;
    this._lastToken = "";
    try {
      this._panel.title = PANEL_TITLE;
      const trajectory = await cli.getTrajectory(sessionRef, { full, maxRecords: 1000 });
      // The panel may have been closed while the CLI call was in flight.
      if (this._disposed) return;
      this._lastToken = trajectoryToken(trajectory);
      this._panel.title = `Trajectory ${shortSessionId(trajectory.session.id)}`;
      this._panel.webview.html = renderTrajectoryHtml(trajectory);
      this.startPolling();
    } catch (err) {
      if (this._disposed) return;
      try {
        this._panel.webview.html = errorPage(String(err));
      } catch {
        // Webview became disposed mid-error-render; nothing left to update.
      }
    }
  }

  private dispose(): void {
    this._disposed = true;
    this.stopPolling();
    TrajectoryPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }
}

/** Cheap change detector for live polling. */
function trajectoryToken(t: cli.Trajectory): string {
  const last = t.records[t.records.length - 1];
  return [
    t.session.updatedAt ?? "",
    t.stats.turns,
    t.stats.records,
    last ? `${last.index}:${last.completedAt ?? ""}` : "",
  ].join("|");
}

function errorPage(message: string): string {
  return `<!DOCTYPE html><html><body><h2>Error loading trajectory</h2><pre>${escapeHtml(message)}</pre></body></html>`;
}

// ---------------------------------------------------------------------------
// Data model shipped to the webview
// ---------------------------------------------------------------------------

interface Row {
  i: number;          // record index
  t: number;          // turn
  s: number | null;   // step
  k: string;          // kind
  e: string;          // event
  sm: string;         // summary
  st: string;         // status
  d: number | null;   // durationMs
  sa: string | null;  // startedAt
  ca: string | null;  // completedAt
  u: unknown;         // usage
  in: string | null;  // input (full only)
  out: string | null; // output (full only)
}

function fmtMs(ms?: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function fmtTime(iso?: string | null): string {
  return iso ? iso.slice(11, 19) : "—";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON-embed: escape so the payload can never close its <script> tag. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function renderTrajectoryHtml(t: cli.Trajectory): string {
  const s = t.session;
  const stats = t.stats;
  const tokens = stats.tokens ?? {};
  const hasDetail = t.detailLevel === "full";

  const rows: Row[] = t.records.map((r) => ({
    i: r.index, t: r.turn, s: r.step ?? null, k: r.kind, e: r.event,
    sm: r.summary, st: r.status, d: r.durationMs ?? null,
    sa: r.startedAt ?? null, ca: r.completedAt ?? null, u: r.usage ?? null,
    "in": r.input ?? null, out: r.output ?? null,
  }));

  const turns = t.turns.map((turn) => ({
    index: turn.index,
    startedAt: turn.startedAt ?? null,
    durationMs: turn.durationMs ?? null,
    status: turn.status,
    steps: turn.steps,
    records: turn.records,
    tokens: { i: turn.tokens?.input ?? 0, o: turn.tokens?.output ?? 0 },
  }));

  const payload = {
    title: s.title,
    provider: s.provider,
    model: s.model || "",
    id: s.id,
    parent: s.parentSessionId ?? null,
    hasDetail,
    stats: {
      turns: stats.turns, records: stats.records, steps: stats.steps ?? 0,
      toolCalls: stats.toolCalls, toolErrors: stats.toolErrors, truncated: stats.truncated ?? 0,
      durationMs: stats.durationMs ?? null,
      tin: tokens.input ?? 0, tout: tokens.output ?? 0, tcache: tokens.cacheRead ?? 0,
    },
    turns,
    rows,
    warnings: (t.warnings ?? []).map((w) => w.message ?? ""),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root { --hover: var(--vscode-list-hoverBackground); --line: var(--vscode-widget-border); }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; font-size: 13px; }
  /* Header */
  header { position: sticky; top: 0; z-index: 30; background: var(--vscode-editor-background);
           border-bottom: 1px solid var(--line); padding: 10px 16px 8px; }
  h2 { margin: 0; font-size: 15px; }
  .meta { color: var(--vscode-descriptionForeground); margin-top: 2px; display: flex; gap: 10px; flex-wrap: wrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { font-size: 11px; padding: 2px 9px; border: 1px solid var(--line); border-radius: 10px;
          background: var(--vscode-textBlockQuote-background); }
  .chip b { font-weight: 600; }
  /* Toolbar */
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .search { flex: 1 1 220px; min-width: 180px; display: flex; align-items: center; gap: 6px;
            background: var(--vscode-input-background); border: 1px solid var(--line); border-radius: 4px; padding: 3px 8px; }
  .search input { flex: 1; background: none; border: none; outline: none; color: var(--vscode-input-foreground); font: inherit; }
  .filters { display: flex; gap: 4px; flex-wrap: wrap; }
  .fbtn { font-size: 11px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 10px;
          background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; }
  .fbtn.on { color: var(--vscode-foreground); background: var(--vscode-button-background);
             border-color: var(--vscode-button-background); }
  select.mini { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
                border: 1px solid var(--line); border-radius: 4px; font-size: 11px; padding: 2px 4px; }
  .range { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .range input[type=range] { width: 130px; }
  .count { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .warn { color: var(--vscode-terminal-ansiYellow); font-size: 12px; margin: 4px 16px; }
  /* Timeline ledger */
  main { padding: 0 16px 40vh; }
  .turn { margin-top: 14px; }
  .thead { display: flex; gap: 12px; align-items: baseline; padding: 3px 0;
           border-bottom: 2px solid var(--line); }
  .thead .no { font-weight: 600; font-size: 12.5px; }
  .thead .dim { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
  .thead .aborted { color: var(--vscode-terminal-ansiYellow); font-size: 11px; }
  .tgrid { display: grid; grid-template-columns: 34px 1fr 74px 20px; }
  /* lane column: vertical line with step ticks */
  .lane { position: relative; }
  .lane::before { content: ""; position: absolute; left: 10px; top: 0; bottom: 0; width: 1px;
                  background: var(--line); }
  .tick { position: relative; margin: 3px 0 3px 22px; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .tick::before { content: ""; position: absolute; left: -16px; top: 50%; width: 9px; height: 1px; background: var(--line); }
  .rrow { display: flex; align-items: baseline; gap: 8px; padding: 3px 8px; border-radius: 4px; cursor: pointer; }
  .rrow:hover { background: var(--hover); }
  .rrow.sel { background: var(--vscode-list-activeSelectionBackground); }
  .rrow .idx { color: var(--vscode-descriptionForeground); font-size: 10.5px; min-width: 34px; text-align: right; }
  .ico { font-size: 12px; min-width: 20px; }
  .ev { color: var(--vscode-charts-blue, #3794ff); font-size: 12px; min-width: 74px; }
  .sm { flex: 1; color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rrow .dur { color: var(--vscode-descriptionForeground); font-size: 11px; min-width: 70px; text-align: right; }
  .st-err { color: var(--vscode-terminal-ansiRed); font-weight: 600; }
  .st-run { color: var(--vscode-terminal-ansiYellow); }
  .st-abt { color: var(--vscode-terminal-ansiYellow); }
  .k-user .sm { color: var(--vscode-charts-green, #89d185); }
  .k-reasoning .sm { color: var(--vscode-descriptionForeground); font-style: italic; }
  .k-system .sm, .k-compaction .sm { color: var(--vscode-descriptionForeground); }
  .k-tool .ev { color: var(--vscode-terminal-ansiYellow); }
  .stepgrp { margin: 5px 0 2px; }
  /* Inspector drawer */
  #insp { position: fixed; right: -46%; top: 0; bottom: 0; width: 45%; z-index: 40;
          background: var(--vscode-sideBar-background); border-left: 1px solid var(--line);
          padding: 14px 18px; overflow-y: auto; transition: right .18s ease; }
  #insp.open { right: 0; }
  #insp h3 { margin: 0 0 8px; font-size: 14px; display: flex; justify-content: space-between; }
  #insp .x { cursor: pointer; color: var(--vscode-descriptionForeground); }
  .kv { display: grid; grid-template-columns: 96px 1fr; gap: 3px 10px; font-size: 12px; margin: 6px 0 12px; }
  .kv dt { color: var(--vscode-descriptionForeground); }
  .kv dd { margin: 0; word-break: break-all; }
  #insp h4 { margin: 14px 0 4px; font-size: 12.5px; }
  #insp pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 10px;
              background: var(--vscode-textBlockQuote-background); border-radius: 6px;
              font-size: 11.5px; line-height: 1.45; max-height: 40vh; overflow: auto; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11.5px; font-style: italic; }
  .empty { color: var(--vscode-descriptionForeground); padding: 30px 0; text-align: center; }
  body.pushed main, body.pushed header { padding-right: 47%; }
  mark { background: var(--vscode-editor-findMatchHighlightBackground, #5a5a20); color: inherit; }
</style>
</head>
<body>
<header>
  <h2 id="title"></h2>
  <div class="meta" id="meta"></div>
  <div class="chips" id="chips"></div>
  <div class="toolbar">
    <div class="search">🔎 <input id="q" placeholder="Search events, summaries, input &amp; output text…" spellcheck="false"></div>
    <div class="filters" id="kinds"></div>
    <select class="mini" id="status">
      <option value="">all status</option>
      <option value="complete">complete</option>
      <option value="error">error</option>
      <option value="running">running</option>
      <option value="aborted">aborted</option>
    </select>
    <div class="range">last <input type="range" id="range" min="10" max="1000" step="10" value="1000"> <span id="rangev">all</span></div>
    <span class="count" id="count"></span>
  </div>
</header>
<div class="warn" id="warn"></div>
<main id="main"></main>
<div id="insp"><div id="inspbody"></div></div>
<script id="data" type="application/json">${embedJson(payload)}</script>
<script>
(function () {
  const D = JSON.parse(document.getElementById("data").textContent);
  const $ = (id) => document.getElementById(id);
  const state = { q: "", kinds: new Set(), status: "", range: D.rows.length, sel: null };
  const KINDS = ["user", "assistant", "reasoning", "tool", "system", "compaction"];
  const ICON = { user: "👤", assistant: "💬", reasoning: "🧠", tool: "🔧", system: "⚙", compaction: "📦" };

  // ---- header ----
  function renderHeader() {
    $("title").textContent = D.title;
    $("meta").innerHTML =
      "<span>" + esc(D.provider) + "</span><span>" + esc(D.model || "—") + "</span>" +
      "<span style='opacity:.7'>" + esc(D.id) + "</span>" +
      (D.parent ? "<span>nested rollout of " + esc(D.parent) + "</span>" : "");
    const S = D.stats;
    $("chips").innerHTML = [
      ["turns", S.turns], ["records", S.records], ["steps", S.steps],
      ["tools", S.toolCalls + (S.toolErrors ? " (" + S.toolErrors + " err)" : "")],
      ["tokens ↑" + kfmt(S.tin), "↓" + kfmt(S.tout) + " R" + kfmt(S.tcache)],
      ["wall", dur(S.durationMs)],
      ["live", new Date().toLocaleTimeString()],
    ].map(([k, v]) => "<span class='chip'><b>" + esc(String(v)) + "</b> " + esc(String(k)) + "</span>").join("");
    $("warn").textContent = D.warnings.join("  ⚠  ");
    $("warn").style.display = D.warnings.length ? "" : "none";
  }
  renderHeader();

  // ---- filter bar ----
  const kindsBar = $("kinds");
  KINDS.forEach((k) => {
    const b = document.createElement("button");
    b.className = "fbtn on"; b.textContent = (ICON[k] || "·") + " " + k;
    b.onclick = () => { b.classList.toggle("on");
      b.classList.contains("on") ? state.kinds.delete(k) : state.kinds.add(k); render(); };
    state.kinds.add(k);
    kindsBar.appendChild(b);
  });
  $("q").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
  $("status").addEventListener("change", (e) => { state.status = e.target.value; render(); });
  const rg = $("range");
  rg.addEventListener("input", () => {
    state.range = Number(rg.value);
    $("rangev").textContent = rg.value === "1000" ? "all" : String(state.range);
    render();
  });

  function match(r) {
    if (state.kinds.size && !state.kinds.has(r.k)) return false;
    if (state.status && r.st !== state.status) return false;
    if (!state.q) return true;
    return (r.e + " " + r.sm + " " + (r["in"] || "") + " " + (r.out || "")).toLowerCase().includes(state.q);
  }

  // ---- render ledger ----
  function render() {
    const matched = D.rows.filter(match);
    // range applies to matched rows, keeping the newest
    const windowed = matched.length > state.range ? matched.slice(-state.range) : matched;
    $("count").textContent = windowed.length + " / " + D.rows.length + " shown";

    const byTurn = new Map();
    for (const r of windowed) { if (!byTurn.has(r.t)) byTurn.set(r.t, []); byTurn.get(r.t).push(r); }

    const main = $("main");
    main.innerHTML = "";
    let shown = 0;
    for (const turn of D.turns) {
      const rows = byTurn.get(turn.index);
      if (!rows || !rows.length) continue;
      shown++;
      const sec = document.createElement("section");
      sec.className = "turn";
      const tk = turn.tokens;
      const bits = [];
      if (tk.i || tk.o) bits.push("↑" + kfmt(tk.i) + " ↓" + kfmt(tk.o));
      const head = document.createElement("div");
      head.className = "thead";
      head.innerHTML = "<span class='no'>Turn " + turn.index + "</span>" +
        "<span class='dim'>" + esc(time(turn.startedAt)) + "</span>" +
        "<span class='dim'>" + esc(dur(turn.durationMs)) + "</span>" +
        "<span class='dim'>" + turn.steps + " steps</span>" +
        (turn.status === "aborted" ? "<span class='aborted'>aborted</span>" : "") +
        (bits.length ? "<span class='dim'>" + bits.join(" · ") + "</span>" : "");
      sec.appendChild(head);

      const grid = document.createElement("div");
      grid.className = "tgrid";
      const lane = document.createElement("div");
      const list = document.createElement("div");
      // Group rows by step for tick marks
      let lastStep = null;
      for (const r of rows) {
        if (r.s !== lastStep) {
          const tick = document.createElement("div");
          tick.className = "tick"; tick.textContent = "s" + (r.s ?? "—");
          lane.appendChild(tick);
          lastStep = r.s;
        }
        const row = document.createElement("div");
        row.className = "rrow k-" + r.k + (state.sel === r.i ? " sel" : "");
        row.dataset.i = String(r.i);
        const durTxt = r.k === "tool" ? dur(r.d) : "";
        row.innerHTML = "<span class='idx'>#" + r.i + "</span>" +
          "<span class='ico'>" + (ICON[r.k] || "·") + "</span>" +
          "<span class='ev'>" + esc(r.e) + "</span>" +
          "<span class='sm'>" + esc(r.sm) + "</span>" +
          "<span class='dur'>" + esc(durTxt) + "</span>" +
          "<span class='" + stCls(r.st) + "'>" + stMark(r.st) + "</span>";
        row.onclick = () => inspect(r, row);
        list.appendChild(row);
      }
      // lane column spans the rows visually via grid; the vertical line is
      // drawn in CSS on .lane::before inside its own column
      grid.appendChild(lane); grid.appendChild(list);
      // two more grid cells for alignment (dur/status live inside rows)
      grid.appendChild(document.createElement("div"));
      grid.appendChild(document.createElement("div"));
      sec.appendChild(grid);
      main.appendChild(sec);
    }
    if (!shown) {
      main.innerHTML = "<div class='empty'>No records match the current filters.</div>";
    }
  }

  // ---- inspector ----
  function inspect(r, rowEl) {
    state.sel = r.i;
    document.querySelectorAll(".rrow.sel").forEach((el) => el.classList.remove("sel"));
    rowEl.classList.add("sel");
    const b = $("inspbody");
    let html = "<h3>" + (ICON[r.k] || "·") + " " + esc(r.k) + " · #" + r.i +
      "<span class='x' id='inspx'>✕ esc</span></h3>" +
      kv([["Turn / Step", r.t + " / s" + (r.s ?? "—")], ["Event", r.e], ["Status", r.st],
          ["Started", r.sa ? r.sa.replace("T", " ").replace("Z", "") : "—"],
          ["Completed", r.ca ? r.ca.replace("T", " ").replace("Z", "") : "—"],
          ["Duration", r.d != null ? r.d + "ms" : "—"],
          ["Tokens", usageLine(r.u)]]);
    if (r["in"]) html += "<h4>Input</h4><pre>" + esc(r["in"]) + "</pre>";
    if (r.out) html += "<h4>Output</h4><pre>" + esc(r.out) + "</pre>";
    if (r.sm === "(encrypted reasoning)") {
      html += "<p class='hint'>Codex encrypts reasoning; only its presence is recorded.</p>";
    } else if (!r["in"] && !r.out && !["user", "system", "assistant"].includes(r.k)) {
      html += "<p class='hint'>This record has no captured input/output text.</p>";
    }
    b.innerHTML = html;
    $("insp").classList.add("open");
    document.body.classList.add("pushed");
    $("inspx").onclick = closeInsp;
  }
  function closeInsp() {
    $("insp").classList.remove("open");
    document.body.classList.remove("pushed");
    state.sel = null;
    document.querySelectorAll(".rrow.sel").forEach((el) => el.classList.remove("sel"));
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInsp(); });

  // ---- helpers ----
  function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function kv(pairs) {
    return "<dl class='kv'>" + pairs.map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>").join("") + "</dl>";
  }
  function kfmt(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }
  function dur(ms) { if (ms == null) return ""; return fmt(ms); }
  function fmt(ms) {
    if (ms < 1000) return ms + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    return Math.floor(ms / 3600000) + "h" + Math.floor((ms % 3600000) / 60000) + "m";
  }
  function time(iso) { return iso ? iso.slice(11, 19) : "—"; }
  function usageLine(u) {
    if (!u || typeof u !== "object") return "—";
    const parts = [];
    if (u.input != null) parts.push("↑" + kfmt(u.input));
    if (u.output != null) parts.push("↓" + kfmt(u.output));
    if (u.cacheRead != null) parts.push("R" + kfmt(u.cacheRead));
    if (u.cacheWrite != null) parts.push("W" + kfmt(u.cacheWrite));
    if (u.cost && typeof u.cost === "object" && u.cost.total != null) parts.push("$" + u.cost.total);
    return parts.length ? parts.join(" ") : "—";
  }
  function stCls(st) { return st === "error" ? "st-err" : st === "running" ? "st-run" : st === "aborted" ? "st-abt" : "dim2"; }
  function stMark(st) { return st === "error" ? "✗" : st === "running" ? "…" : st === "aborted" ? "⊘" : ""; }

  // ---- live updates from the extension host ----
  function applyUpdate(msg) {
    const t = msg.payload;
    D.title = t.session.title;
    D.provider = t.session.provider;
    D.model = t.session.model || "";
    D.id = t.session.id;
    D.parent = t.session.parentSessionId ?? null;
    D.warnings = (t.warnings ?? []).map((w) => w.message ?? "");
    const st = t.stats ?? {};
    const tk = st.tokens ?? {};
    D.stats = {
      turns: st.turns, records: st.records, steps: st.steps ?? 0,
      toolCalls: st.toolCalls, toolErrors: st.toolErrors, truncated: st.truncated ?? 0,
      durationMs: st.durationMs ?? null,
      tin: tk.input ?? 0, tout: tk.output ?? 0, tcache: tk.cacheRead ?? 0,
    };
    D.turns = t.turns.map((turn) => ({
      index: turn.index, startedAt: turn.startedAt ?? null, durationMs: turn.durationMs ?? null,
      status: turn.status, steps: turn.steps, records: turn.records,
      tokens: { i: turn.tokens?.input ?? 0, o: turn.tokens?.output ?? 0 },
    }));
    D.rows = t.records.map((r) => ({
      i: r.index, t: r.turn, s: r.step ?? null, k: r.kind, e: r.event, sm: r.summary,
      st: r.status, d: r.durationMs ?? null, sa: r.startedAt ?? null, ca: r.completedAt ?? null,
      u: r.usage ?? null, "in": r.input ?? null, out: r.output ?? null,
    }));
    renderHeader();

    // Preserve scroll; keep the user anchored where they were reading.
    const main = document.getElementById("main");
    const scroll = window.scrollY;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
    render();
    if (atBottom) {
      window.scrollTo(0, document.body.scrollHeight);
    } else {
      window.scrollTo(0, scroll);
    }
    // Refresh the inspector if its record still exists.
    if (state.sel != null) {
      const r = D.rows.find((x) => x.i === state.sel);
      if (r) {
        const rowEl = document.querySelector('.rrow[data-i="' + state.sel + '"]');
        if (rowEl) inspect(r, rowEl);
      } else {
        closeInsp();
      }
    }
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m && m.type === "update" && m.payload) applyUpdate(m);
  });

  render();
})();
</script>
</body>
</html>`;
}
