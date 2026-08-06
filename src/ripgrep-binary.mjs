import { spawn, spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"

const VERSION="15.1.0"
const PLATFORM={
  "arm64-darwin":["aarch64-apple-darwin","tar.gz"],"arm64-linux":["aarch64-unknown-linux-gnu","tar.gz"],"x64-darwin":["x86_64-apple-darwin","tar.gz"],"x64-linux":["x86_64-unknown-linux-musl","tar.gz"],"arm64-win32":["aarch64-pc-windows-msvc","zip"],"ia32-win32":["i686-pc-windows-msvc","zip"],"x64-win32":["x86_64-pc-windows-msvc","zip"],
}
let pending
const run=(program,args)=>new Promise((resolve,reject)=>{const child=spawn(program,args,{windowsHide:true});let stderr="",stdout="";child.stdout.on("data",data=>stdout+=data);child.stderr.on("data",data=>stderr+=data);child.on("error",reject);child.on("close",code=>code===0?resolve():reject(new Error(stderr.trim()||stdout.trim()||`ripgrep extraction failed with code ${code}`)) )})
function cacheDir(){if(process.env.OPENCODE_TOOLS_CACHE_DIR)return join(process.env.OPENCODE_TOOLS_CACHE_DIR,"bin");if(process.platform==="win32")return join(process.env.LOCALAPPDATA||join(homedir(),"AppData","Local"),"opencode-native-tools","cache","bin");return join(process.env.XDG_CACHE_HOME||join(homedir(),".cache"),"opencode-native-tools","bin")}
function candidates(){
  const name=process.platform==="win32"?"rg.exe":"rg"
  const pathValue=process.env.PATH??process.env.Path??"", search=pathValue?`${pathValue}${delimiter}${cacheDir()}`:cacheDir()
  const extensions=process.platform==="win32"?(process.env.PATHEXT??process.env.Pathext??".COM;.EXE;.BAT;.CMD").split(";"):['']
  const output=[]
  for(const directory of search.split(delimiter).filter(Boolean)) {
    const base=join(directory,name), candidates=process.platform==="win32"&&!/\.[^\\/]+$/.test(name)?extensions.map(extension=>base+extension):[base]
    for(const candidate of candidates)try { if(statSync(candidate).isFile())output.push(candidate) } catch {}
  }
  return output
}
function codexWindowsApp(candidate){return process.platform==="win32"&&/\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources\\rg\.exe$/i.test(candidate)}
function runnable(candidate){return new Promise(resolve=>{
  if(codexWindowsApp(candidate))return resolve(false)
  let child, settled=false, finish=value=>{if(!settled){settled=true;resolve(value)}}
  try { child=spawn(candidate,["--version"],{windowsHide:true,stdio:"ignore",timeout:2000}) } catch { return finish(false) }
  child.once("error",()=>finish(false));child.once("close",code=>finish(code===0))
})}
async function system(){for(const candidate of candidates())if(await runnable(candidate))return candidate}
async function install(){
  const explicit=process.env.OPENCODE_TOOLS_RG_PATH
  if(explicit){if(!existsSync(explicit))throw new Error(`OPENCODE_TOOLS_RG_PATH does not exist: ${explicit}`);if(await runnable(explicit))return explicit;throw new Error(`OPENCODE_TOOLS_RG_PATH is not executable: ${explicit}`)}
  const found=await system();if(found)return found
  const target=join(cacheDir(),process.platform==="win32"?"rg.exe":"rg")
  const key=`${process.arch}-${process.platform}`,config=PLATFORM[key]
  if(!config)throw new Error(`unsupported platform for ripgrep: ${key}`)
  const [platform,extension]=config,filename=`ripgrep-${VERSION}-${platform}.${extension}`,url=`https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
  await mkdir(dirname(target),{recursive:true})
  const response=await fetch(url);if(!response.ok)throw new Error(`failed to download ripgrep: HTTP ${response.status}`)
  const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length)throw new Error(`failed to download ripgrep from ${url}`)
  const temp=await mkdtemp(join(tmpdir(),"opencode-native-ripgrep-")),archive=join(temp,filename)
  try {await writeFile(archive,bytes);if(extension==="zip"){const shell=systemPowerShell();await run(shell,["-NoProfile","-NonInteractive","-Command",`$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'","''")}' -DestinationPath '${temp.replaceAll("'","''")}' -Force`])}else await run("tar",["-xzf",archive,"-C",temp]);const extracted=join(temp,`ripgrep-${VERSION}-${platform}`,process.platform==="win32"?"rg.exe":"rg");if(!existsSync(extracted))throw new Error(`ripgrep archive did not contain executable: ${extracted}`);await copyFile(extracted,target);if(process.platform!=="win32")await chmod(target,0o755);if(!await runnable(target))throw new Error(`downloaded ripgrep is not executable: ${target}`);return target}finally{await rm(temp,{recursive:true,force:true})}
}
function systemPowerShell(){for(const name of ["powershell.exe","pwsh.exe"]){const probe=spawnSync("where.exe",[name],{windowsHide:true,encoding:"utf8"});if(probe.status===0)return probe.stdout.split(/\r?\n/).find(Boolean)||name}return "powershell.exe"}
export function ripgrepPath(){return pending??=(install().catch(error=>{pending=undefined;throw error}))}
