import { existsSync } from "node:fs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const SERVER_NAME = "opencode_native_tools"
export const NAMESPACE = `mcp__${SERVER_NAME}`
const START = "<!-- opencode-native-tools:start -->"
const END = "<!-- opencode-native-tools:end -->"

function codexHome() { return process.env.CODEX_HOME || join(homedir(), ".codex") }
export function paths() { const home=codexHome(); return { home, config:join(home,"config.toml"), agents:join(home,"AGENTS.md") } }

function setTopLevelKey(text, key, value) {
  const line=`${key} = ${value}`
  const match=new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\s*=.*$`,"m")
  const firstTable=text.search(/^\[/m), prefix=firstTable<0?text:text.slice(0,firstTable), suffix=firstTable<0?"":text.slice(firstTable)
  const updated=match.test(prefix) ? prefix.replace(match,line) : `${prefix.trimEnd()}${prefix.trim()?"\n":""}${line}\n\n`
  return updated+suffix
}
function setDirectOnly(text) {
  const key="direct_only_tool_namespaces", re=/^direct_only_tool_namespaces\s*=\s*(\[[^\r\n]*\])[ \t]*$/m, firstTable=text.search(/^\[/m), prefix=firstTable<0?text:text.slice(0,firstTable), match=prefix.match(re)
  if(!match)return setTopLevelKey(text,key,JSON.stringify([NAMESPACE]))
  let values
  try { values=JSON.parse(match[1]) } catch { throw new Error("Cannot update direct_only_tool_namespaces: expected an inline JSON array") }
  if(!Array.isArray(values)||values.some(value=>typeof value!=="string"))throw new Error("Cannot update direct_only_tool_namespaces: expected an array of strings")
  if(!values.includes(NAMESPACE))values.push(NAMESPACE)
  return text.slice(0,prefix.length).replace(re,`${key} = ${JSON.stringify(values)}`)+text.slice(prefix.length)
}
function removeDirectOnly(text) {
  const re=/^direct_only_tool_namespaces\s*=\s*(\[[^\r\n]*\])[ \t]*\r?\n?/m, firstTable=text.search(/^\[/m), prefix=firstTable<0?text:text.slice(0,firstTable), match=prefix.match(re)
  if(!match)return text
  let values
  try { values=JSON.parse(match[1]) } catch { return text }
  if(!Array.isArray(values)||values.some(value=>typeof value!=="string"))return text
  values=values.filter(value=>value!==NAMESPACE)
  const replacement=values.length?`direct_only_tool_namespaces = ${JSON.stringify(values)}\n`:""
  return text.slice(0,prefix.length).replace(re,replacement)+text.slice(prefix.length)
}
function section(text, name) {
  const start=text.search(new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\]\\s*$`,"m"))
  if(start<0)return null
  const end=text.slice(start+1).search(/^\[/m)
  return { start, end:end<0?text.length:start+1+end }
}
function setSectionKeys(text, name, keys) {
  const found=section(text,name)
  if(!found) {
    let out=text.trimEnd()+"\n\n["+name+"]\n"
    for(const [key,value] of Object.entries(keys))out+=`${key} = ${value}\n`
    return out
  }
  let body=text.slice(found.start,found.end)
  for(const [key,value] of Object.entries(keys)) {
    const re=new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\s*=.*$`,"m")
    body=re.test(body)?body.replace(re,`${key} = ${value}`):body.trimEnd()+`\n${key} = ${value}\n`
  }
  return text.slice(0,found.start)+body+text.slice(found.end)
}
function agentsBlock() { return `${START}\nUse the \`opencode_native_tools\` MCP server for \`read\`, \`glob\`, and \`grep\` when inspecting the project.\nRead files with the \`read\` or \`readMany\` tool, not \`resources/read\`. Resources only provide optional server diagnostics; do not repeatedly probe them.\nUse Codex native file-editing tools for \`write\`, \`edit\`, and \`apply_patch\` so Codex can display the file modification diff.\nUse the MCP \`bash\`, \`webfetch\`, \`websearch\`, \`skill\`, and \`todowrite\` tools when appropriate.\n${END}` }
function updateAgents(text, remove=false) {
  const re=new RegExp(`${START}[\\s\\S]*?${END}\\n?`,"m")
  if(remove)return text.replace(re,"").replace(/^\s+$/m,"").trimEnd()+(text.trim()?"\n":"")
  const block=agentsBlock()
  return re.test(text)?text.replace(re,block):`${text.trimEnd()}${text.trim()?"\n\n":""}${block}\n`
}
export async function apply() {
  const p=paths(); await mkdir(p.home,{recursive:true})
  let config=existsSync(p.config)?await readFile(p.config,"utf8"):""
  // Codex renders file diffs only for its native editing tools. Keep this MCP
  // available, but remove any old direct-only routing for this namespace.
  config=removeDirectOnly(config)
  const name=`mcp_servers.${SERVER_NAME}`, existing=section(config,name), body=existing?config.slice(existing.start,existing.end):"", keys={startup_timeout_sec:"30.0"}
  if(!/^command\s*=/m.test(body))keys.command='"opencode-native-tools"'
  if(!/^args\s*=/m.test(body))keys.args="[]"
  config=setSectionKeys(config,name,keys)
  await writeFile(p.config,config,"utf8")
  const agents=existsSync(p.agents)?await readFile(p.agents,"utf8"):""
  await writeFile(p.agents,updateAgents(agents),"utf8")
  return p
}
export async function status() {
  const p=paths(), config=existsSync(p.config)?await readFile(p.config,"utf8"):"", agents=existsSync(p.agents)?await readFile(p.agents,"utf8"):""
  return { ...p, configExists:existsSync(p.config), mcpConfigured:config.includes(`[mcp_servers.${SERVER_NAME}]`), directOnly:config.includes(NAMESPACE), agentsConfigured:agents.includes(START) }
}
export async function unapply() {
  const p=paths()
  if(existsSync(p.config)){const text=await readFile(p.config,"utf8");await writeFile(p.config,removeDirectOnly(text),"utf8")}
  if(existsSync(p.agents)){const text=await readFile(p.agents,"utf8");await writeFile(p.agents,updateAgents(text,true),"utf8")}
  return p
}
