import { spawn } from "node:child_process"
import { ripgrepPath } from "./ripgrep-binary.mjs"

const RECORD_LIMIT = 64 * 1024

export async function rgLines(args, cwd, options = {}) {
  const limit=options.limit ?? 100
  const jsonRecords=args.includes("--json")
  const program=await ripgrepPath()
  return new Promise((resolve, reject) => {
    const child=spawn(program,args,{cwd,windowsHide:true}), rows=[], stderr=[]
    let pending="", stopped=false
    const stop=()=>{if(stopped)return;stopped=true;child.kill()}
    const abort=()=>{stop();reject(new Error("ripgrep execution aborted"))}
    if(options.signal){if(options.signal.aborted)abort();else options.signal.addEventListener("abort",abort,{once:true})}
    const consume=line=>{if(!line||stopped)return;if(jsonRecords&&Buffer.byteLength(line)>RECORD_LIMIT){stop();reject(new Error(`Ripgrep JSON record exceeded ${RECORD_LIMIT} bytes`));return}rows.push(line);if(rows.length>limit){stop();resolve({rows:rows.slice(0,limit),truncated:true})}}
    child.stdout.setEncoding("utf8");child.stdout.on("data",chunk=>{pending+=chunk;let index;while((index=pending.indexOf("\n"))>=0){const line=pending.slice(0,index).replace(/\r$/,"");pending=pending.slice(index+1);consume(line)}if(!stopped&&jsonRecords&&Buffer.byteLength(pending)>RECORD_LIMIT){stop();reject(new Error(`Ripgrep JSON record exceeded ${RECORD_LIMIT} bytes`))}})
    child.stderr.setEncoding("utf8");child.stderr.on("data",chunk=>stderr.push(chunk))
    child.on("error",reject);child.on("close",code=>{if(stopped)return;if(pending)consume(pending);const error=stderr.join("").trim();if(code===2&&(/regex parse error|error parsing regex/.test(error)))return reject(new Error(error));if(code!==0&&code!==1&&code!==2)return reject(new Error(error||`ripgrep failed with code ${code}`));resolve({rows,truncated:false,partial:code===2})})
  })
}
