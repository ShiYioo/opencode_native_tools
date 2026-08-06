import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"

function jsonc(text) {
  const errors=[]
  const value=parseJsonc(text,errors,{allowTrailingComma:true})
  if(errors.length)throw new Error(`Invalid JSONC: ${errors.map(error=>`code ${error.error} at offset ${error.offset}`).join(", ")}`)
  return value
}
async function substitute(text, directory, source) {
  // Substitution happens before JSONC parsing. Escape the value as JSON source
  // so Windows paths and quotes remain valid inside normal JSON strings.
  const envExpanded=text.replace(/\$?\{env:([^}]+)\}/g, (_, name) => JSON.stringify(process.env[name] || "").slice(1,-1))
  const matches=Array.from(envExpanded.matchAll(/\{file:([^}]+)\}/g))
  if(!matches.length)return envExpanded
  let output="", cursor=0
  for(const match of matches) {
    const index=match.index
    output+=envExpanded.slice(cursor,index)
    const lineStart=envExpanded.lastIndexOf("\n",index-1)+1
    if(envExpanded.slice(lineStart,index).trimStart().startsWith("//")) {
      output+=match[0];cursor=index+match[0].length;continue
    }
    const input=match[1]
    const file=input==="~"||input.startsWith("~/")||input.startsWith("~\\") ? resolve(homedir(),input.slice(2)) : isAbsolute(input) ? resolve(input) : resolve(directory,input)
    let content
    try { content=(await readFile(file,"utf8")).trim() }
    catch(error) {
      const detail=error?.code==="ENOENT" ? ` ${file} does not exist` : ""
      throw new Error(`Invalid OpenCode configuration at ${source}: bad file reference: "${match[0]}"${detail}`)
    }
    // This replaces a token within JSON source, so preserve JSON string escaping.
    output+=JSON.stringify(content).slice(1,-1)
    cursor=index+match[0].length
  }
  return output+envExpanded.slice(cursor)
}
// OpenCode configuration values support both documented {env:NAME} tokens and
// the legacy forms accepted by its config loader.
function expand(value) { return String(value).replace(/\{env:([^}]+)\}|\$\{env:([^}]+)\}|\$ENV_([A-Za-z_][A-Za-z0-9_]*)/gi, (_, one, two, three) => process.env[one || two || three] || "") }
function pathValue(value, directory) {
  const result=expand(value)
  if(result==="~"||result.startsWith("~/")||result.startsWith("~\\"))return resolve(homedir(),result.slice(2))
  return isAbsolute(result)?resolve(result):resolve(directory,result)
}
function worktreeDirectories(root) {
  const chain=[]
  let current=resolve(root)
  while(true) {
    chain.push(current)
    if(existsSync(join(current,".git"))) return chain.reverse()
    const parent=dirname(current)
    if(parent===current) return [resolve(root)]
    current=parent
  }
}
export async function compatibleConfig(root) {
  // ConfigPaths.files() searches from the current directory to the worktree,
  // then reverses that list. ConfigPaths.directories() loads discovered
  // .opencode directories in the original current-to-worktree order.
  const projectDirs=worktreeDirectories(root)
  const projectFiles=process.env.OPENCODE_DISABLE_PROJECT_CONFIG==="1"?[]:[
    ...projectDirs.flatMap(dir=>[join(dir,"opencode.json"),join(dir,"opencode.jsonc")]),
    ...projectDirs.toReversed().flatMap(dir=>[join(dir,".opencode","opencode.json"),join(dir,".opencode","opencode.jsonc")]),
  ]
  const explicit=process.env.OPENCODE_CONFIG?(process.env.OPENCODE_CONFIG.startsWith("~")?resolve(homedir(),process.env.OPENCODE_CONFIG.slice(2)):resolve(root,process.env.OPENCODE_CONFIG)):undefined
  const configDir=process.env.OPENCODE_CONFIG_DIR?(process.env.OPENCODE_CONFIG_DIR.startsWith("~")?resolve(homedir(),process.env.OPENCODE_CONFIG_DIR.slice(2)):resolve(root,process.env.OPENCODE_CONFIG_DIR)):undefined
  // OpenCode treats OPENCODE_CONFIG_DIR as Global.Path.config, not an
  // additional layer over the user's normal configuration directory.
  const globalDir=configDir??resolve(homedir(),".config","opencode")
  const files=[resolve(globalDir,"config.json"),resolve(globalDir,"opencode.json"),resolve(globalDir,"opencode.jsonc"),...(explicit?[explicit]:[]),...projectFiles,...(configDir?[resolve(configDir,"opencode.json"),resolve(configDir,"opencode.jsonc")]:[])]
  // OpenCode's optional formatter config is disabled unless explicitly set.
  const output={skills:{paths:[],urls:[]},toolOutput:{maxLines:2000,maxBytes:50*1024},formatter:false}
  const positiveInteger=(value,label)=>{
    if(!Number.isInteger(value)||value<=0)throw new Error(`Invalid OpenCode configuration: ${label} must be a positive integer`)
    return value
  }
  const strings=(value,label)=>{
    if(!Array.isArray(value)||value.some(item=>typeof item!=="string"))throw new Error(`Invalid OpenCode configuration: ${label} must be an array of strings`)
    return value
  }
  // `mergeDeep` in OpenCode preserves sibling object fields while a later array
  // replaces the earlier one. Apply that behavior to the fields this server uses.
  const merge=(value,directory)=>{
    if("shell" in value){if(typeof value.shell!=="string")throw new Error("Invalid OpenCode configuration: shell must be a string");output.shell=expand(value.shell)}
    if("skills" in value){
      if(!value.skills||typeof value.skills!=="object"||Array.isArray(value.skills))throw new Error("Invalid OpenCode configuration: skills must be an object")
      if("paths" in value.skills)output.skills.paths=strings(value.skills.paths,"skills.paths").map(path=>pathValue(path,directory))
      if("urls" in value.skills)output.skills.urls=strings(value.skills.urls,"skills.urls").map(expand)
    }
    if("tool_output" in value){
      if(!value.tool_output||typeof value.tool_output!=="object"||Array.isArray(value.tool_output))throw new Error("Invalid OpenCode configuration: tool_output must be an object")
      if("max_lines" in value.tool_output)output.toolOutput.maxLines=positiveInteger(value.tool_output.max_lines,"tool_output.max_lines")
      if("max_bytes" in value.tool_output)output.toolOutput.maxBytes=positiveInteger(value.tool_output.max_bytes,"tool_output.max_bytes")
    }
    if("formatter" in value){
      if(typeof value.formatter==="boolean"){output.formatter=value.formatter;return}
      if(!value.formatter||typeof value.formatter!=="object"||Array.isArray(value.formatter))throw new Error("Invalid OpenCode configuration: formatter must be a boolean or object")
      const formatters={}
      for(const [name, entry] of Object.entries(value.formatter)){
        if(!entry||typeof entry!=="object"||Array.isArray(entry))throw new Error(`Invalid OpenCode configuration: formatter.${name} must be an object`)
        const copy={}
        if("disabled" in entry){if(typeof entry.disabled!=="boolean")throw new Error(`Invalid OpenCode configuration: formatter.${name}.disabled must be a boolean`);copy.disabled=entry.disabled}
        if("command" in entry){if(!Array.isArray(entry.command)||entry.command.some(part=>typeof part!=="string"))throw new Error(`Invalid OpenCode configuration: formatter.${name}.command must be an array of strings`);copy.command=entry.command}
        if("extensions" in entry){if(!Array.isArray(entry.extensions)||entry.extensions.some(part=>typeof part!=="string"))throw new Error(`Invalid OpenCode configuration: formatter.${name}.extensions must be an array of strings`);copy.extensions=entry.extensions}
        if("environment" in entry){if(!entry.environment||typeof entry.environment!=="object"||Array.isArray(entry.environment)||Object.values(entry.environment).some(part=>typeof part!=="string"))throw new Error(`Invalid OpenCode configuration: formatter.${name}.environment must be an object of strings`);copy.environment=entry.environment}
        formatters[name]=copy
      }
      const prior=typeof output.formatter==="object"?output.formatter:{}
      output.formatter={...prior,...Object.fromEntries(Object.entries(formatters).map(([name,entry])=>[name,{...(prior[name]??{}),...entry,environment:{...(prior[name]?.environment??{}),...(entry.environment??{})}}]))}
    }
  }
  for(const file of files)if(existsSync(file)){
    let value
    try { value=jsonc(await substitute(await readFile(file,"utf8"),resolve(file,".."),file)) }
    catch(error) { throw new Error(`Failed to parse OpenCode configuration at ${file}: ${error instanceof Error ? error.message : String(error)}`) }
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Invalid OpenCode configuration at ${file}: expected an object`)
    merge(value,resolve(file,".."))
  }
  if(process.env.OPENCODE_CONFIG_CONTENT){
    let value
    try { value=jsonc(await substitute(process.env.OPENCODE_CONFIG_CONTENT,root,"OPENCODE_CONFIG_CONTENT")) }
    catch(error) { throw new Error(`Failed to parse OPENCODE_CONFIG_CONTENT: ${error instanceof Error ? error.message : String(error)}`) }
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid OPENCODE_CONFIG_CONTENT: expected an object")
    merge(value,root)
  }
  return output
}
export const flag = name => ["1","true","yes"].includes(String(process.env[name]||"").toLowerCase())
