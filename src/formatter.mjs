import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { npmBinary } from "./npm-binary.mjs"

const simple={
  gofmt:[[".go"],["gofmt","-w","$FILE"]], mix:[[".ex",".exs",".eex",".heex",".leex",".neex",".sface"],["mix","format","$FILE"]], zig:[[".zig",".zon"],["zig","fmt","$FILE"]], ktlint:[[".kt",".kts"],["ktlint","-F","$FILE"]], rubocop:[[".rb",".rake",".gemspec",".ru"],["rubocop","--autocorrect","$FILE"]], standardrb:[[".rb",".rake",".gemspec",".ru"],["standardrb","--fix","$FILE"]], htmlbeautifier:[[".erb",".html.erb"],["htmlbeautifier","$FILE"]], dart:[[".dart"],["dart","format","$FILE"]], terraform:[[".tf",".tfvars"],["terraform","fmt","$FILE"]], latexindent:[[".tex"],["latexindent","-w","-s","$FILE"]], gleam:[[".gleam"],["gleam","format","$FILE"]], shfmt:[[".sh",".bash"],["shfmt","-w","$FILE"]], nixfmt:[[".nix"],["nixfmt","$FILE"]], rustfmt:[[".rs"],["rustfmt","$FILE"]], ormolu:[[".hs"],["ormolu","-i","$FILE"]], cljfmt:[[".clj",".cljs",".cljc",".edn"],["cljfmt","fix","--quiet","$FILE"]], dfmt:[[".d"],["dfmt","-i","$FILE"]],
}
const prettierExtensions=[".js",".jsx",".mjs",".cjs",".ts",".tsx",".mts",".cts",".html",".htm",".css",".scss",".sass",".less",".vue",".svelte",".json",".jsonc",".yaml",".yml",".toml",".xml",".md",".mdx",".graphql",".gql"]
const executable=name=>{const probe=process.platform==="win32"?spawnSync("where.exe",[name],{windowsHide:true,encoding:"utf8"}):spawnSync("which",[name],{encoding:"utf8"});return probe.status===0?(probe.stdout.split(/\r?\n/).find(Boolean)||name):undefined}
async function findUp(root, filepath, names) { let current=dirname(filepath); const boundary=dirname(root); while(current!==boundary){for(const name of names)if(existsSync(join(current,name)))return join(current,name);if(current===root)break;const parent=dirname(current);if(parent===current)break;current=parent} }
async function builtinCommands(root, filepath) {
  const ext=extname(filepath)
  const commands=[]
  for(const [name,[extensions, command]] of Object.entries(simple))if(extensions.includes(ext)&&executable(command[0]))commands.push({name,command})
  if(prettierExtensions.includes(ext)) {
    const packageFile=await findUp(root,filepath,["package.json"])
    if(packageFile)try { const pkg=JSON.parse(await readFile(packageFile,"utf8")); if(pkg.dependencies?.prettier||pkg.devDependencies?.prettier){const bin=await npmBinary("prettier","prettier").catch(()=>undefined);if(bin)commands.push({name:"prettier",command:[bin,"--write","$FILE"],environment:{BUN_BE_BUN:"1"}})}if((process.env.OPENCODE_EXPERIMENTAL_OXFMT==="1"||process.env.OPENCODE_EXPERIMENTAL_OXFMT==="true")&&(pkg.dependencies?.oxfmt||pkg.devDependencies?.oxfmt)){const oxfmt=await npmBinary("oxfmt","oxfmt").catch(()=>undefined);if(oxfmt)commands.push({name:"oxfmt",command:[oxfmt,"$FILE"],environment:{BUN_BE_BUN:"1"}})}}catch{}
    const biome=await findUp(root,filepath,["biome.json","biome.jsonc"])
    if(biome){const bin=await npmBinary("@biomejs/biome","biome").catch(()=>undefined);if(bin)commands.push({name:"biome",command:[bin,"format","--write","$FILE"],environment:{BUN_BE_BUN:"1"}})}
  }
  if([".c",".cc",".cpp",".cxx",".c++",".h",".hh",".hpp",".hxx",".h++",".ino",".C",".H"].includes(ext)&&await findUp(root,filepath,[".clang-format"])) { const bin=executable("clang-format");if(bin)commands.push({name:"clang",command:[bin,"-i","$FILE"]}) }
  if([".ml",".mli"].includes(ext)&&await findUp(root,filepath,[".ocamlformat"])) { const bin=executable("ocamlformat");if(bin)commands.push({name:"ocamlformat",command:[bin,"-i","$FILE"]}) }
  if([".py",".pyi"].includes(ext)){const ruff=executable("ruff");let ruffEnabled=false;if(ruff){for(const name of ["ruff.toml",".ruff.toml","pyproject.toml","requirements.txt","Pipfile"]){const config=await findUp(root,filepath,[name]);if(!config)continue;const text=await readFile(config,"utf8").catch(()=>"");if(name==="ruff.toml"||name===".ruff.toml"||(name==="pyproject.toml"&&text.includes("[tool.ruff]"))||((name==="requirements.txt"||name==="Pipfile")&&text.includes("ruff"))){ruffEnabled=true;break}}if(ruffEnabled)commands.push({name:"ruff",command:[ruff,"format","$FILE"]})}if(!ruffEnabled){const uv=executable("uv");if(uv&&spawnSync(uv,["format","--help"],{windowsHide:true}).status===0)commands.push({name:"uv",command:[uv,"format","--","$FILE"]})}}
  if(ext===".R"){const air=executable("air");if(air){const help=spawnSync(air,["--help"],{windowsHide:true,encoding:"utf8"});if(help.status===0&&help.stdout.split("\n")[0].includes("R language")&&help.stdout.split("\n")[0].includes("formatter"))commands.push({name:"rlang",command:[air,"format","$FILE"]})}}
  if(ext===".php"){const composer=await findUp(root,filepath,["composer.json"]);if(composer)try{const pkg=JSON.parse(await readFile(composer,"utf8"));if(pkg.require?.["laravel/pint"]||pkg["require-dev"]?.["laravel/pint"])commands.push({name:"pint",command:["./vendor/bin/pint","$FILE"]})}catch{}}
  return commands
}

// Matches OpenCode's formatter runner: formatter failures are logged by the
// source runtime and deliberately do not fail the tool operation.
export async function formatFile(root, filepath, formatter) {
  if (!formatter || formatter === false) return false
  const extension=extname(filepath)
  const custom=formatter===true?[]:Object.entries(formatter).filter(([, value]) => value && !value.disabled && Array.isArray(value.command) && (value.extensions ?? []).includes(extension)).map(([,value])=>({command:value.command,environment:value.environment}))
  const builtin=(await builtinCommands(root,filepath)).filter(item=>formatter===true||!formatter[item.name]?.disabled&&!formatter[item.name]?.command&&!(["ruff","uv"].includes(item.name)&&(formatter.ruff?.disabled||formatter.uv?.disabled)))
  const entries=[...builtin,...custom]
  if (!entries.length) return false
  const original=await readFile(filepath, "utf8")
  const hasBom=original.charCodeAt(0) === 0xfeff
  await Promise.all(entries.map(value => new Promise(done => {
    const command=value.command.map(part => part.replaceAll("$FILE", filepath))
    if (!command[0]) return done()
    const child=spawn(command[0], command.slice(1), { cwd: root, windowsHide:true, env:{...process.env,...(value.environment ?? {})}, stdio:"ignore" })
    child.once("error", done)
    child.once("close", done)
  })))
  if (hasBom) {
    const formatted=await readFile(filepath, "utf8")
    if (formatted.charCodeAt(0) !== 0xfeff) await writeFile(filepath, `\ufeff${formatted}`, "utf8")
  }
  return true
}
