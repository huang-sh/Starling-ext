import * as vscode from "vscode";

/**
 * Build a MarkdownString tooltip from label/value pairs.
 *
 * MarkdownString tooltips are rendered by VS Code's hover widget, which
 * stays visible when the mouse moves onto the tooltip body (so the user
 * can read and copy the content without it disappearing). Plain string
 * tooltips render more like a native title attribute and disappear faster.
 */
export function mdTooltip(lines: Array<[string, string]>): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  const body = lines
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => `**${label}:** ${value}`)
    .join("  \n"); // two trailing spaces force a markdown line break
  md.appendMarkdown(body);
  return md;
}
