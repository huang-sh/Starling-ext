import * as vscode from "vscode";
import * as cli from "../cli";

type TreeNode = AgentNode | ModelNode | vscode.TreeItem;

class AgentNode extends vscode.TreeItem {
  constructor(public readonly agent: "claude" | "codex", public readonly count: number) {
    super(agent, count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.contextValue = "model-agent";
    this.iconPath = new vscode.ThemeIcon(agent === "claude" ? "sparkle" : "terminal");
    this.description = count > 0 ? `${count}` : "";
  }
}

export class ModelNode extends vscode.TreeItem {
  constructor(public readonly model: cli.ModelConfigSummary) {
    const displayName = model.scope === "current" && model.name === "current" ? "default" : model.name;
    super(displayName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = model.scope === "profile" ? "model-profile" : "model-current";
    this.iconPath = new vscode.ThemeIcon(model.agent === "claude" ? "sparkle" : "terminal");
    this.description = [model.model || "-", model.provider || ""].filter(Boolean).join(" · ");
    this.tooltip = [
      `Agent: ${model.agent}`,
      `Name: ${displayName}`,
      `Model: ${model.model || "-"}`,
      `Provider: ${model.provider || "-"}`,
      `Reasoning: ${model.reasoning || "-"}`,
      `Auth: ${model.auth || "-"}`,
      `Source: ${model.source}`,
      model.error ? `Error: ${model.error}` : "",
    ].filter(Boolean).join("\n");
  }
}

function errorItem(label: string, err: unknown): vscode.TreeItem {
  const message = err instanceof Error ? err.message : String(err);
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = message.slice(0, 80);
  item.tooltip = message;
  item.iconPath = new vscode.ThemeIcon("error");
  return item;
}

export class ModelsProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private models: cli.ModelConfigSummary[] | undefined;

  refresh(): void {
    this.models = undefined;
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    try {
      const models = await this.loadModels();
      if (!element) {
        const claudeCount = models.filter((model) => model.agent === "claude").length;
        const codexCount = models.filter((model) => model.agent === "codex").length;
        return [
          new AgentNode("claude", claudeCount),
          new AgentNode("codex", codexCount),
        ];
      }
      if (element instanceof AgentNode) {
        return models
          .filter((model) => model.agent === element.agent)
          .sort((a, b) => sortModel(a, b))
          .map((model) => new ModelNode(model));
      }
    } catch (err) {
      return [errorItem("Error loading models", err)];
    }
    return [];
  }

  private async loadModels(): Promise<cli.ModelConfigSummary[]> {
    if (!this.models) {
      this.models = await cli.listModels();
    }
    return this.models;
  }
}

function sortModel(a: cli.ModelConfigSummary, b: cli.ModelConfigSummary): number {
  if (a.scope !== b.scope) {
    return a.scope === "current" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}
