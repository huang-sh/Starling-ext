<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

# Starling Agent

<p align="center">
  <img src="icons/starling.png" alt="Starling Agent logo" width="160">
</p>

Starling Agent 是 Claude Code、Codex 与 Pi 会话的 VS Code 监控与工作台，支持实时状态、Catalog、Projects、模型配置、resume 和 fork。

它配合 Starling CLI 使用，把本地 agent 历史整理成 Monitor、Catalog、Projects、Models 等视图，并在 VS Code 右侧边栏提供 Starling Chat。

当前版本：**0.2.0**

- VS Code Marketplace：[`huangsh.starling-ai`](https://marketplace.visualstudio.com/items?itemName=huangsh.starling-ai)
- GitHub Release：[`v0.2.0`](https://github.com/huang-sh/Starling-ext/releases/tag/v0.2.0)
- CLI 包：[`starling-ai`](https://www.npmjs.com/package/starling-ai)

GitHub Release 会附带打包好的 VSIX：

```text
starling-ai-0.2.0.vsix
```

## 安装要求

扩展要求 VS Code 1.106 或更新版本，以便把 Starling Chat 直接注册到右侧辅助边栏。

先安装 Starling CLI：

```bash
npm install -g starling-ai
```

确认 VS Code 能找到 `starling` 命令：

```bash
starling --help
```

如果 VS Code 的扩展进程找不到 `starling`，请在设置里把 `starling.cliPath` 指向 npm 安装的 `starling` 入口。Starling Chat 需要该 wrapper 定位 SDK Host；若直接配置独立 native binary，还必须显式提供 `STARLING_PI_SDK_HOST` 与 `STARLING_PI_SDK_NODE` 环境变量。

扩展启动时如果找不到 Starling CLI，会提示你执行：

```bash
npm install -g starling-ai
```

也可以通过提示直接打开 `starling.cliPath` 设置。

Starling Chat 需要 Node.js 22.19 或更新版本上的最新版 `starling-ai` npm 包。CLI 固定包含 Pi SDK，并由 Starling Host 直接加载，不会执行 `pi --mode rpc`，因此聊天功能不需要单独安装 Pi CLI。VS Code 扩展本身不内置或加载 SDK。

## 视图

### Starling Chat

运行 **Starling: Open Starling Chat**，即可在 VS Code 的右侧辅助边栏打开 Starling Chat。该视图连接 Starling CLI 的直接 Pi SDK Host，支持：

- 流式显示回答与 thinking。
- 实时显示工具开始、进度、结果与错误。
- Pi 忙碌时排队发送 follow-up。
- 停止当前 turn，以及启动新 session。
- 通过绝对 session 文件路径恢复历史 Pi session。
- 使用 VS Code 原生界面处理 Pi extension 的 confirm、select、input、editor 和 notify 请求。

聊天默认使用第一个 workspace 文件夹作为工作目录。可以把 `starling.chatPiSetting` 设置为 Starling 的 Pi 模型配置名；留空则使用 SDK 默认模型配置。关闭视图时，扩展会取消未完成的交互请求，先通过 stdin 关闭受管 SDK Host，超时后才使用进程信号兜底。

该视图遵循 VS Code Workspace Trust。未信任 workspace 会以 untrusted 状态交给 SDK Host，因此不会启用项目内的 Pi 设置、package 与 extension。

### Catalog

浏览 Starling catalog 以及归档到 catalog 下的会话。

在 catalog session 上右键可以：

- 恢复会话。
- 查看会话详情。
- 编辑会话标题。
- Fork 会话。
- 在新的 VS Code 窗口打开项目。
- 复制项目路径。
- 复制 session ID。
- 移除 pin 元数据。
- 删除会话。

在 catalog 文件夹上右键可以：

- 重命名 catalog。
- 删除 catalog，但不删除真实 session 文件。

### Projects

按项目目录浏览会话，并显示每个项目的 session 数量。

在项目上右键可以：

- 查看项目详情。
- 在新的 VS Code 窗口打开项目。
- 复制项目路径。

项目里的 session 节点支持和 Monitor 视图一致的会话操作。

### Models

浏览 Starling 管理的 Claude、Codex 和 Pi 模型配置。

可以在 Models 视图标题栏创建模型配置模板。扩展会创建：

```text
~/.starling/settings/claude/<name>.json
~/.starling/settings/codex/<name>.toml
~/.starling/settings/pi/<name>.json
```

并在 VS Code 中打开配置文件。

在模型配置上右键可以：

- 打开模型配置文件。
- 启动新的 agent session。
- 在指定 catalog 中启动新的 agent session。
- 删除 Starling 模型配置。

### Monitor

Monitor 是 VS Code 里的 `starling top`。它监控 pinned、active 和 recent 的 Claude Code、Codex 与 Pi 会话，显示状态、上下文、token、CPU、内存和当前任务。

Monitor 视图由 `starling top --json` 提供数据，并在后台刷新。它会把会话分组为：

- Needs attention：等待用户输入或确认的会话。
- Active sessions：正在运行或等待的会话。
- Pinned monitor：已 pin 的会话，按当前 Monitor 排序显示。
- Recent monitor：最近的未 pin 会话，按当前 Monitor 排序显示。
- Static sessions：实时数据不可用时的静态 session 列表。

可以通过 `Starling: Set Monitor Sort` 或 Monitor 视图标题栏按钮切换排序：activity、recent、tokens、created、memory、cpu、ctx、skills、tools。也可以通过 `Starling: Set Monitor Agent Filter` 只显示全部、Claude、Codex 或 Pi 会话。

Linux 上，Pi 启动后会从进程列表隐藏一次性 CLI 参数。通过 Starling 启动的 Pi 会携带受管身份，可以可靠映射；若从 Starling 外部启动 Pi 并使用自定义 session root，请通过 `PI_CODING_AGENT_SESSION_DIR` 或 Pi `settings.json` 持久配置该目录。

会话状态使用 VS Code 主题图标和颜色显示：

- Running：agent 正在处理任务。
- Waiting：agent 正在等待用户输入或权限确认。
- Aborted：当前 turn 被中断或取消。
- Idle：agent 进程存在，但模型没有在处理任务。
- Running?：最近的 running 信号已经过期，需要刷新确认。
- Failure：runtime hook 报告失败。
- Stopped：没有关联的活跃进程。

在 session 上右键可以：

- 恢复会话。
- 查看会话详情。
- Pin 到 catalog。
- 在新的 VS Code 窗口打开项目。
- 复制项目路径。
- 复制 session ID。
- 移除 pin 元数据。
- 删除会话。

## 命令

打开 Command Palette，搜索 `Starling`。

常用命令：

- `Starling: Open Starling Chat`
- `Starling: New Starling Chat`
- `Starling: Resume Starling Chat`
- `Starling: Stop Agent Turn`
- `Starling: Refresh`
- `Starling: Set Monitor Agent Filter`
- `Starling: Set Monitor Sort`
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
- Catalog 右键菜单：`Run Agent > Pi`
- `Starling: Rename Catalog`
- `Starling: Delete Catalog`
- `Starling: Catalog Tree`
- `Starling: List Projects`
- `Starling: Open Project in New Window`
- `Starling: Copy Project Path`
- `Starling: Copy Session ID`

## 设置

```json
{
  "starling.cliPath": "starling",
  "starling.homePath": "",
  "starling.chatPiSetting": "",
  "starling.cacheTtlSeconds": 30,
  "starling.monitorRefreshSeconds": 5,
  "starling.monitorCommandTimeoutSeconds": 60,
  "starling.monitorCacheTtlSeconds": 2,
  "starling.monitorSort": "activity",
  "starling.monitorAgent": "all",
  "starling.projectSessionLimit": 30,
  "starling.sessionTreeLimit": 50
}
```

### `starling.cliPath`

Starling CLI 可执行文件路径。如果 VS Code 扩展进程找不到 `starling`，请使用绝对路径。

### `starling.homePath`

可选的 Starling 数据目录。留空时使用 `~/.starling`。设置后，扩展会把它作为 `STARLING_HOME` 传给 Starling CLI。

### `starling.chatPiSetting`

右侧 Pi Chat 使用的可选 Starling Pi 模型配置名。留空时使用 Pi 默认模型配置。

### `starling.cacheTtlSeconds`

CLI 查询结果缓存时间。设置为 `0` 可以关闭缓存。

### `starling.monitorRefreshSeconds`

后台刷新实时会话状态的间隔。默认是 `5` 秒。扩展会加入少量随机抖动，避免多个 VS Code 窗口在同一时刻轮询。

### `starling.monitorCommandTimeoutSeconds`

每次等待 `starling top` 命令完成的最长时间。默认是 `60` 秒。会话索引很大或主机负载较高时可以调大。

### `starling.monitorCacheTtlSeconds`

实时 monitor 快照缓存时间。刷新失败时，扩展会保留最近一次有效数据并退避重试，避免临时 CLI 错误把视图清空或启动重叠命令。

### `starling.monitorSort`

Monitor 视图排序方式。支持 `activity`、`recent`、`tokens`、`created`、`memory`、`cpu`、`ctx`、`skills`、`tools`。

### `starling.monitorAgent`

Monitor 视图 Agent 过滤方式。支持 `all`、`claude`、`codex`、`pi`。

### `starling.projectSessionLimit`

每个 project 节点默认显示的 session 数量。设置为 `0` 表示全部显示。

### `starling.sessionTreeLimit`

Monitor 视图静态 session fallback 每批加载的 session 数量。设置为 `0` 表示全部加载。

## 本地数据

Starling 的元数据和索引默认保存在：

```text
~/.starling/
```

可以通过 `starling.homePath` 使用其他目录。

扩展通过 Starling CLI 读取这些数据，不会上传 session 内容。

## 日志和问题

扩展会把诊断日志写到 VS Code **Output** 面板：

```text
Output -> Starling
```

CLI 失败、monitor 刷新失败、JSON 解析错误会在影响视图时写入 VS Code **Problems**。刷新成功后，相关诊断会被清理。

## 常用 CLI 命令

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

## 仓库

https://github.com/huang-sh/Starling-ext

CLI 仓库：

```text
https://github.com/huang-sh/Starling
```
