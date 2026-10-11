# OpenCode Native Tools MCP

一个独立的 MCP stdio Server，把 OpenCode `1.18.9` 的公开内置工具带给 Codex、Claude Code 和其他 MCP Code CLI。

它不启动、不调用、也不依赖本机 `opencode` CLI。

## 工具

| 工具 | 用途 |
| --- | --- |
| `read` / `readMany` | 紧凑读取文件、目录、图片和 PDF；支持分页、截断、批量读取和二进制识别 |
| `glob` / `grep` | 文件搜索与紧凑内容搜索 |
| `write` / `edit` / `apply_patch` | 写入、上下文编辑和 OpenCode patch |
| `bash` | Shell 命令、超时、输出截断和进程树清理 |
| `webfetch` / `websearch` | 网页读取，以及 Exa / Parallel 搜索 |
| `todowrite` | 连接隔离、可持久化的待办列表 |
| `skill` | OpenCode、Claude、项目和 URL Skill 发现 |

`task`、`question`、`lsp`、OpenCode UI `ask`、插件 hooks 和内部控制工具不包含在内，因为它们依赖 OpenCode 的交互界面、子代理、LSP 会话或插件运行时。

## 紧凑输出

`read` 默认只返回带行号的正文；`grep` 默认返回 `文件:行号:内容`。两者不会再把正文复制到 `preview` 或 `display.text`。读取被截断时，正文末尾会给出 `startLine`、`endLine`、`totalLines` 和 `nextOffset`；受字节上限影响而无法确认总行数时，`totalLines=unknown`。

需要机器可读元数据时传入 `responseFormat: "detailed"`。此时 `structuredContent` 只包含分页或匹配统计字段，不会重复正文。`readMany` 最多读取 8 个文件，默认每个文件 200 行，整批输出最多 100 KB；单个文件失败会作为该文件的结果返回，不会中断其他文件。

`readMany` 只接受文本文件；目录、图片和 PDF 会返回单项错误，必须通过 `read` 读取。取消请求会终止整个批次，不会伪装成成功返回的文件错误。

### 搜索输出与分页

`grep` 保留原来的默认 `content` 模式，并提供 `outputMode: "files_with_matches"`（只返回文件路径）和 `outputMode: "count"`（返回每个文件的匹配行数，不是匹配子串次数）。只需要定位文件时，选择路径模式可避免输出无用正文。

```json
{
  "pattern": "TODO",
  "include": "**/*.ts",
  "outputMode": "files_with_matches",
  "limit": 50,
  "offset": 0,
  "responseFormat": "detailed"
}
```

结果按路径排序，`limit` 为每页输出条目数（默认 100，范围 1–1000），`offset` 从 0 开始。`nextOffset` 非空时，用它读取下一页；文件变化时，跨请求分页不是固定快照。输出最多 50 KB，提前达到字节上限时同样提供可继续使用的 `nextOffset`。

`ignoreCase: true` 开启大小写不敏感搜索；`context` 为内容模式的前后上下文行数（0–20）。匹配行使用 `路径:行号:正文`，上下文行使用 `路径-行号-正文`；分页单位是输出条目，包括上下文行。

搜索的数量限制只统计实际输出条目，不统计 ripgrep 的生命周期记录。搜索超时为 30 秒；取消或截断时，会等待子进程退出并释放取消监听器。对存在的单个文件指定 `path` 时，只搜索该文件；为兼容原有行为，不存在的文件路径仍搜索其父目录。

工具目录提供标准 MCP `annotations`，区分只读、潜在破坏性、幂等和外部访问行为。注解只供宿主参考，不能代替批准或路径权限检查。

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

## MCP 资源与文件读取

`resources/read` 和 `read` 工具是不同接口。读取项目文件时，调用 `read` 或 `readMany` 工具并传入 `filePath`，不要把文件路径作为资源 URI。

服务支持 `resources/list`、`resources/templates/list` 和 `resources/read`，并在初始化时声明资源能力。资源列表只提供 `opencode-tools://status`，返回服务诊断信息；为兼容已有诊断探测，`test` 也可作为这个资源的别名。未知资源返回带引导说明的成功结果（提示改用 `read` / `readMany` 工具读文件），而不是 `-32002` 错误——部分宿主（如 Codex 桌面端 0.151+）会把 `read_mcp_resource` 暴露给模型，模型用编造的 URI 反复探测时，错误应答只会让它原样重试；缺少或无效的 `uri` 仍返回 `-32602`。

诊断资源是可选的，不需要在每次读取或搜索文件前调用，也不应反复探测。旧版出现 `resources/read ... Method not found` 时，更新包并重启 MCP 连接；再次运行 `apply` 可更新全局 `AGENTS.md` 中的调用说明。

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
