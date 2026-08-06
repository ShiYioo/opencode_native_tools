import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { homedir } from "node:os"
import { glob } from "glob"
import TurndownService from "turndown"
import { Parser } from "htmlparser2"
import { createTwoFilesPatch, diffLines } from "diff"
import { applyPatchToText, parsePatch } from "./patch.mjs"
import { replaceText, trimDiff } from "./edit.mjs"
import { compatibleConfig, flag } from "./config.mjs"
import { rgLines } from "./ripgrep.mjs"
import { atomicWrite, transactionalCommit } from "./store.mjs"
import { CUSTOMIZE_OPENCODE_SKILL } from "./customize-opencode-skill.mjs"
import { parseSkillMarkdown } from "./frontmatter.mjs"
import { formatFile } from "./formatter.mjs"

const READ_LIMIT = 2000, MAX_LINE_LENGTH = 2000, READ_BYTES = 50 * 1024
const BINARY_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo"])
const safeSkillFile = value => {
  if(typeof value!=="string"||!value||value.includes("\\")||value.includes("\0")||value.includes("?")||value.includes("#")||URL.canParse(value)||value.startsWith("/")||/^[a-z]:/i.test(value))return false
  return value.split("/").every(segment=>{try{const decoded=decodeURIComponent(segment);return decoded&&decoded!=="."&&decoded!==".."&&!decoded.includes("/")&&!decoded.includes("\\")&&!decoded.includes("\0")}catch{return false}})
}

function envValue(key) {
  if (process.platform !== "win32") return process.env[key]
  const actual=Object.keys(process.env).find(item=>item.toLowerCase()===key.toLowerCase())
  return actual ? process.env[actual] : undefined
}
function defaultShell() {
  if (process.platform !== "win32") return acceptableShell(envValue("SHELL")) || "/bin/sh"
  for (const candidate of [envValue("SHELL"), "pwsh.exe", "powershell.exe", envValue("OPENCODE_GIT_BASH_PATH"), envValue("ComSpec") || "cmd.exe"]) {
    if (!acceptableShellName(candidate)) continue
    if (!candidate) continue
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate
    const found=spawnSync("where.exe",[candidate],{windowsHide:true,encoding:"utf8"})
    if (found.status===0) return found.stdout.split(/\r?\n/).find(Boolean) || candidate
  }
  return process.env.ComSpec || "cmd.exe"
}

function acceptableShellName(candidate) {
  const name=String(candidate??"").split(/[\\/]/).at(-1)?.replace(/\.exe$/i,"").toLowerCase()
  return name!=="fish"&&name!=="nu"
}

function acceptableShell(candidate) {
  if (!candidate) return undefined
  if (!acceptableShellName(candidate)) return undefined
  if (process.platform !== "win32") {
    if(isAbsolute(candidate))return existsSync(candidate)?candidate:undefined
    const found=spawnSync("which",[candidate],{encoding:"utf8"})
    return found.status===0?(found.stdout.split(/\r?\n/).find(Boolean)||candidate):undefined
  }
  if (isAbsolute(candidate)) return existsSync(candidate) ? candidate : undefined
  const found=spawnSync("where.exe",[candidate],{windowsHide:true,encoding:"utf8"})
  return found.status===0 ? (found.stdout.split(/\r?\n/).find(Boolean) || candidate) : undefined
}

function shellCommand(shell, command, cwd) {
  const name=String(shell).split(/[\\/]/).at(-1)?.replace(/\.exe$/i,"").toLowerCase()
  if(name==="powershell"||name==="pwsh")return [shell,["-NoLogo","-NoProfile","-NonInteractive","-Command",command]]
  if(name==="cmd")return [shell,["/c",command]]
  if(name==="bash")return [shell,["-l","-c",`
    shopt -s expand_aliases
    [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
    cd -- "$1"
    eval ${JSON.stringify(command)}
  `,"opencode",cwd]]
  if(name==="zsh")return [shell,["-l","-c",`
    [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
    [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
    cd -- "$1"
    eval ${JSON.stringify(command)}
  `,"opencode",cwd]]
  return [shell,["-c",command]]
}

export function shellTail(text, maxLines, maxBytes) {
  const lines=text.split("\n")
  if(lines.length<=maxLines && Buffer.byteLength(text,"utf8")<=maxBytes)return {text,cut:false}
  const out=[]
  let bytes=0
  for(let index=lines.length-1;index>=0&&out.length<maxLines;index--) {
    const size=Buffer.byteLength(lines[index],"utf8")+(out.length?1:0)
    if(bytes+size>maxBytes) {
      if(!out.length) {
        const value=Buffer.from(lines[index],"utf8")
        let start=Math.max(0,value.length-maxBytes)
        while(start<value.length&&(value[start]&0xc0)===0x80)start++
        out.unshift(value.subarray(start).toString("utf8"))
      }
      break
    }
    out.unshift(lines[index])
    bytes+=size
  }
  return {text:out.join("\n"),cut:true}
}
export function createRuntime(root) {
  const config = compatibleConfig(root)
  // The server can be initialized before its first tool call. Keep a rejected
  // configuration promise observable by each tool without producing an early
  // unhandled-rejection process failure.
  config.catch(() => {})
  const shellTasks = new Set()
  let disposed=false
  const resolvePath = path => isAbsolute(path ?? "") ? resolve(path) : resolve(root, path ?? ".")
  // OpenCode discovers project external skills from the current directory up
  // to the worktree. The MCP root is the closest equivalent current directory;
  // detect a worktree by its .git marker without invoking Git.
  const projectDirectories = async () => {
    const dirs=[]
    let current=resolve(root)
    while(true) {
      dirs.push(current)
      if(existsSync(join(current,".git"))) break
      const parent=dirname(current)
      if(parent===current) break
      current=parent
    }
    return dirs
  }
  const title = path => relative(root,resolvePath(path)).replaceAll("\\", "/") || "."
  const external = path => { const value=relative(root,resolve(path)); return value===".." || value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(value) }
  const binary = (path, bytes) => { const sample=bytes.subarray(0,4096); return BINARY_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase()) || sample.includes(0) || [...sample].filter(byte => byte < 9 || (byte > 13 && byte < 32)).length > sample.length * .3 }
  const bom = text => text.charCodeAt(0) === 0xfeff ? [true, text.slice(1)] : [false, text]
  const encode = (text, hasBom) => (hasBom ? "\ufeff" : "") + text

  const attachmentMime = bytes => {
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png"
    if (bytes.subarray(0, 3).equals(Buffer.from([255,216,255]))) return "image/jpeg"
    if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif"
    if (bytes.subarray(0, 12).toString("ascii", 0, 4) === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp"
    if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf"
  }
  const fallbackMime = path => ({".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".gif":"image/gif",".webp":"image/webp",".pdf":"application/pdf"}[extname(path).toLowerCase()])
  async function read(args, _session, signal) {
    await config
    if(signal?.aborted)throw new Error("read aborted")
    const path = resolvePath(args.filePath), offset = args.offset || 1, limit = args.limit ?? READ_LIMIT
    let info
    try { info = await stat(path) } catch (error) {
      if (error?.code !== "ENOENT") throw error
      const dir = dirname(path), base = path.slice(dir.length + 1).toLowerCase()
      let choices=[]; try { choices=(await readdir(dir)).filter(item=>item.toLowerCase().includes(base)||base.includes(item.toLowerCase())).slice(0,3).map(item=>resolve(dir,item)) } catch {}
      throw new Error(`File not found: ${path}${choices.length ? `\n\nDid you mean one of these?\n${choices.join("\n")}` : ""}`)
    }
    if (info.isDirectory()) {
      const entries = (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))
      const names=[]
      for (const entry of entries) {
        let directory=entry.isDirectory()
        if (!directory&&entry.isSymbolicLink()) try { directory=(await stat(resolve(path,entry.name))).isDirectory() } catch {}
        names.push(entry.name+(directory?"/":""))
      }
      const items = names.slice(offset - 1, offset - 1 + limit)
      const more=offset-1+items.length<entries.length
      const output=`<path>${path}</path>\n<type>directory</type>\n<entries>\n${items.join("\n")}\n${more?`\n(Showing ${items.length} of ${entries.length} entries. Use 'offset' parameter to read beyond entry ${offset+items.length})`:`\n(${entries.length} entries)`}\n</entries>`
      return {title:title(path),output,metadata:{preview:items.slice(0,20).join("\n"),truncated:more,loaded:[],display:{type:"directory",path,entries:items,offset,totalEntries:entries.length,truncated:more},externalPaths:external(path)?[path]:[]}}
    }
    // OpenCode samples ordinary files before choosing an attachment or binary path.
    // Do not load a potentially large text file merely to render one page.
    const handle=await open(path,"r")
    const sample=Buffer.alloc(Math.min(4096,Number(info.size)))
    try { if(sample.length) await handle.read(sample,0,sample.length,0) } finally { await handle.close() }
    const mime=attachmentMime(sample) ?? fallbackMime(path)
    const bytes=mime?await readFile(path,{signal}):undefined
    if(mime) { const output=mime==="application/pdf"?"PDF read successfully":"Image read successfully"; return {title:title(path),output,attachment:{mimeType:mime,data:bytes.toString("base64")},metadata:{preview:output,truncated:false,loaded:[],externalPaths:external(path)?[path]:[]}} }
    if (binary(path, sample)) throw new Error(`Cannot read binary file: ${path}`)
    const shown=[]; let used=0, count=0, cut=false, more=false, stopped=false, pending=""
    const decoder=new TextDecoder("utf-8")
    const consume=line=>{
      if(stopped)return
      count++
      if(count<offset)return
      if(shown.length>=limit){more=true;return}
      if(line.length>MAX_LINE_LENGTH)line=line.slice(0,MAX_LINE_LENGTH)+`... (line truncated to ${MAX_LINE_LENGTH} chars)`
      const size=Buffer.byteLength(line,"utf8")+(shown.length?1:0)
      if(used+size>READ_BYTES){cut=true;more=true;stopped=true;return}
      shown.push(line);used+=size
    }
    const stream=createReadStream(path,{signal})
    for await(const chunk of stream){
      pending+=decoder.decode(chunk,{stream:true})
      let index
      while(!stopped&&(index=pending.indexOf("\n"))>=0){const line=pending.slice(0,index).replace(/\r$/,"");pending=pending.slice(index+1);consume(line)}
      if(stopped)stream.destroy()
    }
    if(!stopped){pending+=decoder.decode();if(pending!=="")consume(pending.replace(/\r$/,""))}
    if(offset > count && !(count === 0 && offset === 1)) throw new Error(`Offset ${offset} is out of range for this file (${count} lines)`)
    const last=offset+shown.length-1, next=last+1, truncated=more||cut
    const note=cut?`(Output capped at 50 KB. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`:more?`(Showing lines ${offset}-${last} of ${count}. Use offset=${next} to continue.)`:`(End of file - total ${count} lines)`
    const output=`<path>${path}</path>\n<type>file</type>\n<content>\n${shown.map((line,index)=>`${index+offset}: ${line}`).join("\n")}\n\n${note}\n</content>`
    return {title:title(path),output,metadata:{preview:shown.slice(0,20).join("\n"),truncated,loaded:[],display:{type:"file",path,text:shown.join("\n"),lineStart:offset,lineEnd:last,totalLines:count,truncated},externalPaths:external(path)?[path]:[]}}
  }

  async function globFiles(args, _session, signal) {
    await config
    const cwd = resolvePath(args.path), info=await stat(cwd); if(!info.isDirectory()) throw new Error(`glob path must be a directory: ${cwd}`)
    const result=await rgLines(["--no-config","--files","--hidden",`--glob=${args.pattern}`,"--glob=!**/.git/**","."],cwd,{signal}),files=result.rows.map(file=>resolve(cwd,file)),truncated=result.truncated||files.length===100,list=files
    return {title:title(cwd),output:list.length ? [...list,...(truncated?["","(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)"]:[])].join("\n") : "No files found",metadata:{count:list.length,truncated,externalPaths:external(cwd)?[cwd]:[]}}
  }

  function runProcess(command, args, cwd, timeout = 120000) { return new Promise(resolveRun => { const child = spawn(command, args, { cwd, windowsHide: true }); let out="", err="", done=false; const finish=value=>{if(!done){done=true;resolveRun(value)}}; child.stdout.on("data", d=>out+=d); child.stderr.on("data", d=>err+=d); child.on("error", e=>finish({code:-1,out,err:e.message})); child.on("close", code=>finish({code,out,err})); setTimeout(()=>{child.kill();finish({code:-1,out,err:`Command timed out after ${timeout}ms`})},timeout).unref() }) }
  async function shellProcess(shell, command, cwd, timeout, signal, maxBytes, isDisposed) {
    const outdir=resolvePath(".opencode-tools/shell"), file=resolve(outdir,`output-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
    await mkdir(outdir,{recursive:true})
    if(isDisposed())return {code:null,tail:"",file,truncated:false,expired:false,aborted:true}
    return new Promise(resolveRun=>{
      const [program,args]=shellCommand(shell,command,cwd)
      const child=spawn(program,args,{cwd,windowsHide:true,detached:process.platform!=="win32"}), sink=createWriteStream(file)
      let tail="",dropped=false,total=0,expired=false,aborted=false,settled=false,timer
      const stdoutDecoder=new StringDecoder("utf8"), stderrDecoder=new StringDecoder("utf8")
      const append=(data, decoder)=>{const text=typeof data==="string"?data:decoder.write(data);if(!text)return;total+=Buffer.byteLength(text);sink.write(text);tail+=text;while(Buffer.byteLength(tail)>maxBytes*2){const newline=tail.indexOf("\n");if(newline>=0)tail=tail.slice(newline+1);else{const value=Buffer.from(tail,"utf8");let start=Math.max(0,value.length-maxBytes*2);while(start<value.length&&(value[start]&0xc0)===0x80)start++;tail=value.subarray(start).toString("utf8")}dropped=true}}
      const flush=()=>{append(stdoutDecoder.end());append(stderrDecoder.end())}
      const task={terminate:undefined}
      const finish=code=>{if(settled)return;settled=true;flush();clearTimeout(timer);signal?.removeEventListener("abort",abort);shellTasks.delete(task);sink.end(()=>resolveRun({code:(expired||aborted)?null:code,tail,file,truncated:dropped||total>maxBytes,expired,aborted}))}
      const terminate=()=>{if(settled)return;if(process.platform==="win32"){spawn("taskkill",["/pid",String(child.pid),"/t","/f"],{windowsHide:true}).on("close",()=>finish(-1));return}try{process.kill(-child.pid,"SIGTERM")}catch{child.kill("SIGTERM")}const force=setTimeout(()=>{if(settled)return;try{process.kill(-child.pid,"SIGKILL")}catch{child.kill("SIGKILL")};finish(-1)},3000);force.unref()}
      const abort=()=>{aborted=true;terminate()}
      task.terminate=abort
      shellTasks.add(task)
      child.stdout.on("data",data=>append(data,stdoutDecoder)); child.stderr.on("data",data=>append(data,stderrDecoder)); child.on("error",error=>{append(error.message);finish(-1)}); child.on("close",finish)
      if(signal){if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true})}
      timer=setTimeout(()=>{if(settled)return;expired=true;terminate()},timeout+100);timer.unref()
    })
  }
  async function grep(args, _session, signal) {
    await config
    if (!args.pattern) throw new Error("pattern is required")
    const path = resolvePath(args.path), externalPaths=external(path)?[path]:[];let input;try{input=await stat(path)}catch(error){if(error?.code!=="ENOENT")throw error};const cwd = input?.isDirectory() ? path : dirname(path)
    const result = await rgLines(["--no-config", "--json", "--hidden", "--no-messages", ...(args.include ? [`--glob=${args.include}`] : []), "--glob=!**/.git/**", "--", args.pattern, "."], cwd,{signal}), rows=result.rows.map(line=>{try{const item=JSON.parse(line);if(item.type!=="match")return;const data=item.data;return {path:resolve(cwd,data.path.text.replace(/^(?:\.[\\/])+/,"")),line:data.line_number,text:data.lines.text.length>2000?`${data.lines.text.slice(0,2000)}...`:data.lines.text}}catch{}}).filter(Boolean);if(!rows.length)return {title:args.pattern,output:"No files found",metadata:{matches:0,truncated:false,externalPaths}};const truncated=result.truncated||rows.length===100, output=[`Found ${rows.length} matches${truncated?" (more matches available)":""}`];let current="";for(const row of rows){if(current!==row.path){if(current)output.push("");current=row.path;output.push(`${row.path}:`)}output.push(`  Line ${row.line}: ${row.text}`)}if(truncated)output.push("","(Results truncated. Consider using a more specific path or pattern.)");return {title:args.pattern,output:output.join("\n"),metadata:{matches:rows.length,truncated,externalPaths}}
  }

  async function write(args) { const cfg=await config; const path = resolvePath(args.filePath), exists=existsSync(path), source = exists ? await readFile(path, "utf8") : "", [sourceBom] = bom(source), [incomingBom, content] = bom(args.content); await atomicWrite(path, encode(content, sourceBom || incomingBom));await formatFile(root,path,cfg.formatter);return {title:title(path),output:"Wrote file successfully.",metadata:{diagnostics:{},filepath:path,exists,externalPaths:external(path)?[path]:[]}} }
  async function edit(args) { const cfg=await config; const path = resolvePath(args.filePath); if (args.oldString===""&&!existsSync(path)){const [hasBom,content]=bom(args.newString);await atomicWrite(path,encode(content,hasBom));await formatFile(root,path,cfg.formatter);const formatted=bom(await readFile(path,"utf8"))[1],diff=trimDiff(createTwoFilesPatch(path,path,"",formatted.replaceAll("\r\n","\n"))),additions=diffLines("",formatted).filter(x=>x.added).reduce((n,x)=>n+(x.count??0),0);return {title:title(path),output:"Edit applied successfully.",metadata:{diagnostics:{},diff,filediff:{file:path,patch:diff,additions,deletions:0},externalPaths:external(path)?[path]:[]}}} let info;try{info=await stat(path)}catch(error){if(error?.code==="ENOENT")throw new Error(`File ${path} not found`);throw error}if(info.isDirectory())throw new Error(`Path is a directory, not a file: ${path}`);const raw=await readFile(path,"utf8"), [hasBom,source]=bom(raw), ending=source.includes("\r\n")?"\r\n":"\n", old=args.oldString.replaceAll("\r\n","\n").replaceAll("\n",ending), replacement=args.newString.replaceAll("\r\n","\n").replaceAll("\n",ending), next=replaceText(source,old,replacement,args.replaceAll);await writeFile(path,encode(next,hasBom),"utf8");await formatFile(root,path,cfg.formatter);const formatted=bom(await readFile(path,"utf8"))[1];const diff=trimDiff(createTwoFilesPatch(path,path,source.replaceAll("\r\n","\n"),formatted.replaceAll("\r\n","\n")));const additions=diffLines(source,formatted).filter(x=>x.added).reduce((n,x)=>n+(x.count??0),0),deletions=diffLines(source,formatted).filter(x=>x.removed).reduce((n,x)=>n+(x.count??0),0);return {title:title(path),output:"Edit applied successfully.",metadata:{diagnostics:{},diff,filediff:{file:path,patch:diff,additions,deletions},externalPaths:external(path)?[path]:[]}} }
  async function applyPatch(args) {
    const cfg=await config
    if (!args.patchText) throw new Error("patchText is required")
    let hunks
    try { hunks = parsePatch(args.patchText) }
    catch (error) { throw new Error(`apply_patch verification failed: ${error.message}`) }
    if (!hunks.length) {
      const normalized=args.patchText.replace(/\r\n/g,"\n").replace(/\r/g,"\n").trim()
      throw new Error(normalized==="*** Begin Patch\n*** End Patch" ? "patch rejected: empty patch" : "apply_patch verification failed: no hunks found")
    }
    const plan=[]
    for (const hunk of hunks) {
      const path=resolvePath(hunk.path)
      if (hunk.type==="add") {
        const raw=hunk.contents.length===0||hunk.contents.endsWith("\n")?hunk.contents:`${hunk.contents}\n`
        const [hasBom,content]=bom(raw)
        plan.push({kind:"add",path,content,hasBom})
      } else if (hunk.type==="delete") {
        let content
        try { content=await readFile(path,"utf8") }
        catch (error) { throw new Error(`apply_patch verification failed: ${error.message}`) }
        plan.push({kind:"delete",path,content})
      } else {
        let raw
        try { raw=await readFile(path,"utf8") }
        catch { throw new Error(`apply_patch verification failed: Failed to read file to update: ${path}`) }
        const [hasBom,source]=bom(raw),movePath=hunk.movePath||undefined,target=movePath?resolvePath(movePath):path
        let next
        try { next=applyPatchToText(source,path,hunk.chunks) }
        catch (error) { throw new Error(`apply_patch verification failed: ${error.message}`) }
        plan.push({kind:movePath?"move":"update",path,target,source,next,hasBom})
      }
    }
    const writes=plan.filter(item=>item.kind!=="delete").map(item=>({path:item.kind==="add"?item.path:item.target,content:item.kind==="add"?encode(item.content,item.hasBom):encode(item.next,item.hasBom)}))
    const removals=plan.filter(item=>item.kind==="delete"||item.kind==="move").map(item=>item.path)
    await transactionalCommit({writes,removals})
    await Promise.all(writes.map(item=>formatFile(root,item.path,cfg.formatter)))
    const changed=[],files=[],externalPaths=[],diffs=[]
    for (const item of plan) {
      if (external(item.path)) externalPaths.push(item.path)
      if (item.target&&external(item.target)) externalPaths.push(item.target)
      if (item.kind==="add") {
        const patch=trimDiff(createTwoFilesPatch(item.path,item.path,"",item.content))
        changed.push(`A ${title(item.path)}`)
        files.push({filePath:item.path,relativePath:title(item.path),type:"add",patch,additions:diffLines("",item.content).filter(x=>x.added).reduce((n,x)=>n+(x.count??0),0),deletions:0})
        diffs.push(patch)
      } else if (item.kind==="delete") {
        const patch=trimDiff(createTwoFilesPatch(item.path,item.path,item.content,""))
        changed.push(`D ${title(item.path)}`)
        files.push({filePath:item.path,relativePath:title(item.path),type:"delete",patch,additions:0,deletions:item.content.split("\n").length})
        diffs.push(patch)
      } else {
        const patch=trimDiff(createTwoFilesPatch(item.path,item.target,item.source,item.next))
        const changes=diffLines(item.source,item.next)
        changed.push(`M ${title(item.target)}`)
        files.push({filePath:item.path,relativePath:title(item.target),type:item.kind,movePath:item.kind==="move"?item.target:undefined,patch,additions:changes.filter(x=>x.added).reduce((n,x)=>n+(x.count??0),0),deletions:changes.filter(x=>x.removed).reduce((n,x)=>n+(x.count??0),0)})
        diffs.push(patch)
      }
    }
    const output=`Success. Updated the following files:\n${changed.join("\n")}`
    return {title:output,output,metadata:{diff:diffs.filter(Boolean).join("\n"),files,externalPaths:[...new Set(externalPaths)]}}
  }
  async function bash(args, _session, signal) {
    if (args.timeout !== undefined && (!Number.isInteger(args.timeout) || args.timeout <= 0)) throw new Error(`Invalid timeout value: ${args.timeout}. Timeout must be a positive integer.`)
    const configuredTimeout=Number(process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS)
    const defaultTimeout=Number.isInteger(configuredTimeout)&&configuredTimeout>0?configuredTimeout:120000
    const cwd=resolvePath(args.workdir ?? "."), timeout=args.timeout ?? defaultTimeout, cfg=await config
    if(disposed)return {title:args.command,output:"(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",metadata:{output:"(no output)",exit:null,truncated:false,externalPaths:external(cwd)?[cwd]:[]}}
    const configured=envValue("OPENCODE_TOOLS_SHELL") || cfg.shell, shell=acceptableShell(configured)||defaultShell(), {maxBytes,maxLines}=cfg.toolOutput
    if(disposed)return {title:args.command,output:"(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",metadata:{output:"(no output)",exit:null,truncated:false,externalPaths:external(cwd)?[cwd]:[]}}
    const result=await shellProcess(shell,args.command,cwd,timeout,signal,maxBytes,()=>disposed)
    const end=shellTail(result.tail,maxLines,maxBytes);let output=end.text||"(no output)",truncated=result.truncated||end.cut;if(truncated)output=`...output truncated...\n\nFull output saved to: ${result.file}\n\n${output}`;else await rm(result.file,{force:true});const metadata=[];if(result.expired)metadata.push(`shell tool terminated command after exceeding timeout ${timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`);if(result.aborted)metadata.push("User aborted the command");if(metadata.length)output+=`\n\n<shell_metadata>\n${metadata.join("\n")}\n</shell_metadata>`;return {title:args.command,output,metadata:{output:output.length>30000?`...\n\n${output.slice(-30000)}`:output,exit:result.code,truncated,externalPaths:external(cwd)?[cwd]:[],...(truncated?{outputPath:result.file}:{})}}
  }
  function htmlText(html) { let out="", skip=0; const parser=new Parser({onopentag:n=>{if(skip||["script","style","noscript","iframe","object","embed"].includes(n))skip++},ontext:t=>{if(!skip)out+=t},onclosetag:()=>{if(skip)skip--}}); parser.write(html);parser.end();return out.trim() }
  async function webfetch(args, _session, signal) { await config; const format=args.format ?? "markdown", timeout=Math.min(args.timeout ?? 30,120)*1000, abort=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);if(!args.url.startsWith("http://")&&!args.url.startsWith("https://"))throw new Error("URL must start with http:// or https://");const accept={markdown:"text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",text:"text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",html:"text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"}[format];const headers={"user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",accept,"accept-language":"en-US,en;q=0.9"};let response=await fetch(args.url,{headers,signal:abort});if(response.status===403&&response.headers.get("cf-mitigated")==="challenge")response=await fetch(args.url,{headers:{...headers,"user-agent":"opencode"},signal:abort});if(!response.ok)throw new Error(response.status===408?"Request timed out":`Request failed: HTTP ${response.status}`);if(Number(response.headers.get("content-length")||0)>5*1024*1024)throw new Error("Response too large (exceeds 5MB limit)");const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>5*1024*1024)throw new Error("Response too large (exceeds 5MB limit)");const contentType=response.headers.get("content-type")??"",type=contentType.split(";")[0].trim().toLowerCase(),title=`${args.url} (${contentType})`,body=bytes.toString("utf8");if(type.startsWith("image/")&&type!=="image/svg+xml"&&type!=="image/vnd.fastbidsheet")return {title,output:"Image fetched successfully",attachment:{mimeType:type,data:bytes.toString("base64")},metadata:{}};if(format==="html")return {title,output:body,metadata:{}};if(!type.includes("text/html"))return {title,output:body,metadata:{}};if(format==="text")return {title,output:htmlText(body),metadata:{}};const turndown=new TurndownService({headingStyle:"atx",hr:"---",bulletListMarker:"-",codeBlockStyle:"fenced",emDelimiter:"*"});turndown.remove(["script","style","meta","link"]);return {title,output:turndown.turndown(body),metadata:{}} }
  function checksum(value){let hash=0x811c9dc5;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,0x01000193)}return (hash>>>0).toString(36)}
  async function cacheSkillURLs(urls, cache) {
    for (const url of urls) try {
      if (/\/SKILL\.md(?:[?#]|$)/i.test(url)) {
        const response=await fetch(url,{signal:AbortSignal.timeout(15000)})
        if (response.ok) await atomicWrite(resolve(cache,checksum(url),"SKILL.md"),await response.text())
        continue
      }
      const base=url.endsWith("/")?url:`${url}/`, response=await fetch(new URL("index.json",base),{headers:{accept:"application/json"},signal:AbortSignal.timeout(15000)})
      if (!response.ok) continue
       const index=await response.json()
       if (!Array.isArray(index?.skills)) continue
       for (const skill of index.skills) {
         if (!skill||typeof skill.name!=="string"||/[\\/]/.test(skill.name)||!Array.isArray(skill.files)||(!skill.files.includes("SKILL.md")&&!skill.files.includes(`${skill.name}.md`))) continue
         const root=resolve(cache,skill.name)
         const files=skill.files.filter(safeSkillFile)
         if (files.length!==skill.files.length) continue
         const source=new URL(base), skillURL=new URL(`${encodeURIComponent(skill.name)}/`,source)
         if(files.some(file=>new URL(file,skillURL).origin!==source.origin))continue
         const version=typeof skill.version==="string"?skill.version:undefined
         let current
         try { current=await readFile(join(root,".opencode-version"),"utf8") } catch {}
         const download=async (file,target)=>{
           if(existsSync(target))return true
           try { const response=await fetch(new URL(file,skillURL),{signal:AbortSignal.timeout(15000)});if(!response.ok)return false;await mkdir(dirname(target),{recursive:true});await writeFile(target,Buffer.from(await response.arrayBuffer()));return true } catch { return false }
         }
         if(version===undefined||current===version) {
           await Promise.all(files.map(file=>download(file,resolve(root,file))))
           continue
         }
         const token=randomUUID(), staging=`${root}.tmp-${token}`, backup=`${root}.old-${token}`
         try {
           const downloaded=await Promise.all(files.map(file=>download(file,resolve(staging,file))))
           if(!downloaded.every(Boolean)||(!existsSync(join(staging,"SKILL.md"))&&!existsSync(join(staging,`${skill.name}.md`))))continue
           await writeFile(join(staging,".opencode-version"),version)
           const cached=existsSync(root)
           if(cached)await rename(root,backup)
           try { await rename(staging,root) } catch(error) { if(cached)await rename(backup,root).catch(()=>{});throw error }
           if(cached)await rm(backup,{recursive:true,force:true})
         } finally { await rm(staging,{recursive:true,force:true}).catch(()=>{}) }
       }
    } catch {}
  }
  async function websearch(args, sessionID, signal) { await config; const experimental=flag("OPENCODE_EXPERIMENTAL"), enableParallel=flag("OPENCODE_ENABLE_PARALLEL")||flag("OPENCODE_EXPERIMENTAL_PARALLEL"), enableExa=experimental||flag("OPENCODE_ENABLE_EXA")||flag("OPENCODE_EXPERIMENTAL_EXA"), override=process.env.OPENCODE_WEBSEARCH_PROVIDER, provider=override==="exa"||override==="parallel"?override:enableParallel?"parallel":enableExa?"exa":Number.parseInt(checksum(sessionID)||"0",36)%2===0?"exa":"parallel", label=provider==="exa"?"Exa Web Search":"Parallel Web Search", exa=provider==="exa", url=exa?`https://mcp.exa.ai/mcp${process.env.EXA_API_KEY?`?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`:""}`:"https://search.parallel.ai/mcp", input=exa?{query:args.query,type:args.type||"auto",numResults:args.numResults||8,livecrawl:args.livecrawl||"fallback",contextMaxCharacters:args.contextMaxCharacters}:{objective:args.query,search_queries:[args.query],session_id:sessionID,...(process.env.OPENCODE_TOOLS_MODEL_NAME?{model_name:process.env.OPENCODE_TOOLS_MODEL_NAME}:{})};const response=await fetch(url,{method:"POST",headers:{accept:"application/json, text/event-stream","content-type":"application/json",...(exa?{}:{"user-agent":"opencode/1.18.9",...(process.env.PARALLEL_API_KEY?{authorization:`Bearer ${process.env.PARALLEL_API_KEY}`}:{})})},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:exa?"web_search_exa":"web_search",arguments:input}}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});if(!response.ok)throw new Error(`websearch failed: HTTP ${response.status}`);const body=await response.text();for(const line of body.split("\n")){const raw=line.startsWith("data: ")?line.slice(6):line.trim();if(!raw.startsWith("{"))continue;try{const data=JSON.parse(raw),text=data.result?.content?.find(x=>x.text)?.text;if(text)return {title:`${label}: ${args.query}`,output:text,metadata:{provider}}}catch{}}return {title:`${label}: ${args.query}`,output:"No search results found. Please try a different query.",metadata:{provider}} }
  async function skill(args) { const cfg=await config, cache=resolvePath(".opencode-tools/skills-cache");await cacheSkillURLs(cfg.skills.urls,cache);const home=process.env.OPENCODE_TEST_HOME||homedir(), projectDirs=await projectDirectories(), configured=cfg.skills.paths.map(path=>path.startsWith("~/")?resolve(home,path.slice(2)):resolvePath(path)), externalSkills=!flag("OPENCODE_DISABLE_EXTERNAL_SKILLS"), claudeSkills=externalSkills&&!flag("OPENCODE_DISABLE_CLAUDE_CODE")&&!flag("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"), externalRoots=[...(claudeSkills?[resolve(home,".claude"),...projectDirs.map(dir=>resolve(dir,".claude"))]:[]),...(externalSkills?[resolve(home,".agents"),...projectDirs.map(dir=>resolve(dir,".agents"))]:[])], opencodeRoots=[process.env.OPENCODE_CONFIG_DIR??resolve(home,".config","opencode"),resolvePath(".opencode")],found=[];for(const base of externalRoots)if(existsSync(base))for(const file of await glob("skills/**/SKILL.md",{cwd:base,absolute:true,dot:true}))found.push(file);for(const base of opencodeRoots)if(existsSync(base))for(const file of await glob("{skill,skills}/**/SKILL.md",{cwd:base,absolute:true,dot:true}))found.push(file);for(const base of configured)if(existsSync(base))for(const file of await glob("**/SKILL.md",{cwd:base,absolute:true,dot:true}))found.push(file);for(const file of await glob("**/{SKILL.md,*.md}",{cwd:cache,absolute:true,dot:true}))found.push(file);const infos=[];for(const file of found){const parsed=parseSkillMarkdown(await readFile(file,"utf8"));if(parsed)infos.push({file,...parsed})};const unique=new Map;for(const info of infos)unique.set(info.name,info);const info=unique.get(args.name)??(args.name==="customize-opencode"?{file:"<built-in>",name:"customize-opencode",content:CUSTOMIZE_OPENCODE_SKILL,builtin:true}:undefined);if(!info)throw new Error(`Skill "${args.name}" not found. Available skills: ${[...unique.keys(),"customize-opencode"].toSorted().join(", ")}`);const base=dirname(info.file), files=info.builtin?[]:(await glob("**/*",{cwd:base,absolute:true,dot:true,nodir:true,ignore:["**/SKILL.md"]})).slice(0,10);return {title:`Loaded skill: ${info.name}`,output:[`<skill_content name="${info.name}">`,`# Skill: ${info.name}`,"",info.content.trim(),"",`Base directory for this skill: ${base}`,"Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.","Note: file list is sampled.","","<skill_files>",files.map(file=>`<file>${file}</file>`).join("\n"),"</skill_files>","</skill_content>"].join("\n"),metadata:{name:info.name,dir:base,externalPaths:info.builtin?[]:(external(base)?[base]:[])}} }
  async function todo(args, sessionID) { await config; const state=resolvePath(join(".opencode-tools","todos",`${encodeURIComponent(sessionID)}.json`));for(const item of args.todos){if(!item||typeof item!=="object"||typeof item.content!=="string"||typeof item.status!=="string"||typeof item.priority!=="string")throw new Error("Each todo must include content, status, and priority strings.")};await atomicWrite(state,JSON.stringify(args.todos,null,2)+"\n");return {title:`${args.todos.filter(item=>item.status!=="completed").length} todos`,output:JSON.stringify(args.todos,null,2),metadata:{todos:args.todos}} }
  async function dispose() { disposed=true; for (const task of [...shellTasks]) task.terminate() }
  return { read, glob: globFiles, grep, write, edit, applyPatch, bash, webfetch, websearch, skill, todo, dispose }
}
