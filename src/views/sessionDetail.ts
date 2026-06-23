import * as vscode from "vscode";
import * as cli from "../cli";
import {
  formatCompactTokens,
  formatCpuPct,
  formatCtxPct,
  formatElapsedSecs,
  formatMemKb,
  formatRelativeTime,
  formatStatusGlyph,
  formatTokenUsage,
  shortSessionId,
} from "../sessionDisplay";

const PANEL_TITLE = "Session Detail";

export class SessionDetailPanel {
  public static currentPanel: SessionDetailPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _currentSessionId: string | undefined;

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static async createOrShow(sessionId: string): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SessionDetailPanel.currentPanel) {
      SessionDetailPanel.currentPanel._panel.reveal(column);
      await SessionDetailPanel.currentPanel.update(sessionId);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starling-session",
      PANEL_TITLE,
      column || vscode.ViewColumn.One,
      { enableScripts: false }
    );

    SessionDetailPanel.currentPanel = new SessionDetailPanel(panel);
    await SessionDetailPanel.currentPanel.update(sessionId);
  }

  private async update(sessionId: string): Promise<void> {
    this._currentSessionId = sessionId;
    const shortId = shortSessionId(sessionId);
    this._panel.title = `Session ${shortId}`;

    try {
      // Fetch static metadata + live monitor snapshot in parallel. If monitor
      // fails, the panel still renders with static data only.
      const [meta, snap] = await Promise.all([
        cli.getSession(sessionId),
        cli.getMonitorSnapshot({ recent: true }).catch(() => null),
      ]);
      const live = snap
        ? [...snap.pinned, ...snap.recent].find(
            (r) => r.session_id === sessionId || r.canonical_session_id === sessionId
          )
        : undefined;
      this._panel.webview.html = this.renderHtml(meta, live);
    } catch (err) {
      this._panel.webview.html = `<body><h2>Error loading session</h2><pre>${escapeHtml(String(err))}</pre></body>`;
    }
  }

  private renderHtml(meta: cli.SessionMeta, live?: cli.MonitorRow): string {
    const rows: [string, string][] = [
      ["Session ID", shortSessionId(meta.session_id)],
      ["Agent", meta.provider],
      ["Model", meta.model || "-"],
      ["Title", meta.custom_title || "-"],
      ["Project", meta.project_path || "-"],
      ["Catalogs", formatCatalogs(meta.catalogs)],
      ["Tokens", formatTokenUsage(meta.token_usage)],
      ["File", meta.file_path],
      ["Modified", meta.modified_at],
    ];

    const liveSection = live ? this.renderLiveSection(live) : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Session Detail</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    table { border-collapse: collapse; width: 100%; max-width: 800px; }
    td { padding: 6px 12px; border-bottom: 1px solid var(--vscode-widget-border); }
    td:first-child { color: var(--vscode-descriptionForeground); white-space: nowrap; font-weight: 600; }
    td:last-child { word-break: break-all; }
    .prompt {
      margin-top: 16px;
      padding: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      white-space: pre-wrap;
      word-break: break-word;
    }
    h2 { margin-bottom: 12px; }
    h3 { margin-top: 24px; margin-bottom: 8px; color: var(--vscode-foreground); }
    .live {
      margin-bottom: 24px;
      padding: 14px 16px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      background: var(--vscode-textBlockQuote-background);
    }
    .live-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 0.95em;
    }
    .live-header .title { font-weight: 600; }
    .live-header .timestamp { color: var(--vscode-descriptionForeground); }
    .live-table { width: 100%; border-collapse: collapse; }
    .live-table td { padding: 4px 12px; border-bottom: 1px solid var(--vscode-widget-border); }
    .live-table td:first-child { color: var(--vscode-descriptionForeground); white-space: nowrap; font-weight: 600; width: 110px; }
    .status-waiting { color: var(--vscode-terminal-ansiYellow); font-weight: 600; }
    .status-running { color: var(--vscode-terminal-ansiGreen); font-weight: 600; }
    .status-stale_running { color: var(--vscode-terminal-ansiYellow); font-weight: 600; }
    .status-aborted { color: var(--vscode-terminal-ansiYellow); font-weight: 600; }
    .status-failure { color: var(--vscode-terminal-ansiRed); font-weight: 600; }
    .status-idle { color: var(--vscode-descriptionForeground); }
    .status-stopped { color: var(--vscode-descriptionForeground); }
    .status-unknown { color: var(--vscode-descriptionForeground); }
    .sparkline { display: block; margin-top: 6px; }
    .ctx-bar {
      display: inline-block;
      width: 120px;
      height: 10px;
      margin-left: 8px;
      vertical-align: middle;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 2px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .ctx-fill {
      height: 100%;
      background: var(--vscode-charts-yellow, #cca700);
    }
    .ctx-fill.warn { background: var(--vscode-charts-red, #f14c4c); }
    .footer-note {
      margin-top: 12px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <h2>Session Detail</h2>
  ${liveSection}
  <h3>Metadata</h3>
  <table>
    ${rows
      .map(([k, v]) => {
        const fullValue = k === "Session ID" ? meta.session_id : v;
        const title = k === "Session ID" ? `title="${escapeHtml(fullValue)}"` : "";
        return `<tr><td>${escapeHtml(k)}</td><td ${title}>${escapeHtml(v)}</td></tr>`;
      })
      .join("\n")}
  </table>
  ${meta.first_prompt ? `<h3>First Prompt</h3><div class="prompt">${escapeHtml(meta.first_prompt)}</div>` : ""}
</body>
</html>`;
  }

  private renderLiveSection(live: cli.MonitorRow): string {
    const timestamp = new Date().toLocaleTimeString();
    const statusClass = `status-${live.status}`;
    const ctxPct = live.ctx_pct && live.ctx_pct > 0 ? live.ctx_pct : 0;
    const ctxClass = ctxPct >= 90 ? "warn" : "";

    const rows: [string, string][] = [
      ["Status", `<span class="${statusClass}">${escapeHtml(formatStatusGlyph(live.status))}</span>`],
    ];
    if (live.started_at_ms > 0) {
      rows.push(["Elapsed", escapeHtml(formatElapsedSecs(live.elapsed_secs))]);
    }
    if (live.pid != null) {
      rows.push(["CPU", escapeHtml(formatCpuPct(live.cpu_pct))]);
      rows.push(["Mem", escapeHtml(formatMemKb(live.mem_kb))]);
    }
    const ctxLabel = escapeHtml(formatCtxPct(live.ctx_pct));
    rows.push([
      "CTX",
      `${ctxLabel}<span class="ctx-bar"><span class="ctx-fill ${ctxClass}" style="width:${Math.min(100, ctxPct)}%"></span></span>`,
    ]);
    rows.push([
      "Tokens",
      escapeHtml(
        `${formatCompactTokens(live.tokens_in)} / ${formatCompactTokens(live.tokens_out)} / ${formatCompactTokens(live.tokens_cache)} (in/out/ch)`
      ),
    ]);
    if (live.current_task) {
      const task = live.current_task.length > 80 ? live.current_task.slice(0, 79) + "…" : live.current_task;
      rows.push(["Task", `<code>${escapeHtml(task)}</code>`]);
    } else if (live.last_tool) {
      rows.push(["Last tool", escapeHtml(`${live.last_tool} × ${live.tool_count}`)]);
    }
    if (live.compaction_count > 0) {
      rows.push(["Compaction", escapeHtml(`${live.compaction_count} event${live.compaction_count === 1 ? "" : "s"}`)]);
    }
    rows.push(["Activity", escapeHtml(formatRelativeTime(live.last_activity_ms))]);
    rows.push(["PID", live.pid != null ? String(live.pid) : "-"]);

    // Sparkline (token history). Only rendered when ≥ 2 samples exist — a
    // single point doesn't communicate a trend.
    const tokenHistory = live.token_history ?? [];
    const sparkline = tokenHistory.length >= 2 ? renderSparklineSvg(tokenHistory) : "";

    return `<section class="live">
  <div class="live-header">
    <span class="title">Live</span>
    <span class="timestamp">as of ${escapeHtml(timestamp)}</span>
  </div>
  <table class="live-table">
    ${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join("\n")}
  </table>
  ${sparkline}
  <div class="footer-note">Close and reopen the panel to refresh live metrics.</div>
</section>`;
  }

  private dispose(): void {
    SessionDetailPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatCatalogs(catalogs?: Array<{ id: string; name: string }>): string {
  if (!catalogs || catalogs.length === 0) return "-";
  return catalogs.map((catalog) => `${catalog.name} (${catalog.id})`).join(", ");
}

/**
 * Render an inline SVG sparkline for the token-history tail. Pure SVG — no
 * scripts required, so it renders in a webview with enableScripts=false.
 *
 * The polyline is fit to a 240×40 viewport with a small inset. Y axis is
 * scaled so the min/max of the samples span the full height. Width per
 * sample is even, so a long history collapses cleanly to a tight wave.
 */
function renderSparklineSvg(history: number[]): string {
  const width = 240;
  const height = 40;
  const inset = 3;
  const values = history.filter((v) => Number.isFinite(v));
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const n = values.length;
  const stepX = (width - inset * 2) / (n - 1);
  const points = values
    .map((v, i) => {
      const x = inset + i * stepX;
      const y = height - inset - ((v - min) / span) * (height - inset * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<div class="sparkline"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" aria-label="token history sparkline">
    <polyline points="${escapeHtml(points)}" fill="none" stroke="var(--vscode-charts-blue, #3794ff)" stroke-width="1.5" />
  </svg></div>`;
}
