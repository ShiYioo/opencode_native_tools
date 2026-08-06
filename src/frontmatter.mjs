import matter from "gray-matter"

// OpenCode delegates this format to gray-matter, then retries the same source
// sanitization for frontmatter values that contain an unquoted colon.
function sanitize(content) {
  const match=content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if(!match)return content
  const frontmatter=match[1]
  const result=frontmatter.split(/\r?\n/).flatMap(line=>{
    if(line.trim().startsWith("#")||line.trim()===""||/^\s+/.test(line))return [line]
    const entry=line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if(!entry)return [line]
    const value=entry[2].trim()
    if(value===""||value===">"||value==="|"||value.startsWith('"')||value.startsWith("'"))return [line]
    if(!value.includes(":"))return [line]
    return [`${entry[1]}: |-`,`  ${value}`]
  })
  return content.replace(frontmatter,()=>result.join("\n"))
}

export function parseSkillMarkdown(source) {
  let parsed
  try { parsed=matter(source) }
  catch { parsed=matter(sanitize(source)) }
  if(typeof parsed.data?.name!=="string"||(parsed.data.description!==undefined&&typeof parsed.data.description!=="string"))return undefined
  return {name:parsed.data.name,description:parsed.data.description,content:parsed.content}
}
