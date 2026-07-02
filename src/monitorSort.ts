import * as vscode from "vscode";

export const MONITOR_SORT_MODES = [
  {
    value: "activity",
    label: "Activity",
    description: "Status activity first, then most recent activity",
  },
  {
    value: "recent",
    label: "Recent",
    description: "Most recent activity time first",
  },
  {
    value: "tokens",
    label: "Tokens",
    description: "Highest total token usage first",
  },
  {
    value: "created",
    label: "Created",
    description: "Newest session start time first",
  },
  {
    value: "memory",
    label: "Memory",
    description: "Highest memory usage first",
  },
  {
    value: "cpu",
    label: "CPU",
    description: "Highest CPU usage first",
  },
  {
    value: "ctx",
    label: "Context",
    description: "Highest context percentage first",
  },
  {
    value: "skills",
    label: "Skills",
    description: "Highest skill-call count first",
  },
  {
    value: "tools",
    label: "Tools",
    description: "Highest tool-call count first",
  },
] as const;

export type MonitorSort = typeof MONITOR_SORT_MODES[number]["value"];

export const DEFAULT_MONITOR_SORT: MonitorSort = "activity";

const MONITOR_SORT_ALIASES: Record<string, MonitorSort> = {
  active: "activity",
  status: "activity",
  time: "recent",
  "last-active": "recent",
  "last-activity": "recent",
  token: "tokens",
  start: "created",
  started: "created",
  "created-at": "created",
  mem: "memory",
  rss: "memory",
  context: "ctx",
  skill: "skills",
  tool: "tools",
};

export function normalizeMonitorSort(value: unknown): MonitorSort {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return DEFAULT_MONITOR_SORT;
  if (MONITOR_SORT_MODES.some((mode) => mode.value === text)) {
    return text as MonitorSort;
  }
  return MONITOR_SORT_ALIASES[text] ?? DEFAULT_MONITOR_SORT;
}

export function getConfiguredMonitorSort(): MonitorSort {
  const configured = vscode.workspace
    .getConfiguration("starling")
    .get<string>("monitorSort", DEFAULT_MONITOR_SORT);
  return normalizeMonitorSort(configured);
}

export function monitorSortLabel(sort: MonitorSort): string {
  return MONITOR_SORT_MODES.find((mode) => mode.value === sort)?.label ?? "Activity";
}
