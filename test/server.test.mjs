import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"
import { createRuntime, shellTail } from "../src/runtime.mjs"
import { compatibleConfig } from "../src/config.mjs"
import { parseSkillMarkdown } from "../src/frontmatter.mjs"
import { npmBinary } from "../src/npm-binary.mjs"
import { readFile } from "node:fs/promises"
import { apply as applyCodexConfig, status as codexStatus, unapply as unapplyCodexConfig } from "../src/codex-config.mjs"

test("applies Codex routing without replacing user configuration", async () => {
  const home=await mkdtemp(join(tmpdir(),"opencode-codex-home-")), previous=process.env.CODEX_HOME
  process.env.CODEX_HOME=home
  try {
    await writeFile(join(home,"config.toml"),'direct_only_tool_namespaces = ["mcp__fastctx"]\n\n[mcp_servers.fastctx]\ncommand = "fastctx"\n\n[mcp_servers.opencode_native_tools]\ncommand = "npx"\nargs = ["-y", "opencode-native-tools-mcp@latest"]\n\n[plugins.example]\nenabled = true\n')
    await writeFile(join(home,"AGENTS.md"),"Keep this user instruction.\n")
    await applyCodexConfig(); await applyCodexConfig()
    const config=await readFile(join(home,"config.toml"),"utf8"), agents=await readFile(join(home,"AGENTS.md"),"utf8"), result=await codexStatus()
    assert.match(config,/^direct_only_tool_namespaces = \["mcp__fastctx"\]/m)
    assert.match(config,/\[mcp_servers\.fastctx\]/)
    assert.match(config,/\[mcp_servers\.opencode_native_tools\]/)
    assert.match(config,/command = "npx"/)
    assert.match(config,/args = \["-y", "opencode-native-tools-mcp@latest"\]/)
    assert.equal((agents.match(/opencode-native-tools:start/g)||[]).length,1)
    assert.match(agents,/Codex native file-editing tools/)
    assert.match(agents,/not `resources\/read`/)
    assert.match(agents,/do not repeatedly probe them/)
    assert.match(agents,/Keep this user instruction/)
    assert.deepEqual({mcpConfigured:result.mcpConfigured,directOnly:result.directOnly,agentsConfigured:result.agentsConfigured},{mcpConfigured:true,directOnly:false,agentsConfigured:true})
    await unapplyCodexConfig()
    const after=await readFile(join(home,"config.toml"),"utf8"), afterAgents=await readFile(join(home,"AGENTS.md"),"utf8")
    assert.match(after,/direct_only_tool_namespaces = \["mcp__fastctx"\]/)
    assert.match(after,/\[mcp_servers\.opencode_native_tools\]/)
    assert.doesNotMatch(afterAgents,/opencode-native-tools:start/)
    assert.match(afterAgents,/Keep this user instruction/)
  } finally { if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous }
})

test("runs independently of the OpenCode CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-native-mcp-"))
  await writeFile(join(root, "fixture.txt"), "native tool result\n")
  const child = spawn(process.execPath, ["bin/opencode-native-tools.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, OPENCODE_TOOLS_ROOT: root, OPENCODE_BIN: "definitely-not-installed" },
  })
  let output = ""
  const complete = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Independent MCP timed out")), 5000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", data => {
      output += data
      if (output.includes('"id":3')) { clearTimeout(timer); resolve() }
    })
  })
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })
  send(2, "tools/list", {})
  send(3, "tools/call", { name: "read", arguments: { filePath: join(root, "fixture.txt"), limit: 1 } })
  await complete
  child.kill()
  assert.match(output, /opencode-native-tools/)
  assert.match(output, /"read"/)
  assert.match(output, /native tool result/)
  assert.doesNotMatch(output, /"task"/)
  assert.doesNotMatch(output, /definitely-not-installed/)
  const messages=output.split(/\r?\n/).filter(Boolean).map(JSON.parse), catalog=messages.find(message=>message.id===2).result.tools
  const readResult=messages.find(message=>message.id===3).result, read=catalog.find(tool=>tool.name==="read"), readMany=catalog.find(tool=>tool.name==="readMany"), grep=catalog.find(tool=>tool.name==="grep"), bash=catalog.find(tool=>tool.name==="bash")
  assert.deepEqual(read.inputSchema.properties.offset,{type:"integer",minimum:0,description:"The line number to start reading from (1-indexed)"})
  assert.deepEqual(read.inputSchema.properties.limit,{type:"integer",minimum:0,description:"The maximum number of lines to read (defaults to 2000)"})
  assert.equal(read.inputSchema.properties.responseFormat.default,"text")
  assert.equal(readMany.inputSchema.properties.files.maxItems,8)
  assert.equal(grep.inputSchema.properties.responseFormat.default,"text")
  assert.equal(grep.inputSchema.properties.outputMode.default,"content")
  assert.deepEqual(grep.inputSchema.properties.outputMode.enum,["content","files_with_matches","count"])
  assert.equal(grep.inputSchema.properties.limit.maximum,1000)
  assert.equal(grep.annotations.readOnlyHint,true)
  assert.equal(grep.annotations.destructiveHint,false)
  assert.equal(bash.annotations.readOnlyHint,false)
  assert.equal(bash.annotations.destructiveHint,true)
  assert.equal(bash.annotations.openWorldHint,true)
  assert.equal(catalog.find(tool=>tool.name==="write").annotations.openWorldHint,false)
  assert.equal(catalog.find(tool=>tool.name==="webfetch").annotations.openWorldHint,true)
  assert.deepEqual(bash.inputSchema.properties.timeout,{type:"integer",minimum:1,description:"Optional timeout in milliseconds"})
  assert.match(read.description,/2000 lines/)
  assert.match(catalog.find(tool=>tool.name==="apply_patch").description,/\*\*\* Begin Patch/)
  assert.doesNotMatch(catalog.find(tool=>tool.name==="glob").description,/Task tool/)
  assert.doesNotMatch(catalog.find(tool=>tool.name==="webfetch").description,/automatically upgraded/i)
  assert.match(readResult.content[0].text,/1: native tool result/)
  assert.equal(Object.hasOwn(readResult,"structuredContent"),false)
})

test("preserves BOM and CRLF while applying OpenCode-style edits and patches", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-runtime-"))
  const runtime = createRuntime(root)
  await writeFile(join(root, "note.txt"), "\ufefffirst\r\nold value\r\nlast\r\n")
  await runtime.edit({ filePath: "note.txt", oldString: "first\nold value\nlast", newString: "first\nnew value\nlast" })
  const edited = await readFile(join(root, "note.txt"), "utf8")
  assert.equal(edited, "\ufefffirst\r\nnew value\r\nlast\r\n")
  await runtime.applyPatch({ patchText: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: note.txt\n@@\n-first\n+changed\n new value\n last\n*** End Patch" })
  assert.equal(await readFile(join(root, "created.txt"), "utf8"), "created\n")
  assert.match(await readFile(join(root, "note.txt"), "utf8"), /changed/)
})

test("runs configured OpenCode formatter commands after an edit without surfacing formatter failures", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-formatter-"))
  await writeFile(join(root,"opencode.json"),JSON.stringify({formatter:{fixture:{command:[process.execPath,"-e","require('node:fs').appendFileSync(process.argv[1], '!')","$FILE"],extensions:[".txt"]}}}))
  await writeFile(join(root,"fixture.txt"),"old\n")
  const result=await createRuntime(root).edit({filePath:"fixture.txt",oldString:"old",newString:"new"})
  assert.equal(await readFile(join(root,"fixture.txt"),"utf8"),"new\n!")
  assert.match(result.metadata.diff,/new/)
  assert.match(result.metadata.diff,/!/) 
  await writeFile(join(root,"second.txt"),"before\n")
  await createRuntime(root).applyPatch({patchText:"*** Begin Patch\n*** Update File: second.txt\n@@\n-before\n+after\n*** End Patch"})
  assert.equal(await readFile(join(root,"second.txt"),"utf8"),"after\n!")
  const created=await createRuntime(root).edit({filePath:"created.txt",oldString:"",newString:"created\n"})
  assert.equal(await readFile(join(root,"created.txt"),"utf8"),"created\n!")
  assert.equal(created.output,"Edit applied successfully.")
  assert.match(created.metadata.diff,/created/)
  await createRuntime(root).write({filePath:"written.txt",content:"written\n"})
  assert.equal(await readFile(join(root,"written.txt"),"utf8"),"written\n!")
})

test("keeps OpenCode formatters disabled when formatter is absent", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-formatter-default-"))
  assert.equal((await compatibleConfig(root)).formatter,false)
})

test("resolves formatter binaries from the independent OpenCode-style npm cache", async () => {
  const cache=await mkdtemp(join(tmpdir(),"opencode-npm-cache-")), bin=join(cache,"packages","prettier","node_modules",".bin",process.platform==="win32"?"prettier.cmd":"prettier")
  await mkdir(dirname(bin),{recursive:true});await writeFile(bin,"")
  const previous=process.env.OPENCODE_TOOLS_NPM_CACHE_DIR;process.env.OPENCODE_TOOLS_NPM_CACHE_DIR=cache
  try { assert.equal(await npmBinary("prettier","prettier"),bin) } finally { if(previous===undefined)delete process.env.OPENCODE_TOOLS_NPM_CACHE_DIR;else process.env.OPENCODE_TOOLS_NPM_CACHE_DIR=previous }
})

test("returns compact read pagination with optional structured metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-read-"))
  const runtime = createRuntime(root)
  await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\n")
  const page = await runtime.read({ filePath: "lines.txt", offset: 2, limit: 1 })
  assert.equal(page.title,"lines.txt")
  assert.match(page.output, /^2: two/m)
  assert.match(page.output, /\[truncated startLine=2 endLine=2 totalLines=3 nextOffset=3 reason=limit\]/)
  assert.equal(page.structuredContent,null)
  const detailed=await runtime.read({filePath:"lines.txt",offset:2,limit:1,responseFormat:"detailed"})
  assert.deepEqual(detailed.structuredContent,{path:join(root,"lines.txt"),type:"file",startLine:2,endLine:2,totalLines:3,nextOffset:3,truncated:true,reason:"limit"})
  await assert.rejects(() => runtime.read({ filePath: "lines.txt", offset: 5 }), /Offset 5 is out of range for this file \(3 lines\)/)
  await writeFile(join(root, "payload.txt"), Buffer.from([0, 1, 2]))
  await assert.rejects(() => runtime.read({ filePath: "payload.txt" }), /Cannot read binary file/)
  await writeFile(join(root, "not-an-extension"), Buffer.from([137,80,78,71,13,10,26,10]))
  const image = await runtime.read({ filePath: "not-an-extension" })
  assert.equal(image.attachment.mimeType, "image/png")
  await writeFile(join(root, "bitmap-without-extension"), Buffer.from([0x42,0x4d,0,0,0,0]))
  await assert.rejects(() => runtime.read({ filePath: "bitmap-without-extension" }), /Cannot read binary file/)
})

test("uses OpenCode MIME fallback for known attachment extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-read-mime-")), runtime=createRuntime(root)
  await writeFile(join(root, "extension-only.png"), "fixture bytes without a PNG signature")
  const result=await runtime.read({ filePath: "extension-only.png" })
  assert.equal(result.attachment.mimeType, "image/png")
  assert.equal(result.output, "Image read successfully")
})

test("streams normal read files while retaining pagination and unterminated final lines", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-read-stream-")), runtime=createRuntime(root)
  await writeFile(join(root,"large.txt"),`${"first\n"}${"middle\n".repeat(30_000)}final-without-newline`)
  const first=await runtime.read({filePath:"large.txt",limit:1})
  assert.match(first.output,/1: first/)
  assert.match(first.output,/totalLines=30002 nextOffset=2 reason=limit/)
  const final=await runtime.read({filePath:"large.txt",offset:30002,limit:1})
  assert.match(final.output,/30002: final-without-newline/)
  assert.doesNotMatch(final.output,/truncated/)
  assert.equal(final.metadata.totalLines,30002)
})

test("reads multiple files with isolated errors and detailed summaries", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-read-many-")), runtime=createRuntime(root)
  await writeFile(join(root,"one.txt"),"one\n")
  await writeFile(join(root,"two.txt"),"two\nthree\n")
  const result=await runtime.readMany({files:[{filePath:"one.txt"},{filePath:"missing.txt"},{filePath:"two.txt",limit:1}],responseFormat:"detailed"})
  assert.match(result.output,/== one\.txt ==\n1: one/)
  assert.match(result.output,/== missing\.txt ==\n\[error: File not found/)
  assert.match(result.output,/== two\.txt ==\n1: two/)
  assert.equal(result.structuredContent.files.length,3)
  assert.equal(result.structuredContent.files[1].status,"error")
  assert.equal(result.structuredContent.files[2].nextOffset,2)
})

test("propagates MCP abort signals to stream-backed reads", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-read-abort-")), runtime=createRuntime(root)
  await writeFile(join(root,"fixture.txt"),"content\n")
  await assert.rejects(()=>runtime.read({filePath:"fixture.txt"},undefined,AbortSignal.abort()),/read aborted/)
})

test("fails explicitly for malformed compatible OpenCode configuration", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-invalid-"))
  await writeFile(join(root,"opencode.jsonc"),"{ invalid")
  await assert.rejects(()=>createRuntime(root).read({filePath:"anything.txt"}),/Failed to parse OpenCode configuration/)
})

test("uses OpenCode deep-merge semantics for tool configuration fields", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-merge-")), explicit=join(root,"explicit.json")
  const previous={config:process.env.OPENCODE_CONFIG,content:process.env.OPENCODE_CONFIG_CONTENT}
  await writeFile(explicit,JSON.stringify({skills:{paths:["explicit-path"],urls:["https://explicit.invalid"]},tool_output:{max_lines:101,max_bytes:1024}}))
  await writeFile(join(root,"opencode.json"),JSON.stringify({skills:{paths:["project-path"]},tool_output:{max_bytes:2048}}))
  process.env.OPENCODE_CONFIG=explicit
  process.env.OPENCODE_CONFIG_CONTENT=JSON.stringify({skills:{urls:["https://inline.invalid"]}})
  try {
    const config=await compatibleConfig(root)
    assert.deepEqual(config.skills.paths,[join(root,"project-path")])
    assert.deepEqual(config.skills.urls,["https://inline.invalid"])
    assert.deepEqual(config.toolOutput,{maxLines:101,maxBytes:2048})
  } finally {
    if(previous.config===undefined)delete process.env.OPENCODE_CONFIG;else process.env.OPENCODE_CONFIG=previous.config
    if(previous.content===undefined)delete process.env.OPENCODE_CONFIG_CONTENT;else process.env.OPENCODE_CONFIG_CONTENT=previous.content
  }
})

test("rejects non-positive OpenCode tool output limits", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-limits-"))
  await writeFile(join(root,"opencode.json"),JSON.stringify({tool_output:{max_bytes:0}}))
  await assert.rejects(()=>createRuntime(root).read({filePath:"anything.txt"}),/tool_output.max_bytes must be a positive integer/)
})

test("expands OpenCode {file:path} configuration tokens relative to their config file", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-file-token-")), configDir=join(root,"config"), skills=join(root,"external-skills")
  await mkdir(configDir,{recursive:true});await mkdir(join(skills,"from-file"),{recursive:true})
  await writeFile(join(skills,"from-file","SKILL.md"),"---\nname: file-token-skill\n---\nLoaded through a file token.\n")
  await writeFile(join(configDir,"skill-path.txt"),"../external-skills\n")
  await writeFile(join(configDir,"opencode.json"),JSON.stringify({skills:{paths:["{file:skill-path.txt}"]}}))
  const previous=process.env.OPENCODE_CONFIG
  process.env.OPENCODE_CONFIG=join(configDir,"opencode.json")
  try { assert.match((await createRuntime(root).skill({name:"file-token-skill"})).output,/Loaded through a file token/) }
  finally { if(previous===undefined)delete process.env.OPENCODE_CONFIG;else process.env.OPENCODE_CONFIG=previous }
})

test("reports missing OpenCode {file:path} configuration tokens", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-missing-file-token-"))
  await writeFile(join(root,"opencode.json"),JSON.stringify({shell:"{file:missing-shell.txt}"}))
  await assert.rejects(()=>createRuntime(root).read({filePath:"anything.txt"}),/bad file reference.*missing-shell\.txt.*does not exist/)
})

test("uses compact grep results and persists truncated shell output", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-search-"))
  const shell=process.platform==="win32"?"cmd.exe":process.env.SHELL||"/bin/sh"
  const command=process.platform==="win32"?"for /L %i in (1,1,30000) do @echo x":"yes x | head -n 30000"
  await writeFile(join(root,"opencode.json"),JSON.stringify({shell}))
  const runtime = createRuntime(root)
  await mkdir(join(root, "src"))
  await mkdir(join(root, ".git"))
  await writeFile(join(root, ".gitignore"), "ignored.txt\n")
  await writeFile(join(root, "src", "one.js"), "const needle = 1;\n")
  await writeFile(join(root, "ignored.txt"), "needle\n")
  const found = await runtime.glob({ pattern: "**/*.js" })
  assert.match(found.output, /src[\\/]one\.js/)
  assert.equal(found.metadata.count, 1)
  const matches = await runtime.grep({ pattern: "needle" })
  assert.match(matches.output, /one\.js:1:const needle = 1;/)
  assert.equal(matches.structuredContent,null)
  const result = await runtime.bash({ command })
  assert.equal(result.metadata.truncated, true)
  assert.match(result.output, /Full output saved to:/)
  assert.ok(result.metadata.outputPath)
})

test("uses the configured shell output byte limit when deciding truncation", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-shell-limit-"))
  const shell=process.platform==="win32"?"cmd.exe":process.env.SHELL||"/bin/sh"
  await writeFile(join(root,"opencode.json"),JSON.stringify({shell,tool_output:{max_lines:100000,max_bytes:100000}}))
  const command=process.platform==="win32"?"for /L %i in (1,1,20000) do @echo x":"yes x | head -n 20000"
  const result=await createRuntime(root).bash({command,timeout:10000})
  assert.equal(result.metadata.truncated,false)
  assert.doesNotMatch(result.output,/Full output saved to:/)
})

test("glob includes hidden files while continuing to exclude .git", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-glob-hidden-")), runtime=createRuntime(root)
  await mkdir(join(root,".hidden"),{recursive:true});await mkdir(join(root,".git"),{recursive:true})
  await writeFile(join(root,".hidden","visible-to-glob.txt"),"ok\n");await writeFile(join(root,".git","excluded.txt"),"no\n")
  const found=await runtime.glob({pattern:"**/*.txt"})
  assert.match(found.output,/\.hidden[\\/]visible-to-glob\.txt/)
  assert.doesNotMatch(found.output,/\.git[\\/]excluded\.txt/)
})

test("reports external glob and grep targets in MCP audit metadata", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-audit-root-")), outside=await mkdtemp(join(tmpdir(),"opencode-audit-outside-")), runtime=createRuntime(root)
  await writeFile(join(outside,"fixture.txt"),"needle\n")
  assert.deepEqual((await runtime.glob({pattern:"*.txt",path:outside})).metadata.externalPaths,[outside])
  assert.deepEqual((await runtime.grep({pattern:"needle",path:outside})).metadata.externalPaths,[outside])
  assert.deepEqual((await runtime.grep({pattern:"absent",path:outside})).metadata.externalPaths,[outside])
  assert.deepEqual((await runtime.bash({command:"echo audit",workdir:outside})).metadata.externalPaths,[outside])
})

test("validates and persists a connection todo list", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-todo-"))
  const runtime = createRuntime(root)
  const saved = await runtime.todo({ todos: [{ content: "finish port", status: "in_progress", priority: "high" }] }, "fixture-session")
  assert.equal(JSON.parse(await readFile(join(root,".opencode-tools","todos","fixture-session.json"), "utf8"))[0].content, "finish port")
  assert.deepEqual(saved.metadata.todos, [{ content: "finish port", status: "in_progress", priority: "high" }])
  assert.equal("state" in saved.metadata,false)
  const custom=await runtime.todo({todos:[{content:"custom schema value",status:"waiting",priority:"urgent"}]},"fixture-session")
  assert.deepEqual(custom.metadata.todos,[{content:"custom schema value",status:"waiting",priority:"urgent"}])
  await assert.rejects(() => runtime.todo({ todos: [{ content: "missing priority", status: "pending" }] }, "fixture-session"), /content, status, and priority strings/)
})

test("encodes todo session identifiers before persisting state", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-todo-session-path-")), runtime=createRuntime(root)
  await runtime.todo({todos:[{content:"safe",status:"pending",priority:"low"}]},"../../outside")
  assert.equal(JSON.parse(await readFile(join(root,".opencode-tools","todos","..%2F..%2Foutside.json"),"utf8"))[0].content,"safe")
})

test("uses OpenCode edit fallback matching and reports external path metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-edit-"))
  const runtime = createRuntime(root)
  await writeFile(join(root, "edit.txt"), "function demo() {\n  return 42;\n}\n")
  await runtime.edit({ filePath: "edit.txt", oldString: "function demo() {\nreturn 42;\n}", newString: "function demo() {\n  return 43;\n}" })
  assert.match(await readFile(join(root, "edit.txt"), "utf8"), /return 43/)
  const outside = join(tmpdir(), `opencode-audit-${Date.now()}.txt`)
  await writeFile(outside, "audited\n")
  const read = await runtime.read({ filePath: outside })
  assert.deepEqual(read.metadata.externalPaths, [outside])
})

test("uses OpenCode edit errors for missing files and directory targets", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-edit-errors-")), runtime=createRuntime(root)
  await mkdir(join(root,"folder"))
  await assert.rejects(()=>runtime.edit({filePath:"missing.txt",oldString:"old",newString:"new"}),/File .*missing\.txt not found/)
  await assert.rejects(()=>runtime.edit({filePath:"folder",oldString:"old",newString:"new"}),/Path is a directory, not a file: .*folder/)
})

test("does not mutate earlier patch targets when a later hunk cannot be computed", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-patch-tx-"))
  const runtime = createRuntime(root)
  await writeFile(join(root, "first.txt"), "before\n")
  await writeFile(join(root, "second.txt"), "unchanged\n")
  await assert.rejects(() => runtime.applyPatch({ patchText: "*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+after\n*** Update File: second.txt\n@@\n-missing\n+changed\n*** End Patch" }), /Failed to find expected lines/)
  assert.equal(await readFile(join(root, "first.txt"), "utf8"), "before\n")
  assert.equal(await readFile(join(root, "second.txt"), "utf8"), "unchanged\n")
})

test("applies OpenCode Add File trailing-newline and BOM semantics and permits an existing target", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-patch-add-")), runtime=createRuntime(root)
  await writeFile(join(root,"added.txt"),"old\n")
  await runtime.applyPatch({patchText:"*** Begin Patch\n*** Add File: added.txt\n+replacement\n*** End Patch"})
  assert.equal(await readFile(join(root,"added.txt"),"utf8"),"replacement\n")
  await runtime.applyPatch({patchText:"*** Begin Patch\n*** Add File: bom.txt\n+\ufeffbom content\n*** End Patch"})
  assert.equal(await readFile(join(root,"bom.txt"),"utf8"),"\ufeffbom content\n")
})

test("ignores empty OpenCode patch headers instead of resolving them to the workspace root", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-patch-empty-path-")), runtime=createRuntime(root)
  await assert.rejects(()=>runtime.applyPatch({patchText:"*** Begin Patch\n*** Add File:\n+ignored\n*** End Patch"}),/no hunks found/)
  await assert.rejects(()=>runtime.applyPatch({patchText:"*** Begin Patch\n*** Delete File:\n*** End Patch"}),/no hunks found/)
})

test("treats an empty OpenCode Move to directive as an in-place update", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-patch-empty-move-")), runtime=createRuntime(root)
  await writeFile(join(root,"note.txt"),"before\n")
  await runtime.applyPatch({patchText:"*** Begin Patch\n*** Update File: note.txt\n*** Move to:\n@@\n-before\n+after\n*** End Patch"})
  assert.equal(await readFile(join(root,"note.txt"),"utf8"),"after\n")
})

test("uses OpenCode empty-file semantics when an update removes all content", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-patch-empty-content-")), runtime=createRuntime(root)
  await writeFile(join(root,"only.txt"),"only line\n")
  await runtime.applyPatch({patchText:"*** Begin Patch\n*** Update File: only.txt\n@@\n-only line\n*** End Patch"})
  assert.equal(await readFile(join(root,"only.txt"),"utf8"),"")
})

test("cancels an in-flight bash call through the standard MCP notification", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-cancel-"))
  const child = spawn(process.execPath, ["bin/opencode-native-tools.mjs"], { cwd: process.cwd(), env: { ...process.env, OPENCODE_TOOLS_ROOT: root } })
  let output = ""
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cancelled shell did not return")), 5000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", data => { output += data; if (output.includes('"id":41')) { clearTimeout(timer); resolve() } })
  })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "bash", arguments: { command: "ping -n 8 127.0.0.1 > nul" } } }) + "\n")
  setTimeout(() => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41, reason: "test" } }) + "\n"), 150)
  await done
  child.kill()
  assert.match(output, /User aborted the command/)
})

test("uses OpenCode-compatible Exa and Parallel MCP request shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-search-wire-"))
  const runtime = createRuntime(root), originalFetch = globalThis.fetch, calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: JSON.parse(init.body) }); return new Response(JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text: "fixture result" }] } }), { headers: { "content-type": "application/json" } }) }
  const previous = process.env.OPENCODE_WEBSEARCH_PROVIDER, previousExa = process.env.EXA_API_KEY
  try {
    process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa";process.env.EXA_API_KEY = "fixture key/with symbols"
    assert.equal((await runtime.websearch({ query: "exa fixture" }, "session-a")).metadata.provider, "exa")
    process.env.OPENCODE_WEBSEARCH_PROVIDER = "parallel"; process.env.OPENCODE_TOOLS_MODEL_NAME = "fixture-model"
    assert.equal((await runtime.websearch({ query: "parallel fixture" }, "session-b")).metadata.provider, "parallel")
    assert.equal(calls[0].init.params.name, "web_search_exa")
    assert.equal(calls[0].url, "https://mcp.exa.ai/mcp?exaApiKey=fixture%20key%2Fwith%20symbols")
    assert.equal(calls[1].init.params.name, "web_search")
    assert.equal(calls[1].init.params.arguments.session_id, "session-b")
    assert.equal(calls[1].init.params.arguments.model_name, "fixture-model")
  } finally { globalThis.fetch = originalFetch; if (previous === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER; else process.env.OPENCODE_WEBSEARCH_PROVIDER = previous; delete process.env.OPENCODE_TOOLS_MODEL_NAME;if(previousExa===undefined)delete process.env.EXA_API_KEY;else process.env.EXA_API_KEY=previousExa }
})

test("retries Cloudflare challenges with OpenCode's honest user agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-fetch-wire-")), runtime = createRuntime(root), originalFetch = globalThis.fetch, calls = []
  globalThis.fetch = async (url, init) => { calls.push({url:String(url),headers:init.headers}); return calls.length === 1 ? new Response("blocked", { status: 403, headers: { "cf-mitigated": "challenge" } }) : new Response("ok", { headers: { "content-type": "text/plain" } }) }
  try {
    assert.equal((await runtime.webfetch({ url: "http://fixture.invalid", format: "markdown" })).output, "ok")
    assert.match(calls[0].headers.accept, /text\/markdown/)
    assert.equal(calls[0].url, "http://fixture.invalid")
    assert.equal(calls[1].headers["user-agent"], "opencode")
  } finally { globalThis.fetch = originalFetch }
})

test("does not turn SVG webfetch responses into image attachments", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-fetch-svg-")), runtime=createRuntime(root), originalFetch=globalThis.fetch
  globalThis.fetch=async()=>new Response("<svg><text>fixture</text></svg>",{headers:{"content-type":"image/svg+xml"}})
  try { const result=await runtime.webfetch({url:"https://fixture.invalid",format:"html"});assert.equal(result.attachment,undefined);assert.match(result.output,/<svg>/) }
  finally { globalThis.fetch=originalFetch }
})

test("discovers frontmatter skills from compatible project configuration paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-skill-config-")), external = await mkdtemp(join(tmpdir(), "opencode-skill-path-"))
  await mkdir(join(external, "skills", "fixture-skill"), { recursive: true })
  await writeFile(join(external, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: fixture\n---\nUse the fixture skill.\n")
  await writeFile(join(root, "opencode.json"), JSON.stringify({ skills: { paths: [external] } }))
  const loaded = await createRuntime(root).skill({ name: "fixture-skill" })
  assert.match(loaded.output, /# Skill: fixture-skill/)
  assert.match(loaded.output, /Use the fixture skill/)
})

test("parses the OpenCode skill frontmatter forms used by ConfigMarkdown", () => {
  assert.deepEqual(parseSkillMarkdown("---\nname: 'quoted-skill'\ndescription: |\n  A multiline\n  description.\n---\nBody\n"),{name:"quoted-skill",description:"A multiline\ndescription.\n",content:"Body\n"})
  assert.equal(parseSkillMarkdown("---\nname: skill:with-colon\n---\nBody\n").name,"skill:with-colon")
  assert.equal(parseSkillMarkdown("---\nname: 42\n---\nBody\n"),undefined)
  assert.equal(parseSkillMarkdown("---\nname: valid\ndescription: false\n---\nBody\n"),undefined)
})

test("scans configured skill paths with OpenCode's recursive skill pattern", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-skill-path-root-")), external = await mkdtemp(join(tmpdir(), "opencode-skill-path-root-external-"))
  await mkdir(join(external, "custom"), { recursive: true })
  await writeFile(join(external, "custom", "SKILL.md"), "---\nname: recursive-path-skill\n---\nFound recursively.\n")
  await writeFile(join(root, "opencode.json"), JSON.stringify({ skills: { paths: [external] } }))
  assert.match((await createRuntime(root).skill({ name: "recursive-path-skill" })).output, /Found recursively/)
})

test("discovers compatible .agents skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-agent-skill-"))
  await mkdir(join(root, ".agents", "skills", "agent-fixture"), { recursive: true })
  await writeFile(join(root, ".agents", "skills", "agent-fixture", "SKILL.md"), "---\nname: agent-fixture\n---\nAgent skill body.\n")
  assert.match((await createRuntime(root).skill({ name: "agent-fixture" })).output, /Agent skill body/)
})

test("discovers project external skills from a nested directory up to its worktree", async () => {
  const worktree=await mkdtemp(join(tmpdir(), "opencode-skill-upward-")), root=join(worktree,"packages","fixture")
  await mkdir(join(worktree,".git"),{recursive:true})
  await mkdir(join(worktree,".agents","skills","parent-skill"),{recursive:true})
  await mkdir(root,{recursive:true})
  await writeFile(join(worktree,".agents","skills","parent-skill","SKILL.md"),"---\nname: parent-agent-skill\n---\nFound from parent project directory.\n")
  assert.match((await createRuntime(root).skill({name:"parent-agent-skill"})).output,/Found from parent project directory/)
})

test("uses OpenCode skill discovery roots instead of implicit workspace skill folders", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-skill-roots-")), runtime=createRuntime(root)
  await mkdir(join(root,"skills","implicit"),{recursive:true})
  await writeFile(join(root,"skills","implicit","SKILL.md"),"---\nname: implicit-workspace-skill\n---\nShould not be discovered.\n")
  await mkdir(join(root,".agents","skill","singular"),{recursive:true})
  await writeFile(join(root,".agents","skill","singular","SKILL.md"),"---\nname: singular-external-skill\n---\nShould not be discovered.\n")
  await assert.rejects(()=>runtime.skill({name:"implicit-workspace-skill"}),/Skill "implicit-workspace-skill" not found/)
  await assert.rejects(()=>runtime.skill({name:"singular-external-skill"}),/Skill "singular-external-skill" not found/)
})

test("loads the built-in customize-opencode skill unless disk overrides it", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-built-in-skill-")), runtime=createRuntime(root)
  const builtin=await runtime.skill({name:"customize-opencode"})
  assert.match(builtin.output,/Customizing opencode/)
  assert.match(builtin.output,/Base directory for this skill: \./)
  assert.equal(builtin.metadata.dir,".")
  await mkdir(join(root,".opencode","skills","customize-opencode"),{recursive:true})
  await writeFile(join(root,".opencode","skills","customize-opencode","SKILL.md"),"---\nname: customize-opencode\n---\nDisk override.\n")
  assert.match((await runtime.skill({name:"customize-opencode"})).output,/Disk override/)
})

test("caches and loads URL skills independently of OpenCode", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-skill-url-")), originalFetch = globalThis.fetch
  await writeFile(join(root, "opencode.json"), JSON.stringify({ skills: { urls: ["https://fixture.invalid/SKILL.md"] } }))
  globalThis.fetch = async () => new Response("---\nname: remote-fixture\n---\nRemote skill body.\n", { headers: { "content-type": "text/plain" } })
  try {
    const loaded = await createRuntime(root).skill({ name: "remote-fixture" })
    assert.match(loaded.output, /Remote skill body/)
    assert.match(loaded.metadata.dir, /skills-cache/)
  } finally { globalThis.fetch = originalFetch }
})

test("loads OpenCode URL skill indexes and their sampled files", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-skill-index-")), originalFetch = globalThis.fetch, calls=[]
  await writeFile(join(root, "opencode.json"), JSON.stringify({ skills: { urls: ["https://fixture.invalid/catalog"] } }))
  globalThis.fetch = async url => { const value=String(url);calls.push(value);if(value.endsWith("/index.json"))return new Response(JSON.stringify({skills:[{name:"indexed-skill",files:["SKILL.md","references/info.txt"],version:"1"}]}));if(value.endsWith("/indexed-skill/SKILL.md"))return new Response("---\nname: indexed-skill\n---\nIndexed skill body.\n");return new Response("Reference file.") }
  try {
    const loaded=await createRuntime(root).skill({name:"indexed-skill"})
    assert.match(loaded.output,/Indexed skill body/)
    assert.match(loaded.output,/references[\\/]info.txt/)
    assert.ok(calls.some(url=>url.endsWith("/catalog/index.json")))
  } finally { globalThis.fetch=originalFetch }
})

test("accepts the OpenCode URL index alternate {name}.md skill entry", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-skill-index-alternate-")), originalFetch=globalThis.fetch
  await writeFile(join(root,"opencode.json"),JSON.stringify({skills:{urls:["https://fixture.invalid/catalog"]}}))
  globalThis.fetch=async url=>{
    const value=String(url)
    if(value.endsWith("/index.json"))return new Response(JSON.stringify({skills:[{name:"alternate-skill",files:["alternate-skill.md"],version:"1"}]}))
    return new Response("---\nname: alternate-skill\n---\nAlternate entry body.\n")
  }
  try { assert.match((await createRuntime(root).skill({name:"alternate-skill"})).output,/Alternate entry body/) }
  finally { globalThis.fetch=originalFetch }
})

test("rejects unsafe and cross-origin files in OpenCode skill indexes", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-skill-unsafe-index-")), originalFetch=globalThis.fetch, calls=[]
  await writeFile(join(root,"opencode.json"),JSON.stringify({skills:{urls:["https://fixture.invalid/catalog"]}}))
  globalThis.fetch=async url=>{calls.push(String(url));return new Response(JSON.stringify({skills:[{name:"unsafe",files:["SKILL.md","%2e%2e/escape.txt"]},{name:"cross-origin",files:["SKILL.md","https://other.invalid/escape.txt"]}]}))}
  try { await assert.rejects(()=>createRuntime(root).skill({name:"unsafe"}),/Available skills: customize-opencode/);assert.equal(calls.length,1) }
  finally { globalThis.fetch=originalFetch }
})

test("refreshes versioned URL skills atomically and keeps a complete prior cache on failure", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-skill-refresh-")), originalFetch=globalThis.fetch
  await writeFile(join(root,"opencode.json"),JSON.stringify({skills:{urls:["https://fixture.invalid/catalog"]}}))
  let version="1", fail=false
  globalThis.fetch=async url=>{
    const value=String(url)
    if(value.endsWith("/index.json"))return new Response(JSON.stringify({skills:[{name:"versioned-skill",files:["SKILL.md","references/info.txt"],version}]}))
    if(fail&&value.endsWith("references/info.txt"))return new Response("failed",{status:500})
    if(value.endsWith("SKILL.md"))return new Response(`---\nname: versioned-skill\n---\nVersion ${version}.\n`)
    return new Response(`Reference ${version}.`)
  }
  try {
    assert.match((await createRuntime(root).skill({name:"versioned-skill"})).output,/Version 1/)
    version="2"
    assert.match((await createRuntime(root).skill({name:"versioned-skill"})).output,/Version 2/)
    fail=true;version="3"
    assert.match((await createRuntime(root).skill({name:"versioned-skill"})).output,/Version 2/)
    assert.equal(await readFile(join(root,".opencode-tools","skills-cache","versioned-skill",".opencode-version"),"utf8"),"2")
  } finally { globalThis.fetch=originalFetch }
})

test("caps glob results at 100 and rejects oversized grep JSON records", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-rg-limits-")), runtime = createRuntime(root)
  await mkdir(join(root, ".git"))
  for (let index = 0; index < 101; index++) await writeFile(join(root, `file-${index}.txt`), "small\n")
  const files = await runtime.glob({ pattern: "*.txt" })
  assert.equal(files.metadata.count, 100)
  assert.equal(files.metadata.truncated, true)
  await writeFile(join(root, "large.txt"), "x".repeat(70 * 1024))
  await assert.rejects(() => runtime.grep({ pattern: "x", include: "large.txt" }), /Ripgrep JSON record exceeded 65536 bytes/)
})

test("returns OpenCode-style ripgrep errors for an invalid grep regex", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-rg-regex-")), runtime=createRuntime(root)
  await writeFile(join(root,"fixture.txt"),"needle\n")
  await assert.rejects(()=>runtime.grep({pattern:"["}),/regex parse error|error parsing regex/)
})

test("rejects an empty grep pattern with OpenCode's tool-level error", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-grep-empty-"))
  const child=spawn(process.execPath,["bin/opencode-native-tools.mjs"],{cwd:process.cwd(),env:{...process.env,OPENCODE_TOOLS_ROOT:root}})
  let output="";child.stdout.setEncoding("utf8")
  const complete=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("empty grep MCP response timed out")),2000);child.stdout.on("data",data=>{output+=data;if(output.includes('"id":71')){clearTimeout(timer);resolve()}})})
  child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:71,method:"tools/call",params:{name:"grep",arguments:{pattern:""}}})+"\n")
  await complete;child.kill()
  assert.match(output,/pattern is required/)
})

test("grep uses a missing file path's parent directory like OpenCode", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-grep-missing-file-")), runtime=createRuntime(root)
  await writeFile(join(root,"present.txt"),"needle\n")
  const found=await runtime.grep({pattern:"needle",path:"missing.txt"})
  assert.match(found.output,/present\.txt/)
})

test("propagates MCP abort signals to ripgrep-backed tools", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-ripgrep-abort-")), runtime=createRuntime(root)
  await writeFile(join(root,"fixture.txt"),"needle\n")
  await assert.rejects(()=>runtime.grep({pattern:"needle"},undefined,AbortSignal.abort()),/ripgrep execution aborted/)
})

test("terminates a timed out shell command and preserves timeout metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-shell-timeout-")), runtime = createRuntime(root)
  const result = await runtime.bash({ command: "ping -n 8 127.0.0.1 > nul", timeout: 100 })
  assert.match(result.output, /shell tool terminated command after exceeding timeout 100 ms/)
  assert.equal(result.metadata.exit, null)
  await assert.rejects(() => runtime.bash({ command: "echo never", timeout: -1 }), /Invalid timeout value: -1/)
  await assert.rejects(() => runtime.bash({ command: "echo never", timeout: 0 }), /positive integer/)
  await assert.rejects(() => runtime.bash({ command: "echo never", timeout: 1.5 }), /positive integer/)
})

test("uses OpenCode's positive experimental bash default timeout flag", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-shell-flag-timeout-")), previous=process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
  process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS="100"
  try {
    const result=await createRuntime(root).bash({command:process.platform==="win32"?"ping -n 8 127.0.0.1 > nul":"sleep 8"})
    assert.match(result.output,/exceeding timeout 100 ms/)
    assert.equal(result.metadata.exit,null)
  } finally { if(previous===undefined)delete process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS;else process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=previous }
})

test("uses OpenCode tool_output limits for bash tail truncation", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-shell-limits-"))
  const shell=process.platform==="win32"?"cmd.exe":process.env.SHELL||"/bin/sh"
  const command=process.platform==="win32"?"echo one & echo two & <nul set /p =three":"printf 'one\\ntwo\\nthree'"
  await writeFile(join(root,"opencode.json"),JSON.stringify({shell,tool_output:{max_lines:2,max_bytes:1024}}))
  const result=await createRuntime(root).bash({command})
  assert.match(result.output,/three/)
  assert.doesNotMatch(result.output,/one/)
  assert.equal(result.metadata.truncated,true)
})

test("keeps a complete UTF-8 character for a single oversized shell output line", () => {
  const result=shellTail("你".repeat(20),10,5)
  assert.equal(result.cut,true)
  assert.equal(result.text,"你")
  assert.doesNotMatch(result.text,/�/)
})

test("falls back from an unavailable configured shell", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-shell-fallback-"))
  await writeFile(join(root,"opencode.json"),JSON.stringify({shell:"definitely-not-a-shell.exe"}))
  const command=process.platform==="win32"?"Write-Output shell-fallback":"echo shell-fallback"
  const result=await createRuntime(root).bash({command})
  assert.match(result.output,/shell-fallback/)
})

test("rejects OpenCode-denied fish and nu shells before execution", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-shell-denied-"))
  await writeFile(join(root,"opencode.json"),JSON.stringify({shell:"fish"}))
  const result=await createRuntime(root).bash({command:process.platform==="win32"?"echo shell-fallback":"echo shell-fallback"})
  assert.match(result.output,/shell-fallback/)
})

test("honors OPENCODE_GIT_BASH_PATH in Windows default shell selection", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-git-bash-shell-")), previous={shell:process.env.SHELL,gitBash:process.env.OPENCODE_GIT_BASH_PATH}
  // Force the source priority to reach the explicit Git Bash entry without requiring a Git install.
  delete process.env.SHELL;process.env.OPENCODE_GIT_BASH_PATH=process.env.ComSpec
  try { const result=await createRuntime(root).bash({command:"echo git-bash-override"});assert.match(result.output,/git-bash-override/) }
  finally { if(previous.shell===undefined)delete process.env.SHELL;else process.env.SHELL=previous.shell;if(previous.gitBash===undefined)delete process.env.OPENCODE_GIT_BASH_PATH;else process.env.OPENCODE_GIT_BASH_PATH=previous.gitBash }
})

test("terminates active shell process trees when the MCP runtime is disposed", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-shell-dispose-")), runtime=createRuntime(root)
  const running=runtime.bash({command:"ping -n 8 127.0.0.1 > nul"})
  await new Promise(resolve=>setTimeout(resolve,100))
  await runtime.dispose()
  const result=await running
  assert.match(result.output,/User aborted the command/)
  assert.equal(result.metadata.exit,null)
})

test("honors OpenCode external skill disable flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-skill-disable-")), previous = process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS
  await mkdir(join(root, ".claude", "skills", "hidden-skill"), { recursive: true })
  await writeFile(join(root, ".claude", "skills", "hidden-skill", "SKILL.md"), "---\nname: hidden-skill\n---\nHidden.\n")
  await mkdir(join(root, ".agents", "skills", "hidden-agent-skill"), { recursive: true })
  await writeFile(join(root, ".agents", "skills", "hidden-agent-skill", "SKILL.md"), "---\nname: hidden-agent-skill\n---\nHidden.\n")
  process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true"
  try { const runtime=createRuntime(root);await assert.rejects(() => runtime.skill({ name: "hidden-skill" }), /Available skills: customize-opencode/);await assert.rejects(() => runtime.skill({ name: "hidden-agent-skill" }), /Available skills: customize-opencode/) }
  finally { if (previous === undefined) delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS; else process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = previous }
})

test("expands environment variables in compatible skill path configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-config-env-")), external = await mkdtemp(join(tmpdir(), "opencode-config-env-path-")), previous = process.env.OPENCODE_TEST_SKILL_PATH
  await mkdir(join(external, "skills", "env-skill"), { recursive: true })
  await writeFile(join(external, "skills", "env-skill", "SKILL.md"), "---\nname: env-skill\n---\nEnvironment expanded.\n")
  process.env.OPENCODE_TEST_SKILL_PATH = external
  await writeFile(join(root, "opencode.json"), JSON.stringify({ skills: { paths: ["${env:OPENCODE_TEST_SKILL_PATH}"] } }))
  try { assert.match((await createRuntime(root).skill({ name: "env-skill" })).output, /Environment expanded/) }
  finally { if (previous === undefined) delete process.env.OPENCODE_TEST_SKILL_PATH; else process.env.OPENCODE_TEST_SKILL_PATH = previous }
})

test("expands documented OpenCode {env:NAME} configuration values", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-braced-env-")), external=await mkdtemp(join(tmpdir(),"opencode-config-braced-env-path-")), previous=process.env.OPENCODE_BRACED_SKILL_PATH
  await mkdir(join(external,"braced"),{recursive:true})
  await writeFile(join(external,"braced","SKILL.md"),"---\nname: braced-env-skill\n---\nBraced environment expansion.\n")
  process.env.OPENCODE_BRACED_SKILL_PATH=external
  await writeFile(join(root,"opencode.json"),JSON.stringify({skills:{paths:["{env:OPENCODE_BRACED_SKILL_PATH}"]}}))
  try { assert.match((await createRuntime(root).skill({name:"braced-env-skill"})).output,/Braced environment expansion/) }
  finally { if(previous===undefined)delete process.env.OPENCODE_BRACED_SKILL_PATH;else process.env.OPENCODE_BRACED_SKILL_PATH=previous }
})

test("reads JSONC comments and trailing commas without corrupting URL values", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-config-jsonc-")), external = await mkdtemp(join(tmpdir(), "opencode-config-jsonc-path-"))
  await mkdir(join(external, "skills", "jsonc-skill"), { recursive: true })
  await mkdir(join(root, ".opencode"), { recursive: true })
  await writeFile(join(external, "skills", "jsonc-skill", "SKILL.md"), "---\nname: jsonc-skill\n---\nJSONC works.\n")
  await writeFile(join(root, ".opencode", "opencode.jsonc"), `{
    // A URL must remain a string, not a comment.
    "shell": "cmd.exe",
    "endpoint": "https://example.invalid/api",
    "skills": { "paths": [${JSON.stringify(external)},], },
  }`)
  assert.match((await createRuntime(root).skill({ name: "jsonc-skill" })).output, /JSONC works/)
})

test("honors OpenCode explicit and inline configuration overrides", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-overrides-")), external=await mkdtemp(join(tmpdir(),"opencode-config-overrides-skill-")), config=join(root,"override.json"), before={config:process.env.OPENCODE_CONFIG,content:process.env.OPENCODE_CONFIG_CONTENT,disable:process.env.OPENCODE_DISABLE_PROJECT_CONFIG}
  await mkdir(join(external,"inline"),{recursive:true})
  await writeFile(join(external,"inline","SKILL.md"),"---\nname: inline-config-skill\n---\nLoaded from inline config.\n")
  await writeFile(join(root,"opencode.json"),JSON.stringify({skills:{paths:[join(root,"missing")]}}))
  await writeFile(config,JSON.stringify({skills:{paths:[external]}}))
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG="1";process.env.OPENCODE_CONFIG=config;process.env.OPENCODE_CONFIG_CONTENT=JSON.stringify({skills:{paths:[external]}})
  try { assert.match((await createRuntime(root).skill({name:"inline-config-skill"})).output,/Loaded from inline config/) }
  finally { for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[`OPENCODE_${key.toUpperCase()}`];};if(before.config===undefined)delete process.env.OPENCODE_CONFIG;else process.env.OPENCODE_CONFIG=before.config;if(before.content===undefined)delete process.env.OPENCODE_CONFIG_CONTENT;else process.env.OPENCODE_CONFIG_CONTENT=before.content;if(before.disable===undefined)delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;else process.env.OPENCODE_DISABLE_PROJECT_CONFIG=before.disable }
})

test("uses project config after OPENCODE_CONFIG and resolves skill paths against each config file", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-order-")), explicit=join(root,"explicit.json"), external=join(root,"external"), project=join(root,".opencode","project-skills"), previous=process.env.OPENCODE_CONFIG
  await mkdir(join(external,"same"),{recursive:true});await mkdir(join(project,"same"),{recursive:true})
  await writeFile(join(external,"same","SKILL.md"),"---\nname: config-order-skill\n---\nExplicit config body.\n")
  await writeFile(join(project,"same","SKILL.md"),"---\nname: config-order-skill\n---\nProject config body.\n")
  await writeFile(explicit,JSON.stringify({skills:{paths:["external"]}}))
  await mkdir(join(root,".opencode"),{recursive:true})
  await writeFile(join(root,".opencode","opencode.json"),JSON.stringify({skills:{paths:["project-skills"]}}))
  process.env.OPENCODE_CONFIG=explicit
  try { assert.match((await createRuntime(root).skill({name:"config-order-skill"})).output,/Project config body/) }
  finally { if(previous===undefined)delete process.env.OPENCODE_CONFIG;else process.env.OPENCODE_CONFIG=previous }
})

test("matches OpenCode nested project config and .opencode directory precedence", async () => {
  const worktree=await mkdtemp(join(tmpdir(),"opencode-config-upward-")), root=join(worktree,"packages","fixture")
  await mkdir(join(worktree,".git"),{recursive:true})
  await mkdir(join(root,".opencode"),{recursive:true})
  await mkdir(join(worktree,".opencode"),{recursive:true})
  await writeFile(join(worktree,"opencode.json"),JSON.stringify({shell:"parent-direct"}))
  await writeFile(join(root,"opencode.jsonc"),JSON.stringify({shell:"child-direct"}))
  await writeFile(join(root,".opencode","opencode.json"),JSON.stringify({shell:"child-directory"}))
  await writeFile(join(worktree,".opencode","opencode.jsonc"),JSON.stringify({shell:"parent-directory"}))
  assert.equal((await compatibleConfig(root)).shell,"parent-directory")
})

test("loads OPENCODE_CONFIG_DIR as the final compatible configuration layer", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-dir-root-")), configDir=await mkdtemp(join(tmpdir(),"opencode-config-dir-")), previous=process.env.OPENCODE_CONFIG_DIR
  await mkdir(join(configDir,"skills","dir-override"),{recursive:true})
  await writeFile(join(configDir,"skills","dir-override","SKILL.md"),"---\nname: config-dir-skill\n---\nConfig directory override.\n")
  await writeFile(join(configDir,"opencode.jsonc"),JSON.stringify({skills:{paths:["skills"]}}))
  process.env.OPENCODE_CONFIG_DIR=configDir
  try { assert.match((await createRuntime(root).skill({name:"config-dir-skill"})).output,/Config directory override/) }
  finally { if(previous===undefined)delete process.env.OPENCODE_CONFIG_DIR;else process.env.OPENCODE_CONFIG_DIR=previous }
})

test("uses OPENCODE_CONFIG_DIR as the OpenCode global config root", async () => {
  const root=await mkdtemp(join(tmpdir(),"opencode-config-dir-root-fields-")), configDir=await mkdtemp(join(tmpdir(),"opencode-config-dir-fields-")), previous=process.env.OPENCODE_CONFIG_DIR
  await writeFile(join(configDir,"config.json"),JSON.stringify({shell:"cmd.exe",tool_output:{max_lines:77}}))
  await writeFile(join(configDir,"opencode.json"),JSON.stringify({tool_output:{max_bytes:4096}}))
  process.env.OPENCODE_CONFIG_DIR=configDir
  try { const config=await compatibleConfig(root);assert.equal(config.shell,"cmd.exe");assert.deepEqual(config.toolOutput,{maxLines:77,maxBytes:4096}) }
  finally { if(previous===undefined)delete process.env.OPENCODE_CONFIG_DIR;else process.env.OPENCODE_CONFIG_DIR=previous }
})
