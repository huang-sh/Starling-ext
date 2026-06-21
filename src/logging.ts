import * as vscode from "vscode";

let outputChannel: vscode.LogOutputChannel | undefined;
let diagnostics: vscode.DiagnosticCollection | undefined;

let problemUri: vscode.Uri | undefined;
const activeProblems = new Map<string, vscode.Diagnostic>();
const recentLogs = new Map<string, number>();
const DUPLICATE_LOG_WINDOW_MS = 10_000;

export function initializeLogging(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Starling", { log: true });
  diagnostics = vscode.languages.createDiagnosticCollection("Starling");
  problemUri = vscode.Uri.joinPath(context.extensionUri, "package.json");
  context.subscriptions.push(outputChannel, diagnostics);
  outputChannel.info("Starling logging initialized.");
}

export function disposeLogging(): void {
  diagnostics?.dispose();
  outputChannel?.dispose();
  diagnostics = undefined;
  outputChannel = undefined;
  problemUri = undefined;
  activeProblems.clear();
}

export function getOutputChannel(): vscode.LogOutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Starling", { log: true });
  }
  return outputChannel;
}

export function logInfo(message: string): void {
  appendLog("info", message);
}

export function logError(message: string, err?: unknown): void {
  const detail = err == null ? "" : `\n${errorMessage(err)}`;
  appendLog("error", `${message}${detail}`, message);
}

export function reportProblem(
  key: string,
  message: string,
  severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Error
): void {
  if (!diagnostics || !problemUri) return;
  const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), message, severity);
  diagnostic.source = "Starling";
  activeProblems.set(key, diagnostic);
  diagnostics.set(problemUri, [...activeProblems.values()]);
}

export function clearProblem(key: string): void {
  if (!diagnostics || !problemUri) return;
  if (!activeProblems.delete(key)) return;
  diagnostics.set(problemUri, [...activeProblems.values()]);
}

export function clearAllProblems(): void {
  activeProblems.clear();
  diagnostics?.clear();
}

function appendLog(level: "info" | "error", message: string, dedupeKey = message): void {
  const key = `${level}:${dedupeKey}`;
  const now = Date.now();
  const last = recentLogs.get(key) ?? 0;
  if (now - last < DUPLICATE_LOG_WINDOW_MS) return;
  recentLogs.set(key, now);

  const channel = getOutputChannel();
  if (level === "error") {
    channel.error(message);
    channel.show(true);
  } else {
    channel.info(message);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || err.message;
  }
  return String(err);
}
