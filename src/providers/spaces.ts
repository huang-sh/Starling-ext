import * as vscode from "vscode";
import * as cli from "../cli";
import { formatStatusGlyph, shortSessionId } from "../sessionDisplay";
import { mdTooltip } from "../tooltip";
import { iconForStatus, LiveStatusStore } from "./liveStatus";

// --- Tree item types ---

class SpaceNode extends vscode.TreeItem {
  constructor(public readonly space: cli.Space, public readonly childSpaces: cli.Space[]) {
    const spacePinCount = space.session_count ?? space.pin_count ?? 0;
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
      ["Origin", isAutoArchiveCatalog(space) ? "auto-archive" : "manual"],
      ["Description", space.description || "-"],
      ["Tags", space.tags.join(", ") || "-"],
      ["Created", space.created_at],
    ]);
    // Auto-created catalogs (cwd-named auto-archive) keep the themed folder
    // (they behave like normal catalogs); user-created ones get the bookmark
    // icon + tint to stand out as hand-picked collections.
    this.iconPath = isAutoArchiveCatalog(space)
      ? new vscode.ThemeIcon("folder")
      : new vscode.ThemeIcon("bookmark", new vscode.ThemeColor("charts.purple"));
    this.contextValue = "catalog";
  }
}

class PinNode extends vscode.TreeItem {
  constructor(
    public readonly bookmark: cli.Bookmark,
    public readonly catalog?: cli.SpaceWithPins,
    public readonly monitor?: cli.MonitorRow
  ) {
    const hasTitle = Boolean(bookmark.title && bookmark.title.trim());
    super(
      truncate(hasTitle ? bookmark.title : shortSessionId(bookmark.session_id) + "…"),
      vscode.TreeItemCollapsibleState.None
    );
    // Display title and session ID exclusively: prefer title, fall back to session ID.
    this.description = hasTitle ? "" : shortSessionId(bookmark.session_id);
    const tooltipRows: Array<[string, string]> = [
      ["Pin", `\`${bookmark.id}\``],
      ["Session", `\`${bookmark.session_id}\``],
      ["Status", monitor ? formatStatusGlyph(monitor.status) : "-"],
      ["Agent", bookmark.provider || "-"],
      ["Project", bookmark.project_path || "-"],
      ["First prompt", bookmark.first_prompt || "-"],
      ["Title", bookmark.title || "-"],
      ["Tags", bookmark.tags.join(", ") || "-"],
      ["Origin", bookmark.origin === "auto" ? "auto-archive" : "manual"],
      ["Updated", bookmark.updated_at],
      ["Created", bookmark.created_at],
    ];
    this.tooltip = mdTooltip(tooltipRows);
    // Origin is the primary visual identity: auto-archive pins show the
    // plain file icon (the status lives in the Monitor view); manual pins
    // get the pin icon + blue tint (distinct from catalog bookmarks), with
    // live status winning when known.
    this.iconPath = bookmark.origin === "auto"
      ? new vscode.ThemeIcon("file")
      : monitor
        ? iconForStatus(monitor.status)
        : new vscode.ThemeIcon("pinned", new vscode.ThemeColor("charts.blue"));
    this.contextValue = "session-pin";
  }
}

/** Description the starling auto-archive hook stamps on cwd-named catalogs. */
const AUTO_ARCHIVE_DESCRIPTION = "Auto-created from agent working directory";

function isAutoArchiveCatalog(space: { description?: string }): boolean {
  return space.description === AUTO_ARCHIVE_DESCRIPTION;
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

  constructor(private readonly liveStatus: LiveStatusStore) {
    this.liveStatus.onDidStatusChange(() => this._onDidChange.fire());
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    try {
      const spaces = await cli.listSpaces(false) as cli.Space[];
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
        const details = await cli.getSpace(element.space.id);
        const pins = details.pins ?? [];
        if (children.length === 0 && pins.length === 0) {
          return [new vscode.TreeItem("(empty)", vscode.TreeItemCollapsibleState.None)];
        }
        return [
          ...children,
          ...pins.map((pin) => new PinNode(
            pin,
            details,
            this.liveStatus.getMonitor(
              pin.session_id,
              pin.provider,
              pin.project_path
            )
          )),
        ];
      }
    } catch (err) {
      return [errorItem("Error loading catalogs", err)];
    }
    return [];
  }
}

function childCatalogs(spaces: cli.Space[], parentId: string): cli.Space[] {
  return spaces.filter((space) => space.parent_id === parentId);
}
