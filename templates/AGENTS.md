# OpenCode Native Tools MCP Policy

Use the `opencode_native_tools` MCP server for `read`, `glob`, and `grep`
when inspecting the project.

Read files with the `read` or `readMany` tool, not `resources/read`. Resources
only provide optional server diagnostics; do not repeatedly probe them.

Use Codex native file-editing tools for `write`, `edit`, and `apply_patch` so
Codex can display the file modification diff.

Use the MCP `bash`, `webfetch`, `websearch`, `skill`, and `todowrite` tools
when appropriate.

The host Code CLI remains responsible for requesting approval before calls
that can modify files, execute commands, access the network, or access paths
outside the active workspace.
