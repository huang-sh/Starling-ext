import * as vscode from "vscode";
import * as cli from "../cli";
import { mdTooltip } from "../tooltip";

type TreeNode = McpRootNode | McpServerNode | McpToolNode | McpProfileNode | McpProfileServerNode | vscode.TreeItem;

class McpRootNode extends vscode.TreeItem {
  constructor(
    public readonly kind: "servers" | "profiles",
    count: number
  ) {
    super(kind === "servers" ? "Servers" : "Profiles", count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.contextValue = "mcp-root";
    this.iconPath = new vscode.ThemeIcon(kind === "servers" ? "server-environment" : "settings-gear");
    this.description = count > 0 ? String(count) : "";
  }
}

export class McpServerNode extends vscode.TreeItem {
  constructor(
    public readonly server: cli.McpServerSummary,
    private readonly profileNames: string[]
  ) {
    super(server.name, server.enabled === false ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "mcp-server";
    this.iconPath = new vscode.ThemeIcon(iconForServer(server));
    this.description = serverDescription(server, profileNames);
    this.tooltip = mdTooltip([
      ["Server", server.name],
      ["Type", server.type || "stdio"],
      ["Built-in", server.builtin ? "yes" : "no"],
      ["Enabled", server.enabled === false ? "no" : "yes"],
      ["Command", server.command ? `\`${server.command}\`` : "-"],
      ["Args", server.args?.length ? server.args.map((arg) => `\`${arg}\``).join(" ") : "-"],
      ["URL", server.url ? `\`${server.url}\`` : "-"],
      ["Profiles", profileNames.length ? profileNames.join(", ") : "-"],
      ["Env", describeSecretRecord(server.env)],
      ["Headers", describeSecretRecord(server.headers)],
    ]);
  }
}

class McpToolNode extends vscode.TreeItem {
  constructor(
    public readonly serverName: string,
    public readonly tool: cli.McpToolSummary
  ) {
    super(tool.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "mcp-tool";
    this.iconPath = new vscode.ThemeIcon("tools");
    this.description = toolDescription(tool);
    this.tooltip = mdTooltip([
      ["Server", serverName],
      ["Tool", tool.name],
      ["Description", tool.description || "-"],
      ["Required", tool.required.length ? tool.required.map((name) => `\`${name}\``).join(", ") : "-"],
      ["Parameters", tool.properties.length ? tool.properties.map((name) => `\`${name}\``).join(", ") : "-"],
    ]);
  }
}

class McpProfileNode extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly servers: string[],
    public readonly isDefault: boolean
  ) {
    super(name, servers.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = "mcp-profile";
    this.iconPath = new vscode.ThemeIcon(isDefault ? "star-full" : "settings");
    this.description = [isDefault ? "default" : "", `${servers.length} server${servers.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    this.tooltip = mdTooltip([
      ["Profile", name],
      ["Default", isDefault ? "yes" : "no"],
      ["Servers", servers.length ? servers.join(", ") : "-"],
    ]);
  }
}

class McpProfileServerNode extends vscode.TreeItem {
  constructor(
    public readonly serverName: string,
    public readonly server?: cli.McpServerSummary
  ) {
    super(serverName, server && server.enabled !== false ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = "mcp-profile-server";
    this.iconPath = new vscode.ThemeIcon(server ? iconForServer(server) : "warning");
    this.description = server ? server.type || "stdio" : "missing";
    this.tooltip = mdTooltip([
      ["Server", serverName],
      ["Type", server?.type || "-"],
      ["Status", server ? "configured" : "missing"],
    ]);
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

export class McpProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private servers: cli.McpServerSummary[] | undefined;
  private profiles: cli.McpProfileList | undefined;

  refresh(): void {
    this.servers = undefined;
    this.profiles = undefined;
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    try {
      const servers = await this.loadServers();
      const profiles = await this.loadProfiles();

      if (!element) {
        return [
          new McpRootNode("servers", servers.length),
          new McpRootNode("profiles", Object.keys(profiles.profiles).length),
        ];
      }

      if (element instanceof McpRootNode && element.kind === "servers") {
        if (servers.length === 0) {
          return [new vscode.TreeItem("No MCP servers", vscode.TreeItemCollapsibleState.None)];
        }
        return servers
          .slice()
          .sort((a, b) => sortServer(a, b))
          .map((server) => new McpServerNode(server, profilesForServer(server.name, profiles)));
      }

      if (element instanceof McpServerNode) {
        return this.loadServerTools(element.server);
      }

      if (element instanceof McpRootNode && element.kind === "profiles") {
        const entries = Object.entries(profiles.profiles);
        if (entries.length === 0) {
          return [new vscode.TreeItem("No MCP profiles", vscode.TreeItemCollapsibleState.None)];
        }
        return entries
          .sort(([a], [b]) => profileSort(a, b, profiles.default_profile || undefined))
          .map(([name, profileServers]) => new McpProfileNode(name, profileServers, name === profiles.default_profile));
      }

      if (element instanceof McpProfileNode) {
        const byName = new Map(servers.map((server) => [server.name, server]));
        return element.servers.map((serverName) => new McpProfileServerNode(serverName, byName.get(serverName)));
      }

      if (element instanceof McpProfileServerNode && element.server) {
        return this.loadServerTools(element.server);
      }
    } catch (err) {
      return [errorItem("Error loading MCP", err)];
    }
    return [];
  }

  private async loadServers(): Promise<cli.McpServerSummary[]> {
    if (!this.servers) {
      this.servers = await cli.listMcpServers();
    }
    return this.servers;
  }

  private async loadProfiles(): Promise<cli.McpProfileList> {
    if (!this.profiles) {
      this.profiles = await cli.listMcpProfiles();
    }
    return this.profiles;
  }

  private async loadServerTools(server: cli.McpServerSummary): Promise<TreeNode[]> {
    if (server.enabled === false) {
      return [];
    }
    try {
      const tools = await cli.listMcpServerTools(server);
      if (tools.length === 0) {
        const item = new vscode.TreeItem("No tools", vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        return [item];
      }
      return tools.map((tool) => new McpToolNode(server.name, tool));
    } catch (err) {
      return [errorItem("Error loading tools", err)];
    }
  }
}

export function extractMcpServerName(node: unknown): string | undefined {
  if (node instanceof McpServerNode) return node.server.name;
  if (node instanceof McpProfileServerNode) return node.serverName;
  const candidate = node as { server?: { name?: unknown }; serverName?: unknown };
  if (typeof candidate?.server?.name === "string") return candidate.server.name;
  if (typeof candidate?.serverName === "string") return candidate.serverName;
  return undefined;
}

function sortServer(a: cli.McpServerSummary, b: cli.McpServerSummary): number {
  if (Boolean(a.builtin) !== Boolean(b.builtin)) return a.builtin ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function profileSort(a: string, b: string, defaultProfile?: string): number {
  if (a === defaultProfile && b !== defaultProfile) return -1;
  if (b === defaultProfile && a !== defaultProfile) return 1;
  return a.localeCompare(b);
}

function profilesForServer(serverName: string, profiles: cli.McpProfileList): string[] {
  return Object.entries(profiles.profiles)
    .filter(([, servers]) => servers.includes(serverName))
    .map(([profile]) => profile);
}

function iconForServer(server: cli.McpServerSummary): string {
  if (server.enabled === false) return "circle-slash";
  if (server.type === "http") return "globe";
  if (server.name === "agnes") return "paintcan";
  if (server.name === "starling") return "star-full";
  return "plug";
}

function serverDescription(server: cli.McpServerSummary, profileNames: string[]): string {
  const parts = [
    server.enabled === false ? "disabled" : server.type || "stdio",
    server.builtin ? "built-in" : "",
    profileNames.length ? `profiles ${profileNames.length}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function toolDescription(tool: cli.McpToolSummary): string {
  const parts = [
    tool.required.length ? `req ${tool.required.length}` : "",
    tool.properties.length ? `${tool.properties.length} param${tool.properties.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function describeSecretRecord(record?: Record<string, string>): string {
  const entries = Object.entries(record || {});
  if (entries.length === 0) return "-";
  return entries
    .map(([key, value]) => {
      const configured = value && !/^\$\{[^}]+\}$/.test(value);
      return `\`${key}\`=${configured ? "***" : "(env)"}`;
    })
    .join(", ");
}
