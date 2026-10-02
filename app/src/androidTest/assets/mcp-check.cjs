// Real JSON-RPC fixtures. Shared by desktop SDK checks and the packaged App-UID check.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const tool = {name:'ping',description:'Return the MCP fixture marker',inputSchema:{type:'object',properties:{},additionalProperties:false}};
function rpc(message) {
  if (message.method === 'initialize') return {protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'},instructions:'Protocol fixture'};
  if (message.method === 'tools/list') return {tools:[tool]};
  if (message.method === 'tools/call') return {content:[{type:'text',text:'mcp-protocol-ok'}]};
  return {};
}
module.exports = async function checkMcp({query,config,setSettings,nodeCommand,npmCli}) {
  const calls=[], active=new Set();
  let base, protectedMode=true, pendingAuthUrl, echoAuth=false, failToken=false, hanging=0, hungClosed=0;
  const api=http.createServer(async(req,res)=>{
    const url=new URL(req.url,base);
    if (url.pathname === '/resource') { res.setHeader('content-type','application/json');res.end(JSON.stringify({resource:base+'/auth',authorization_servers:[base]}));return; }
    if (url.pathname.startsWith('/.well-known/')) {
      res.setHeader('content-type','application/json');res.end(JSON.stringify({issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',response_types_supported:['code'],code_challenge_methods_supported:['S256']}));return;
    }
    if (url.pathname === '/register') {
      let body='';for await(const chunk of req)body+=chunk;
      const client=JSON.parse(body);
      res.setHeader('content-type','application/json');res.end(JSON.stringify({client_id:'fixture-client',redirect_uris:client.redirect_uris}));return;
    }
    if (url.pathname === '/token') {
      if(failToken){res.writeHead(400);res.end('invalid client_secret: '+process.env.MCP_REVIEW_SECRET);return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:'fixture-token-not-real',token_type:'Bearer',expires_in:3600}));return;
    }
    if (url.pathname === '/auth' && protectedMode && req.headers.authorization !== 'Bearer fixture-token-not-real') {
      res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${base}/resource"`});res.end();return;
    }
    if(url.pathname==='/hang'){hanging++;res.on('close',()=>{hungClosed++;});for await(const chunk of req){}return;}
    if(url.pathname==='/echo'||(url.pathname==='/auth'&&echoAuth)){
      res.writeHead(400);res.end('invalid access token: '+String(req.headers.authorization??'').replace(/^Bearer /,''));return;
    }
    if(url.pathname==='/rpc-error'){
      let body='';for await(const chunk of req)body+=chunk;const message=JSON.parse(body);
      res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'token: '+String(req.headers.authorization??'').replace(/^Bearer /,'')}}));return;
    }
    if (url.pathname === '/provider' && req.headers.authorization !== 'Bearer fixture-only'
        && req.headers.authorization !== 'Bearer synthetic-only') {res.writeHead(401);res.end();return;}
    if (req.method !== 'POST') {res.writeHead(405);res.end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    const message=JSON.parse(body);calls.push(message.method);
    if (!message.id) {res.writeHead(202);res.end();return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:rpc(message)}));
  });
  api.on('connection',socket=>{active.add(socket);socket.on('close',()=>active.delete(socket));});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${api.address().port}`;
  const globalFile=path.join(config.agentDir,'mcp.json'),projectFile=path.join(config.cwd,'.pi/mcp.json');
  const fixture=path.join(config.cwd,'mcp-fixture.cjs'),pidFile=path.join(config.cwd,'mcp-pid');
  await fs.writeFile(fixture,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const rpc=${rpc.toString()};const tool=${JSON.stringify(tool)};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const msg=JSON.parse(line);if(msg.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:rpc(msg)})+'\\n');});
`);
  let listing;
  const list=async()=>{listing=(await query('mcp_list')).result;return listing;};
  const args=(name,scope='global')=>({name,scope,revision:listing.revisions[scope]});
  try {
    await fs.writeFile(globalFile,'S3CR3T malformed');
    const malformedTurn=await query('prompt',{sdk:true,prompt:'MCP idle fixture'});
    const notices=malformedTurn.events.filter(event=>event.type==='extension_ui')
      .flatMap(event=>event.state?.notifications??[]);
    assert(notices.some(notice=>notice.message.includes('MCP 配置文件 JSON 无效')),'malformed config is reported with a safe chat notice');
    assert(!JSON.stringify(malformedTurn.events).includes('S3CR3T'),'malformed config source never reaches chat notifications');
    assert(!JSON.stringify((await query('mcp_list')).result).includes('S3CR3T'),'settings use the same safe config diagnostic');
    await fs.writeFile(globalFile,JSON.stringify({unknownTop:{keep:true},mcpServers:{
      fixture:{url:base+'/mcp',exposure:'codemode',unknownServer:{keep:1}},
      disabled:{command:'definitely-missing-command',enabled:false},
      broken:{type:'sse',url:base+'/sse'},
    }}));
    await list();assert.equal(listing.servers.length,2);assert.equal(listing.errors.length,1);assert.equal(listing.chatEnabled,true);
    await assert.rejects(fs.stat(path.join(config.agentDir,'mcp-auth.json')),{code:'ENOENT'},'listing never creates credential files');
    assert(!JSON.stringify(listing).includes('unknownServer'));
    const originalFile=await fs.readFile(globalFile,'utf8');
    const fullSource=originalFile.replace('"unknownTop":','"keepNumeric":1e+02,"unknownTop":')+'\r\n';
    const fullSave=(await query('mcp_file_save',{scope:'global',name:'./mcp.json',source:fullSource,expected:originalFile})).result;
    assert.equal(fullSave.source,fullSource);assert.equal(await fs.readFile(globalFile,'utf8'),fullSource);
    assert.equal(await fs.readFile(globalFile+'.previous','utf8'),originalFile);
    await list();
    let before=await fs.readFile(globalFile,'utf8');
    await query('mcp_save',{...args('invalid'),definition:{command:'node',args:[42]}},false);
    assert.equal(await fs.readFile(globalFile,'utf8'),before,'invalid input does not write');
    await query('mcp_save',{...args('fixture'),revision:'stale',definition:{url:base}},false);
    assert.equal(await fs.readFile(globalFile,'utf8'),before,'stale revision does not write');
    const edit=(await query('mcp_edit',args('fixture'))).result;
    assert.equal(edit.config.unknownServer.keep,1);
    await query('mcp_toggle',{...args('fixture'),enabled:false});await list();
    assert.equal(JSON.parse(await fs.readFile(globalFile)).unknownTop.keep,true);
    const count=calls.length;
    assert.equal((await query('mcp_check',args('fixture'))).result.state,'disabled');assert.equal(calls.length,count);
    await query('mcp_toggle',{...args('fixture'),enabled:true});await list();
    const connectedProbe=(await query('mcp_check',args('fixture'))).result;
    assert.equal(connectedProbe.state,'connected',JSON.stringify(connectedProbe));
    assert(calls.includes('initialize')&&calls.includes('notifications/initialized')&&calls.includes('tools/list'));
    await setSettings({defaultTools:['+codemode']});
    let turn=await query('prompt',{sdk:true,prompt:'MCP codemode fixture'});
    assert(turn.events.some(e=>e.type==='tool_end'&&e.name==='codemode'&&!e.isError),JSON.stringify(turn.events));
    assert(calls.includes('tools/call'),'codemode uses real tools/call');
    // Official name collision and project-credential restrictions.
    await query('mcp_save',{...args('fixture-two'),definition:{url:base}},true);await list();
    await query('mcp_save',{...args('fixture_two'),definition:{url:base}},false);
    await query('mcp_save',{...args('private','project'),definition:{url:base,auth:{provider:'fixture'}}},false);
    const projectSource=JSON.stringify({mcpServers:{fixture:{command:'legacy-project-command',exposure:'direct'}}})+'\n';
    await fs.writeFile(projectFile,projectSource);
    await query('mcp_save',{...args('fixture','project'),definition:{command:'node',args:[fixture],exposure:'direct'}},false);
    await query('mcp_file_save',{scope:'project',name:'./mcp.json',source:'{}',expected:projectSource},false);
    await list();assert.equal(listing.servers.find(s=>s.name==='fixture').scope,'global');
    await query('mcp_save',{...args('fixture'),definition:{command:'node',args:[fixture],exposure:'direct'}});await list();
    assert.equal(await fs.readFile(projectFile,'utf8'),projectSource,'legacy project MCP bytes stay unchanged');
    turn=await query('prompt',{sdk:true,prompt:'MCP direct fixture'});
    assert(turn.events.some(e=>e.type==='tool_end'&&e.name==='mcp__fixture__ping'&&!e.isError),JSON.stringify(turn.events));
    const pid=Number(await fs.readFile(pidFile,'utf8'));
    assert.throws(()=>process.kill(pid,0),'stdio child is released after prompt');
    await query('mcp_remove',args('fixture','project'),false);await list();assert.equal(listing.servers.find(s=>s.name==='fixture').scope,'global');
    await query('mcp_save',{...args('fixture'),definition:{url:base+'/mcp',exposure:'deferred'}});await list();
    await setSettings({defaultTools:[]});
    turn=await query('prompt',{sdk:true,prompt:'MCP deferred fixture'});
    assert(turn.events.some(e=>e.type==='tool_end'&&e.name==='tool_search'&&!e.isError),JSON.stringify(turn.events));
    assert(turn.events.some(e=>e.type==='tool_end'&&e.name==='mcp__fixture__ping'&&!e.isError),JSON.stringify(turn.events));
    const stalled=path.join(config.cwd,'mcp-stalled.cjs');
    await fs.writeFile(stalled,`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();`);
    await query('mcp_save',{...args('stall'),definition:{command:'node',args:[stalled],timeout:10}});await list();
    await query('mcp_check',args('stall'),false,{abortAfter:200,cancelled:true});
    assert.throws(()=>process.kill(Number(require('node:fs').readFileSync(pidFile,'utf8')),0),'aborted initialize releases the child');
    await query('mcp_save',{...args('hanging'),definition:{url:base+'/hang',exposure:'codemode',timeout:30}});await list();
    await fs.rm(pidFile,{force:true});
    const started=Date.now();await query('prompt',{sdk:true,prompt:'MCP idle fixture'});
    assert(Date.now()-started<4000,'normal completion must not await initialization timeout');
    for(let attempt=0;attempt<200&&hungClosed!==hanging;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert(hanging>0&&hungClosed===hanging,'normal completion closes initializing HTTP responses: '+hanging+'/'+hungClosed);
    assert.throws(()=>process.kill(Number(require('node:fs').readFileSync(pidFile,'utf8')),0),'normal completion releases initializing stdio');
    await query('mcp_remove',args('hanging'));await list();await query('mcp_remove',args('stall'));await list();
    await query('mcp_save',{...args('failure'),definition:{command:'missing-mcp-executable',timeout:1}});await list();
    assert.equal((await query('mcp_check',args('failure'))).result.state,'failed');
    await query('mcp_save',{...args('provider'),definition:{url:base+'/provider',auth:{provider:'fixture'}}});await list();
    assert.equal((await query('mcp_check',args('provider'))).result.state,'connected','provider tokens resolve through the official registry');
    await query('mcp_save',{...args('oauth'),definition:{url:base+'/auth'}});await list();
    assert.equal((await query('mcp_check',args('oauth'))).result.state,'needs-auth');
    const authFile=path.join(config.agentDir,'mcp-auth.json');
    const assertListenerFree=async()=>{
      const redirect=new URL(pendingAuthUrl.searchParams.get('redirect_uri'));
      const listener=require('node:net').createServer();
      await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(Number(redirect.port),'127.0.0.1',resolve);});
      await new Promise(resolve=>listener.close(resolve));
    };
    const auth=(await query('mcp_login',args('oauth'),true,{auth(event){
      if(event.type==='auth')pendingAuthUrl=new URL(event.event.url);
      if(event.type==='auth_prompt') {
        const redirect=new URL(pendingAuthUrl.searchParams.get('redirect_uri'));
        redirect.searchParams.set('code','fixture-code');redirect.searchParams.set('state',pendingAuthUrl.searchParams.get('state'));
        return redirect.href;
      }
    }})).result;
    assert.equal(auth.state,'connected');
    await assertListenerFree();
    assert((await fs.readFile(authFile,'utf8')).includes('fixture-token-not-real'));
    assert(!JSON.stringify(auth).includes('fixture-token-not-real'));
    if(process.platform!=='win32')assert.equal((await fs.stat(authFile)).mode & 0o777,0o600);
    echoAuth=true;
    const oauthFailure=(await query('mcp_check',args('oauth'))).result;
    assert.equal(oauthFailure.state,'failed');assert(!JSON.stringify(oauthFailure).includes('fixture-token-not-real'));
    echoAuth=false;
    await query('mcp_logout',args('oauth'));
    assert(!(await fs.readFile(authFile,'utf8')).includes('fixture-token-not-real'));
    await query('mcp_login',args('oauth'),false,{cancelled:true,auth(event){
      if(event.type==='auth')pendingAuthUrl=new URL(event.event.url);
      if(event.type==='auth_prompt')return null;
    }});
    await assertListenerFree();
    await query('mcp_login',args('oauth'),false,{auth(event){
      if(event.type==='auth')pendingAuthUrl=new URL(event.event.url);
      if(event.type==='auth_prompt')return 'invalid-redirect';
    }});
    await assertListenerFree();
    process.env.MCP_REVIEW_SECRET='fixture-echo-secret';
    config.runtimeEnvironment={...process.env};
    for(const [name,definition] of [
      ['braced',{url:base+'/echo',headers:{Authorization:'Bearer ${MCP_REVIEW_SECRET}'}}],
      ['unbraced',{url:base+'/echo',headers:{Authorization:'Bearer $MCP_REVIEW_SECRET'}}],
      ['literal',{url:base+'/rpc-error',headers:{Authorization:'Bearer fixture-echo-secret'}}],
      ['providerEcho',{url:base+'/echo',auth:{provider:'fixture'}}],
    ]){
      await list();await query('mcp_save',{...args(name),definition});await list();
      const failure=(await query('mcp_check',args(name))).result;
      assert.equal(failure.state,'failed');
      if(name!=='literal')assert.match(failure.error,/status 400/);
      for(const secret of ['fixture-echo-secret','fixture-only','synthetic-only'])assert(!JSON.stringify(failure).includes(secret),JSON.stringify(failure));
    }
    const counter=path.join(config.cwd,'mcp-command-counter');
    config.runtimeEnvironment.MCP_COUNTER=counter;
    await list();await query('mcp_save',{...args('commandHeader'),definition:{url:base+'/echo',headers:{Authorization:
      `!node -e "require('node:fs').appendFileSync(process.env.MCP_COUNTER,'x');process.stdout.write('Bearer fixture-echo-secret')"`}}});await list();
    const commandFailure=(await query('mcp_check',args('commandHeader'))).result;
    assert.equal(commandFailure.state,'failed');assert(!JSON.stringify(commandFailure).includes('fixture-echo-secret'));
    assert.equal(await fs.readFile(counter,'utf8'),'x','diagnostic sanitization does not rerun credential commands');
    await list();await query('mcp_save',{...args('oauthThrow'),definition:{url:base+'/auth',oauth:{clientId:'fixture-client',clientSecret:'$MCP_REVIEW_SECRET'}}});await list();
    failToken=true;
    const thrown=await query('mcp_login',args('oauthThrow'),false,{auth(event){
      if(event.type==='auth')pendingAuthUrl=new URL(event.event.url);
      if(event.type==='auth_prompt'){
        const redirect=new URL(pendingAuthUrl.searchParams.get('redirect_uri'));redirect.searchParams.set('code','fixture');
        redirect.searchParams.set('state',pendingAuthUrl.searchParams.get('state'));return redirect.href;
      }
    }});
    assert(thrown.events.some(event=>event.type==='error'),'OAuth throw reaches the error boundary');
    assert(!JSON.stringify(thrown.events).includes('fixture-echo-secret'));
    failToken=false;await assertListenerFree();
    await setSettings({extensions:['-builtin:mcp']});
    assert.equal((await query('mcp_list')).result.chatEnabled,false);
    const checked=(await query('mcp_check',args('fixture'))).result;
    assert.equal(checked.state,'connected');assert(checked.chatNote.includes('builtin:mcp'));
    await setSettings({extensions:[]});
    const replacement=path.join(config.agentDir,'extensions/mcp-replacement.ts');
    await fs.mkdir(path.dirname(replacement),{recursive:true});
    await fs.writeFile(replacement,"export default function(pi){pi.registerCommand('mcp',{description:'Fixture replacement',handler:async()=>{}});}");
    assert.equal((await query('mcp_list')).result.chatEnabled,false,'third-party /mcp replaces the builtin');
    await fs.rm(replacement);
    // Exercise the npm/npx adapter with the actual packaged npm JS, not a shell shim.
    if(npmCli) {
      config.runtimeEnvironment={...process.env};config.settings={...(config.settings??{}),npmCommand:[nodeCommand,npmCli]};
      const {name}=JSON.parse(await fs.readFile(path.join(path.dirname(npmCli),'../package.json'),'utf8'));
      assert.equal(name,'npm');
      for(const command of ['npm','npx']) {
        await list();await query('mcp_save',{...args(command),definition:{command,
          args:[...(command==='npm'?['exec']:[]),'--call','node mcp-fixture.cjs'],timeout:5}});await list();
        const result=(await query('mcp_check',args(command))).result;
        assert.equal(result.state,'connected',result.error);
        assert.equal(result.tools[0].name,'ping');
        const child=Number(await fs.readFile(pidFile,'utf8'));
        assert.throws(()=>process.kill(child,0),'npm/npx child process is released');
      }
    }
    console.log('PASS: review fixes: normal-completion pending stdio/HTTP cleanup; full-file alias/CAS/backup; echoed template/literal/provider/OAuth/clientSecret failures and no credential command replay');
    console.log('PASS: MCP initialize/list/call via HTTP + node/npm/npx stdio; SDK direct/codemode/deferred; scopes, disabled, validation/revisions, failures, needs-auth; OAuth redirect, credential isolation/signout/cancel listener; builtin disable; child release');
  } finally {
    protectedMode=false;
    api.closeAllConnections();await new Promise(resolve=>api.close(resolve));
    for(const socket of active)socket.destroy();
    await fs.rm(globalFile,{force:true});await fs.rm(projectFile,{force:true});
  }
};
