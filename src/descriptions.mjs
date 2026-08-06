// Ported from OpenCode 1.18.9 tool instructions. These descriptions deliberately
// omit OpenCode-only UI, Task, and approval references.
export const DESCRIPTIONS = {
  read: `Read a file or directory from the local filesystem. The filePath should be absolute. By default, returns up to 2000 lines starting at line 1. Use offset (1-indexed) and limit to read later sections. Lines are returned as <line>: <content>; directories list entries with a trailing / for subdirectories. Lines longer than 2000 characters are truncated. Images and PDFs are returned as attachments.`,
  glob: `Fast file pattern matching for codebases of any size. Supports patterns such as **/*.js and src/**/*.ts. Returns matching file paths. Use it to find files by name pattern.`,
  grep: `Fast regular-expression content search for codebases of any size. The optional include parameter filters searched files, for example *.js or *.{ts,tsx}. Returns matching paths, line numbers, and matching lines.`,
  write: `Write a text file to the local filesystem. An existing file is overwritten. Prefer edit for an existing file when a targeted replacement is sufficient.`,
  edit: `Replace text in a file using OpenCode matching semantics. Preserve the exact indentation from read output, excluding its line-number prefix. The operation fails when oldString cannot be identified unambiguously; supply more context or use replaceAll to replace every occurrence.`,
  apply_patch: `Apply an OpenCode patch document. Wrap one or more file operations in *** Begin Patch and *** End Patch. Use *** Add File, *** Delete File, or *** Update File headers. New lines in an added file must begin with +. Updates may include a *** Move to: path directive.`,
  bash: `Execute a shell command. Set workdir instead of changing directories inside the command when possible. timeout is in milliseconds. Output is capped; complete truncated output is saved to a file.`,
  webfetch: `Fetch content from a fully formed HTTP or HTTPS URL. format controls whether text, Markdown, or HTML is returned; Markdown is the default. This tool is read-only.`,
  websearch: `Search the web through the configured Exa or Parallel provider. Query is required; numResults, livecrawl, type, and contextMaxCharacters are optional provider controls.`,
  todowrite: `Create and maintain the structured task list for the current MCP session. Each item has content, status, and priority.`,
  skill: `Load a discovered specialized skill. The output contains the skill instructions and references to files in the skill directory. The name must match a discovered skill.`,
}
