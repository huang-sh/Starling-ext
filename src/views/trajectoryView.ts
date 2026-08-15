import * as vscode from "vscode";
import * as cli from "../cli";
import { formatCompactTokens, shortSessionId } from "../sessionDisplay";

const PANEL_TITLE = "Session Trajectory";

/**
 * Editor-panel webview rendering the trajectory-v1 ledger: header stats,
 * per-turn sections with records, and an inspector for the selected record
 * (timing, usage, input/output when --full data is present).
 */
export class TrajectoryPanel {
  public static currentPanel: TrajectoryPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _currentSessionId: string | undefined;
  private _pendingUpdate: Promise<void> = Promise.resolve();

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
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

  private async doUpdate(sessionRef: string, full: boolean): Promise<void> {
    if (this._panel.visible === false && this._currentSessionId === sessionRef) return;
    this._currentSessionId = sessionRef;
    this._panel.title = PANEL_TITLE;
    try {
      const trajectory = await cli.getTrajectory(sessionRef, { full, maxRecords: 1000 });
      this._panel.title = `Trajectory ${shortSessionId(trajectory.session.id)}`;
      this._panel.webview.html = renderTrajectoryHtml(trajectory);
    } catch (err) {
      this._panel.webview.html = `<body><h2>Error loading trajectory</h2><pre>${escapeHtml(String(err))}</pre></body>`;
    }
  }

  private dispose(): void {
    TrajectoryPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }
}

function fmtMs(ms?: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  return iso.slice(11, 19);
}

const KIND_ICON: Record<string, string> = {
  user: "👤",
  assistant: "💬",
  reasoning: "🧠",
  tool: "🔧",
  system: "⚙",
  compaction: "📦",
};

function statusBadge(status: string): string {
  if (status === "error") return `<span class="badge error">✗ error</span>`;
  if (status === "running") return `<span class="badge running">…</span>`;
  if (status === "aborted") return `<span class="badge aborted">aborted</span>`;
  return "";
}

function renderTrajectoryHtml(t: cli.Trajectory): string {
  const s = t.session;
  const stats = t.stats;
  const tokens = stats.tokens ?? {};
  const byTurn = new Map<number, cli.TrajectoryRecord[]>();
  for (const r of t.records) {
    const list = byTurn.get(r.turn) ?? [];
    list.push(r);
    byTurn.set(r.turn, list);
  }

  const turnSections = t.turns
    .map((turn) => {
      const rows = (byTurn.get(turn.index) ?? [])
        .map(
          (r) => `<tr class="record kind-${r.kind}" data-record="${r.index}">
  <td class="c-index">#${r.index}</td>
  <td class="c-step">s${r.step ?? "—"}</td>
  <td class="c-kind">${KIND_ICON[r.kind] ?? "·"} ${r.kind}</td>
  <td class="c-event">${escapeHtml(r.event)}</td>
  <td class="c-summary">${escapeHtml(r.summary || "")}</td>
  <td class="c-dur">${r.kind === "tool" ? fmtMs(r.durationMs) : ""}</td>
  <td class="c-status">${statusBadge(r.status)}</td>
</tr>`
        )
        .join("\n");
      const truncatedNote =
        (byTurn.get(turn.index) ?? []).length === 0 && turn.records > 0
          ? `<tr><td colspan="7" class="truncated-note">records truncated — raise --max-records</td></tr>`
          : "";
      const turnTokens = turn.tokens ?? {};
      const tokenBits: string[] = [];
      if (turnTokens.input || turnTokens.output) {
        tokenBits.push(`↑${formatCompactTokens(turnTokens.input ?? 0)} ↓${formatCompactTokens(turnTokens.output ?? 0)}`);
      }
      return `<section class="turn">
  <div class="turn-header">
    <span class="turn-no">Turn ${turn.index}</span>
    <span class="turn-time">${fmtTime(turn.startedAt)}</span>
    <span class="turn-dur">${fmtMs(turn.durationMs)}</span>
    <span class="turn-steps">${turn.steps} steps</span>
    ${turn.status === "aborted" ? `<span class="badge aborted">aborted</span>` : ""}
    ${tokenBits.length ? `<span class="turn-tokens">${tokenBits.join(" · ")}</span>` : ""}
  </div>
  <table class="ledger">
    <tbody>${rows}${truncatedNote}</tbody>
  </table>
</section>`;
    })
    .join("\n");

  const warnings = (t.warnings ?? [])
    .map((w) => `<div class="warning">⚠ ${escapeHtml(w.message ?? "")}</div>`)
    .join("\n");

  const detailRows = t.detailLevel === "full"
    ? t.records.map((r) => detailJson(r)).join(",\n")
    : "null";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Trajectory</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 16px 20px; }
  h2 { margin: 0 0 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 12px; word-break: break-all; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .stat { padding: 4px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 4px;
          background: var(--vscode-textBlockQuote-background); font-size: 0.9em; }
  .stat b { font-weight: 600; }
  .warning { color: var(--vscode-terminal-ansiYellow); margin: 6px 0; }
  .parent { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .turn { margin-bottom: 18px; }
  .turn-header { display: flex; gap: 14px; align-items: baseline; padding: 4px 0;
                 border-bottom: 2px solid var(--vscode-widget-border); font-size: 0.95em; }
  .turn-no { font-weight: 600; }
  .turn-time, .turn-dur, .turn-steps, .turn-tokens { color: var(--vscode-descriptionForeground); }
  table.ledger { border-collapse: collapse; width: 100%; }
  .ledger td { padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 50%, transparent);
               vertical-align: top; }
  .c-index, .c-step { color: var(--vscode-descriptionForeground); white-space: nowrap; width: 1%; }
  .c-kind { white-space: nowrap; width: 1%; }
  .c-event { color: var(--vscode-charts-blue, #3794ff); white-space: nowrap; width: 1%; }
  .c-summary { word-break: break-word; }
  .c-dur { color: var(--vscode-descriptionForeground); white-space: nowrap; width: 1%; text-align: right; }
  .c-status { width: 1%; }
  .truncated-note td { color: var(--vscode-descriptionForeground); font-style: italic; }
  .kind-tool .c-kind { color: var(--vscode-terminal-ansiYellow); }
  .kind-error td { }
  .badge { font-size: 0.85em; padding: 1px 6px; border-radius: 3px; }
  .badge.error { color: var(--vscode-terminal-ansiRed); }
  .badge.running { color: var(--vscode-terminal-ansiYellow); }
  .badge.aborted { color: var(--vscode-terminal-ansiYellow); }
  .record { cursor: pointer; }
  .record:hover td { background: var(--vscode-list-hoverBackground); }
  .record.selected td { background: var(--vscode-list-activeSelectionBackground); }
  #inspector { position: fixed; right: 0; top: 0; bottom: 0; width: 38%;
               background: var(--vscode-sideBar-background); border-left: 1px solid var(--vscode-widget-border);
               padding: 14px 16px; overflow-y: auto; display: none; box-sizing: border-box; }
  #inspector.open { display: block; }
  #inspector h3 { margin-top: 0; }
  #inspector pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textBlockQuote-background);
                   padding: 8px; font-size: 0.85em; }
  #inspector .kv { display: grid; grid-template-columns: 110px 1fr; gap: 2px 8px; margin: 8px 0; }
  #inspector .kv dt { color: var(--vscode-descriptionForeground); }
  #inspector .close { cursor: pointer; float: right; }
  body.padded { padding-right: 40%; }
</style>
</head>
<body>
  <h2>${escapeHtml(s.title)}</h2>
  <div class="subtitle">${escapeHtml(s.provider)} · ${escapeHtml(s.model || "—")} · ${escapeHtml(s.id)}
    ${s.parentSessionId ? `<span class="parent"><br>nested rollout of ${escapeHtml(s.parentSessionId)}</span>` : ""}
  </div>
  <div class="stats">
    <span class="stat"><b>${stats.turns}</b> turns</span>
    <span class="stat"><b>${stats.records}</b> records</span>
    <span class="stat"><b>${stats.steps ?? "—"}</b> steps</span>
    <span class="stat"><b>${stats.toolCalls}</b> tools <b>${stats.toolErrors}</b> errors</span>
    <span class="stat">↑<b>${formatCompactTokens(tokens.input ?? 0)}</b> ↓<b>${formatCompactTokens(tokens.output ?? 0)}</b> R<b>${formatCompactTokens(tokens.cacheRead ?? 0)}</b></span>
    <span class="stat">${fmtMs(stats.durationMs)}</span>
  </div>
  ${warnings}
  <div id="content">
  ${turnSections}
  </div>
  <div id="inspector">
    <span class="close" onclick="closeInspector()">✕</span>
    <div id="inspector-body"></div>
  </div>
<script>
  const details = { records: [${detailRows}] };
  function recordDetail(i) {
    return details.records.find((r) => r && r.index === i);
  }
  function closeInspector() {
    document.getElementById("inspector").classList.remove("open");
    document.body.classList.remove("padded");
    document.querySelectorAll(".record.selected").forEach((el) => el.classList.remove("selected"));
  }
  document.querySelectorAll(".record").forEach((row) => {
    row.addEventListener("click", () => {
      const i = Number(row.dataset.record);
      const d = recordDetail(i);
      document.querySelectorAll(".record.selected").forEach((el) => el.classList.remove("selected"));
      row.classList.add("selected");
      const body = document.getElementById("inspector-body");
      if (d && d.input !== undefined) {
        body.innerHTML = renderDetail(d);
        document.getElementById("inspector").classList.add("open");
        document.body.classList.add("padded");
      } else {
        body.innerHTML = renderDetail(d);
        document.getElementById("inspector").classList.add("open");
        document.body.classList.add("padded");
      }
    });
  });
  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function renderDetail(d) {
    const rows = [];
    rows.push(["Index", "#" + d.index], ["Turn / Step", d.turn + " / s" + (d.step ?? "—")],
              ["Kind", d.kind], ["Event", d.event], ["Status", d.status],
              ["Started", d.startedAt ?? "—"], ["Completed", d.completedAt ?? "—"],
              ["Duration", d.durationMs != null ? d.durationMs + "ms" : "—"]);
    let html = "<dl class='kv'>" + rows.map(([k, v]) => "<dt>" + k + "</dt><dd>" + esc(v) + "</dd>").join("") + "</dl>";
    if (d.input != null && d.input !== "") html += "<h4>Input</h4><pre>" + esc(d.input) + "</pre>";
    if (d.output != null && d.output !== "") html += "<h4>Output</h4><pre>" + esc(d.output) + "</pre>";
    if (d.input == null && d.output == null && d.kind !== "user") {
      html += "<p class='hint'>Run with Full detail to see input/output text.</p>";
    }
    return html;
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInspector(); });
</script>
</body>
</html>`;
}

function detailJson(r: cli.TrajectoryRecord): string {
  return JSON.stringify({
    index: r.index,
    turn: r.turn,
    step: r.step ?? null,
    kind: r.kind,
    event: r.event,
    status: r.status,
    startedAt: r.startedAt ?? null,
    completedAt: r.completedAt ?? null,
    durationMs: r.durationMs ?? null,
    input: r.input ?? null,
    output: r.output ?? null,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
