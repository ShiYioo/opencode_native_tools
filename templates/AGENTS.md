# OpenCode Native Tools MCP Policy

For file and shell work, prefer the `opencode_native_tools` MCP server.

Use its `read`, `glob`, `grep`, `write`, `edit`, `apply_patch`, and `bash`
tools before equivalent built-in, shell-based, or other MCP alternatives.

Only fall back to host-native tools if the MCP server is unavailable or the
specific MCP call fails. State the fallback briefly before using it.

The host Code CLI remains responsible for requesting approval before calls
that can modify files, execute commands, access the network, or access paths
outside the active workspace.
