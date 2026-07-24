import * as vscode from "vscode";
import type { AgentProvider } from "./agent";

export const MONITOR_AGENT_MODES = [
  {
    value: "all",
    label: "All Agents",
    description: "Show Claude, Codex, and Pi sessions",
  },
  {
    value: "claude",
    label: "Claude",
    description: "Only show Claude Code sessions",
  },
  {
    value: "codex",
    label: "Codex",
    description: "Only show Codex sessions",
  },
  {
    value: "pi",
    label: "Pi",
    description: "Only show Pi sessions",
  },
] as const;

export type MonitorAgentMode = typeof MONITOR_AGENT_MODES[number]["value"];
export type MonitorAgentFilter = AgentProvider;

export const DEFAULT_MONITOR_AGENT: MonitorAgentMode = "all";

export function normalizeMonitorAgent(value: unknown): MonitorAgentMode {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return DEFAULT_MONITOR_AGENT;
  if (MONITOR_AGENT_MODES.some((mode) => mode.value === text)) {
    return text as MonitorAgentMode;
  }
  return DEFAULT_MONITOR_AGENT;
}

export function getConfiguredMonitorAgentMode(): MonitorAgentMode {
  const configured = vscode.workspace
    .getConfiguration("starling")
    .get<string>("monitorAgent", DEFAULT_MONITOR_AGENT);
  return normalizeMonitorAgent(configured);
}

export function getConfiguredMonitorAgentFilter(): MonitorAgentFilter | undefined {
  const mode = getConfiguredMonitorAgentMode();
  return mode === "all" ? undefined : mode;
}

export function monitorAgentLabel(agent: MonitorAgentMode): string {
  return MONITOR_AGENT_MODES.find((mode) => mode.value === agent)?.label ?? "All Agents";
}
