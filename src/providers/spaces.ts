import * as vscode from "vscode";
import * as cli from "../cli";
import { shortSessionId } from "../sessionDisplay";
import { mdTooltip } from "../tooltip";

// --- Tree item types ---

class SpaceNode extends vscode.TreeItem {
  constructor(public readonly space: cli.SpaceWithPins, public readonly childSpaces: cli.SpaceWithPins[]) {
    const spacePinCount = space.pins?.length ?? 0;
    const childCount = childSpaces.length;
    const state =
      spacePinCount > 0 || childCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

    super(truncate(space.name, 28), state);

    this.description = [
      childCount > 0 ? `${childCount} child` : "",
      spacePinCount > 0 ? `${spacePinCount} pin` : "",
    ].filter(Boolean).join(" · ");
    this.tooltip = mdTooltip([
      ["Catalog", space.name],
      ["ID", `\`${space.id}\``],
      ["Description", space.description || "-"],
      ["Tags", space.tags.join(", ") || "-"],
      ["Created", space.created_at],
    ]);
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = "catalog";
  }
}

class PinNode extends vscode.TreeItem {
  constructor(public readonly bookmark: cli.Bookmark, public readonly session?: cli.SessionMeta) {
    super(
      truncate(bookmark.title || shortSessionId(bookmark.session_id) + "…"),
      vscode.TreeItemCollapsibleState.None
    );
    const short = shortSessionId(bookmark.session_id);
    this.description = short;
    this.tooltip = mdTooltip([
      ["Pin", `\`${bookmark.id}\``],
      ["Session", `\`${bookmark.session_id}\``],
      ["Agent", session?.provider || bookmark.provider || "-"],
      ["Model", session?.model || "-"],
      ["Project", session?.project_path || bookmark.project_path || "-"],
      ["Modified", session?.modified_at || "-"],
      ["Tokens", formatTokenUsage(session?.token_usage)],
      ["Title", bookmark.title || "-"],
      ["Tags", bookmark.tags.join(", ") || "-"],
      ["Created", bookmark.created_at],
    ]);
    this.iconPath = new vscode.ThemeIcon("bookmark");
    this.contextValue = "session-pin";
  }
}

function truncate(value: string, maxLength = 28): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `…${trimmed.slice(-(maxLength - 1))}`;
}

type TreeNode = SpaceNode | PinNode | vscode.TreeItem;

function errorItem(label: string, err: unknown): vscode.TreeItem {
  const message = err instanceof Error ? err.message : String(err);
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = message.slice(0, 80);
  item.tooltip = message;
  item.iconPath = new vscode.ThemeIcon("error");
  return item;
}

// --- Provider ---

export class SpacesProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly sessionLookup = new Map<string, cli.SessionMeta>();
  private readonly sessionLoads = new Set<string>();

  refresh(): void {
    this.sessionLookup.clear();
    this.sessionLoads.clear();
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    try {
      const spaces = await cli.listSpaces(true) as cli.SpaceWithPins[];
      if (!element) {
        if (spaces.length === 0) {
          return [new vscode.TreeItem("No catalogs", vscode.TreeItemCollapsibleState.None)];
        }
        const roots = spaces.filter((space) => !space.parent_id);
        return roots.map((space) => new SpaceNode(space, childCatalogs(spaces, space.id)));
      }
      if (element instanceof SpaceNode) {
        const children = childCatalogs(spaces, element.space.id).map((space) =>
          new SpaceNode(space, childCatalogs(spaces, space.id))
        );
        const pins = element.space.pins ?? [];
        if (children.length === 0 && pins.length === 0) {
          return [new vscode.TreeItem("(empty)", vscode.TreeItemCollapsibleState.None)];
        }
        this.hydratePinSessions(pins);
        return [...children, ...pins.map((p) => new PinNode(p, this.sessionLookup.get(p.session_id)))];
      }
    } catch (err) {
      return [errorItem("Error loading catalogs", err)];
    }
    return [];
  }

  private hydratePinSessions(pins: cli.Bookmark[]): void {
    const pending = pins
      .map((pin) => pin.session_id)
      .filter((sessionId) => sessionId && !this.sessionLookup.has(sessionId) && !this.sessionLoads.has(sessionId));
    if (pending.length === 0) return;

    for (const sessionId of pending) {
      this.sessionLoads.add(sessionId);
    }

    void cli.getSessions(pending)
      .then((sessions) => {
        for (const sessionId of pending) {
          this.sessionLoads.delete(sessionId);
          const session = sessions.get(sessionId);
          if (session) {
            this.sessionLookup.set(sessionId, session);
          }
        }
        if (sessions.size > 0) {
          this._onDidChange.fire();
        }
      })
      .catch(() => {
        for (const sessionId of pending) {
          this.sessionLoads.delete(sessionId);
        }
      });
  }
}

function childCatalogs(spaces: cli.SpaceWithPins[], parentId: string): cli.SpaceWithPins[] {
  return spaces.filter((space) => space.parent_id === parentId);
}

function formatTokenUsage(tokenUsage?: cli.TokenUsage): string {
  if (!tokenUsage) {
    return "unknown";
  }
  const input = tokenUsage.input_tokens ?? "-";
  const output = tokenUsage.output_tokens ?? "-";
  const total = tokenUsage.total_tokens ?? "-";
  const cache = tokenUsage.cache_tokens ?? "-";
  return `input: ${input}, output: ${output}, total: ${total}, cache: ${cache}`;
}
