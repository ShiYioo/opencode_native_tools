#!/usr/bin/env node
const command=process.argv[2]
if(command && ["apply","status","unapply"].includes(command)) {
  const { apply, status, unapply }=await import("../src/codex-config.mjs")
  if(command==="apply") { const p=await apply(); console.log(`Codex configured: ${p.config}`); console.log("Restart Codex or create a new task to reload MCP preferences.") }
  if(command==="status") console.log(JSON.stringify(await status(),null,2))
  if(command==="unapply") { const p=await unapply(); console.log(`Removed managed routing rules. MCP config was preserved: ${p.config}`) }
} else await import("../src/server.mjs")
