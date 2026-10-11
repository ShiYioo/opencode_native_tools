import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { createRuntime } from "./runtime.mjs"
import { object, string, integer, toolError } from "./validation.mjs"
import { DESCRIPTIONS } from "./descriptions.mjs"

const root = resolve(process.env.OPENCODE_TOOLS_ROOT || process.cwd())
const runtime = createRuntime(root)
// A host may set this stable identifier to restore its own MCP session's todo state.
const sessionID = process.env.OPENCODE_TOOLS_SESSION_ID || randomUUID()
const schema = (properties, required=[]) => ({type:"object",properties,required,additionalProperties:false})
const str = description => ({type:"string",description}), num = description => ({type:"number",description})
const responseFormat={type:"string",enum:["text","detailed"],default:"text",description:"Return compact text (default) or non-duplicated structured metadata"}
const readOnlyTools=new Set(["read","readMany","glob","grep","webfetch","websearch","skill"])
const destructiveTools=new Set(["write","edit","apply_patch","bash"])
const openWorldTools=new Set(["bash","webfetch","websearch","skill"])
const tools = [
 ["read",DESCRIPTIONS.read,schema({filePath:str("The absolute path to the file or directory to read"),offset:{type:"integer",minimum:0,description:"The line number to start reading from (1-indexed)"},limit:{type:"integer",minimum:0,description:"The maximum number of lines to read (defaults to 2000)"},responseFormat},["filePath"]),"read"],
 ["readMany",DESCRIPTIONS.readMany,schema({files:{type:"array",minItems:1,maxItems:8,description:"The files to read",items:schema({filePath:str("The absolute path to the file"),offset:{type:"integer",minimum:0,description:"The line number to start reading from (1-indexed)"},limit:{type:"integer",minimum:0,description:"The maximum number of lines to read"}},["filePath"])},responseFormat},["files"]),"readMany"],
 ["glob",DESCRIPTIONS.glob,schema({pattern:str("The glob pattern to match files against"),path:str("The directory to search in. If omitted, the current working directory is used. Must be a valid directory path when provided.")},["pattern"]),"glob"],
 ["grep",DESCRIPTIONS.grep,schema({pattern:str("The regex pattern to search for in file contents"),path:str("The file or directory to search. Defaults to the current directory."),include:str('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),outputMode:{type:"string",enum:["content","files_with_matches","count"],default:"content",description:"Matching lines, paths only, or matching-line counts per file"},ignoreCase:{type:"boolean",default:false,description:"Case-insensitive search"},context:{type:"integer",minimum:0,maximum:20,default:0,description:"Surrounding lines in content mode; ignored in other modes"},limit:{type:"integer",minimum:1,maximum:1000,default:100,description:"Maximum output entries in this page"},offset:{type:"integer",minimum:0,maximum:1000000,default:0,description:"Skip this many output entries (0-based)"},responseFormat},["pattern"]),"grep"],
 ["write",DESCRIPTIONS.write,schema({filePath:str("The absolute path to the file to write"),content:str("The content to write to the file")},["filePath","content"]),"write"],
 ["edit",DESCRIPTIONS.edit,schema({filePath:str("The absolute path to the file to modify"),oldString:str("The text to replace"),newString:str("The text to replace it with (must be different from oldString)"),replaceAll:{type:"boolean",description:"Replace all occurrences of oldString (default false)"}},["filePath","oldString","newString"]),"edit"],
 ["apply_patch",DESCRIPTIONS.apply_patch,schema({patchText:str("The full patch text that describes all changes to be made")},["patchText"]),"applyPatch"],
 ["bash",DESCRIPTIONS.bash,schema({command:str("The command to execute"),workdir:str("The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands."),timeout:{type:"integer",minimum:1,description:"Optional timeout in milliseconds"}},["command"]),"bash"],
 ["webfetch",DESCRIPTIONS.webfetch,schema({url:str("URL"),format:{type:"string",enum:["text","markdown","html"],default:"markdown",description:"The format to return the content in (text, markdown, or html). Defaults to markdown."},timeout:num("Optional timeout in seconds (max 120)")},["url"]),"webfetch"],
 ["websearch",DESCRIPTIONS.websearch,schema({query:str("Query"),numResults:num("Results"),type:{type:"string",enum:["auto","fast","deep"]},livecrawl:{type:"string",enum:["fallback","preferred"]},contextMaxCharacters:num("Context limit")},["query"]),"websearch"],
 ["todowrite",DESCRIPTIONS.todowrite,schema({todos:{type:"array",description:"The updated todo list",items:schema({content:str("Brief description of the task"),status:str("Current status of the task: pending, in_progress, completed, cancelled"),priority:str("Priority level of the task: high, medium, low")},["content","status","priority"]) }},["todos"]),"todo"],
 ["skill",DESCRIPTIONS.skill,schema({name:str("Skill name")},["name"]),"skill"],
].map(([name,description,inputSchema,handler])=>({name,description,inputSchema,handler,annotations:{readOnlyHint:readOnlyTools.has(name),destructiveHint:destructiveTools.has(name),idempotentHint:readOnlyTools.has(name)||name==="todowrite",openWorldHint:openWorldTools.has(name)}}))
function emit(value){process.stdout.write(JSON.stringify(value)+"\n")};function result(id,value){emit({jsonrpc:"2.0",id,result:value})};function failure(id,code,message){emit({jsonrpc:"2.0",id,error:{code,message}})}
function asContent(value){if(typeof value==="string")return {content:[{type:"text",text:value}]};const output=value?.output??JSON.stringify(value),content=[{type:"text",text:output}];if(value?.attachment){if(value.attachment.mimeType.startsWith("image/"))content.push({type:"image",mimeType:value.attachment.mimeType,data:value.attachment.data});else content.push({type:"resource",resource:{uri:`data:${value.attachment.mimeType};base64,${value.attachment.data}`,mimeType:value.attachment.mimeType,blob:value.attachment.data}})}const structured=value?.structuredContent===null?undefined:value?.structuredContent??{...(value?.title!==undefined?{title:value.title}:{}),...(value?.metadata!==undefined?{metadata:value.metadata}:{})};return {content,...(structured&&Object.keys(structured).length?{structuredContent:structured}:{})}}
const allowed={read:["filePath","offset","limit","responseFormat"],readMany:["files","responseFormat"],glob:["pattern","path"],grep:["pattern","path","include","outputMode","ignoreCase","context","limit","offset","responseFormat"],write:["filePath","content"],edit:["filePath","oldString","newString","replaceAll"],apply_patch:["patchText"],bash:["command","workdir","timeout"],webfetch:["url","format","timeout"],websearch:["query","numResults","type","livecrawl","contextMaxCharacters"],todowrite:["todos"],skill:["name"]}
function validate(name, input){const args=object(name,input);for(const key of Object.keys(args))if(!allowed[name].includes(key))throw toolError(name,`unknown property: ${key}`);if(["read","write","edit"].includes(name))string(name,args,"filePath");if(["glob","grep"].includes(name)&&typeof args.pattern!=="string")throw toolError(name,"pattern must be a string");for(const key of ["path","include","workdir"])if(args[key]!==undefined)string(name,args,key,true);if(["read","grep","readMany"].includes(name)&&args.responseFormat!==undefined&&!['text','detailed'].includes(args.responseFormat))throw toolError(name,"responseFormat must be text or detailed");if(name==="readMany"){if(!Array.isArray(args.files)||!args.files.length||args.files.length>8)throw toolError(name,"files must contain 1 to 8 items");for(const item of args.files){if(!item||typeof item!=="object"||Array.isArray(item))throw toolError(name,"each file must be an object");for(const key of Object.keys(item))if(!["filePath","offset","limit"].includes(key))throw toolError(name,`unknown file property: ${key}`);string(name,item,"filePath");for(const key of ["offset","limit"])if(item[key]!==undefined)integer(name,item,key,{min:0})}}if(name==="write")string(name,args,"content");if(name==="edit"){for(const key of ["oldString","newString"])if(typeof args[key]!=="string")throw toolError(name,`${key} must be a string`);if(args.replaceAll!==undefined&&typeof args.replaceAll!=="boolean")throw toolError(name,"replaceAll must be a boolean")};if(name==="bash")string(name,args,"command");if(name==="webfetch"){string(name,args,"url");if(args.format!==undefined&&!['text','markdown','html'].includes(args.format))throw toolError(name,"format must be text, markdown, or html")};if(name==="websearch"){string(name,args,"query");if(args.type!==undefined&&!['auto','fast','deep'].includes(args.type))throw toolError(name,"type must be auto, fast, or deep");if(args.livecrawl!==undefined&&!['fallback','preferred'].includes(args.livecrawl))throw toolError(name,"livecrawl must be fallback or preferred")};if(name==="bash"&&args.timeout!==undefined)integer(name,args,"timeout",{min:1});if(name==="skill")string(name,args,"name");if(name==="apply_patch")string(name,args,"patchText");if(name==="todowrite"){if(!Array.isArray(args.todos))throw toolError(name,"todos must be an array");for(const todo of args.todos){if(!todo||typeof todo!=="object"||Array.isArray(todo))throw toolError(name,"each todo must be an object");for(const key of Object.keys(todo))if(!["content","status","priority"].includes(key))throw toolError(name,`unknown todo property: ${key}`);for(const key of ["content","status","priority"])if(typeof todo[key]!=="string")throw toolError(name,`todo ${key} must be a string`)}}for(const key of ["offset","limit"])if(args[key]!==undefined)integer(name,args,key,{min:0});for(const key of ["timeout","numResults","contextMaxCharacters"])if(args[key]!==undefined&&(typeof args[key]!=="number"||!Number.isFinite(args[key])))throw toolError(name,`${key} must be a number`);return args}
const serverInstructions=`Independent OpenCode 1.18.9 tool port. Root: ${root}

Tool preference: use this server's read, glob, and grep tools for project inspection. Read files with tools/call using read or readMany and filePath, not resources/read. MCP resources only expose optional server diagnostics; do not repeatedly probe them during project inspection. For file modifications, prefer the host's native write/edit/apply_patch tools so the host can render its file-change diff; use this server's write, edit, or apply_patch only when native editing is unavailable. The host remains responsible for approval before side-effecting calls.`
const statusResource={uri:"opencode-tools://status",name:"opencode_native_tools status",description:"Optional server diagnostics. Use the read or readMany tool for files.",mimeType:"application/json"}
const requests=new Map(), cancellations=new Set()
async function handle(request){
  if(request.jsonrpc!=="2.0")return failure(request.id??null,-32600,"Invalid Request")
  if(request.method==="notifications/initialized")return
  if(request.method==="notifications/cancelled"){
    const key=String(request.params?.requestId),controller=requests.get(key)
    if(controller)controller.abort();else cancellations.add(key)
    return
  }
  if(request.method==="initialize")return result(request.id,{protocolVersion:"2025-06-18",capabilities:{tools:{listChanged:false},resources:{listChanged:false,subscribe:false}},serverInfo:{name:"opencode-native-tools",version:"1.18.9-port"},instructions:serverInstructions})
  if(request.method==="ping")return result(request.id,{})
  if(request.method==="resources/list")return result(request.id,{resources:[statusResource]})
  if(request.method==="resources/templates/list")return result(request.id,{resourceTemplates:[]})
  if(request.method==="resources/read"){
    const uri=request.params?.uri
    if(typeof uri!=="string"||!uri.trim())return failure(request.id,-32602,"uri must be a non-empty string")
    // Retain the literal "test" URI as an alias for older diagnostic probes.
    // Catch-all: hosts expose read_mcp_resource to models that probe it with invented URIs;
    // a -32002 error makes them retry the same junk, so answer with a guided success instead.
    const known=uri===statusResource.uri||uri==="test"
    const text=JSON.stringify({server:"opencode_native_tools",protocolVersion:"2025-06-18",
      ...(known?{}:{note:`No resource at "${uri}". The only resource is "${statusResource.uri}" (server diagnostics). For files, call the read or readMany tools with filePath instead.`}),
      fileAccessTools:["read","readMany"]})
    return result(request.id,{contents:[{uri,mimeType:statusResource.mimeType,text}]})
  }
  if(request.method==="tools/list")return result(request.id,{tools:tools.map(({handler,...tool})=>tool)})
  if(request.method==="tools/call"){
    const tool=tools.find(x=>x.name===request.params?.name)
    if(!tool)return failure(request.id,-32602,`Unknown tool: ${request.params?.name}`)
    const controller=new AbortController(),key=String(request.id)
    requests.set(key,controller)
    if(cancellations.delete(key))controller.abort()
    try{return result(request.id,asContent(await runtime[tool.handler](validate(tool.name,request.params.arguments??{}),sessionID,controller.signal)))}
    catch(error){return result(request.id,{content:[{type:"text",text:error instanceof Error?error.message:String(error)}],isError:true})}
    finally{requests.delete(key)}
  }
  return failure(request.id,-32601,`Method not found: ${request.method}`)
}
let buffer="", queue=Promise.resolve(), closed=false;const dispose=()=>{if(closed)return;closed=true;runtime.dispose().catch(()=>{})};process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;try{const request=JSON.parse(line);if(request.method==="notifications/cancelled"){handle(request);continue}queue=queue.then(()=>handle(request)).catch(()=>failure(request.id??null,-32603,"Internal error"))}catch{failure(null,-32700,"Parse error")}}});process.stdin.on("end",dispose);process.stdin.on("close",dispose)
