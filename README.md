# OpenCode Native Tools MCP

一个独立的 MCP stdio Server，把 OpenCode `1.18.9` 的公开内置工具带给 Codex、Claude Code 和其他 MCP Code CLI。

它不启动、不调用、也不依赖本机 `opencode` CLI。

## 工具

| 工具 | 用途 |
| --- | --- |
| `read` | 读取文件、目录、图片和 PDF；支持分页、截断、二进制识别 |
| `glob` / `grep` | 文件搜索与内容搜索 |
| `write` / `edit` / `apply_patch` | 写入、上下文编辑和 OpenCode patch |
| `bash` | Shell 命令、超时、输出截断和进程树清理 |
| `webfetch` / `websearch` | 网页读取，以及 Exa / Parallel 搜索 |
| `todowrite` | 连接隔离、可持久化的待办列表 |
| `skill` | OpenCode、Claude、项目和 URL Skill 发现 |

`task`、`question`、`lsp`、OpenCode UI `ask`、插件 hooks 和内部控制工具不包含在内，因为它们依赖 OpenCode 的交互界面、子代理、LSP 会话或插件运行时。

## 安装到 Codex

需要 Node.js `20` 或更高版本。选择以下任一种方式；通常推荐 **方式 A**，它启动更快且不依赖每次执行时下载包。

### 方式 A：全局安装

```bash
npm install -g opencode-native-tools-mcp
```

在 Codex 配置文件中加入：

```toml
[mcp_servers.opencode_native_tools]
command = "opencode-native-tools"
args = []
startup_timeout_sec = 30.0
```

默认情况下，服务使用 MCP Client 启动它时的工作目录作为项目根目录。

### 方式 B：使用 npx，不做全局安装

不需要先执行 `npm install -g`。在 Codex 配置文件中加入：

```toml
[mcp_servers.opencode_native_tools]
command = "npx"
args = ["-y", "opencode-native-tools-mcp@latest"]
startup_timeout_sec = 30.0
```

安装 MCP 后，建议执行一次配置器，让 Codex 自动优先使用本服务进行读取和搜索：

```bash
opencode-native-tools apply
opencode-native-tools status
```

如果使用的是本节的 npx 方式，执行 `npx -y opencode-native-tools-mcp@latest apply`。`apply` 会保留已有 MCP 的 `command` 和 `args`，并更新全局 `AGENTS.md` 中的标记块。它不会把本 MCP 加入 `direct_only_tool_namespaces`：文件修改必须交给 Codex 原生的 `write` / `edit` / `apply_patch`，这样 Codex 才能显示文件修改 Diff。完成后重启 Codex 或新建 task。需要撤销自动规则时执行 `opencode-native-tools unapply`。

默认情况下，服务使用 MCP Client 启动它时的工作目录作为项目根目录。

如果需要固定操作某个项目，再额外添加：

```toml
[mcp_servers.opencode_native_tools.env]
OPENCODE_TOOLS_ROOT = "D:/path/to/your-project"
```

Windows 的全局 Codex 配置文件通常是：

```text
C:\Users\<你的用户名>\.codex\config.toml
```

保存后重启 Codex Desktop，或新建一个 task，让 Codex 重新读取 MCP 配置。

## 验证是否接入成功

在终端执行：

```bash
codex mcp list
```

应该能看到：

```text
opencode_native_tools  ...  enabled
```

然后在新的 Codex task 中输入：

```text
使用 opencode_native_tools 的 glob 查找 package.json，再用 read 读取它。
```

Codex 应调用 `read`、`glob`、`grep`、`write`、`edit`、`apply_patch`、`bash` 等同名 MCP 工具。

## 项目根目录

`OPENCODE_TOOLS_ROOT` 用于固定该 MCP 默认操作的项目目录。未设置时，服务使用 MCP Client 启动时的工作目录；只有在全局配置需要固定到某个仓库时，才需要设置它。

如果不设置它，服务会使用 Codex 启动 MCP 进程时的工作目录。

## 权限与禁用工具

OpenCode 的 `ask` 是其自身 UI 的交互能力，通用 MCP Server 无法复刻。文件修改和 shell 命令的批准应由 Codex 在调用前负责。

推荐为有副作用的工具要求批准：

```toml
[mcp_servers.opencode_native_tools.tools.write]
approval_mode = "approve"

[mcp_servers.opencode_native_tools.tools.edit]
approval_mode = "approve"

[mcp_servers.opencode_native_tools.tools.apply_patch]
approval_mode = "approve"

[mcp_servers.opencode_native_tools.tools.bash]
approval_mode = "approve"
```

可以禁用不希望 Codex 使用的工具：

```toml
[mcp_servers.opencode_native_tools]
disabled_tools = ["bash", "webfetch", "websearch"]
```

或者只保留白名单中的工具：

```toml
[mcp_servers.opencode_native_tools]
enabled_tools = ["read", "glob", "grep", "write", "edit", "apply_patch"]
```

这些是 Codex 的 MCP 配置，只影响 Codex；其他 MCP Client 仍会看到服务公开的完整工具列表。

`apply_patch` 的目标路径位于 `patchText` 中。宿主应在调用前解析 `*** Add File`、`*** Update File`、`*** Delete File` 和 `*** Move to`，并按自身策略批准工作区外访问。结果中的 `metadata.externalPaths` 用于审计，不能替代调用前批准。

## 让 Codex 优先使用本 MCP

服务会在 MCP 初始化时声明对文件读取和搜索的工具偏好。文件修改使用 Codex 原生工具，以便 Codex 记录并显示文件 Diff。要让 Codex 在项目中更稳定地优先使用本 MCP，可以在目标仓库根目录放置 `AGENTS.md`。

仓库提供了可直接使用的模板：[templates/AGENTS.md](templates/AGENTS.md)。它要求 Codex 使用 `opencode_native_tools` 进行读取和搜索，并使用 Codex 原生编辑工具修改文件，以保留 Codex 的 Diff 展示。

## 搜索与可选依赖

`glob` 和 `grep` 优先使用系统 PATH 中的 `rg`。找不到时，服务会下载兼容版本的 ripgrep 并写入自己的缓存；普通用户通常不需要手动安装 `rg`。离线或受限网络环境可以自行安装 ripgrep，或设置：

```text
OPENCODE_TOOLS_RG_PATH=/path/to/rg
```

Windows 下服务会按 `PATH` 优先级查找 `rg.exe`，但会跳过 Codex Desktop WindowsApps 中不可由 MCP 启动的内置副本。其他候选和缓存副本会在服务首次使用时验证一次可执行性；成功路径会在进程内缓存，后续 `glob` 和 `grep` 不产生额外探测开销。

没有可用的 ripgrep 时，服务会下载并验证自己的缓存版本。受限网络环境可通过 `OPENCODE_TOOLS_RG_PATH` 指定允许启动的 `rg.exe` 绝对路径。

`websearch` 是可选工具。要启用它，在 MCP 的 `env` 中提供一个 provider 的 key：

```toml
[mcp_servers.opencode_native_tools.env]
EXA_API_KEY = "..."
# 或 PARALLEL_API_KEY = "..."
```

可通过 `OPENCODE_WEBSEARCH_PROVIDER = "exa"` 或 `"parallel"` 固定 provider。Parallel 还可设置 `OPENCODE_TOOLS_MODEL_NAME`。

## OpenCode 兼容配置

服务会读取兼容的 OpenCode JSON / JSONC 配置数据，但不会加载 OpenCode runtime、插件或 hooks。支持以下配置来源：

- `OPENCODE_CONFIG`
- `OPENCODE_CONFIG_CONTENT`
- `OPENCODE_CONFIG_DIR`
- `OPENCODE_DISABLE_PROJECT_CONFIG`

兼容 `shell`、`tool_output`、`formatter`、`skills` 和 websearch runtime flags。Windows 默认按 `pwsh`、`powershell`、Git Bash、`cmd` 选择 shell；`OPENCODE_TOOLS_SHELL` 和 `OPENCODE_GIT_BASH_PATH` 可覆盖。

默认不会格式化文件。要在 `write`、`edit`、`apply_patch` 后启用 formatter，在项目的 `opencode.json` 或 `opencode.jsonc` 中设置：

```jsonc
{
  "formatter": true
}
```

## 兼容性边界

本实现以 OpenCode `1.18.9` 为固定对照基线。以下差异是通用 MCP 协议限制或有意保留的独立实现选择：

- 宿主 Code CLI 负责批准；不提供 OpenCode UI `ask`。
- LSP diagnostics、watcher 和 OpenCode event bus 未迁移。
- 标准 MCP `content` / `structuredContent` 是对 OpenCode 内部 Tool result 的协议适配。
- `apply_patch` 会先计算全部变更，再原子提交；OpenCode 原实现为审批后按顺序应用。
- ripgrep、formatter、URL skills 和 shell 输出使用本服务的独立缓存，不与 OpenCode 全局缓存共享。
