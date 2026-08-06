import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const pending=new Map()
const cacheRoot=()=>process.env.OPENCODE_TOOLS_NPM_CACHE_DIR||process.env.OPENCODE_TOOLS_CACHE_DIR?join(process.env.OPENCODE_TOOLS_NPM_CACHE_DIR||process.env.OPENCODE_TOOLS_CACHE_DIR,"packages"):process.platform==="win32"?join(process.env.LOCALAPPDATA||join(homedir(),"AppData","Local"),"opencode-native-tools","cache","packages"):join(process.env.XDG_CACHE_HOME||join(homedir(),".cache"),"opencode-native-tools","packages")
const packageDir=pkg=>join(cacheRoot(),pkg)
const run=(program,args,cwd)=>new Promise((resolve,reject)=>{
  const child=spawn(program,args,{cwd,windowsHide:true,stdio:"ignore"})
  child.on("error",reject)
  child.on("close",code=>code===0?resolve():reject(new Error(`npm install ${args.at(-1)} failed with code ${code}`)))
})
async function pick(pkg, bin) {
  const dir=packageDir(pkg), binDir=join(dir,"node_modules",".bin")
  let files;try{files=await readdir(binDir)}catch{return undefined}
  if(!files.length)return undefined
  const suffix=process.platform==="win32"?".cmd":""
  const target=bin??(files.length===1?files[0]:undefined)
  if(target){const candidate=join(binDir,`${target}${suffix}`);return existsSync(candidate)?candidate:undefined}
  try {const manifest=JSON.parse(await readFile(join(dir,"node_modules",pkg,"package.json"),"utf8")), value=manifest.bin, name=pkg.startsWith("@")?pkg.split("/")[1]:pkg, inferred=typeof value==="string"?name:Object.keys(value??{})[0];return inferred?await pick(pkg,inferred):undefined}catch{return undefined}
}
async function resolve(pkg, bin) {
  const cached=await pick(pkg,bin);if(cached)return cached
  const dir=packageDir(pkg);await mkdir(dir,{recursive:true})
  await run(process.platform==="win32"?"npm.cmd":"npm",["install","--ignore-scripts","--no-audit","--no-fund","--no-package-lock","--no-save",pkg],dir)
  return pick(pkg,bin)
}
export function npmBinary(pkg, bin) {const key=`${pkg}:${bin??""}`;if(!pending.has(key))pending.set(key,resolve(pkg,bin).finally(()=>pending.delete(key)));return pending.get(key)}
