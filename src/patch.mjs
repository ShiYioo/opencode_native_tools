// Ported from packages/opencode/src/patch/index.ts. Kept dependency-free so
// the MCP server does not need the OpenCode CLI or its process runtime.
function normalizeUnicode(value) {
  return value.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐‑‒–—―]/g, "-").replace(/…/g, "...").replace(/ /g, " ")
}

function seek(lines, pattern, offset, eof = false) {
  const match = compare => {
    if (eof) {
      const start = lines.length - pattern.length
      if (start >= offset && pattern.every((line, index) => compare(lines[start + index], line))) return start
    }
    for (let start = offset; start <= lines.length - pattern.length; start++) {
      if (pattern.every((line, index) => compare(lines[start + index], line))) return start
    }
    return -1
  }
  let found = match((a, b) => a === b)
  if (found < 0) found = match((a, b) => a.trimEnd() === b.trimEnd())
  if (found < 0) found = match((a, b) => a.trim() === b.trim())
  if (found < 0) found = match((a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()))
  return found
}

export function parsePatch(patchText) {
  const heredoc = patchText.trim().match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)
  const lines = (heredoc ? heredoc[2] : patchText.trim()).split("\n")
  const begin = lines.findIndex(line => line.trim() === "*** Begin Patch")
  const end = lines.findIndex(line => line.trim() === "*** End Patch")
  if (begin < 0 || end < 0 || begin >= end) throw new Error("Invalid patch format: missing Begin/End markers")
  const hunks = []
  for (let index = begin + 1; index < end;) {
    const line = lines[index]
    if (line.startsWith("*** Add File:")) {
      const path = line.slice(13).trim(); if (!path) { index++; continue }
      let content = ""; index++
      while (index < end && !lines[index].startsWith("***")) { if (lines[index].startsWith("+")) content += lines[index].slice(1) + "\n"; index++ }
      hunks.push({ type: "add", path, contents: content.endsWith("\n") ? content.slice(0, -1) : content }); continue
    }
    if (line.startsWith("*** Delete File:")) { const path=line.slice(16).trim();if(path)hunks.push({ type: "delete", path });index++; continue }
    if (line.startsWith("*** Update File:")) {
      const path = line.slice(16).trim(); if(!path){index++;continue}; index++; let movePath
      if (lines[index]?.startsWith("*** Move to:")) { movePath = lines[index].slice(12).trim(); index++ }
      const chunks = []
      while (index < end && !lines[index].startsWith("***")) {
        if (!lines[index].startsWith("@@")) { index++; continue }
        const context = lines[index++].slice(2).trim(); const oldLines = [], newLines = []; let eof = false
        while (index < end && !lines[index].startsWith("@@") && !lines[index].startsWith("***")) {
          const current = lines[index++]
          if (current === "*** End of File") { eof = true; break }
          if (current.startsWith(" ")) { oldLines.push(current.slice(1)); newLines.push(current.slice(1)) }
          else if (current.startsWith("-")) oldLines.push(current.slice(1))
          else if (current.startsWith("+")) newLines.push(current.slice(1))
        }
        chunks.push({ oldLines, newLines, context, eof })
      }
      hunks.push({ type: "update", path, movePath, chunks }); continue
    }
    index++
  }
  if (!hunks.length) throw new Error("apply_patch verification failed: no hunks found")
  return hunks
}

export function applyPatchToText(original, filePath, chunks) {
  const newline = original.includes("\r\n") ? "\r\n" : "\n"
  const lines = original.replaceAll("\r\n", "\n").split("\n")
  if (lines.at(-1) === "") lines.pop()
  const replacements = []; let offset = 0
  for (const chunk of chunks) {
    if (chunk.context) {
      const context = seek(lines, [chunk.context], offset)
      if (context < 0) throw new Error(`Failed to find context '${chunk.context}' in ${filePath}`)
      offset = context + 1
    }
    let oldLines = chunk.oldLines, newLines = chunk.newLines
    if (!oldLines.length) { replacements.push([lines.length, 0, newLines]); continue }
    let found = seek(lines, oldLines, offset, chunk.eof)
    if (found < 0 && oldLines.at(-1) === "") { oldLines = oldLines.slice(0, -1); newLines = newLines.at(-1) === "" ? newLines.slice(0, -1) : newLines; found = seek(lines, oldLines, offset, chunk.eof) }
    if (found < 0) throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`)
    replacements.push([found, oldLines.length, newLines]); offset = found + oldLines.length
  }
  for (const [start, count, replacement] of replacements.sort((a, b) => b[0] - a[0])) lines.splice(start, count, ...replacement)
  const next=lines.join(newline)
  return next ? next + newline : ""
}
