# OpenCode Native Tools MCP

将 OpenCode `1.18.9` 的公开内置工具独立移植为一个 MCP stdio Server，供 Codex、Claude Code 及其他兼容 MCP 的 Code CLI 使用。

```text
Code CLI -> MCP JSON-RPC (stdio) -> OpenCode Native Tools MCP
```

它不会启动、调用或依赖本机的 `opencode` 可执行文件、OpenCode 插件或 OpenCode 运行时。

## 已提供的工具

| 工具 | 用途 |
| --- | --- |
| `read` | 文件、目录、图片与 PDF 读取；支持分页、截断、二进制识别 |
| `glob` / `grep` | OpenCode 风格的文件搜索与内容搜索 |
| `write` / `edit` / `apply_patch` | 写入、上下文编辑及 OpenCode patch 格式变更 |
| `bash` | 兼容 OpenCode shell 选择、超时、流式尾部截断与进程树清理 |
| `webfetch` / `websearch` | 网页抓取，以及 Exa / Parallel 搜索 |
| `todowrite` | 按 MCP 连接隔离并持久化的待办列表 |
| `skill` | OpenCode、Claude、项目与 URL Skill 发现 |

不暴露以下 OpenCode 能力：`task`、`question`、`lsp`、内部控制工具、插件 hooks 与 Code Mode。它们依赖 OpenCode 的子代理、交互 UI、语言服务器会话或插件运行时，不能作为通用独立 MCP 工具可靠复刻。

## 快速开始

### 前置条件

- Node.js `20` 或更高版本
- npm（首次安装项目依赖及可选 formatter 时使用）
- `websearch` 另需 `EXA_API_KEY` 或 `PARALLEL_API_KEY`

通过 npm 直接使用：

```bash
npx -y opencode-native-tools-mcp
```

克隆项目后安装依赖：

```bash
npm install
```

本地启动：

```bash
npm start
```

服务使用 stdio 传输 JSON-RPC；不要在终端中手工输入普通文本后期待交互式 CLI 输出。应由 MCP Client（例如 Codex）启动它。

### ripgrep 依赖

`glob` 和 `grep` 优先使用 PATH 中的 `rg`。如果没有安装，服务会下载 OpenCode 对应版本的 ripgrep 并缓存到自己的缓存目录；因此普通用户不必单独全局安装 `rg`。在离线、受限网络或受控构建环境中，建议自行安装 `rg`，或通过 `OPENCODE_TOOLS_RG_PATH` 指向已有二进制。

## 配置 Codex

在 Windows 的 `C:\Users\<你的用户名>\.codex\config.toml` 添加：

```toml
[mcp_servers.opencode_native_tools]
command = "npx"
args = ["-y", "opencode-native-tools-mcp"]
startup_timeout_sec = 30.0

[mcp_servers.opencode_native_tools.env]
# 该 MCP 默认操作的项目根目录；替换为你的实际项目路径。
OPENCODE_TOOLS_ROOT = "D:/path/to/your-project"
```

保存后重启 Codex Desktop，或新建一个 task，使其重新加载 MCP 配置。可使用以下命令确认 Codex 已发现服务：

```bash
codex mcp list
```

预期能看到 `opencode_native_tools` 的状态为 `enabled`。

如果不设置 `OPENCODE_TOOLS_ROOT`，服务将使用 MCP Client 启动进程时的工作目录。对多项目使用场景，建议在各项目的 `.codex/config.toml` 中设置项目专属根目录，避免把文件操作意外指向错误仓库。

### Codex 的工具批准

此服务不会实现 OpenCode 的 `ask` UI。工具批准必须由宿主 Code CLI 在**调用前**负责。在 Codex 中，可以为有副作用的工具要求批准：

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

建议让 `read`、`glob`、`grep` 保持无需批准，而对写入与 shell 命令保持批准。`apply_patch` 的目标路径位于 `patchText` 中；宿主必须在工具调用前解析 `*** Add File`、`*** Update File`、`*** Delete File` 和 `*** Move to` 并自行决定是否批准工作区外路径。返回值中的 `metadata.externalPaths` 只用于事后审计，不能替代调用前批准。

### 在 Codex 中禁用工具

`enabled_tools`、`disabled_tools` 与单工具 `approval_mode` 都是 **Codex 原生 MCP 配置能力**，不是本项目的私有配置。它们在 Codex 读取 MCP 工具清单后决定哪些工具可以暴露给 Codex agent。

使用黑名单禁用一个或多个工具：

```toml
[mcp_servers.opencode_native_tools]
disabled_tools = ["bash", "webfetch", "websearch"]
```

例如，只禁止 shell：

```toml
[mcp_servers.opencode_native_tools]
disabled_tools = ["bash"]
```

也可以使用白名单，仅保留明确需要的工具：

```toml
[mcp_servers.opencode_native_tools]
enabled_tools = ["read", "glob", "grep", "write", "edit", "apply_patch"]
```

如果同时设置两者，`disabled_tools` 优先。要完全停用服务：

```toml
[mcp_servers.opencode_native_tools]
enabled = false
```

这些设置只影响 Codex 对此 MCP Server 的访问；它们不会更改服务本身，也不会阻止 Claude Code 或其他 MCP Client 发现完整 11 个工具。若需要跨所有 MCP Client 的硬性禁用，必须由部署者限制启动环境，或在本服务中实现独立的服务端工具 allow-list / deny-list。

### 让 Codex 优先使用本 MCP

服务会通过 MCP `initialize` 响应声明工具偏好：文件读取、搜索、写入、编辑、patch 与 shell 工作优先使用本服务的 `read`、`glob`、`grep`、`write`、`edit`、`apply_patch`、`bash`。这是一项面向兼容 MCP Client 的**软偏好**，不是绕过宿主审批或强制模型选择工具的机制。

对 Codex，最稳定的方式是在目标项目根目录添加 `AGENTS.md`。可直接复制本仓库的模板：[templates/AGENTS.md](templates/AGENTS.md)。模板要求 Codex 优先使用本 MCP，并且只在服务不可用或具体调用失败时才回退至宿主工具。


## OpenCode 兼容配置

服务只读取兼容的 OpenCode JSON / JSONC 配置数据，不加载 OpenCode 运行时、插件或 hooks。支持的覆盖方式包括：

- `OPENCODE_CONFIG`
- `OPENCODE_CONFIG_CONTENT`
- `OPENCODE_CONFIG_DIR`
- `OPENCODE_DISABLE_PROJECT_CONFIG`

支持 JSONC 注释与尾逗号，以及 OpenCode 风格的 `{env:NAME}`、`{file:path}` 配置插值。服务会读取与下列能力有关的兼容配置：

- `shell`：选择 PowerShell、pwsh、Git Bash、cmd 或 POSIX shell
- `tool_output`：shell 输出尾部与字节限制
- `formatter`：写入、编辑、patch 后的格式化行为
- `skills`：项目、全局、Claude、自定义路径与 URL skills
- websearch 的 Exa / Parallel provider 开关

Windows 上 shell 的默认优先级为 `pwsh`、`powershell`、Git Bash、`cmd`。`OPENCODE_TOOLS_SHELL` 可显式覆盖；`OPENCODE_GIT_BASH_PATH` 可指定 Git Bash。

## Formatter

默认不格式化。要启用 OpenCode 兼容的自动格式化，在目标项目的 `opencode.json` 或 `opencode.jsonc` 中配置：

```jsonc
{
  "formatter": true
}
```

`write`、`edit`、`apply_patch` 成功后会尝试格式化相应文件。服务会在其独立 npm 缓存中解析或安装所需工具（如 Prettier、Biome、oxfmt）；不需要把它们全局安装。首次缓存缺失时需要 npm 与网络；formatter 找不到或失败不会使原始写入操作失败。

可使用 `OPENCODE_TOOLS_NPM_CACHE_DIR` 或 `OPENCODE_TOOLS_CACHE_DIR` 自定义该缓存位置。

## Web Search

设置至少一个 API key：

```text
EXA_API_KEY=...
# 或
PARALLEL_API_KEY=...
```

`OPENCODE_WEBSEARCH_PROVIDER` 可覆盖 provider 选择。对于 Parallel，可用 `OPENCODE_TOOLS_MODEL_NAME` 提供模型名；这是对 OpenCode 内部 model session context 的独立 MCP 等价适配。

## 兼容性边界

实现以 `D:/demo/opencode-dev/opencode-dev` 的 OpenCode `1.18.9` 源码为固定对照基线。目标是高保真移植公开工具行为，但以下差异是有意保留或由通用 MCP 协议决定的：

- OpenCode 的 UI `ask` 不可移植；由宿主 CLI 负责批准。
- LSP diagnostics、watcher 与 OpenCode event bus 未迁移；其中 LSP 已明确不在范围内。
- 标准 MCP 的 `content` 与 `structuredContent` 是对 OpenCode 内部 Tool result / attachment 的协议适配。
- `apply_patch` 采用全部 hunk 先计算、再提交的原子策略；OpenCode 原实现为审批后按顺序应用。
- ripgrep、npm formatter、URL skills 和 shell 输出使用本服务的独立缓存目录，不与 OpenCode 全局缓存共享。
