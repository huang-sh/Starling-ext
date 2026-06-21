import * as vscode from "vscode";
import * as path from "path";
import { SessionsProvider } from "./providers/sessions";
import { SpacesProvider } from "./providers/spaces";
import { ProjectsProvider } from "./providers/projects";
import { ModelsProvider } from "./providers/models";
import { SessionDetailPanel } from "./views/sessionDetail";
import * as cli from "./cli";
import { shortSessionId } from "./sessionDisplay";
import {
  clearProblem,
  disposeLogging,
  getOutputChannel,
  initializeLogging,
  logError,
  logInfo,
  reportProblem,
} from "./logging";

let starlingInstallPromptVisible = false;

interface QuickPickItem<T> extends vscode.QuickPickItem {
  value: T;
}

export function activate(context: vscode.ExtensionContext): void {
  initializeLogging(context);
  logInfo("Starling extension activated.");

  const sessionsProvider = new SessionsProvider();
  const spacesProvider = new SpacesProvider();
  const projectsProvider = new ProjectsProvider();
  const modelsProvider = new ModelsProvider();

  const sessionsTree = vscode.window.createTreeView("starling-sessions", {
    treeDataProvider: sessionsProvider,
  });
  sessionsProvider.setTreeView(sessionsTree);
  context.subscriptions.push(sessionsTree, sessionsProvider.startBackgroundMonitoring());
  vscode.window.registerTreeDataProvider("starling-spaces", spacesProvider);
  vscode.window.registerTreeDataProvider("starling-projects", projectsProvider);
  vscode.window.registerTreeDataProvider("starling-models", modelsProvider);

  const refreshAllViews = () => {
    cli.clearCliCache();
    sessionsProvider.refresh();
    spacesProvider.refresh();
    projectsProvider.refresh();
    modelsProvider.refresh();
  };
  const refreshHandler = () => {
    refreshAllViews();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.refresh", refreshHandler)
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isStarlingModelProfilePath(document.uri.fsPath)) {
        refreshAllViews();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("starling")) {
        refreshAllViews();
        void checkStarlingCliOnActivation();
      }
    })
  );

  void checkStarlingCliOnActivation();

  // Core actions
  context.subscriptions.push(
    vscode.commands.registerCommand("starling.resume", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;
      try {
        await resumeSessionInTerminal(sessionId);
      } catch (err) {
        await showCommandError("Resume", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.pin", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      const title = await vscode.window.showInputBox({
        title: "Pin title (optional)",
        placeHolder: "Use first prompt as default",
      });
      const tags = await vscode.window.showInputBox({
        title: "Tags (comma-separated, optional)",
      });
      const to = await pickSpaceName("Optional: add to existing catalog");

      try {
        await cli.pinSession(sessionId, {
          title: normalizeOptionalInput(title),
          tags: normalizeOptionalInput(tags),
          to: to ?? undefined,
        });
        vscode.window.showInformationMessage(`Pinned session ${shortSessionId(sessionId)}…`);
        refreshAllViews();
      } catch (err) {
        await showCommandError("Pin", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.pinToSpace", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      try {
        const space = await pickSpaceName("Select a catalog");
        if (!space) return;

        await cli.pinSession(sessionId, { to: space });
        vscode.window.showInformationMessage(`Pinned session ${shortSessionId(sessionId)}… to "${space}"`);
        refreshAllViews();
      } catch (err) {
        await showCommandError("Pin to catalog", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.removePin", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      try {
        await cli.unpinSession(sessionId);
        vscode.window.showInformationMessage(`Removed pin for ${shortSessionId(sessionId)}…`);
        refreshAllViews();
      } catch (err) {
        await showCommandError("Remove pin", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.deleteSession", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      const confirmed = await vscode.window.showWarningMessage(
        `Delete session ${shortSessionId(sessionId)}? This removes the Starling pin and deletes the session file.`,
        { modal: true },
        "Delete Session"
      );
      if (confirmed !== "Delete Session") return;

      try {
        await cli.deleteSession(sessionId);
        vscode.window.showInformationMessage(`Deleted session ${shortSessionId(sessionId)}…`);
        refreshAllViews();
      } catch (err) {
        await showCommandError("Delete session", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.showSession", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;
      await SessionDetailPanel.createOrShow(sessionId);
    })
  );

  // Command-line parity: session
  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionList", async () => {
      const agent = await pickAgent("Filter by agent");
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Use default limit", value: "limited" as const },
          { label: "Stream all sessions", value: "all" as const },
        ],
        { placeHolder: "Session list mode" }
      );
      if (!mode) return;

      let limit: number | undefined;
      if (mode.value === "limited") {
        const raw = await vscode.window.showInputBox({
          title: "How many sessions to show?",
          value: "20",
          prompt: "Leave empty for 20",
          validateInput: (value) => {
            if (!value) return undefined;
            const parsed = Number(value);
            return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a positive integer";
          },
        });
        if (raw !== undefined) {
          const parsed = Number(raw || "20");
          if (!Number.isInteger(parsed) || parsed <= 0) {
            return;
          }
          limit = parsed;
        }
      }

      await runCliCommandOutput(
        "Starling: session list",
        () => cli.listSessionsText({
          agent,
          all: mode.value === "all",
          limit,
        })
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionShow", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;
      await runCliCommandOutput("Starling: session show", () => cli.getSessionText(sessionId));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionIndexStatus", async () => {
      await runCliCommandOutput("Starling: session index status", () => cli.sessionIndexStatusText());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionIndexRebuild", async () => {
      const agent = await pickAgent("Index agent filter");
      await runCliCommandOutput("Starling: session index rebuild", () => cli.sessionIndexRebuildText(agent));
      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionIndexClear", async () => {
      await runCliCommandOutput("Starling: session index clear", () => cli.sessionIndexClearText());
      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.loadMoreSessions", (provider: unknown) => {
      const normalized = normalizeSessionProvider(provider);
      if (!normalized) {
        return;
      }
      sessionsProvider.showMoreSessions(normalized);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.loadMoreProjectSessions", (path: unknown) => {
      const projectPath = typeof path === "string" ? path : extractProjectPath(path);
      if (!projectPath) {
        return;
      }
      projectsProvider.showMoreProjectSessions(projectPath);
    })
  );

  // Command-line parity: catalog
  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogList", async () => {
      const pinsOption = await vscode.window.showQuickPick(
        [
          { label: "Catalog list", value: false },
          { label: "Catalog list including pins", value: true },
        ],
        { placeHolder: "Catalog list mode" }
      );
      if (!pinsOption) return;

      await runCliCommandOutput("Starling: catalog list", () =>
        cli.catalogListText({ pins: pinsOption.value })
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogTree", async () => {
      const sessionsOption = await vscode.window.showQuickPick(
        [
          { label: "Catalogs only", value: false },
          { label: "Catalogs and sessions", value: true },
        ],
        { placeHolder: "Catalog tree output" }
      );
      if (!sessionsOption) return;
      await runCliCommandOutput("Starling: catalog tree", () =>
        cli.catalogTreeText({ sessions: sessionsOption.value })
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.modelList", async () => {
      const agent = await pickAgent("Filter by agent");
      await runCliCommandOutput("Starling: model list", () => cli.modelListText(agent));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.modelAdd", async () => {
      try {
        const created = await collectAndAddModelProfile();
        if (!created) return;
        vscode.window.showInformationMessage(`Opened ${created.agent} model profile template: ${created.name}`);
        refreshAllViews();
      } catch (err) {
        await showCommandError("Add model", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.modelOpenSettings", async (node: unknown) => {
      try {
        const model = await pickModelFromNode(node);
        if (!model) return;
        await openModelSettings(model);
      } catch (err) {
        await showCommandError("Open model settings", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.modelStart", async (node: unknown) => {
      try {
        const model = await pickModelFromNode(node);
        if (!model) return;
        await startModelSessionInTerminal(model);
      } catch (err) {
        await showCommandError("Start agent session", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.modelStartInCatalog", async (node: unknown) => {
      try {
        const model = await pickModelFromNode(node);
        if (!model) return;
        const catalog = await pickSpaceName("Start session in catalog");
        if (!catalog) return;
        await startModelSessionInTerminal(model, catalog);
      } catch (err) {
        await showCommandError("Start agent session", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.modelDelete", async (node: unknown) => {
      try {
        const model = await pickModelFromNode(node);
        if (!model) return;
        await deleteModelProfile(model);
        refreshAllViews();
      } catch (err) {
        await showCommandError("Delete model profile", err);
      }
    })
  );

  const createCatalogFromInput = async (parent?: cli.Space): Promise<void> => {
    const name = await vscode.window.showInputBox({
      title: parent ? `Child catalog under ${parent.name}` : "Catalog name",
      prompt: parent ? "Required. Use A/B/C to create nested child catalogs." : "Required",
      validateInput: (value) => (value.trim() ? undefined : "Catalog name is required"),
    });
    if (!name) return;

    const description = await vscode.window.showInputBox({
      title: "Description (optional)",
    });
    const tags = await vscode.window.showInputBox({
      title: "Tags (comma-separated, optional)",
    });
    const selectedParent = parent ? parent.id : await pickSpaceName("Parent catalog (optional)");

    await runCliCommandOutput("Starling: catalog create", () =>
      cli.createCatalog(name.trim(), {
        description: normalizeOptionalInput(description),
        tags: normalizeOptionalInput(tags),
        parent: normalizeOptionalInput(selectedParent),
      })
    );
    refreshAllViews();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogShow", async () => {
      const space = await pickSpace();
      if (!space) return;
      await runCliCommandOutput("Starling: catalog show", () => cli.catalogShowText(space.id));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogCreate", async () => {
      await createCatalogFromInput();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogCreateChild", async (node: unknown) => {
      const parent = await pickSpaceFromNode(node);
      if (!parent) return;
      await createCatalogFromInput(parent);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogRemove", async () => {
      const space = await pickSpace();
      if (!space) return;

      const mode = await vscode.window.showQuickPick([
        { label: "Remove catalog", value: "catalog" as const },
        { label: "Remove one session from catalog", value: "pin" as const },
      ], { placeHolder: `Remove from ${space.name}` });
      if (!mode) return;

      if (mode.value === "catalog") {
        const confirm = await vscode.window.showWarningMessage(
          `Remove catalog ${space.name}?`,
          { modal: true },
          "Remove"
        );
        if (confirm !== "Remove") return;
        await runCliCommandOutput("Starling: catalog delete", () => cli.removeCatalog(space.id));
      } else {
        const pins = await cli.listPins(space.id);
        if (pins.length === 0) {
          vscode.window.showInformationMessage(`Catalog ${space.name} has no pins.`);
          return;
        }
        const selected = await pickPinFrom(pins, `Select pin in ${space.name}`);
        if (!selected) return;
        await runCliCommandOutput("Starling: catalog detach", () =>
          cli.removeSessionFromCatalog(space.id, selected.session_id)
        );
      }

      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogRename", async (node: unknown) => {
      const space = await pickSpaceFromNode(node);
      if (!space) return;

      const nextName = normalizeOptionalInput(
        await vscode.window.showInputBox({
          title: `Rename catalog ${space.name}`,
          value: space.name,
          validateInput: (value) => {
            const trimmed = value.trim();
            if (!trimmed) return "Catalog name is required";
            if (trimmed.includes("/")) return "Enter a single catalog name, not a path";
            return undefined;
          },
        })
      );
      if (!nextName || nextName === space.name) return;

      try {
        await cli.renameCatalog(space.id, nextName);
        vscode.window.showInformationMessage(`Renamed catalog "${space.name}" to "${nextName}".`);
        refreshAllViews();
      } catch (err) {
        await showCommandError("Rename catalog", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogDelete", async (node: unknown) => {
      const space = await pickSpaceFromNode(node);
      if (!space) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete catalog "${space.name}"? Child catalogs will also be deleted. Sessions are not deleted.`,
        { modal: true },
        "Delete Catalog"
      );
      if (confirm !== "Delete Catalog") return;

      try {
        await cli.removeCatalog(space.id);
        vscode.window.showInformationMessage(`Deleted catalog "${space.name}".`);
        refreshAllViews();
      } catch (err) {
        await showCommandError("Delete catalog", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogDeleteWithSessions", async (node: unknown) => {
      const space = await pickSpaceFromNode(node);
      if (!space) return;

      const allSpaces = (await cli.listSpaces(true)) as cli.SpaceWithPins[];
      const subtreeIds = new Set<string>([space.id]);
      const stack = [space.id];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const candidate of allSpaces) {
          if (candidate.parent_id === current && !subtreeIds.has(candidate.id)) {
            subtreeIds.add(candidate.id);
            stack.push(candidate.id);
          }
        }
      }

      const sessionIds = new Set<string>();
      for (const candidate of allSpaces) {
        if (!subtreeIds.has(candidate.id)) continue;
        for (const pin of candidate.pins ?? []) {
          if (pin.session_id) sessionIds.add(pin.session_id);
        }
      }

      const sessionCount = sessionIds.size;
      const childCount = subtreeIds.size - 1;
      const detail = [
        childCount > 0 ? `Deletes ${childCount} child catalog${childCount === 1 ? "" : "s"} and "${space.name}".` : `Deletes catalog "${space.name}".`,
        sessionCount > 0
          ? `${sessionCount} pinned session${sessionCount === 1 ? "" : "s"} will be permanently deleted. Sessions pinned to other catalogs are also removed from those.`
          : "No pinned sessions to delete.",
      ].join("\n");

      const confirm = await vscode.window.showWarningMessage(
        `Delete "${space.name}"${sessionCount > 0 ? " with all sessions" : ""}?`,
        { modal: true, detail },
        "Delete"
      );
      if (confirm !== "Delete") return;

      try {
        for (const sessionId of sessionIds) {
          await cli.deleteSession(sessionId);
        }
        await cli.removeCatalog(space.id);
        vscode.window.showInformationMessage(
          `Deleted catalog "${space.name}"${sessionCount > 0 ? ` and ${sessionCount} session${sessionCount === 1 ? "" : "s"}` : ""}.`
        );
        refreshAllViews();
      } catch (err) {
        await showCommandError("Delete catalog with sessions", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogTag", async () => {
      const space = await pickSpace();
      if (!space) return;

      const tagsInput = normalizeOptionalInput(
        await vscode.window.showInputBox({
          title: `Add tags to ${space.name}`,
          placeHolder: "Comma-separated tags",
        })
      );
      if (!tagsInput) return;

      const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length === 0) return;

      await runCliCommandOutput("Starling: catalog tag", () => cli.tagCatalog(space.id, tags));
      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogEdit", async () => {
      const space = await pickSpace();
      if (!space) return;

      const description = await vscode.window.showInputBox({
        title: "New description (leave empty to skip)",
      });
      const rename = await vscode.window.showInputBox({
        title: "Rename catalog (leave empty to skip)",
      });
      const parent = await pickSpaceName("New parent catalog (leave empty to skip)");

      const patch: {
        description?: string;
        rename?: string;
        parent?: string;
      } = {};

      const normalizedDescription = normalizeOptionalInput(description);
      const normalizedRename = normalizeOptionalInput(rename);
      const normalizedParent = normalizeOptionalInput(parent);
      if (normalizedDescription) patch.description = normalizedDescription;
      if (normalizedRename) patch.rename = normalizedRename;
      if (normalizedParent) patch.parent = normalizedParent;

      if (Object.keys(patch).length === 0) {
        vscode.window.showInformationMessage("No updates provided.");
        return;
      }

      await runCliCommandOutput("Starling: catalog edit", () => cli.editCatalog(space.id, patch));
      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogCopyName", async (node: unknown) => {
      const space = await pickSpaceFromNode(node);
      if (!space) return;

      try {
        await vscode.env.clipboard.writeText(space.name);
        vscode.window.showInformationMessage(`Copied catalog name: ${space.name}`);
      } catch (err) {
        await showCommandError("Copy catalog name", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogCopyId", async (node: unknown) => {
      const space = await pickSpaceFromNode(node);
      if (!space) return;

      try {
        await vscode.env.clipboard.writeText(space.id);
        vscode.window.showInformationMessage(`Copied catalog ID: ${space.id}`);
      } catch (err) {
        await showCommandError("Copy catalog ID", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogRunClaude", async (node: unknown) => {
      await runAgentInCatalog(node, "claude");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogRunCodex", async (node: unknown) => {
      await runAgentInCatalog(node, "codex");
    })
  );

  // Command-line parity: project
  context.subscriptions.push(
    vscode.commands.registerCommand("starling.projectList", async () => {
      const agent = await pickAgent("Filter by agent");
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Show recent projects", value: "limited" as const },
          { label: "Scan all sessions", value: "all" as const },
        ],
        { placeHolder: "Project list mode" }
      );
      if (!mode) return;

      let limit = 100;
      if (mode.value === "limited") {
        const raw = await vscode.window.showInputBox({
          title: "Max sessions to scan",
          value: "100",
          validateInput: (value) => {
            if (!value) return undefined;
            const parsed = Number(value);
            return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a positive integer";
          },
        });
        if (!raw) return;
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return;
        }
        limit = parsed;
      }

      await runCliCommandOutput("Starling: project list", () =>
        cli.projectListText({
          agent,
          limit: limit,
          all: mode.value === "all",
        })
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.projectShow", async (node: unknown) => {
      const nodePath = extractProjectPath(node);
      const selected = await selectProjectPath(nodePath);
      if (!selected) return;

      const agent = await pickAgent("Filter by agent");
      await runCliCommandOutput("Starling: project show", () => cli.projectShowText(selected, agent));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.openProject", async (node: unknown) => {
      const nodePath = extractProjectPath(node);
      const selected = await selectProjectPath(nodePath);
      if (!selected) return;

      try {
        await openProjectFolderInNewWindow(selected);
      } catch (err) {
        await showCommandError("Open project", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.copyProject", async (node: unknown) => {
      const nodePath = extractProjectPath(node);
      const selected = await selectProjectPath(nodePath);
      if (!selected) return;

      try {
        await vscode.env.clipboard.writeText(selected);
        vscode.window.showInformationMessage(`Copied project path: ${selected}`);
      } catch (err) {
        await showCommandError("Copy project path", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.copySessionId", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      try {
        await vscode.env.clipboard.writeText(sessionId);
        vscode.window.showInformationMessage(`Copied session ID: ${sessionId}`);
      } catch (err) {
        await showCommandError("Copy session ID", err);
      }
    })
  );

}

export function deactivate(): void {
  disposeLogging();
}

async function runCliCommandOutput(title: string, command: () => Promise<string>): Promise<void> {
  try {
    const text = await command();
    clearProblem("command");
    logInfo(`${title} completed.`);
    const outputChannel = getOutputChannel();
    outputChannel.clear();
    outputChannel.appendLine(`[${title}]`);
    outputChannel.appendLine(text.trim());
    outputChannel.show(true);
  } catch (err) {
    if (await maybePromptStarlingInstall(err)) return;
    const message = `${title} failed: ${errorMessage(err)}`;
    logError(message, err);
    reportProblem("command", message);
    vscode.window.showErrorMessage(`${title} failed: ${errorMessage(err)}`);
  }
}

async function showCommandError(action: string, err: unknown): Promise<void> {
  if (await maybePromptStarlingInstall(err)) return;
  const message = `${action} failed: ${errorMessage(err)}`;
  logError(message, err);
  reportProblem("command", message);
  vscode.window.showErrorMessage(`${action} failed: ${errorMessage(err)}`);
}

async function checkStarlingCliOnActivation(): Promise<void> {
  try {
    await cli.checkStarlingAvailable();
    clearProblem("cli");
    logInfo("Starling CLI is available.");
  } catch (err) {
    logError("Starling CLI availability check failed.", err);
    await maybePromptStarlingInstall(err);
  }
}

async function maybePromptStarlingInstall(err: unknown): Promise<boolean> {
  if (!(err instanceof cli.StarlingCliNotFoundError)) return false;
  const message = `Starling CLI was not found (${err.cliPath}). Install it with npm or set starling.cliPath.`;
  logError(message, err);
  reportProblem("cli", message);
  if (starlingInstallPromptVisible) return true;

  starlingInstallPromptVisible = true;
  try {
    const selected = await vscode.window.showWarningMessage(
      message,
      "Install in Terminal",
      "Set CLI Path"
    );

    if (selected === "Install in Terminal") {
      const terminal = vscode.window.createTerminal("Install Starling CLI");
      terminal.show();
      terminal.sendText("npm install -g starling-ai");
    } else if (selected === "Set CLI Path") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "starling.cliPath");
    }
  } finally {
    starlingInstallPromptVisible = false;
  }

  return true;
}

async function openProjectFolderInNewWindow(projectPath: string): Promise<void> {
  const normalized = projectPath.trim();
  if (!normalized) {
    throw new Error("Project path is empty.");
  }

  const uri = vscode.Uri.file(normalized);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    throw new Error(`Cannot open project path: ${projectPath}`);
  }
  await vscode.commands.executeCommand("vscode.openFolder", uri, true);
}

function normalizeOptionalInput(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSessionProvider(value: unknown): "claude" | "codex" | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "claude" || value === "codex") return value;
  return undefined;
}

async function resumeSessionInTerminal(sessionId: string): Promise<void> {
  const resolved = await resolveSessionForResume(sessionId);
  if (!resolved) {
    throw new Error(
      `Session not found: ${shortSessionId(sessionId)}… (try refreshing the session list and retrying)`
    );
  }

  const meta = resolved;
  const terminal = vscode.window.createTerminal({
    name: `starling: ${normalizedSessionLabel(sessionId)}`,
    cwd: meta.project_path || undefined,
  });
  const agent = meta.provider === "codex" ? "codex" : "claude";
  const command = agent === "codex"
    ? `codex resume ${meta.session_id}`
    : `claude --resume ${meta.session_id}`;
  terminal.sendText(command);
  terminal.show();
}

async function startModelSessionInTerminal(model: cli.ModelConfigSummary, catalog?: string): Promise<void> {
  if (model.error) {
    throw new Error(`Model profile has an error: ${model.error}`);
  }
  if (!model.exists) {
    throw new Error(`Model profile source does not exist: ${model.source}`);
  }

  const args = ["run"];
  if (model.scope === "profile") {
    args.push("--setting", shellArg(model.name));
  }
  if (catalog) {
    args.push("--catalog", shellArg(catalog));
  }
  args.push(model.agent);

  const terminal = vscode.window.createTerminal({
    name: `starling: ${model.agent} ${model.scope === "profile" ? model.name : "default"}`,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  terminal.sendText(`starling ${args.join(" ")}`);
  terminal.show();
}

async function runAgentInCatalog(node: unknown, agent: "claude" | "codex"): Promise<void> {
  const space = await pickSpaceFromNode(node);
  if (!space) return;

  let models: cli.ModelConfigSummary[];
  try {
    models = (await cli.listModels()).filter((model) => model.agent === agent);
  } catch (err) {
    await showCommandError(`Run ${agent} in catalog`, err);
    return;
  }

  if (models.length === 0) {
    vscode.window.showInformationMessage(`No ${agent} model profiles found.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    models.map((model): QuickPickItem<cli.ModelConfigSummary> => ({
      label: model.scope === "current" && model.name === "current" ? "default" : model.name,
      description: model.model || "-",
      detail: model.source,
      value: model,
    })),
    { placeHolder: `Select a ${agent} model to run in "${space.name}"` }
  );
  if (!picked) return;

  try {
    await startModelSessionInTerminal(picked.value, space.name);
  } catch (err) {
    await showCommandError(`Run ${agent} in catalog`, err);
  }
}

async function openModelSettings(model: cli.ModelConfigSummary): Promise<void> {
  if (!model.source) {
    throw new Error("Model settings source is unknown.");
  }
  const uri = vscode.Uri.file(model.source);
  if (!model.exists) {
    const create = await vscode.window.showWarningMessage(
      `Model settings file does not exist: ${model.source}`,
      "Create File"
    );
    if (create !== "Create File") return;
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(model.source)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(modelProfileTemplateText(model.agent), "utf-8"));
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function deleteModelProfile(model: cli.ModelConfigSummary): Promise<void> {
  if (model.scope !== "profile") {
    throw new Error("Only Starling model profiles can be deleted. Default/current model settings are not deleted from the extension.");
  }
  if (!model.exists) {
    throw new Error(`Model profile source does not exist: ${model.source}`);
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Delete ${model.agent} model profile "${model.name}"?`,
    { modal: true, detail: `This removes ${model.source}. It does not delete default agent settings or auth files.` },
    "Delete"
  );
  if (confirmed !== "Delete") return;
  await cli.deleteModelProfile(model);
  vscode.window.showInformationMessage(`Deleted ${model.agent} model profile: ${model.name}`);
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizedSessionLabel(sessionId: string): string {
  return shortSessionId(sessionId.trim());
}

async function resolveSessionForResume(sessionId: string): Promise<cli.SessionMeta | undefined> {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) {
    return undefined;
  }

  try {
    const meta = await cli.getSession(normalized);
    return meta;
  } catch {
    // keep going with fallback when "starling session show" can't resolve exact id
  }

  const sessions = await cli.listSessions(500);
  const exactMatch = sessions.find((session) =>
    session.session_id.toLowerCase() === normalized.toLowerCase()
  );
  if (exactMatch) return exactMatch;

  const shortMatches = sessions.filter((session) =>
    session.session_id.toLowerCase().startsWith(normalized.toLowerCase())
  );
  if (shortMatches.length === 1) return shortMatches[0];

  if (shortMatches.length > 1) {
    const picked = await vscode.window.showQuickPick(
      shortMatches.map((session) => ({
        label: `${session.session_id}`,
        description: `${session.provider} · ${session.project_path || "(no project)"}`,
        detail: session.first_prompt?.slice(0, 80),
        value: session,
      })),
      {
        placeHolder: "Select the session to resume",
      }
    );
    return picked?.value;
  }

  return undefined;
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim().replace(/^["']|["']$/g, "");
}

async function pickSessionId(node: unknown): Promise<string | undefined> {
  const direct = extractSessionId(node);
  if (direct) return direct;

  const selected = await pickSession();
  return selected?.session_id;
}

async function pickSpace(): Promise<cli.Space | undefined> {
  const spaces = await cli.listSpaces();
  if (spaces.length === 0) {
    vscode.window.showInformationMessage("No catalogs found.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    spaces.map((space) => ({
      label: `${catalogPath(space, spaces)} (${space.id})`,
      description: space.description,
      value: space,
    }))
  );
  return selected?.value as cli.Space | undefined;
}

async function pickSpaceFromNode(node: unknown): Promise<cli.Space | undefined> {
  const direct = extractSpace(node);
  if (direct) return direct;
  return pickSpace();
}

async function selectProjectPath(nodePath?: string): Promise<string | undefined> {
  if (nodePath) return nodePath;

  const picked = await pickProject();
  if (picked) return picked.project_path;

  const manual = normalizeOptionalInput(
    await vscode.window.showInputBox({
      title: "Project path",
      placeHolder: "/path/to/project",
    })
  );
  return manual;
}

async function pickProject(): Promise<cli.ProjectSummary | undefined> {
  const projects = await cli.listProjects({ all: false, limit: 300 });
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No projects found.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.project_path,
      description: `${project.session_count} sessions`,
      detail: `Last active: ${project.last_active}`,
      value: project,
    })),
    { placeHolder: "Select a project" }
  );
  return picked?.value;
}

function pickSpaceName(placeHolder?: string): Promise<string | undefined> {
  return (async () => {
    const spaces = await cli.listSpaces();
    const items: QuickPickItem<string>[] = spaces.map((space) => ({
      label: `${catalogPath(space, spaces)} (${space.id})`,
      description: space.description,
      value: space.id,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder });
    return picked?.value;
  })();
}

function catalogPath(space: cli.Space, spaces: cli.Space[]): string {
  const parts = [space.name];
  let current = space;
  const seen = new Set<string>();
  while (current.parent_id && !seen.has(current.parent_id)) {
    seen.add(current.parent_id);
    const parent = spaces.find((candidate) => candidate.id === current.parent_id);
    if (!parent) break;
    parts.unshift(parent.name);
    current = parent;
  }
  return parts.join("/");
}

async function pickSession(provider?: "claude" | "codex"): Promise<cli.SessionMeta | undefined> {
  const sessions = await cli.listSessions(200, provider);
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("No sessions found.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    sessions.map((session) => ({
      label: `${shortSessionId(session.session_id)}  ${session.provider}  ${session.model || "-"}`,
      description: session.project_path || "(no project)",
      detail: session.first_prompt?.slice(0, 80) || undefined,
      value: session,
    })),
    { placeHolder: "Select a session" }
  );

  return selected?.value;
}

async function pickPin(): Promise<cli.Bookmark | undefined> {
  const pins = await cli.listPins();
  return pickPinFrom(pins, "Select a pin");
}

async function pickPinFrom(pins: cli.Bookmark[], placeHolder: string): Promise<cli.Bookmark | undefined> {
  if (pins.length === 0) {
    vscode.window.showInformationMessage("No pins found.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    pins.map((bookmark): QuickPickItem<cli.Bookmark> => ({
      label: `${bookmark.id}  ${shortSessionId(bookmark.session_id)}`,
      description: bookmark.title || "(untitled)",
      detail: bookmark.tags.length > 0 ? `#${bookmark.tags.join(", ")}` : undefined,
      value: bookmark,
    })),
    { placeHolder }
  );

  return selected?.value;
}

async function pickAgent(placeHolder = "Filter by agent"): Promise<"claude" | "codex" | undefined> {
  type AgentPick = {
    label: string;
    value: "claude" | "codex" | undefined;
  };
  const selected = await vscode.window.showQuickPick(
    [
      { label: "claude", value: "claude" as const },
      { label: "codex", value: "codex" as const },
      { label: "all", value: undefined },
    ] as AgentPick[],
    { placeHolder }
  );
  return selected?.value;
}

async function collectAndAddModelProfile(): Promise<{ agent: "claude" | "codex"; name: string } | undefined> {
  const agent = await pickRequiredAgent("Model agent");
  if (!agent) return undefined;

  const name = normalizeOptionalInput(await vscode.window.showInputBox({
    title: "Profile name",
    prompt: "Claude uses JSON; Codex uses TOML under ~/.starling/settings/<agent>/",
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Profile name is required";
      if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return "Use letters, numbers, dot, dash, and underscore only";
      return undefined;
    },
  }));
  if (!name) return undefined;

  const extension = agent === "codex" ? ".toml" : ".json";
  const filePath = path.join(cli.starlingHomeRoot(), "settings", agent, `${name}${extension}`);
  const uri = vscode.Uri.file(filePath);
  const exists = await fileExists(uri);
  if (!exists) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(modelProfileTemplateText(agent), "utf-8"));
  }

  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return { agent, name };
}

async function pickRequiredAgent(placeHolder: string): Promise<"claude" | "codex" | undefined> {
  type AgentPick = {
    label: string;
    value: "claude" | "codex";
  };
  const selected = await vscode.window.showQuickPick(
    [
      { label: "claude", value: "claude" as const },
      { label: "codex", value: "codex" as const },
    ] as AgentPick[],
    { placeHolder }
  );
  return selected?.value;
}

async function pickModelFromNode(node: unknown): Promise<cli.ModelConfigSummary | undefined> {
  const direct = extractModel(node);
  if (direct) return direct;

  const models = await cli.listModels();
  if (models.length === 0) {
    vscode.window.showInformationMessage("No models found.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    models.map((model): QuickPickItem<cli.ModelConfigSummary> => ({
      label: `${model.agent}  ${model.scope === "current" && model.name === "current" ? "default" : model.name}`,
      description: model.model || "-",
      detail: model.source,
      value: model,
    })),
    { placeHolder: "Select a model profile" }
  );
  return picked?.value;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function modelProfileTemplateText(agent: "claude" | "codex"): string {
  const template = modelProfileTemplate(agent);
  if (agent === "codex") return codexModelProfileTemplateToml();
  return `${JSON.stringify(template, null, 2)}\n`;
}

function modelProfileTemplate(agent: "claude" | "codex"): Record<string, unknown> {
  if (agent === "claude") {
    return {
      env: {
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: "",
        API_TIMEOUT_MS: "3000000",
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ANTHROPIC_MODEL: "",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
      },
      enableAllProjectMcpServers: true,
      permissions: {
        allow: [
          "Edit:*",
          "Write:*",
          "MultiEdit:*",
          "NotebookEdit:*",
          "Bash:*",
        ],
        defaultMode: "plan",
      },
    };
  }

  return {
    auth: {
      OPENAI_API_KEY: "",
    },
    config: {
      model_provider: "custom",
      model: "",
      model_reasoning_effort: "high",
      disable_response_storage: true,
      model_providers: {
        custom: {
          name: "custom",
          base_url: "",
          wire_api: "responses",
          requires_openai_auth: true,
        },
      },
    },
  };
}

function codexModelProfileTemplateToml(): string {
  return [
    'model_provider = "custom"',
    'model = ""',
    'model_reasoning_effort = "high"',
    "disable_response_storage = true",
    'api_format = "openai_chat"',
    "",
    "[model_providers.custom]",
    'name = "custom"',
    'base_url = ""',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    'api_format = "openai_chat"',
    'experimental_bearer_token = ""',
    "",
  ].join("\n");
}

function isStarlingModelProfilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const settingsRoot = path.join(cli.starlingHomeRoot(), "settings").replace(/\\/g, "/");
  return normalized.startsWith(`${settingsRoot}/claude/`) || normalized.startsWith(`${settingsRoot}/codex/`);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface HasSessionMeta {
  meta?: {
    session_id: string;
    project_path?: string | null;
  };
  bookmark?: {
    session_id: string;
    project_path?: string | null;
  };
  project?: { project_path: string };
  space?: cli.Space;
  model?: cli.ModelConfigSummary;
}

function extractSessionId(node: unknown): string | undefined {
  if (!node) return undefined;
  const obj = node as HasSessionMeta;
  if (obj.meta?.session_id) return obj.meta.session_id;
  if (obj.bookmark?.session_id) return obj.bookmark.session_id;
  return undefined;
}

function extractProjectPath(node: unknown): string | undefined {
  if (!node) return undefined;
  const obj = node as HasSessionMeta & {
    summary?: { project_path: string };
    directory?: { realPath?: string; displayPath?: string; fullPath?: string };
  };
  if (obj.project?.project_path) return obj.project.project_path;
  if (obj.directory?.realPath) return obj.directory.realPath;
  if (obj.directory?.displayPath) return obj.directory.displayPath;
  if (obj.directory?.fullPath) return obj.directory.fullPath;
  if (obj.bookmark?.project_path) return obj.bookmark.project_path;
  if (obj.meta?.project_path) return obj.meta.project_path;
  if (obj.summary?.project_path) return obj.summary.project_path;
  return undefined;
}

function extractSpace(node: unknown): cli.Space | undefined {
  if (!node) return undefined;
  const obj = node as HasSessionMeta;
  return obj.space;
}

function extractModel(node: unknown): cli.ModelConfigSummary | undefined {
  if (!node) return undefined;
  const obj = node as HasSessionMeta;
  return obj.model;
}
