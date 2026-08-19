import * as vscode from "vscode";
import * as cli from "../cli";
import { AGENT_PROVIDERS, agentIconName, normalizeAgentProvider } from "../agent";
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
  summarizeMonitorRows,
} from "../sessionDisplay";
import { clearProblem, logError, reportProblem } from "../logging";
import { iconForStatus, LiveStatusStore, monitorIdentityKey, statusColor } from "./liveStatus";
import { getConfiguredMonitorAgentMode, monitorAgentLabel } from "../monitorAgent";
import { getConfiguredMonitorSort, monitorSortLabel } from "../monitorSort";
import { sameSessionIdentity } from "../sessionIdentity";

// --- Tree item types ---

class ProviderNode extends vscode.TreeItem {
  constructor(public readonly provider: string) {
    super(provider, vscode.TreeItemCollapsibleState.Collapsed);
    const agent = normalizeAgentProvider(provider);
    this.iconPath = new vscode.ThemeIcon(agent ? agentIconName(agent) : "server");
    this.contextValue = "provider";
  }
}

type MonitorGroupKind = "attention" | "active" | "pinned" | "recent" | "static";

class MonitorSummaryNode extends vscode.TreeItem {
  constructor(snapshot: cli.MonitorSnapshot) {
    super("Starling monitor", vscode.TreeItemCollapsibleState.None);
    const rows = monitorRows(snapshot);
    const summary = summarizeMonitorRows(rows, snapshot.active);
    const agent = getConfiguredMonitorAgentMode();
    const sort = getConfiguredMonitorSort();
    this.description = `${snapshot.pinned_total} pinned  ·  ${snapshot.active} active  ·  agent ${agent}  ·  sort ${sort}`;
    this.tooltip = `${summary.tooltip} · Agent: ${monitorAgentLabel(agent)} · Sort: ${monitorSortLabel(sort)}`;
    this.iconPath = summary.attention > 0
      ? new vscode.ThemeIcon("warning", statusColor("waiting"))
      : summary.active > 0
        ? new vscode.ThemeIcon("pulse", statusColor("running"))
        : new vscode.ThemeIcon("pulse", statusColor("idle"));
    this.command = {
      title: "Open Monitor Panel",
      command: "starling.openMonitorPanel",
    };
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
    const title = normalizeDisplayTitle(monitor.title, sessionId);
    const label = title ? truncate(title, 58) : shortSessionId(sessionId);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.meta = {
      session_id: sessionId,
      project_path: monitor.project_path || null,
    };

    const ctx = formatCtxPct(monitor.ctx_pct);
    const tokens = `${formatCompactTokens(monitor.tokens_in)}/${formatCompactTokens(monitor.tokens_out)}/${formatCompactTokens(monitor.tokens_cache)}`;
    const parts = [
      monitor.model || "",
      ctx !== "-" ? `ctx ${ctx}` : "",
      tokens !== "0/0/0" ? `tok ${tokens}` : "",
      monitor.skill_count > 0 ? `skills ${monitor.skill_count}` : "",
      monitor.current_task ? truncate(monitor.current_task, 42) : "",
    ].filter(Boolean);
    this.description = parts.join("  ·  ");
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
    const label = titleSummary || shortId;

    super(
      label,
      vscode.TreeItemCollapsibleState.None
    );
    const pinnedSuffix = isPinned ? " (pinned)" : "";

    this.description = `${meta.model || ""}${pinnedSuffix}`.trim();

    this.tooltip = buildSessionTooltip(meta, isPinned, monitor);
    this.iconPath = monitor ? iconForStatus(monitor.status) : new vscode.ThemeIcon("terminal");
    this.contextValue = isPinned ? "session-pinned" : "session-unpinned";
  }
}

function normalizeDisplayTitle(title: string | null | undefined, sessionId: string): string {
  const normalized = (title || "").trim();
  if (!normalized) return "";
  if (normalized === sessionId || normalized === shortSessionId(sessionId)) return "";
  return normalized;
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
    if (monitor.skill_count > 0) {
      lines.push(`**Skill calls:** ${monitor.skill_count}`);
      const usage = formatSkillUsage(monitor);
      if (usage !== "-") {
        lines.push(`**Skill usage:** ${usage}`);
      }
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
  if (monitor.skill_count > 0) {
    lines.push(`**Skill calls:** ${monitor.skill_count}`);
    const usage = formatSkillUsage(monitor);
    if (usage !== "-") {
      lines.push(`**Skill usage:** ${usage}`);
    }
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
  private treeView: vscode.TreeView<TreeNode> | undefined;

  constructor(private readonly liveStatus: LiveStatusStore) {
    this.liveStatus.onDidChange(() => {
      this.updateBadge();
      this._onDidChange.fire();
    });
  }

  setTreeView(treeView: vscode.TreeView<TreeNode>): void {
    this.treeView = treeView;
    this.updateBadge();
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      const snapshot = await this.liveStatus.ensureSnapshot();
      if (snapshot) {
        clearProblem("monitor");
        return this.buildMonitorRoot(snapshot);
      }
      const message = "Monitor unavailable: no live status snapshot";
      logError(message);
      reportProblem("monitor", message);
      return [
        errorItem("Monitor unavailable", message),
        new MonitorGroupNode("static", [], "Static sessions", vscode.TreeItemCollapsibleState.Expanded),
      ];
    }
    if (element instanceof MonitorGroupNode) {
      if (element.kind === "static") {
        return AGENT_PROVIDERS.map((provider) => new ProviderNode(provider));
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
        const pins = await this.getPins();
        const items: TreeNode[] = sessions.map(
          (session) => new SessionNode(
            session,
            pins.some((pin) => sameSessionIdentity(session, pin)),
            this.liveStatus.getMonitor(
              session.session_id,
              session.provider,
              session.project_path,
              session.file_path
            )
          )
        );
        if (limit > 0 && sessions.length >= limit) {
          items.push(new LoadMoreSessionsNode(element.provider));
        }
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

  private buildMonitorRoot(snapshot: cli.MonitorSnapshot): TreeNode[] {
    const rows = uniqueMonitorRows(monitorRows(snapshot));
    const attention = rows.filter((row) => row.status === "waiting");
    const active = rows.filter(isActiveMonitorRow);
    const pinned = rows.filter((row) => row.pinned);
    const recent = rows.filter((row) => !row.pinned);
    const nodes: TreeNode[] = [new MonitorSummaryNode(snapshot)];
    if (attention.length > 0) {
      nodes.push(new MonitorGroupNode("attention", attention, "Needs attention"));
    }
    if (active.length > 0) {
      nodes.push(new MonitorGroupNode("active", active, "Active sessions"));
    }
    nodes.push(new MonitorGroupNode("pinned", pinned, "Pinned monitor", vscode.TreeItemCollapsibleState.Expanded));
    if (recent.length > 0) {
      nodes.push(new MonitorGroupNode("recent", recent, "Recent monitor", vscode.TreeItemCollapsibleState.Collapsed));
    }
    nodes.push(new MonitorGroupNode("static", [], "Static sessions", vscode.TreeItemCollapsibleState.Collapsed));
    return nodes;
  }

  private updateBadge(): void {
    if (!this.treeView) return;
    const snapshot = this.liveStatus.getSnapshot();
    if (!snapshot) {
      this.treeView.badge = undefined;
      return;
    }
    const summary = summarizeMonitorRows(this.liveStatus.getRows(), snapshot.active);
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

  private getVisibleLimit(provider: string): number {
    const step = getSessionsLimit();
    if (step <= 0) return 0;

    const existing = this.visibleLimits.get(provider);
    return existing ?? step;
  }

  private async getPins(): Promise<cli.Bookmark[]> {
    try {
      return await cli.listPins();
    } catch {
      return [];
    }
  }
}

function uniqueMonitorRows(rows: cli.MonitorRow[]): cli.MonitorRow[] {
  const seen = new Set<string>();
  const unique: cli.MonitorRow[] = [];
  for (const row of rows) {
    const key = monitorIdentityKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function monitorRows(snapshot: cli.MonitorSnapshot): cli.MonitorRow[] {
  return snapshot.rows ?? [...snapshot.pinned, ...snapshot.recent];
}

function isActiveMonitorRow(row: cli.MonitorRow): boolean {
  return cli.isActiveMonitorRowStatus(row);
}

function formatSkillUsage(monitor: cli.MonitorRow): string {
  const usage = monitor.skill_usage
    .filter((entry) => entry.name && entry.count > 0)
    .slice(0, 4)
    .map((entry) => `${entry.name}×${entry.count}`);
  if (usage.length > 0) return usage.join(", ");
  return monitor.last_skill ? `${monitor.last_skill}×${monitor.skill_count}` : "-";
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
