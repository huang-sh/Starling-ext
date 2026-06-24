import * as vscode from "vscode";
import * as cli from "../cli";
import { clearProblem, logError, reportProblem } from "../logging";

const DEFAULT_MONITOR_REFRESH_MS = 3000;

export function iconForStatus(status: cli.LiveStatus): vscode.ThemeIcon {
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

export function statusColor(status: cli.LiveStatus): vscode.ThemeColor {
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

export function monitorMapFromSnapshot(snapshot: cli.MonitorSnapshot): Map<string, cli.MonitorRow> {
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

export function monitorForSession(
  monitorBySid: Map<string, cli.MonitorRow>,
  sessionId: string
): cli.MonitorRow | undefined {
  return monitorBySid.get(sessionId);
}

export class LiveStatusStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<cli.MonitorSnapshot>();
  private readonly _onDidStatusChange = new vscode.EventEmitter<cli.MonitorSnapshot>();
  readonly onDidChange = this._onDidChange.event;
  readonly onDidStatusChange = this._onDidStatusChange.event;

  private snapshot?: cli.MonitorSnapshot;
  private monitorBySid = new Map<string, cli.MonitorRow>();
  private inFlight: Promise<cli.MonitorSnapshot | undefined> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  getSnapshot(): cli.MonitorSnapshot | undefined {
    return this.snapshot;
  }

  getMonitor(sessionId: string): cli.MonitorRow | undefined {
    return monitorForSession(this.monitorBySid, sessionId);
  }

  getRows(): cli.MonitorRow[] {
    return this.snapshot ? [...this.snapshot.pinned, ...this.snapshot.recent] : [];
  }

  startBackgroundMonitoring(): vscode.Disposable {
    const tick = async () => {
      if (this.disposed) return;
      await this.refresh({ force: true });
      if (this.disposed) return;
      this.timer = setTimeout(tick, getMonitorRefreshMs());
    };
    this.timer = setTimeout(tick, 0);
    return new vscode.Disposable(() => this.dispose());
  }

  async ensureSnapshot(): Promise<cli.MonitorSnapshot | undefined> {
    if (this.snapshot) return this.snapshot;
    return this.refresh({ force: false });
  }

  async refresh(opts: { force: boolean }): Promise<cli.MonitorSnapshot | undefined> {
    if (this.inFlight) return this.inFlight;
    const request = (async () => {
      try {
        const next = await cli.getMonitorSnapshot({
          recent: true,
          force: opts.force,
          allowStale: true,
        });
        clearProblem("monitor");
        this.replaceSnapshot(next);
        return next;
      } catch (err) {
        const message = `Monitor refresh failed: ${errorMessage(err)}`;
        logError("Monitor refresh failed", err);
        reportProblem("monitor", message, vscode.DiagnosticSeverity.Warning);
        return this.snapshot;
      } finally {
        this.inFlight = undefined;
      }
    })();
    this.inFlight = request;
    return request;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this._onDidChange.dispose();
    this._onDidStatusChange.dispose();
  }

  private replaceSnapshot(next: cli.MonitorSnapshot): void {
    const previous = this.snapshot;
    const changed = !previous || !monitorSnapshotsEqual(previous, next);
    const statusChanged = !previous || !monitorStatusSnapshotsEqual(previous, next);
    this.snapshot = next;
    this.monitorBySid = monitorMapFromSnapshot(next);
    if (changed) {
      this._onDidChange.fire(next);
    }
    if (statusChanged) {
      this._onDidStatusChange.fire(next);
    }
  }
}

function getMonitorRefreshMs(): number {
  const configured = vscode.workspace.getConfiguration("starling").get<number>("monitorRefreshSeconds", 5);
  const normalized = Number(configured);
  if (!Number.isFinite(normalized) || normalized <= 0) return DEFAULT_MONITOR_REFRESH_MS;
  return Math.max(1000, Math.floor(normalized * 1000));
}

function monitorSnapshotsEqual(a: cli.MonitorSnapshot, b: cli.MonitorSnapshot): boolean {
  if (
    a.pinned_total !== b.pinned_total ||
    a.recent_total !== b.recent_total ||
    a.active !== b.active
  ) {
    return false;
  }
  return monitorMapsEqual(monitorMapFromSnapshot(a), monitorMapFromSnapshot(b));
}

function monitorStatusSnapshotsEqual(a: cli.MonitorSnapshot, b: cli.MonitorSnapshot): boolean {
  const aMap = monitorMapFromSnapshot(a);
  const bMap = monitorMapFromSnapshot(b);
  if (aMap.size !== bMap.size) return false;
  for (const [sid, row] of aMap) {
    const other = bMap.get(sid);
    if (!other || row.status !== other.status) return false;
  }
  return true;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function monitorMapsEqual(
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
      row.compaction_count !== other.compaction_count ||
      row.last_activity_ms !== other.last_activity_ms
    ) {
      return false;
    }
  }
  return true;
}
