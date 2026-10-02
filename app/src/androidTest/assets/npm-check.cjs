// Runs unchanged on desktop Node and the APK's Node launcher, using a loopback registry/model only.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');

// Photon-generated 2400x2 PNG: exceeds the default 2000px inline-image limit.
const imageData = 'iVBORw0KGgoAAAANSUhEUgAACWAAAAACCAYAAADc6efsAAAAoElEQVR4Ae3AA6AkWZbG8f937o3IzKdyS2Oubdu2bdu2bdu2bWmMnpZKr54yMyLu+Xa3anqmhztr1a/aNlddddVVV1111VVXXXXVVVddddVVV1111VVXXXXVVVddddVVV1111VVXXXXVVVf9a1G56qqrrrrqqquuuuqqq6666qqrrrrqqquuuuqqq6666qqrrrrqqquuuuqqq6666t+CfwTwpAQFRMfFhgAAAABJRU5ErkJggg==';

async function main() {
  const mcpOnly=process.argv.includes('--mcp-only');
  const npmCli = path.resolve(process.argv[2]);
  const sourceBundle = path.resolve(process.argv[3]);
  await fs.mkdir(os.tmpdir(), { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-sdk-check-'));
  const runtimeDir = path.join(root, 'runtime');
  await fs.mkdir(runtimeDir);
  // Run outside the repo: an omitted dependency must not resolve through developer node_modules.
  for (const name of ['pi-runtime.cjs','codemode-worker.js','image-resize-worker.js','photon_rs_bg.wasm','pi-sdk']) {
    await fs.cp(path.join(path.dirname(sourceBundle), name), path.join(runtimeDir, name), {recursive:true});
  }
  const bundle = path.join(runtimeDir, 'pi-runtime.cjs');
  const registry = new Map(), requests = [], children = new Set();
  const api = http.createServer(async (req, res) => {
    const url = decodeURIComponent(req.url);
    if (url === '/v1/chat/completions') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body); requests.push(request);
      const last = request.messages.at(-1);
      const prompt = JSON.stringify(last.content);
      if(prompt.includes('MCP idle'))await new Promise(resolve=>setTimeout(resolve,250));
      const tool = last.role === 'tool' && last.tool_call_id === 'fixture-call' && prompt.includes('mcp__fixture__ping')
        ? ['mcp__fixture__ping', {}] : last.role !== 'user' || !request.tools?.length ? undefined :
        prompt.includes('MCP deferred') ? ['tool_search', {query:'ping'}] :
        prompt.includes('MCP codemode') ? ['codemode', {code:'const found=await searchTools(\"ping\",{namespace:\"mcp__fixture\"}); if(!found.length)throw Error(\"not found\"); text(await tools.mcp__fixture__ping({}));'}] :
        prompt.includes('MCP direct') ? ['mcp__fixture__ping', {}] :
        prompt.includes('use probe') ? ['npm_probe', {}] :
        prompt.includes('runtime codemode') ? ['codemode', { code: `
          const ok = await tools.bash({command:'node -e "process.stdout.write(String.fromCharCode(98,97,115,104,45,111,107))"'});
          const bad = await tools.bash({command:'node -e "process.exit(7)"'});
          if (ok.exit_code !== 0 || ok.output !== 'bash-ok' || bad.exit_code !== 7) throw Error('bash structured result');
          text('bash-structured-ok'); text(await tools.read({path:'runtime-image.png'}));
        ` }] :
        prompt.includes('generate fixture image') ? ['codemode', { code: `
          const available = await models.getAvailableOfType('image', 'fixture-images');
          if (available.length !== 1) throw Error('image credentials/catalog');
          const result = await models.generateImages(available[0], {input:[{type:'text',text:'paint fixture'}]});
          if (result.stopReason !== 'stop') throw Error(result.errorMessage);
          for (const block of result.output) if (block.type === 'image') image(block); else text(block.text);
        ` }] :
        prompt.includes('runtime read image') ? ['read', { path:'runtime-image.png' }] :
        prompt.includes('runtime list apps') ? ['list_apps', {}] :
        prompt.includes('runtime search apps') ? ['search_apps', { query:'settings' }] :
        prompt.includes('runtime schedule') ? ['schedule_task', { action:'list' }] :
        prompt.includes('runtime screenshot') ? ['shower', { action:'screenshot' }] : undefined;
      const useTool = !!tool;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
        function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { role: 'assistant', content: 'fixture reply' };
      res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: useTool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const value = registry.get(url);
    if (!value) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not_found"}'); return; }
    res.setHeader('content-type', Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json');
    res.end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  });
  const bridge = net.createServer();
  let socket;
  const env = { ...process.env, HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: path.join(root, 'agent'),
    npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'npmrc'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  async function npm(args, cwd) {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
    const timer = setTimeout(() => child.kill(), 60000);
    try { const [code] = await once(child, 'close'); assert.equal(code, 0, output); return output.trim(); }
    finally { clearTimeout(timer); children.delete(child); }
  }
  try {
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const base = `http://127.0.0.1:${api.address().port}`; env.npm_config_registry = base;
    if(!mcpOnly)assert.equal(await npm(['--version'], root), '11.6.2');
    async function publish(name, files, manifest = {}) {
      const dir = path.join(root, name.replace(/[@/]/g, '-') + '-' + (manifest.version || '1.0.0')); await fs.mkdir(dir);
      const pkg = { name, version: '1.0.0', ...manifest };
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
      for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(dir, file), text);
      await npm(['pack', '--ignore-scripts'], dir);
      const archive = (await fs.readdir(dir)).find(file => file.endsWith('.tgz'));
      const bytes = await fs.readFile(path.join(dir, archive));
      registry.set(`/tar/${archive}`, bytes);
      pkg.dist = { tarball: `${base}/tar/${archive}`, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
      const prior=registry.get('/'+name);
      registry.set('/' + name, { name, 'dist-tags': { latest: pkg.version }, versions: { ...prior?.versions, [pkg.version]: pkg } });
    }
    if(!mcpOnly){
    await publish('fixture-dep', { 'index.js': "module.exports = 'dependency-ok';" }, { main: 'index.js' });
    await publish('@fixture/pi-probe', {
      'probe.ts': `import { Type } from 'typebox';
export default function(pi) { pi.registerTool({ name:'npm_probe', label:'Npm probe', description:'Fixture tool', parameters:Type.Object({}),
execute:async()=>({content:[{type:'text',text:'npm-probe-ok'}]}) }); }`,
      'postinstall.cjs': `const {spawnSync}=require('node:child_process');
const child=spawnSync(process.execPath,['-e','process.stdout.write("child-ok")'],{encoding:'utf8'});
if(child.status!==0 || child.stdout!=='child-ok') throw Error('execPath child failed');
require('node:fs').writeFileSync('installed.txt',require('fixture-dep')+':'+child.stdout);`,
    }, { pi: { extensions: ['probe.ts'] }, dependencies: { 'fixture-dep': '1.0.0' }, scripts: { postinstall: 'node postinstall.cjs' } });
    await publish('@fixture/broken', { 'broken.ts': "export default function() { throw Error('fixture-load-error'); }" }, { pi: { extensions: ['broken.ts'] } });
    }
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\npm-sdk-${process.pid}` : `@npm-sdk-${process.pid}`;
    bridge.listen(endpoint.startsWith('@') ? '\0' + endpoint.slice(1) : endpoint); await once(bridge, 'listening');
    const connection = once(bridge, 'connection', { signal: AbortSignal.timeout(20000) });
    const child = spawn(process.execPath, [bundle, endpoint], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    children.add(child); let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    [socket] = await connection; socket.setEncoding('utf8');
    const events = [], waiters = new Set(); let input = '', sequence = 0;
    socket.on('data', chunk => {
      input += chunk;
      for (let end; (end = input.indexOf('\n')) >= 0;) {
        const event = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
        events.push(event); for (const waiter of waiters) waiter(event);
        const result = event.type === 'apps_request' ? [{label:'Settings',packageName:'com.android.settings'}]
          : event.type === 'schedule_request' ? {tasks:[],records:[],exactAlarmGranted:false,schedulingError:'',timeZone:'UTC'}
          : event.type === 'shower_request' ? {ok:true,action:'screenshot',displayId:7,width:2400,height:2,dpi:320,
            imageWidth:2400,imageHeight:2,mimeType:'image/png',data:imageData} : undefined;
        if (result) socket.write(JSON.stringify({type:event.type.replace('_request','_response'),id:event.id,callId:event.callId,result}) + '\n');
      }
    });
    function waitFor(predicate) {
      const found = events.find(predicate); if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const check = event => { if (predicate(event)) { clearTimeout(timer); waiters.delete(check); resolve(event); } };
        const timer = setTimeout(() => { waiters.delete(check); reject(Error('Bridge timeout: ' + stderr)); }, 60000);
        waiters.add(check);
      });
    }
    const ready = await waitFor(event => event.type === 'ready');
    assert.equal(ready.piVersion, '1.0.0', 'shipped SDK version');
    assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(bundle), 'pi-sdk/package.json'))).version, ready.piVersion);
    if(!mcpOnly)assert.equal((await fs.readFile(path.join(path.dirname(bundle), 'photon_rs_bg.wasm'))).subarray(0,4).toString('hex'), '0061736d');
    if(!mcpOnly){
    const worker = new Worker(path.join(path.dirname(bundle), 'image-resize-worker.js'));
    try {
      const response = once(worker, 'message', {signal:AbortSignal.timeout(20000)});
      worker.postMessage({inputBytes:new Uint8Array(Buffer.from(imageData,'base64')),mimeType:'image/png',options:{maxWidth:1200}});
      const [message] = await response;
      assert(!message.error, message.error);
      assert(message.result, 'packaged Photon worker must not return null');
      assert.equal(message.result.width, 1200); assert.equal(message.result.height, 1);
      assert.equal(message.result.wasResized, true);
    } finally { await worker.terminate(); }
    }
    const config = { agentDir: path.join(root, 'agent'), cwd: path.join(root, 'workspace'), cacheDir: path.join(root, 'cache'),
      models: { providers: { fixture: { baseUrl: base + '/v1', api: 'openai-completions', models: [{ id: 'fixture', name: 'Fixture', input:['text','image'] }] } } },
      chatAttachmentRoot: path.join(root, 'attachments'),
      auth: { fixture: { type: 'api_key', key: 'synthetic-only' }, 'fixture-images': {type:'api_key',key:'synthetic-image-key'} } };
    await fs.mkdir(config.agentDir, { recursive: true }); await fs.mkdir(path.join(config.cwd, '.pi'), { recursive: true });
    const globalFile = path.join(config.agentDir, 'settings.json'), projectFile = path.join(config.cwd, '.pi/settings.json');
    await fs.writeFile(globalFile, JSON.stringify({ npmCommand: [process.execPath, npmCli], defaultProvider: 'fixture',
      defaultModel: 'fixture', defaultTools: [], retry: { enabled: false }, compaction: { enabled: false } }));
    await fs.writeFile(projectFile, '{}');
    async function query(type, args = {}, succeeds = true, options = {}) {
      const id = String(++sequence);
      const snapshot = { ...config, globalSettings: JSON.parse(await fs.readFile(globalFile)), projectSettings: JSON.parse(await fs.readFile(projectFile)) };
      snapshot.settings = {...snapshot.globalSettings, ...snapshot.projectSettings};
      const auth = event => {
        if (event.id !== id) return;
        const value = options.auth?.(event);
        if (event.type === 'auth_prompt' && options.auth) socket.write(JSON.stringify(value === null
          ? {type:'abort',id} : {type:'auth_reply',id,promptId:event.promptId,value}) + '\n');
      };
      waiters.add(auth);
      socket.write(JSON.stringify({ type, id, config: snapshot, ...args }) + '\n');
      const timer=options.abortAfter?setTimeout(()=>socket.write(JSON.stringify({type:'abort',id})+'\n'),options.abortAfter):undefined;
      let end;
      try { end = await waitFor(event => event.id === id && event.type === 'end'); } finally { waiters.delete(auth);clearTimeout(timer); }
      const current = events.filter(event => event.id === id);
      assert.equal(end.status, succeeds ? 'completed' : options.cancelled ? 'aborted' : 'error', JSON.stringify(current) + stderr);
      // Same persistence boundary as the native host: save settings before the next request snapshot.
      for (const event of current.filter(event => event.type === 'setting')) {
        const file = event.project ? projectFile : globalFile;
        const settings = JSON.parse(await fs.readFile(file));
        assert.deepEqual(settings[event.key] ?? null, event.previous);
        settings[event.key] = event.value; await fs.writeFile(file, JSON.stringify(settings));
      }
      return { result: current.find(event => event.type === 'result')?.result, events: current };
    }
    const originalSettings = await fs.readFile(globalFile, 'utf8');
    await require('./mcp-check.cjs')({query,config,nodeCommand:process.execPath,npmCli,setSettings:async patch=>{
      const settings=JSON.parse(await fs.readFile(globalFile));Object.assign(settings,patch);await fs.writeFile(globalFile,JSON.stringify(settings));
    }});
    await fs.writeFile(globalFile,originalSettings);
    if(mcpOnly)return;
    const initial = await query('prompt', { sdk: true, prompt: 'hello' });
    const history = initial.events.find(event => event.type === 'context').entries;
    const source = 'npm:@fixture/pi-probe';
    await query('install', { source }); await query('install', { source });
    let resources = (await query('resources')).result;
    const installed = resources.packages.find(item => item.source === source && item.scope === 'user');
    assert.equal(installed.version, '1.0.0');
    assert.equal(await fs.readFile(path.join(installed.installedPath, 'installed.txt'), 'utf8'), 'dependency-ok:child-ok');
    assert.equal(resources.packageExtensions.filter(item => item.source === source && item.loaded).length, 1);
    assert.equal(resources.packages.filter(item => item.source === source).length, 1, 'repeat install is deduplicated');
    const next = await query('prompt', { sdk: true, prompt: 'use probe', sdkHistory: history });
    assert(next.events.some(event => event.type === 'tool_end' && event.name === 'npm_probe' && !event.isError));
    const nextHistory = next.events.find(event => event.type === 'context').entries;
    assert.equal(nextHistory[0].id, history[0].id, 'same conversation survives installation');
    assert(requests.some(request => request.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('npm-probe-ok'))));
    await query('install', { source: 'npm:@fixture/broken' });
    resources = (await query('resources')).result;
    assert(resources.packageExtensions.find(item => item.source === 'npm:@fixture/broken').errors.some(error => error.error.includes('fixture-load-error')));
    assert.equal(resources.packageExtensions.find(item => item.source === source).errors.length, 0, 'unrelated package errors are not attributed');
    const extension = resources.packageExtensions.find(item => item.source === source);
    await query('resource_toggle', { kind: 'extensions', path: extension.path, enabled: false });
    assert((await query('resources')).result.packageExtensions.some(item => item.source === source && !item.enabled && !item.loaded));
    await query('resource_toggle', { kind: 'extensions', path: extension.path, enabled: null });
    const legacyProjectDir=path.join(config.cwd,'.pi/npm/node_modules/@fixture/pi-probe');
    await fs.mkdir(legacyProjectDir,{recursive:true});
    const legacyManifest=JSON.stringify({name:'@fixture/pi-probe',version:'1.0.0',pi:{extensions:['probe.ts']}});
    await fs.writeFile(path.join(legacyProjectDir,'package.json'),legacyManifest);
    await fs.writeFile(path.join(legacyProjectDir,'probe.ts'),'legacy-project-code');
    const legacySettings=JSON.stringify({packages:[source],defaultModel:'ignored-project-model'});
    await fs.writeFile(projectFile,legacySettings);
    await query('install', { source, project: true }, false);
    await query('remove', { source, project: true }, false);
    await query('update', { source, project: true }, false);
    resources = (await query('resources')).result;
    assert(resources.packageExtensions.some(item => item.source === source && item.scope === 'user' && item.loaded));
    assert(!resources.packageExtensions.some(item => item.scope === 'project'),'legacy project packages are ignored');
    await publish('@fixture/pi-pinned',{'probe.ts':'export default function() {}'},{pi:{extensions:['probe.ts']}});
    const pinned='npm:@fixture/pi-pinned@1.0.0';await query('install',{source:pinned});
    await publish('@fixture/pi-pinned',{'probe.ts':'export default function() {}'},{version:'2.0.0',pi:{extensions:['probe.ts']}});
    await query('update',{source:pinned});
    assert.equal((await query('resources')).result.packages.find(item=>item.source===pinned).version,'1.0.0','explicit pinned sources remain pinned');
    await query('remove',{source:pinned});
    await publish('@fixture/pi-probe',{'probe.ts':`import {Type} from 'typebox';
export default function(pi){pi.registerTool({name:'npm_probe',label:'Npm probe v2',description:'Version 2 fixture',parameters:Type.Object({}),
execute:async()=>({content:[{type:'text',text:'npm-probe-v2'}]})});}`},{version:'2.0.0',pi:{extensions:['probe.ts']}});
    await query('update',{source});
    resources=(await query('resources')).result;
    assert.equal(resources.packages.find(item=>item.source===source).version,'2.0.0','unpinned source updates v1 to v2');
    const updated=await query('prompt',{sdk:true,prompt:'use probe',sdkHistory:nextHistory});
    assert(updated.events.some(event=>event.type==='tool_end'&&event.name==='npm_probe'&&!event.isError&&JSON.stringify(event.result).includes('npm-probe-v2')),'same-process next turn executes v2, not cached v1');
    assert.equal(updated.events.find(event=>event.type==='context').entries[0].id,history[0].id,'update retains same conversation');
    assert.equal(await fs.readFile(projectFile,'utf8'),legacySettings,'global operations preserve old project settings bytes');
    assert.equal(await fs.readFile(path.join(legacyProjectDir,'package.json'),'utf8'),legacyManifest,'global update leaves old project package at v1');
    assert.equal(await fs.readFile(path.join(legacyProjectDir,'probe.ts'),'utf8'),'legacy-project-code');
    console.log('PASS: unpinned registry v1->v2; same-process same-chat next-turn v2 factory; explicit pin retained; old project package/settings bytes unchanged');
    await query('install', { source: 'npm:fixture-dep' });
    assert(!(await query('resources')).result.packageExtensions.some(item => item.source === 'npm:fixture-dep'), 'ordinary npm package is not a Pi extension');
    const before = await fs.readFile(globalFile, 'utf8');
    await query('install', { source: 'npm:missing-fixture' }, false);
    assert.equal(await fs.readFile(globalFile, 'utf8'), before, 'failed npm install does not persist a source');
    await query('remove', { source });
    assert(!(await query('resources')).result.packageExtensions.some(item => item.source === source));
    // These operations use disposable settings, attachments and native replies, never user data.
    await fs.writeFile(path.join(config.cwd, 'runtime-image.png'), Buffer.from(imageData, 'base64'));
    const extensions = path.join(config.agentDir, 'extensions');
    await fs.mkdir(extensions, {recursive:true});
    await fs.writeFile(path.join(extensions, 'fixture-images.ts'), `
export default function(pi) {
  const model = {type:'image',provider:'fixture-images',id:'paint',name:'Fixture image',api:'openrouter-images',
    input:['text'],output:['image'],baseUrl:'http://127.0.0.1'};
  pi.registerProvider({id:'fixture-images',name:'Fixture images',
    auth:{apiKey:{name:'Fixture key',resolve:async ({credential})=>credential?.key ? {auth:{apiKey:credential.key}} : undefined}},
    getModels:()=>[],getAllModels:()=>[model],
    stream:()=>{throw Error('image-only')},streamSimple:()=>{throw Error('image-only')},
    generateImages:async (selected,context,options)=>{
      if (options.apiKey !== 'synthetic-image-key' || context.input[0].text !== 'paint fixture') throw Error('image request auth/input');
      return {api:selected.api,provider:selected.provider,model:selected.id,stopReason:'stop',timestamp:Date.now(),
        output:[{type:'image',mimeType:'image/png',data:${JSON.stringify(imageData)}}],
        usage:{input:1,output:2,totalTokens:3,cost:{total:0.01}}};
    }});
}
`);
    const settings = JSON.parse(await fs.readFile(globalFile));
    settings.defaultTools = ['read','list_apps','search_apps','schedule_task','shower'];
    settings.conversationTitle = {model:'fixture/fixture'};
    await fs.writeFile(globalFile, JSON.stringify(settings));
    for (const [prompt, name, requestType] of [
      ['runtime list apps','list_apps','apps_request'], ['runtime search apps','search_apps','apps_request'],
      ['runtime schedule','schedule_task','schedule_request'], ['runtime read image','read',undefined],
    ]) {
      const turn = await query('prompt', {sdk:true,prompt});
      assert(turn.events.some(event=>event.type==='tool_end' && event.name===name && !event.isError), JSON.stringify(turn.events));
      if (requestType) assert.equal(turn.events.filter(event=>event.type===requestType).length, 1);
      assert.equal(turn.events.find(event=>event.type==='context').entries.findLast(entry=>entry.type==='session_info')?.name, 'fixture reply',
        'conversation-title uses the 1.0.0 agent_end/agent_settled lifecycle: ' + JSON.stringify(turn.events) + stderr);
      if (name === 'read') {
        const message = turn.events.find(event=>event.type==='message' && event.message.role==='tool').message;
        assert.match(message.content, /original 2400x2, displayed at 2000x2/);
        assert.equal(message.attachments.length, 1, 'bundled read processes and attaches a resized image');
      }
    }
    config.bundledShower = true;
    let screenshotHistory;
    for (let i=0; i<2; i++) {
      const turn = await query('prompt', {sdk:true,prompt:'runtime screenshot',sdkHistory:screenshotHistory});
      screenshotHistory = turn.events.find(event=>event.type==='context').entries;
      assert.equal(screenshotHistory.filter(entry=>entry.message?.role==='toolResult' && entry.message.toolName==='shower').length, i+1);
      const modelImages = JSON.stringify(requests.findLast(request=>request.tools?.length).messages).match(/data:image\/png;base64,/g) ?? [];
      assert.equal(modelImages.length, 1, 'shower-context keeps only the latest screenshot for the model');
      assert.equal(turn.events.find(event=>event.type==='message' && event.message.role==='tool').message.attachments.length, 1);
    }
    delete config.bundledShower;
    settings.defaultTools = ['+codemode']; settings.codemode = {mode:'only'}; delete settings.conversationTitle;
    await fs.writeFile(globalFile, JSON.stringify(settings));
    const coded = await query('prompt', {sdk:true,prompt:'runtime codemode'});
    const codeEnd = coded.events.find(event=>event.type==='tool_end' && event.name==='codemode');
    assert.equal(codeEnd.isError, false, JSON.stringify(codeEnd));
    const codeText = codeEnd.result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
    assert.match(codeText, /bash-structured-ok/);
    assert.match(codeText, /original 2400x2, displayed at 2000x2/);
    const painted = await query('prompt', {sdk:true,prompt:'generate fixture image'});
    const paintEnd = painted.events.find(event=>event.type==='tool_end' && event.name==='codemode');
    assert.equal(paintEnd.isError, false, JSON.stringify(paintEnd));
    const attachment = painted.events.find(event=>event.type==='message' && event.message.role==='tool').message.attachments[0];
    assert.equal(attachment.mimeType, 'image/png');
    const generated = paintEnd.result.content.find(part=>part.type==='image');
    assert(generated, 'generateImages output survives codemode image() processing');
    const savedImage = await fs.readFile(attachment.path);
    assert.deepEqual(savedImage, Buffer.from(generated.data,'base64'));
    assert.equal(savedImage.readUInt32BE(16), 2000, 'generated image is resized, not silently omitted');
    assert(painted.events.find(event=>event.type==='context').entries.some(entry=>entry.message?.role==='toolResult'
      && entry.message.content.some(part=>part.type==='image')), 'generated image remains in native history');
    assert(JSON.stringify(requests.at(-1).messages).includes('data:image/png;base64,'), 'generated image reaches the follow-up chat request');
    let installationId;
    for (const [providerId, previous, finish] of [
      ['anthropic',undefined,'abort'], ['openai',undefined,'abort'],
      ['openai','reuse','fail'], ['openai','','abort'],
    ]) {
      const globalSettings = JSON.parse(await fs.readFile(globalFile));
      if (previous === '') { globalSettings.deviceId = ''; await fs.writeFile(globalFile, JSON.stringify(globalSettings)); }
      const id = String(++sequence);
      const snapshot = {...config,globalSettings,projectSettings:{deviceId:'11111111-1111-4111-8111-111111111111'}};
      socket.write(JSON.stringify({type:'login',id,providerId,authType:'oauth',config:snapshot}) + '\n');
      const prompt = await waitFor(event=>event.id===id && (event.type==='auth_prompt' || event.type==='end'));
      assert.equal(prompt.type, 'auth_prompt', JSON.stringify(events.filter(event=>event.id===id)) + stderr);
      assert.equal(prompt.prompt.type, providerId === 'anthropic' ? 'select' : 'manual_code');
      const current = events.filter(event=>event.id===id);
      const changes = current.filter(event=>event.type==='setting');
      if (providerId === 'openai') {
        if (previous === 'reuse') assert.equal(changes.length, 0, 'existing installation ID is not rewritten');
        else {
          assert.equal(changes.length, 1);
          const change = changes[0];
          assert.equal(change.key, 'deviceId'); assert.equal(change.previous, previous ?? null); assert.equal(change.project, false);
          assert.match(change.value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          assert.equal(current[0], change, 'deviceId setting precedes auth and prompt');
          installationId = change.value;
          assert.equal(globalSettings.deviceId ?? null, change.previous);
          globalSettings.deviceId = change.value; await fs.writeFile(globalFile, JSON.stringify(globalSettings));
        }
        const authUrl = new URL(current.find(event=>event.type==='auth' && event.event.type==='auth_url').event.url);
        assert.equal(authUrl.searchParams.get('ext_agent_host_id'), 'urn:uuid:' + installationId, 'only global installation ID is used');
      } else assert.equal(changes.length, 0, 'flows not requesting a device ID leave settings unchanged');
      socket.write(JSON.stringify(finish === 'abort' ? {type:'abort',id}
        : {type:'auth_reply',id,promptId:prompt.promptId,value:'invalid-redirect-fixture'}) + '\n');
      assert.equal((await waitFor(event=>event.id===id && event.type==='end')).status, finish === 'abort' ? 'aborted' : 'error');
      if (providerId === 'openai') assert.equal(JSON.parse(await fs.readFile(globalFile)).deviceId, installationId,
        'cancel/failure does not lose the durable installation ID');
      assert(!events.some(event=>event.id===id && event.type==='credential'), 'cancel/failure does not mutate credentials');
    }
    console.log('PASS: Pi 1.0.0; Photon WASM + real resize worker/read; four bundled factories; codemode worker/bash structured exits; generateImages credentials/native history/chat attachment; bundled OAuth loaders/deviceId reuse, ordered persistence, cancel/failure (no external requests)');
    console.log('PASS: npm 11.6.2; scoped registry install; dependencies/postinstall/node/execPath; durable settings; fresh TS extension load; same-chat next-turn tool; filters/scopes/non-extension/errors/repeat install/remove');
  } finally {
    socket?.destroy();
    await Promise.all([...children].map(async child => { if (child.exitCode !== null || child.signalCode) return; const closed = once(child, 'close'); child.kill(); await closed; }));
    api.closeAllConnections();
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => bridge.close(resolve))]);
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
