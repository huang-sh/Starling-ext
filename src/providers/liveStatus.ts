import * as vscode from "vscode";
import * as cli from "../cli";
import { clearProblem, logError, reportProblem } from "../logging";
import { getConfiguredMonitorAgentFilter } from "../monitorAgent";
import { getConfiguredMonitorSort } from "../monitorSort";
import { monitorRefreshDelayMs } from "../monitorPolicy";
import {
  scopedSessionLookupKey,
  sessionFileLookupKey,
  sessionIdentityKey,
  unscopedSessionLookupKey,
} from "../sessionIdentity";

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
  const unscoped = new Map<string, cli.MonitorRow | undefined>();
  for (const row of monitorRows(snapshot)) {
    if (!row.session_id) continue;
    if (row.file_path) {
      next.set(sessionFileLookupKey(row.file_path), row);
    }
    const ids = new Set([row.session_id, row.canonical_session_id].filter(Boolean));
    for (const id of ids) {
      next.set(scopedSessionLookupKey(row.provider, id, row.project_path), row);
      const key = unscopedSessionLookupKey(id);
      const existing = unscoped.get(key);
      if (!unscoped.has(key)) {
        unscoped.set(key, row);
      } else if (existing && monitorIdentityKey(existing) !== monitorIdentityKey(row)) {
        unscoped.set(key, undefined);
      }
    }
  }
  for (const [key, row] of unscoped) {
    if (row) next.set(key, row);
  }
  return next;
}

export function monitorForSession(
  monitorBySid: Map<string, cli.MonitorRow>,
  sessionId: string,
  provider?: string,
  projectPath?: string | null,
  filePath?: string | null
): cli.MonitorRow | undefined {
  if (filePath) {
    const byFile = monitorBySid.get(sessionFileLookupKey(filePath));
    if (byFile) return byFile;
  }
  if (provider) {
    const scoped = monitorBySid.get(scopedSessionLookupKey(provider, sessionId, projectPath));
    if (scoped) return scoped;
  }
  return monitorBySid.get(unscopedSessionLookupKey(sessionId));
}

export function monitorIdentityKey(row: cli.MonitorRow): string {
  return sessionIdentityKey({
    provider: row.provider,
    session_id: row.canonical_session_id || row.session_id,
    project_path: row.project_path,
    file_path: row.file_path,
  });
}

export class LiveStatusStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<cli.MonitorSnapshot>();
  private readonly _onDidStatusChange = new vscode.EventEmitter<cli.MonitorSnapshot>();
  readonly onDidChange = this._onDidChange.event;
  readonly onDidStatusChange = this._onDidStatusChange.event;

  private snapshot?: cli.MonitorSnapshot;
  private monitorBySid = new Map<string, cli.MonitorRow>();
  private inFlight: Promise<cli.MonitorSnapshot | undefined> | undefined;
  private requestSerial = 0;
  private timer: NodeJS.Timeout | undefined;
  private watchRetryTimer: NodeJS.Timeout | undefined;
  private watch?: cli.MonitorWatchHandle;
  private disposed = false;

  getSnapshot(): cli.MonitorSnapshot | undefined {
    return this.snapshot;
  }

  getMonitor(
    sessionId: string,
    provider?: string,
    projectPath?: string | null,
    filePath?: string | null
  ): cli.MonitorRow | undefined {
    return monitorForSession(this.monitorBySid, sessionId, provider, projectPath, filePath);
  }

  getRows(): cli.MonitorRow[] {
    return this.snapshot ? monitorRows(this.snapshot) : [];
  }

  startBackgroundMonitoring(): vscode.Disposable {
    this.startWatchOrPoll();
    return new vscode.Disposable(() => this.dispose());
  }

  /**
   * Preferred source: `starling top --json --watch` — one persistent
   * process pushing ~1s snapshots (hot cache, ≤2s perceived latency).
   * Falls back to the legacy poll loop whenever the watch process dies
   * (unsupported CLI build, crash, binary upgrade), with periodic retry
   * of the watch path. Dispose kills the watch child.
   */
  private startWatchOrPoll(): void {
    this.stopWatchRetryTimer();
    let receivedSnapshot = false;
    const handle = cli.watchMonitorSnapshots({
      agent: getConfiguredMonitorAgentFilter(),
      sort: getConfiguredMonitorSort(),
      onSnapshot: (raw) => {
        try {
          receivedSnapshot = true;
          const next = cli.normalizeMonitorSnapshot(raw);
          clearProblem("monitor");
          this.replaceSnapshot(next);
          // Watch is healthy: make sure no poll timer competes with it.
          this.stopPollTimer();
        } catch (err) {
          logError("Monitor watch snapshot parse failed", err);
        }
      },
      onExit: (reason) => {
        this.watch = undefined;
        if (this.disposed) return;
        logError(`Monitor watch stopped; falling back to polling`, new Error(reason));
        this.startPolling();
        this.watchRetryTimer = setTimeout(() => {
          if (this.disposed || this.watch) return;
          this.stopPollTimer();
          this.startWatchOrPoll();
        }, getMonitorRefreshMs());
      },
    });
    this.watch = handle;
    // Safety net: if the watch never produces a snapshot (stalled pipe),
    // the poll fallback still delivers data.
    this.timer = setTimeout(() => {
      if (!this.disposed && !receivedSnapshot) this.startPolling();
    }, getMonitorRefreshMs() * 2);
  }

  private startPolling(): void {
    this.stopPollTimer();
    const tick = async () => {
      if (this.disposed) return;
      await this.refresh({ force: true });
      if (this.disposed || this.watch) return;
      this.timer = setTimeout(tick, monitorRefreshDelayMs(getMonitorRefreshMs()));
    };
    this.timer = setTimeout(tick, 0);
  }

  private stopPollTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private stopWatchRetryTimer(): void {
    if (this.watchRetryTimer) {
      clearTimeout(this.watchRetryTimer);
      this.watchRetryTimer = undefined;
    }
  }

  async ensureSnapshot(): Promise<cli.MonitorSnapshot | undefined> {
    if (this.snapshot) return this.snapshot;
    return this.refresh({ force: false });
  }

  async refresh(opts: { force: boolean }): Promise<cli.MonitorSnapshot | undefined> {
    if (this.inFlight) return this.inFlight;
    const serial = ++this.requestSerial;
    const request = (async () => {
      try {
        const next = await cli.getMonitorSnapshot({
          force: opts.force,
          allowStale: true,
          agent: getConfiguredMonitorAgentFilter(),
          sort: getConfiguredMonitorSort(),
        });
        clearProblem("monitor");
        if (serial === this.requestSerial) {
          this.replaceSnapshot(next);
        }
        return next;
      } catch (err) {
        const message = `Monitor refresh failed: ${errorMessage(err)}`;
        logError("Monitor refresh failed", err);
        reportProblem("monitor", message, vscode.DiagnosticSeverity.Warning);
        return this.snapshot;
      } finally {
        if (serial === this.requestSerial) {
          this.inFlight = undefined;
        }
      }
    })();
    this.inFlight = request;
    return request;
  }

  dispose(): void {
    this.disposed = true;
    this.watch?.dispose();
    this.watch = undefined;
    this.stopWatchRetryTimer();
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

function monitorRows(snapshot: cli.MonitorSnapshot): cli.MonitorRow[] {
  return snapshot.rows ?? [...snapshot.pinned, ...snapshot.recent];
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
  if (monitorRowOrder(a) !== monitorRowOrder(b)) return false;
  return monitorMapsEqual(monitorMapFromSnapshot(a), monitorMapFromSnapshot(b));
}

function monitorStatusSnapshotsEqual(a: cli.MonitorSnapshot, b: cli.MonitorSnapshot): boolean {
  const aMap = monitorMapFromSnapshot(a);
  const bMap = monitorMapFromSnapshot(b);
  if (aMap.size !== bMap.size) return false;
  for (const [sid, row] of aMap) {
    const other = bMap.get(sid);
    if (!other || row.status !== other.status || row.pid !== other.pid) return false;
  }
  return true;
}

function monitorRowOrder(snapshot: cli.MonitorSnapshot): string {
  return monitorRows(snapshot)
    .map(monitorIdentityKey)
    .join("\0");
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
      row.last_skill !== other.last_skill ||
      row.tokens_in !== other.tokens_in ||
      row.tokens_out !== other.tokens_out ||
      row.tokens_cache !== other.tokens_cache ||
      row.skill_count !== other.skill_count ||
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
