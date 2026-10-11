import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

test("supports MCP diagnostic resources without changing file tools", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-resources-"))
  await writeFile(join(root,"fixture.txt"),"file tool still works\n")
  const child=spawn(process.execPath,[fileURLToPath(new URL("../bin/opencode-native-tools.mjs",import.meta.url))],{
    cwd:root,env:{...process.env,OPENCODE_TOOLS_ROOT:root},windowsHide:true,
  })
  const pending=new Map()
  let buffer="",stderr="",nextID=0
  child.stderr.on("data",chunk=>{stderr+=chunk})
  child.stdout.setEncoding("utf8")
  child.stdout.on("data",chunk=>{
    buffer+=chunk
    let end
    while((end=buffer.indexOf("\n"))>=0){
      const response=JSON.parse(buffer.slice(0,end))
      buffer=buffer.slice(end+1)
      pending.get(response.id)?.resolve(response)
      pending.delete(response.id)
    }
  })
  child.on("error",error=>{
    for(const request of pending.values())request.reject(error)
    pending.clear()
  })
  child.on("exit",code=>{
    for(const request of pending.values())request.reject(new Error(`MCP exited (${code}): ${stderr}`))
    pending.clear()
  })
  const request=(method,params)=>new Promise((resolve,reject)=>{
    const id=++nextID,timer=setTimeout(()=>{
      pending.delete(id)
      reject(new Error(`MCP request timed out: ${method}; ${stderr}`))
    },5000)
    pending.set(id,{
      resolve:value=>{clearTimeout(timer);resolve(value)},
      reject:error=>{clearTimeout(timer);reject(error)},
    })
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n")
  })
  try{
    const init=await request("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"resources-test",version:"1"}})
    assert.deepEqual(init.result.capabilities.resources,{listChanged:false,subscribe:false})
    assert.deepEqual(init.result.capabilities.tools,{listChanged:false})
    assert.match(init.result.instructions,/not resources\/read/)
    assert.match(init.result.instructions,/do not repeatedly probe/)
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n")
    const list=await request("resources/list",{})
    assert.equal(list.result.resources.length,1)
    assert.equal(list.result.resources[0].uri,"opencode-tools://status")
    assert.equal(list.result.resources[0].mimeType,"application/json")
    const templates=await request("resources/templates/list",{})
    assert.deepEqual(templates.result,{resourceTemplates:[]})
    for(const uri of [list.result.resources[0].uri,"test"]){
      const read=await request("resources/read",{uri})
      assert.equal(read.error,undefined)
      assert.equal(read.result.contents.length,1)
      assert.equal(read.result.contents[0].uri,uri)
      assert.equal(read.result.contents[0].mimeType,"application/json")
      const status=JSON.parse(read.result.contents[0].text)
      assert.equal(status.server,"opencode_native_tools")
      assert.deepEqual(status.fileAccessTools,["read","readMany"])
      assert.equal(status.protocolVersion,init.result.protocolVersion)
    }
    for(const uri of ["opencode-tools://missing","file:///fixture.txt"]){
      const missing=await request("resources/read",{uri})
      assert.equal(missing.error,undefined)
      assert.equal(missing.result.contents[0].uri,uri)
      const status=JSON.parse(missing.result.contents[0].text)
      assert.match(status.note,/No resource at/)
      assert.match(status.note,/read or readMany tools with filePath/)
      assert.deepEqual(status.fileAccessTools,["read","readMany"])
    }
    for(const params of [undefined,null,{},[],{uri:null},{uri:7},{uri:""},{uri:"  "}]){
      const invalid=await request("resources/read",params)
      assert.equal(invalid.error.code,-32602)
    }
    const tools=await request("tools/list",{})
    assert.ok(tools.result.tools.some(tool=>tool.name==="read"))
    const file=await request("tools/call",{name:"read",arguments:{filePath:join(root,"fixture.txt")}})
    assert.notEqual(file.result.isError,true)
    assert.match(file.result.content[0].text,/1: file tool still works/)
    assert.deepEqual((await request("ping",{})).result,{})
    assert.equal((await request("unknown/method",{})).error.code,-32601)
  }finally{
    await new Promise(resolve=>{
      if(child.exitCode!==null||child.signalCode!==null)return resolve()
      const timer=setTimeout(()=>child.kill(),5000)
      child.once("close",()=>{clearTimeout(timer);resolve()})
      child.stdin.end()
    })
    await rm(root,{recursive:true,force:true})
  }
})
