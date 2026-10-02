import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import checkMcp from "../app/src/androidTest/assets/mcp-check.cjs";
import { createSdkRuntime, sdkQuery } from "./sdk.js";
import { mcpQuery } from "./mcp.js";
import { FileAuthStorageBackend } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

const root=await mkdtemp(join(tmpdir(),"launcher-mcp-check-"));
const api=createServer(async(req,res)=>{
  let body="";for await(const chunk of req)body+=chunk;
  const request=JSON.parse(body),last=request.messages.at(-1),prompt=JSON.stringify(last.content);
  if(prompt.includes("MCP idle"))await new Promise(resolve=>setTimeout(resolve,250));
  const tool=prompt.includes("MCP idle")?undefined:last.role==="tool" && last.tool_call_id==="mcp-call" && JSON.stringify(last.content).includes("mcp__fixture__ping") ? ["mcp__fixture__ping",{}] : last.role!=="user"?undefined:prompt.includes("MCP deferred")?["tool_search",{query:"ping"}]:prompt.includes("MCP codemode")?["codemode",{code:`const matches=await searchTools("ping",{namespace:"mcp__fixture"}); if(!matches.length)throw Error("not discovered"); const result=await tools.mcp__fixture__ping({}); text(result);`}]:["mcp__fixture__ping",{}];
  if(tool)assert(request.tools.some(item=>item.function.name===tool[0]),"MCP tool reaches model declaration");
  const delta=tool?{role:"assistant",tool_calls:[{index:0,id:"mcp-call",type:"function",function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]}:{role:"assistant",content:"done"};
  res.writeHead(200,{"content-type":"text/event-stream"});
  res.end(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason:tool?"tool_calls":"stop"}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve=>api.listen(0,"127.0.0.1",resolve));
const config={agentDir:join(root,"agent"),cwd:join(root,"workspace"),cacheDir:join(root,"cache"),
  settings:{defaultProvider:"fixture",defaultModel:"fixture",compaction:{enabled:false},retry:{enabled:false}},
  models:{providers:{fixture:{baseUrl:`http://127.0.0.1:${api.address().port}/v1`,api:"openai-completions",models:[{id:"fixture",name:"Fixture"}]}}},
  auth:{fixture:{type:"api_key",key:"fixture-only"}}};
await mkdir(config.agentDir,{recursive:true});await mkdir(join(config.cwd,".pi"),{recursive:true});
try {
  // Hold the exact upstream lock, then race both first-party writers against a changed revision.
  const path=join(config.agentDir,"mcp.json");
  const original='{"mcpServers":{"keep":{"url":"https://example.test/mcp"}},"number":1e+02}\r\n';
  await writeFile(path,original);
  const listing=await sdkQuery({type:"mcp_list",config});
  let release, entered;
  const locked=new Promise(resolve=>entered=resolve), gate=new Promise(resolve=>release=resolve);
  const held=new FileAuthStorageBackend(path).withLockAsync(async()=>{
    entered();await gate;await writeFile(path,original.replace("1e+02","2e+02"));return {result:undefined};
  });
  await locked;
  const fileSave=mcpQuery({type:"mcp_file_save",scope:"global",name:"./mcp.json",source:original.replace("1e+02","3e+02"),expected:original},config);
  const mutation=mcpQuery({type:"mcp_toggle",scope:"global",name:"keep",enabled:false,revision:listing.revisions.global},config);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(await readFile(path,"utf8"),original,"neither writer bypasses the lock");
  release();await held;
  const writes=await Promise.allSettled([fileSave,mutation]);
  assert(writes.every(result=>result.status==="rejected"&&/配置已变化/.test(result.reason.message)),"both writers compare inside the shared lock");
  const current=await readFile(path,"utf8"), source=current.replace("2e+02","4e+02");
  await sdkQuery({type:"mcp_file_save",config,scope:"global",name:"./mcp.json",source,expected:current});
  assert.equal(await readFile(path,"utf8"),source,"numbers and CRLF preserved verbatim");
  assert.equal(await readFile(path+".previous","utf8"),current,"previous edition kept");
  await rm(path,{force:true});
  console.log("PASS: official-lock interleaving for full-file/server writes; canonical alias, CAS, numeric/CRLF source and previous backup");
  await checkMcp({config,nodeCommand:process.execPath,npmCli:resolve(import.meta.dirname,"node_modules/npm/bin/npm-cli.js"),
    setSettings:async patch=>{Object.assign(config.settings,patch);},
    async query(type,args={},succeeds=true,options={}) {
      const events=[],controller=new AbortController();
      const timer=options.abortAfter?setTimeout(()=>controller.abort(),options.abortAfter):undefined;
      const emit=event=>{events.push(event);options.auth?.(event);};
      let result;
      try {
        if(type==="prompt") {
          const runtime=await createSdkRuntime({config,...args},controller.signal);runtime.subscribe(emit);await runtime.prompt(args.prompt);
          assert(!events.some(event=>event.type==="error"),JSON.stringify(events));
        } else result=await sdkQuery({type,config,...args},controller.signal,emit,async prompt=>{
          const value=options.auth?.({type:"auth_prompt",prompt});
          if(value===null){controller.abort();throw controller.signal.reason;}
          return value;
        });
      } catch(error) {if(succeeds)throw error;events.push({type:"error",message:error.message});return {events};}
      finally {clearTimeout(timer);}
      assert(succeeds,"expected operation to fail");return {result,events};
    },
  });
} finally {
  api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await rm(root,{recursive:true,force:true});
}
