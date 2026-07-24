export const AGENT_PROVIDERS = ["claude", "codex", "pi"] as const;

export type AgentProvider = typeof AGENT_PROVIDERS[number];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string"
    && AGENT_PROVIDERS.includes(value as AgentProvider);
}

export function normalizeAgentProvider(value: unknown): AgentProvider | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isAgentProvider(normalized) ? normalized : undefined;
}

export function agentLabel(agent: AgentProvider): string {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  return "Pi";
}

export function agentIconName(agent: AgentProvider): string {
  if (agent === "claude") return "sparkle";
  if (agent === "codex") return "terminal";
  return "rocket";
}

export function agentResumeArgs(
  agent: AgentProvider,
  sessionId: string,
  filePath?: string | null,
): string[] {
  if (agent === "codex") return ["resume", sessionId];
  if (agent === "claude") return ["--resume", sessionId];
  if (!filePath) {
    throw new Error("Pi resume requires an absolute transcript path");
  }
  return ["--session", filePath];
}

export function agentForkArgs(
  agent: AgentProvider,
  sessionId: string,
  filePath?: string | null,
): string[] {
  if (agent === "codex") return ["fork", sessionId];
  if (agent === "claude") return ["--resume", sessionId, "--fork-session"];
  if (!filePath) {
    throw new Error("Pi fork requires an absolute transcript path");
  }
  return ["--fork", filePath];
}
