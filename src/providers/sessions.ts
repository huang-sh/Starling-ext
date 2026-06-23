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
import { clearProblem, logError, reportProblem } from "../logging";
import { normalizePathForTree } from "./projects";

// --- Tree item types ---

class ProviderNode extends vscode.TreeItem {
  constructor(public readonly provider: string) {
    super(provider, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(
      provider === "claude" ? "hubot" : "server"
    );
    this.contextValue = "provider";
  }
}

type MonitorGroupKind = "attention" | "active" | "pinned" | "recent" | "static";

class MonitorSummaryNode extends vscode.TreeItem {
  constructor(snapshot: cli.MonitorSnapshot) {
    super("Starling monitor", vscode.TreeItemCollapsibleState.None);
    const rows = [...snapshot.pinned, ...snapshot.recent];
    const summary = summarizeMonitorRows(rows);
    this.description = `${snapshot.pinned_total} pinned  ·  ${snapshot.active} active`;
    this.tooltip = summary.tooltip;
    this.iconPath = summary.attention > 0
      ? new vscode.ThemeIcon("warning", statusColor("waiting"))
      : summary.active > 0
        ? new vscode.ThemeIcon("pulse", statusColor("running"))
        : new vscode.ThemeIcon("pulse", statusColor("idle"));
    this.contextValue = "monitor-summary";
  }
}

class MonitorGroupNode extends vscode.TreeItem {
  constructor(
    public readonly kind: MonitorGroupKind,
    public readonly rows: cli.MonitorRow[],
    label: string,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded
  ) {
    super(label, collapsible);
    this.description = String(rows.length);
    this.contextValue = `monitor-${kind}`;
    this.iconPath = iconForMonitorGroup(kind);
  }
}

class MonitorSessionNode extends vscode.TreeItem {
  public readonly meta: { session_id: string; project_path?: string | null };

  constructor(public readonly monitor: cli.MonitorRow) {
    const sessionId = monitor.canonical_session_id || monitor.session_id;
    const title = monitor.title || monitor.current_task || sessionId;
    const compactTitle = title.length > 58 ? `${title.slice(0, 55)}...` : title;
    super(`${shortSessionId(sessionId)}  ${compactTitle}`, vscode.TreeItemCollapsibleState.None);

    this.meta = {
      session_id: sessionId,
      project_path: monitor.project_path || null,
    };

    const project = projectNameForMonitor(monitor.project_path);
    const ctx = formatCtxPct(monitor.ctx_pct);
    const tokens = `${formatCompactTokens(monitor.tokens_in)}/${formatCompactTokens(monitor.tokens_out)}`;
    const task = monitor.current_task || (monitor.last_tool ? `last ${monitor.last_tool}` : "");
    const taskSuffix = task ? `  ·  ${truncate(task, 36)}` : "";
    this.description = `${statusText(monitor.status)}  ·  ${monitor.provider}  ·  ${monitor.model || "-"}  ·  ${project}  ·  ctx ${ctx}  ·  tok ${tokens}${taskSuffix}`;
    this.tooltip = buildMonitorTooltip(monitor);
    this.iconPath = iconForStatus(monitor.status);
    this.contextValue = monitor.pinned ? "session-pinned" : "session-unpinned";
  }
}

class SessionNode extends vscode.TreeItem {
  constructor(
    public readonly meta: cli.SessionMeta,
    public readonly isPinned: boolean,
    monitor?: cli.MonitorRow
  ) {
    const shortId = shortSessionId(meta.session_id);
    const title = meta.custom_title || meta.first_prompt || "";
    const titleSummary =
      title
        ? title.length > 40
          ? title.slice(0, 37) + "…"
          : title
        : "";
    const label = titleSummary
      ? `${shortId} ${titleSummary}`
      : shortId;

    super(
      label,
      vscode.TreeItemCollapsibleState.None
    );
    const normalizedProject = normalizePathForTree(meta.project_path || "");
    const project = normalizedProject ? normalizedProject.split("/").slice(-2).join("/") : "";
    const pinnedSuffix = isPinned ? " (pinned)" : "";

    const statusPrefix = monitor ? `${statusText(monitor.status)}  ·  ` : "";
    this.description = `${statusPrefix}${meta.model || ""}  ${project}${pinnedSuffix}`.trim();

    this.tooltip = buildSessionTooltip(meta, isPinned, monitor);
    this.iconPath = monitor ? iconForStatus(monitor.status) : new vscode.ThemeIcon("terminal");
    this.contextValue = isPinned ? "session-pinned" : "session-unpinned";
  }
}

function iconForStatus(status: cli.LiveStatus): vscode.ThemeIcon {
  switch (status) {
    case "waiting":
      return new vscode.ThemeIcon("warning", statusColor(status));
    case "running":
      return new vscode.ThemeIcon("sync~spin", statusColor(status));
    case "stale_running":
      return new vscode.ThemeIcon("debug-pause", statusColor(status));
    case "aborted":
      return new vscode.ThemeIcon("debug-stop", statusColor(status));
    case "idle":
      return new vscode.ThemeIcon("circle-large-outline", statusColor(status));
    case "failure":
      return new vscode.ThemeIcon("error", statusColor(status));
    case "stopped":
      return new vscode.ThemeIcon("debug-stop", statusColor(status));
    default:
      return new vscode.ThemeIcon("question", statusColor("unknown"));
  }
}

function statusColor(status: cli.LiveStatus): vscode.ThemeColor {
  switch (status) {
    case "waiting":
      return new vscode.ThemeColor("charts.yellow");
    case "running":
      return new vscode.ThemeColor("charts.green");
    case "stale_running":
      return new vscode.ThemeColor("charts.orange");
    case "aborted":
      return new vscode.ThemeColor("charts.orange");
    case "idle":
      return new vscode.ThemeColor("charts.blue");
    case "failure":
      return new vscode.ThemeColor("charts.red");
    case "stopped":
      return new vscode.ThemeColor("descriptionForeground");
    default:
      return new vscode.ThemeColor("disabledForeground");
  }
}

function statusText(status: cli.LiveStatus): string {
  switch (status) {
    case "waiting":
      return "Waiting";
    case "running":
      return "Running";
    case "stale_running":
      return "Running?";
    case "aborted":
      return "Aborted";
    case "idle":
      return "Idle";
    case "failure":
      return "Failure";
    case "stopped":
      return "Stopped";
    default:
      return "Unknown";
  }
}

function iconForMonitorGroup(kind: MonitorGroupKind): vscode.ThemeIcon {
  switch (kind) {
    case "attention":
      return new vscode.ThemeIcon("warning", statusColor("waiting"));
    case "active":
      return new vscode.ThemeIcon("pulse", statusColor("running"));
    case "pinned":
      return new vscode.ThemeIcon("pinned", new vscode.ThemeColor("charts.blue"));
    case "recent":
      return new vscode.ThemeIcon("history");
    case "static":
      return new vscode.ThemeIcon("list-tree");
  }
}

/**
 * Build the session hover tooltip. Static fields always render; a "— live —"
 * section is appended when a MonitorRow is available so the user sees status,
 * CPU/mem (when running), CTX%, tokens, current task, elapsed, compaction
 * events, and activity on hover.
 */
function buildSessionTooltip(
  meta: cli.SessionMeta,
  isPinned: boolean,
  monitor?: cli.MonitorRow
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;

  const pairs: Array<[string, string]> = [
    ["Session", `\`${meta.session_id}\``],
    ["Agent", meta.provider],
    ["Model", meta.model || "-"],
    ["Project", meta.project_path || "-"],
    ["Modified", meta.modified_at],
    ["Tokens", formatTokenUsage(meta.token_usage)],
    ["Pinned", isPinned ? "yes" : "no"],
  ];
  if (meta.first_prompt) pairs.push(["Prompt", meta.first_prompt]);

  const lines = pairs
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `**${k}:** ${v}`);

  if (monitor) {
    lines.push("**— live —**");
    lines.push(`**Status:** ${formatStatusGlyph(monitor.status)}`);
    if (monitor.started_at_ms > 0) {
      lines.push(`**Elapsed:** ${formatElapsedSecs(monitor.elapsed_secs)}`);
    }
    if (monitor.pid != null) {
      lines.push(`**CPU:** ${formatCpuPct(monitor.cpu_pct)}`);
      lines.push(`**Mem:** ${formatMemKb(monitor.mem_kb)}`);
    }
    lines.push(`**CTX:** ${formatCtxPct(monitor.ctx_pct)}`);
    lines.push(
      `**Tokens:** ${formatCompactTokens(monitor.tokens_in)}/${formatCompactTokens(monitor.tokens_out)}/${formatCompactTokens(monitor.tokens_cache)} (in/out/ch)`
    );
    if (monitor.current_task) {
      const task = monitor.current_task.length > 60
        ? monitor.current_task.slice(0, 59) + "…"
        : monitor.current_task;
      lines.push(`**Task:** \`${task}\``);
    } else if (monitor.last_tool) {
      lines.push(`**Last tool:** ${monitor.last_tool}×${monitor.tool_count}`);
    }
    if (monitor.compaction_count > 0) {
      lines.push(`**Compaction events:** ${monitor.compaction_count}`);
    }
    lines.push(`**Activity:** ${formatRelativeTime(monitor.last_activity_ms)}`);
  }

  md.appendMarkdown(lines.join("  \n"));
  return md;
}

function buildMonitorTooltip(monitor: cli.MonitorRow): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  const sessionId = monitor.canonical_session_id || monitor.session_id;
  const lines = [
    `**Session:** \`${sessionId}\``,
    `**Status:** ${formatStatusGlyph(monitor.status)}`,
    `**Agent:** ${monitor.provider}`,
    `**Model:** ${monitor.model || "-"}`,
    `**Project:** ${monitor.project_path || "-"}`,
    `**Catalog:** ${monitor.catalog || "-"}`,
    `**Pinned:** ${monitor.pinned ? "yes" : "no"}`,
  ];
  if (monitor.session_id && monitor.session_id !== sessionId) {
    lines.push(`**Source:** \`${monitor.session_id}\``);
  }

  if (monitor.pid != null) {
    lines.push(`**PID:** ${monitor.pid}`);
    lines.push(`**CPU:** ${formatCpuPct(monitor.cpu_pct)}`);
    lines.push(`**Mem:** ${formatMemKb(monitor.mem_kb)}`);
  }
  if (monitor.started_at_ms > 0) {
    lines.push(`**Elapsed:** ${formatElapsedSecs(monitor.elapsed_secs)}`);
  }
  lines.push(`**CTX:** ${formatCtxPct(monitor.ctx_pct)}`);
  lines.push(
    `**Tokens:** ${formatCompactTokens(monitor.tokens_in)}/${formatCompactTokens(monitor.tokens_out)}/${formatCompactTokens(monitor.tokens_cache)} (in/out/cache)`
  );
  if (monitor.current_task) {
    lines.push(`**Task:** ${monitor.current_task}`);
  }
  if (monitor.last_tool) {
    lines.push(`**Last tool:** ${monitor.last_tool} x${monitor.tool_count}`);
  }
  if (monitor.compaction_count > 0) {
    lines.push(`**Compaction events:** ${monitor.compaction_count}`);
  }
  lines.push(`**Last activity:** ${formatRelativeTime(monitor.last_activity_ms)}`);

  md.appendMarkdown(lines.join("  \n"));
  return md;
}

class LoadMoreSessionsNode extends vscode.TreeItem {
  constructor(public readonly provider: string) {
    super("Load more sessions", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("chevron-down");
    this.command = {
      title: "Load more sessions",
      command: "starling.loadMoreSessions",
      arguments: [provider],
    };
    this.contextValue = "session-load-more";
  }
}

type TreeNode =
  | ProviderNode
  | MonitorSummaryNode
  | MonitorGroupNode
  | MonitorSessionNode
  | SessionNode
  | LoadMoreSessionsNode
  | vscode.TreeItem;

function errorItem(label: string, err: unknown): vscode.TreeItem {
  const message = err instanceof Error ? err.message : String(err);
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = message.slice(0, 80);
  item.tooltip = message;
  item.iconPath = new vscode.ThemeIcon("error");
  return item;
}

// --- Provider ---

export class SessionsProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly visibleLimits = new Map<string, number>();

  // Live monitor cache. Keyed by session_id. Populated async after the tree
  // returns its first (static-tooltip) render; a single follow-up refresh
  // re-renders items with the live section appended. Bounded by monitor's own
  // output (≤ ~30 pinned + 8 recent + all running).
  private monitorBySid = new Map<string, cli.MonitorRow>();
  private monitorFetchInFlight: Promise<void> | null = null;
  private monitorRefreshQueued = false;
  private treeView: vscode.TreeView<TreeNode> | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  setTreeView(treeView: vscode.TreeView<TreeNode>): void {
    this.treeView = treeView;
    this.updateBadge();
  }

  startBackgroundMonitoring(): vscode.Disposable {
    const tick = async () => {
      if (this.disposed) return;
      await this.refreshMonitorSnapshot({ force: true });
      if (this.disposed) return;
      this.monitorTimer = setTimeout(tick, getMonitorRefreshMs());
    };
    this.monitorTimer = setTimeout(tick, 0);
    return new vscode.Disposable(() => {
      this.disposed = true;
      if (this.monitorTimer) {
        clearTimeout(this.monitorTimer);
        this.monitorTimer = undefined;
      }
    });
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      try {
        const snapshot = await cli.getMonitorSnapshot({ recent: true, allowStale: true });
        this.replaceMonitorSnapshot(snapshot);
        return this.buildMonitorRoot(snapshot);
      } catch (err) {
        const message = `Monitor unavailable: ${errorMessage(err)}`;
        logError(message, err);
        reportProblem("monitor", message);
        return [
          errorItem("Monitor unavailable", err),
          new MonitorGroupNode("static", [], "Static sessions", vscode.TreeItemCollapsibleState.Expanded),
        ];
      }
    }
    if (element instanceof MonitorGroupNode) {
      if (element.kind === "static") {
        return [new ProviderNode("claude"), new ProviderNode("codex")];
      }
      return element.rows.map((row) => new MonitorSessionNode(row));
    }
    if (element instanceof ProviderNode) {
      try {
        const limit = this.getVisibleLimit(element.provider);
        let sessions: cli.SessionMeta[];
        if (limit <= 0) {
          sessions = await cli.listSessions(0, element.provider, { all: true });
          if (sessions.length === 0) {
            return [new vscode.TreeItem("No sessions found", vscode.TreeItemCollapsibleState.None)];
          }
        } else {
          sessions = await cli.listSessions(limit, element.provider);
          if (sessions.length === 0) {
            return [new vscode.TreeItem("No sessions found", vscode.TreeItemCollapsibleState.None)];
          }
        }
        const pinnedIds = await this.getPinnedSessionIds();
        const items: TreeNode[] = sessions.map(
          (s) => new SessionNode(s, pinnedIds.has(s.session_id), this.monitorBySid.get(s.session_id))
        );
        if (limit > 0 && sessions.length >= limit) {
          items.push(new LoadMoreSessionsNode(element.provider));
        }
        // Async enrich: fetch monitor snapshot (debounced) and re-render once.
        this.scheduleMonitorRefresh();
        return items;
      } catch (err) {
        return [errorItem("Error loading sessions", err)];
      }
    }
    return [];
  }

  showMoreSessions(provider: string): void {
    const step = getSessionsLimit();
    if (step <= 0) return;

    const current = this.getVisibleLimit(provider);
    this.visibleLimits.set(provider, current + step);
    this._onDidChange.fire();
  }

  resetLimits(): void {
    this.visibleLimits.clear();
    this._onDidChange.fire();
  }

  /**
   * Debounced + idempotent scheduler. Multiple getChildren calls in rapid
   * succession (e.g. expanding both claude and codex at once) coalesce into a
   * single monitor fetch.
   */
  private scheduleMonitorRefresh(): void {
    if (this.monitorRefreshQueued || this.monitorFetchInFlight) return;
    this.monitorRefreshQueued = true;
    setTimeout(() => {
      this.monitorRefreshQueued = false;
      this.refreshMonitorSnapshot({ force: false }).catch(() => undefined);
    }, 50);
  }

  private async refreshMonitorSnapshot(opts: { force: boolean }): Promise<void> {
    if (this.monitorFetchInFlight) return this.monitorFetchInFlight;
    const p = (async () => {
      try {
        const snap = await cli.getMonitorSnapshot({ recent: true, force: opts.force });
        const next = monitorMapFromSnapshot(snap);
        // Only fire if visible tooltip fields changed — otherwise the refresh
        // loop (fire → getChildren → schedule → fetch → fire) never settles.
        const changed = !this.monitorMapsEqual(this.monitorBySid, next);
        this.monitorBySid = next;
        this.updateBadge();
        if (changed) this._onDidChange.fire();
      } catch (err) {
        // Monitor unavailable (CLI error / not installed). Silently keep
        // static-only tooltips — the tree must never break because of monitor.
        const message = `Monitor refresh failed: ${errorMessage(err)}`;
        logError(message, err);
        reportProblem("monitor", message, vscode.DiagnosticSeverity.Warning);
      } finally {
        this.monitorFetchInFlight = null;
      }
    })();
    this.monitorFetchInFlight = p;
    return p;
  }

  private replaceMonitorSnapshot(snapshot: cli.MonitorSnapshot): void {
    this.monitorBySid = monitorMapFromSnapshot(snapshot);
    clearProblem("monitor");
    this.updateBadge();
  }

  private buildMonitorRoot(snapshot: cli.MonitorSnapshot): TreeNode[] {
    const rows = uniqueMonitorRows([...snapshot.pinned, ...snapshot.recent]);
    const attention = rows.filter((row) => row.status === "waiting");
    const active = rows.filter((row) => isActiveLiveStatus(row.status));
    const nodes: TreeNode[] = [new MonitorSummaryNode(snapshot)];
    if (attention.length > 0) {
      nodes.push(new MonitorGroupNode("attention", sortMonitorRows(attention), "Needs attention"));
    }
    if (active.length > 0) {
      nodes.push(new MonitorGroupNode("active", sortMonitorRows(active), "Active sessions"));
    }
    nodes.push(new MonitorGroupNode("pinned", sortMonitorRows(snapshot.pinned), "Pinned monitor", vscode.TreeItemCollapsibleState.Expanded));
    if (snapshot.recent.length > 0) {
      nodes.push(new MonitorGroupNode("recent", sortMonitorRows(snapshot.recent), "Recent monitor", vscode.TreeItemCollapsibleState.Collapsed));
    }
    nodes.push(new MonitorGroupNode("static", [], "Static sessions", vscode.TreeItemCollapsibleState.Collapsed));
    return nodes;
  }

  private updateBadge(): void {
    if (!this.treeView) return;
    const summary = summarizeMonitorRows([...this.monitorBySid.values()]);
    if (summary.attention > 0) {
      this.treeView.badge = {
        value: summary.attention,
        tooltip: summary.tooltip,
      };
    } else if (summary.active > 0) {
      this.treeView.badge = {
        value: summary.active,
        tooltip: summary.tooltip,
      };
    } else {
      this.treeView.badge = undefined;
    }
  }

  private monitorMapsEqual(
    a: Map<string, cli.MonitorRow>,
    b: Map<string, cli.MonitorRow>
  ): boolean {
    if (a.size !== b.size) return false;
    for (const [sid, row] of a) {
      const other = b.get(sid);
      if (!other) return false;
      if (
        row.status !== other.status ||
        row.pid !== other.pid ||
        row.ctx_pct !== other.ctx_pct ||
        row.last_tool !== other.last_tool ||
        row.tokens_in !== other.tokens_in ||
        row.tokens_out !== other.tokens_out ||
        row.tokens_cache !== other.tokens_cache ||
        row.current_task !== other.current_task ||
        row.started_at_ms !== other.started_at_ms ||
        row.compaction_count !== other.compaction_count
      ) {
        return false;
      }
    }
    return true;
  }

  private getVisibleLimit(provider: string): number {
    const step = getSessionsLimit();
    if (step <= 0) return 0;

    const existing = this.visibleLimits.get(provider);
    return existing ?? step;
  }

  private async getPinnedSessionIds(): Promise<Set<string>> {
    try {
      const pins = await cli.listPins();
      return new Set(pins.map((p) => p.session_id));
    } catch {
      return new Set();
    }
  }
}

function monitorMapFromSnapshot(snapshot: cli.MonitorSnapshot): Map<string, cli.MonitorRow> {
  const next = new Map<string, cli.MonitorRow>();
  for (const row of [...snapshot.pinned, ...snapshot.recent]) {
    if (!row.session_id) continue;
    next.set(row.session_id, row);
    if (row.canonical_session_id) {
      next.set(row.canonical_session_id, row);
    }
  }
  return next;
}

function uniqueMonitorRows(rows: cli.MonitorRow[]): cli.MonitorRow[] {
  const seen = new Set<string>();
  const unique: cli.MonitorRow[] = [];
  for (const row of rows) {
    const key = row.canonical_session_id || row.session_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function isActiveLiveStatus(status: cli.LiveStatus): boolean {
  return status === "waiting" || status === "running";
}

function sortMonitorRows(rows: cli.MonitorRow[]): cli.MonitorRow[] {
  const rank: Record<cli.LiveStatus, number> = {
    running: 0,
    stale_running: 1,
    waiting: 2,
    failure: 3,
    aborted: 4,
    idle: 5,
    stopped: 6,
    unknown: 7,
  };
  return [...rows].sort((a, b) => {
    const statusDiff = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    return (b.last_activity_ms || 0) - (a.last_activity_ms || 0);
  });
}

function projectNameForMonitor(projectPath: string): string {
  const normalized = normalizePathForTree(projectPath || "");
  if (!normalized) return "-";
  return normalized.split("/").filter(Boolean).slice(-1)[0] || normalized;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getSessionsLimit(): number {
  const configured = vscode.workspace.getConfiguration("starling").get<number>("sessionTreeLimit", 50);
  const normalized = Number(configured);
  if (!Number.isFinite(normalized)) return 50;
  return Math.max(0, Math.floor(normalized));
}

function getMonitorRefreshMs(): number {
  const configured = vscode.workspace.getConfiguration("starling").get<number>("monitorRefreshSeconds", 5);
  const normalized = Number(configured);
  if (!Number.isFinite(normalized) || normalized <= 0) return 3000;
  return Math.max(1000, Math.floor(normalized * 1000));
}

function summarizeMonitorRows(rows: cli.MonitorRow[]): { attention: number; active: number; tooltip: string } {
  const counts = new Map<cli.LiveStatus, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const waiting = counts.get("waiting") ?? 0;
  const running = counts.get("running") ?? 0;
  const stale = counts.get("stale_running") ?? 0;
  const aborted = counts.get("aborted") ?? 0;
  const idle = counts.get("idle") ?? 0;
  const failure = counts.get("failure") ?? 0;
  const active = waiting + running;
  const parts = [
    waiting ? `${waiting} waiting` : "",
    running ? `${running} running` : "",
    stale ? `${stale} stale` : "",
    failure ? `${failure} failure` : "",
    aborted ? `${aborted} aborted` : "",
    idle ? `${idle} idle` : "",
  ].filter(Boolean);
  return {
    attention: waiting,
    active,
    tooltip: parts.length ? parts.join(", ") : "No active sessions",
  };
}
