# Starling Agent

<p align="center">
  <img src="icons/starling.png" alt="Starling Agent logo" width="160">
</p>

Starling Agent is a VS Code sidebar for browsing, resuming, and organizing Claude Code and OpenAI Codex sessions.

It works with the Starling CLI and shows your local agent history in four focused views: Catalog, Projects, Models, and Monitor.

Current release: **0.1.0**

- VS Code Marketplace: [`huangsh.starling-ai`](https://marketplace.visualstudio.com/items?itemName=huangsh.starling-ai)
- GitHub Release: [`v0.1.0`](https://github.com/huang-sh/Starling-ext/releases/tag/v0.1.0)
- CLI package: [`starling-ai`](https://www.npmjs.com/package/starling-ai)

The GitHub release includes the packaged VSIX:

```text
starling-ai-0.1.0.vsix
```

## Requirements

Install the Starling CLI first:

```bash
npm install -g starling-ai
```

Then make sure VS Code can find the `starling` command:

```bash
starling --help
```

If VS Code cannot find `starling` on `PATH`, set `starling.cliPath` to an absolute executable path in VS Code settings.

When the extension starts and cannot find the Starling CLI, it prompts you to install it with:

```bash
npm install -g starling-ai
```

You can also use the prompt to open the `starling.cliPath` setting.

Starling CLI 0.1.0 or newer is recommended so the Monitor view can consume the current `starling top --json` protocol.

## Views

### Catalog

Browse hierarchical Starling catalogs and the sessions assigned to them.

Right-click a catalog session to:

- Resume the session.
- Show session details.
- Open the session project in a new VS Code window.
- Copy the project path.
- Copy the session ID.
- Remove pin metadata.
- Delete the session.

Right-click a catalog folder to:

- Rename the catalog.
- Delete the catalog without deleting session files.

### Projects

Browse projects as a directory tree with session counts.

Right-click a project to:

- Show project details.
- Open the project in a new VS Code window.
- Copy the project path.

Project session nodes support the same session actions as the Monitor view.

### Models

Browse Starling-managed Claude and Codex model profiles.

Use the Models view title bar to create a model profile template. The extension creates:

```text
~/.starling/settings/claude/<name>.json
~/.starling/settings/codex/<name>.toml
```

and opens the profile file in VS Code for editing.

Right-click a model profile to:

- Open the model settings file.
- Start a new agent session.
- Start a new agent session in a catalog.
- Delete the Starling model profile.

### Monitor

Monitor pinned, active, and recent Claude Code and Codex sessions with live status, context, token, CPU, memory, and task details.

The Monitor view is backed by `starling top --json` and refreshes in the background. It groups sessions into:

- Needs attention: sessions waiting for user input or approval.
- Active sessions: sessions currently running or waiting.
- Pinned monitor: pinned sessions, sorted by live state.
- Recent monitor: optional recent unpinned sessions.
- Static sessions: fallback session list if live monitor data is temporarily unavailable.

Session states are shown with colored VS Code theme icons:

- Running: the agent is actively processing work.
- Waiting: the agent is waiting for user input or approval.
- Idle: the agent process exists, but the model is not currently processing.
- Stopped: no active process is associated with the session.

Right-click a session to:

- Resume the session.
- Show session details.
- Pin it to a catalog.
- Open its project in a new VS Code window.
- Copy the project path.
- Copy the session ID.
- Remove pin metadata.
- Delete the session.

## Commands

Open the Command Palette and search for `Starling`.

Common commands:

- `Starling: Refresh`
- `Starling: Resume Session`
- `Starling: Show Session Details`
- `Starling: Pin Session`
- `Starling: Pin to Catalog`
- `Starling: Remove Pin`
- `Starling: Delete Session`
- `Starling: List Sessions`
- `Starling: Session Index Status`
- `Starling: Rebuild Session Index`
- `Starling: List Models`
- `Starling: Add Model`
- `Starling: Open Model Settings`
- `Starling: Start Agent Session`
- `Starling: Start Agent Session in Catalog`
- `Starling: Rename Catalog`
- `Starling: Delete Catalog`
- `Starling: Catalog Tree`
- `Starling: List Projects`
- `Starling: Open Project in New Window`
- `Starling: Copy Project Path`
- `Starling: Copy Session ID`

## Settings

```json
{
  "starling.cliPath": "starling",
  "starling.homePath": "",
  "starling.cacheTtlSeconds": 30,
  "starling.monitorRefreshSeconds": 3,
  "starling.monitorCacheTtlSeconds": 2,
  "starling.projectSessionLimit": 30,
  "starling.sessionTreeLimit": 50
}
```

### `starling.cliPath`

Path to the Starling CLI executable. Use an absolute path if the VS Code extension host cannot find `starling` on `PATH`.

### `starling.homePath`

Optional Starling data directory. Leave empty to use `~/.starling`. When set, the extension passes this path as `STARLING_HOME` to the Starling CLI.

### `starling.cacheTtlSeconds`

How long CLI query results are cached. Set to `0` to disable cache.

### `starling.monitorRefreshSeconds`

How often the extension refreshes live session status in the background. The default is `3` seconds.

### `starling.monitorCacheTtlSeconds`

How long live monitor snapshots are cached. The extension keeps the last good snapshot when a refresh fails, so transient CLI errors do not blank the Monitor view.

### `starling.projectSessionLimit`

Number of sessions shown per project node before requiring "Load more". Set to `0` to show all.

### `starling.sessionTreeLimit`

Number of sessions loaded per batch in the Monitor view's static session fallback. Set to `0` to load all.

## Local Data

Starling stores metadata and indexes under:

```text
~/.starling/
```

Set `starling.homePath` to use a different directory.

The extension reads this data through the Starling CLI. It does not upload session contents.

## Logs and Problems

The extension writes diagnostic logs to the VS Code **Output** panel:

```text
Output -> Starling
```

CLI failures, monitor refresh failures, and JSON parsing errors are also reported to VS Code **Problems** diagnostics when they affect a view. Successful refreshes clear the related diagnostics.

## Useful CLI Commands

```bash
starling session ls
starling session show <session-id>
starling session index status
starling session index rebuild
starling catalog tree
starling project ls
starling model ls
starling top
starling top --json
starling run status
```

## Repository

https://github.com/huang-sh/Starling-ext

The CLI repository is:

```text
https://github.com/huang-sh/Starling
```
