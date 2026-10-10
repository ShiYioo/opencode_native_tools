import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { getEventListeners } from "node:events"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createRuntime } from "../src/runtime.mjs"
import { rgLines } from "../src/ripgrep.mjs"

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"opencode-tool-optimizations-"))
  const runtime=createRuntime(root)
  t.after(async()=>{await runtime.dispose();await rm(root,{recursive:true,force:true})})
  return {root,runtime}
}

test("grep limits matching entries, not ripgrep lifecycle records",async t=>{
  const {root,runtime}=await fixture(t)
  await Promise.all(Array.from({length:40},(_,i)=>writeFile(join(root,`${String(i).padStart(2,"0")}.txt`),"needle\n")))
  const result=await runtime.grep({pattern:"needle",responseFormat:"detailed"})
  assert.equal(result.structuredContent.matches,40)
  assert.equal(result.structuredContent.truncated,false)
  assert.equal(result.output.split("\n").length,40)
})

test("grep paginates deterministic output with a usable nextOffset",async t=>{
  const {root,runtime}=await fixture(t)
  await writeFile(join(root,"one.txt"),Array.from({length:5},(_,i)=>`needle ${i}`).join("\n"))
  const first=await runtime.grep({pattern:"needle",limit:2,responseFormat:"detailed"})
  assert.equal(first.structuredContent.nextOffset,2)
  assert.equal(first.structuredContent.reason,"maxResults")
  assert.match(first.output,/one\.txt:1:needle 0/)
  const second=await runtime.grep({pattern:"needle",limit:2,offset:2,responseFormat:"detailed"})
  assert.equal(second.structuredContent.nextOffset,4)
  assert.match(second.output,/one\.txt:3:needle 2/)
  assert.doesNotMatch(second.output,/needle 0|needle 1/)
  const last=await runtime.grep({pattern:"needle",limit:2,offset:4,responseFormat:"detailed"})
  assert.equal(last.structuredContent.truncated,false)
  assert.equal(last.structuredContent.nextOffset,null)
  assert.equal(last.structuredContent.matches,1)
  const exhausted=await runtime.grep({pattern:"needle",offset:10,responseFormat:"detailed"})
  assert.equal(exhausted.output,"No files found")
  assert.equal(exhausted.structuredContent.truncated,false)
})

test("grep provides path-only and per-file matching-line count modes",async t=>{
  const {root,runtime}=await fixture(t)
  await writeFile(join(root,"a.txt"),"needle needle\nneedle\n")
  await writeFile(join(root,"b.txt"),"needle\n")
  const files=await runtime.grep({pattern:"needle",outputMode:"files_with_matches",responseFormat:"detailed"})
  assert.deepEqual(files.output.split("\n"),[join(root,"a.txt"),join(root,"b.txt")])
  assert.equal(files.structuredContent.returned,2)
  const counts=await runtime.grep({pattern:"needle",outputMode:"count",responseFormat:"detailed"})
  assert.deepEqual(counts.output.split("\n"),[`${join(root,"a.txt")}:2`,`${join(root,"b.txt")}:1`])
  assert.equal(counts.structuredContent.matches,3)
  const page=await runtime.grep({pattern:"needle",outputMode:"files_with_matches",limit:1,responseFormat:"detailed"})
  assert.equal(page.structuredContent.nextOffset,1)
  assert.match(page.output,/a\.txt/)
  const next=await runtime.grep({pattern:"needle",outputMode:"count",offset:1,limit:1,responseFormat:"detailed"})
  assert.equal(next.output,`${join(root,"b.txt")}:1`)
  assert.equal(next.structuredContent.truncated,false)
})

test("grep supports case folding and distinguishes context from matches",async t=>{
  const {root,runtime}=await fixture(t)
  await writeFile(join(root,"one.txt"),"before\nNEEDLE\nafter\n")
  assert.equal((await runtime.grep({pattern:"needle"})).output,"No files found")
  const result=await runtime.grep({pattern:"needle",ignoreCase:true,context:1,responseFormat:"detailed"})
  assert.match(result.output,/one\.txt-1-before/)
  assert.match(result.output,/one\.txt:2:NEEDLE/)
  assert.match(result.output,/one\.txt-3-after/)
  assert.equal(result.structuredContent.matches,1)
  assert.equal(result.structuredContent.returned,3)
})

test("grep honors an existing file target without searching siblings",async t=>{
  const {root,runtime}=await fixture(t)
  await writeFile(join(root,"a.txt"),"needle\n")
  await writeFile(join(root,"b.txt"),"needle\n")
  const result=await runtime.grep({pattern:"needle",path:"a.txt"})
  assert.match(result.output,/a\.txt/)
  assert.doesNotMatch(result.output,/b\.txt/)
})

test("exactly full grep and glob pages are not incorrectly marked truncated",async t=>{
  const {root,runtime}=await fixture(t)
  await Promise.all(Array.from({length:100},(_,i)=>writeFile(join(root,`${i}.txt`),"needle\n")))
  assert.equal((await runtime.grep({pattern:"needle"})).metadata.truncated,false)
  assert.equal((await runtime.glob({pattern:"*.txt"})).metadata.truncated,false)
})

test("grep output stays within its byte budget and can resume after the cut",async t=>{
  const {root,runtime}=await fixture(t)
  await writeFile(join(root,"one.txt"),Array.from({length:100},()=>`needle ${"x".repeat(1800)}`).join("\n"))
  const result=await runtime.grep({pattern:"needle",limit:1000,responseFormat:"detailed"})
  assert.ok(Buffer.byteLength(result.output)<=50*1024)
  assert.equal(result.structuredContent.reason,"maxBytes")
  assert.ok(result.structuredContent.nextOffset>0)
  const next=await runtime.grep({pattern:"needle",offset:result.structuredContent.nextOffset,limit:1,responseFormat:"detailed"})
  assert.equal(next.structuredContent.returned,1)
  assert.match(next.output,new RegExp(`one\\.txt:${result.structuredContent.nextOffset+1}:needle`))
})

test("search completion releases its cancellation listener",async t=>{
  const {root,runtime}=await fixture(t)
  await writeFile(join(root,"one.txt"),"needle\n")
  const controller=new AbortController()
  await runtime.grep({pattern:"needle"},undefined,controller.signal)
  assert.equal(getEventListeners(controller.signal,"abort").length,0)
  await runtime.grep({pattern:"needle",limit:1,context:1},undefined,controller.signal)
  assert.equal(getEventListeners(controller.signal,"abort").length,0)
  await writeFile(join(root,"one.txt"),"needle\nneedle\n")
  await runtime.grep({pattern:"needle",limit:1},undefined,controller.signal)
  assert.equal(getEventListeners(controller.signal,"abort").length,0)
  controller.abort()
  await assert.rejects(()=>runtime.glob({pattern:"*.txt"},undefined,controller.signal),/ripgrep execution aborted/)
})

test("an in-flight search abort waits for child cleanup and releases its listener",async t=>{
  const {root}=await fixture(t)
  await writeFile(join(root,"one.txt"),"needle\n")
  const controller=new AbortController()
  await assert.rejects(()=>rgLines(["--no-config","--files","."],root,{
    signal:controller.signal,
    select:line=>{controller.abort();return line},
  }),/ripgrep execution aborted/)
  assert.equal(getEventListeners(controller.signal,"abort").length,0)
  await rm(join(root,"one.txt"))
})

test("readMany propagates cancellation instead of reporting successful file errors",async t=>{
  const {root,runtime}=await fixture(t)
  await writeFile(join(root,"one.txt"),"one\n")
  await assert.rejects(()=>runtime.readMany({files:[{filePath:"one.txt"}]},undefined,AbortSignal.abort()),/readMany aborted/)
})

test("text read budgets include line-number prefixes and pagination markers",async t=>{
  const {root,runtime}=await fixture(t)
  const files=Array.from({length:4},(_,index)=>({filePath:`${index}.txt`}))
  await Promise.all(files.map(file=>writeFile(join(root,file.filePath),Array.from({length:200},()=>"\u4f60".repeat(200)).join("\n"))))
  const single=await runtime.read({filePath:"0.txt"})
  assert.ok(Buffer.byteLength(single.output)<=50*1024)
  assert.equal(single.metadata.reason,"maxBytes")
  const batch=await runtime.readMany({files,responseFormat:"detailed"})
  assert.ok(Buffer.byteLength(batch.output)<=100*1024)
  assert.equal(batch.structuredContent.truncated,true)
  assert.ok(batch.structuredContent.nextFileIndex>0)
})

test("readMany rejects media and directories per file without dropping attachments silently",async t=>{
  const {root,runtime}=await fixture(t)
  await writeFile(join(root,"one.txt"),"one\n")
  await writeFile(join(root,"image.png"),Buffer.from([137,80,78,71,13,10,26,10]))
  await writeFile(join(root,"file.pdf"),"%PDF-1.7\n")
  await mkdir(join(root,"directory"))
  const result=await runtime.readMany({files:[{filePath:"image.png"},{filePath:"file.pdf"},{filePath:"directory"},{filePath:"one.txt"}],responseFormat:"detailed"})
  assert.deepEqual(result.structuredContent.files.map(file=>file.status),["error","error","error","ok"])
  assert.match(result.output,/use read for image and PDF attachments/)
  assert.doesNotMatch(result.output,/Image read successfully|PDF read successfully/)
  assert.match(result.output,/1: one/)
  assert.equal((await runtime.read({filePath:"image.png"})).attachment.mimeType,"image/png")
})

test("MCP advertises search options and rejects invalid values as tool errors",async t=>{
  const {root}=await fixture(t)
  const child=spawn(process.execPath,[fileURLToPath(new URL("../bin/opencode-native-tools.mjs",import.meta.url))],{
    cwd:root,env:{...process.env,OPENCODE_TOOLS_ROOT:root},windowsHide:true,
  })
  let stdout="",stderr=""
  child.stdout.on("data",chunk=>{stdout+=chunk})
  child.stderr.on("data",chunk=>{stderr+=chunk})
  const complete=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error(`MCP test timed out: ${stderr}`))},10000)
    child.once("error",error=>{clearTimeout(timer);reject(error)})
    child.once("close",code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`MCP exited ${code}: ${stderr}`))})
  })
  const invalid=[{outputMode:"unknown"},{ignoreCase:"true"},{context:-1},{context:21},{limit:0},{limit:1001},{offset:-1},{offset:1000001}]
  child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})+"\n")
  invalid.forEach((args,index)=>child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:index+2,method:"tools/call",params:{name:"grep",arguments:{pattern:"needle",...args}}})+"\n"))
  child.stdin.end()
  await complete
  const messages=stdout.trim().split(/\r?\n/).map(JSON.parse)
  const grep=messages.find(message=>message.id===1).result.tools.find(tool=>tool.name==="grep")
  assert.equal(grep.inputSchema.properties.outputMode.default,"content")
  assert.equal(grep.annotations.readOnlyHint,true)
  for(let index=0;index<invalid.length;index++){
    const result=messages.find(message=>message.id===index+2).result
    assert.equal(result.isError,true)
    assert.match(result.content[0].text,/invalid arguments/)
  }
})
