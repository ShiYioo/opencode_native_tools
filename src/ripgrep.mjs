import { spawn } from "node:child_process"
import { ripgrepPath } from "./ripgrep-binary.mjs"

const RECORD_LIMIT = 64 * 1024

export async function rgLines(args, cwd, options = {}) {
  const limit=options.limit ?? 100, offset=options.offset ?? 0, maxBytes=options.maxBytes ?? Infinity
  const jsonRecords=args.includes("--json")
  if(options.signal?.aborted)throw new Error("ripgrep execution aborted")
  const program=await ripgrepPath()
  if(options.signal?.aborted)throw new Error("ripgrep execution aborted")
  return new Promise((resolve, reject) => {
    const child=spawn(program,args,{cwd,windowsHide:true}), rows=[]
    let pending="", stderr="", settled=false, closed=false, skipped=0, used=0, timer
    const finish=(error,value,kill=false)=>{
      if(settled)return
      settled=true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort",abort)
      const complete=()=>{if(error)reject(error);else resolve(value)}
      if(kill&&!closed){
        child.once("close",complete)
        child.kill()
      }else complete()
    }
    const abort=()=>finish(new Error("ripgrep execution aborted"),undefined,true)
    const consume=line=>{
      if(!line||settled)return
      if(jsonRecords&&Buffer.byteLength(line)>RECORD_LIMIT)return finish(new Error(`Ripgrep JSON record exceeded ${RECORD_LIMIT} bytes`),undefined,true)
      let row
      try{row=options.select?options.select(line):line}
      catch(error){return finish(error,undefined,true)}
      if(settled)return
      if(row===undefined||row===null)return
      if(skipped++<offset)return
      if(rows.length>=limit)return finish(null,{rows,truncated:true,reason:"maxResults"},true)
      const size=(options.sizeOf?options.sizeOf(row):Buffer.byteLength(line))+(rows.length?1:0)
      if(used+size>maxBytes){
        if(!rows.length)return finish(new Error("A search result exceeds the output byte budget; narrow the search path"),undefined,true)
        return finish(null,{rows,truncated:true,reason:"maxBytes"},true)
      }
      rows.push(row);used+=size
    }
    child.stdout.setEncoding("utf8")
    child.stdout.on("data",chunk=>{
      if(settled)return
      pending+=chunk
      let index
      while(!settled&&(index=pending.indexOf("\n"))>=0){
        const line=pending.slice(0,index).replace(/\r$/,"")
        pending=pending.slice(index+1)
        consume(line)
      }
      if(!settled&&jsonRecords&&Buffer.byteLength(pending)>RECORD_LIMIT)finish(new Error(`Ripgrep JSON record exceeded ${RECORD_LIMIT} bytes`),undefined,true)
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-RECORD_LIMIT)})
    child.on("error",error=>finish(error))
    child.on("close",code=>{
      closed=true
      if(settled)return
      if(pending)consume(pending)
      if(settled)return
      const error=stderr.trim()
      if(code===2&&(/regex parse error|error parsing regex/.test(error)))return finish(new Error(error))
      if(code!==0&&code!==1&&code!==2)return finish(new Error(error||`ripgrep failed with code ${code}`))
      finish(null,{rows,truncated:false,reason:null,partial:code===2})
    })
    timer=setTimeout(()=>finish(new Error("ripgrep execution timed out"),undefined,true),options.timeout ?? 30000)
    timer.unref()
    if(options.signal){
      if(options.signal.aborted)abort()
      else options.signal.addEventListener("abort",abort,{once:true})
    }
  })
}
