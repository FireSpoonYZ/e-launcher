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

async function main() {
  const npmCli = path.resolve(process.argv[2]);
  const bundle = path.resolve(process.argv[3]);
  await fs.mkdir(os.tmpdir(), { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-sdk-check-'));
  const registry = new Map(), requests = [], children = new Set();
  const api = http.createServer(async (req, res) => {
    const url = decodeURIComponent(req.url);
    if (url === '/v1/chat/completions') {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body); requests.push(request);
      const last = request.messages.at(-1);
      const useTool = last.role === 'user' && JSON.stringify(last.content).includes('use probe');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
        function: { name: 'npm_probe', arguments: '{}' } }] } : { role: 'assistant', content: 'fixture reply' };
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
    assert.equal(await npm(['--version'], root), '11.6.2');
    async function publish(name, files, manifest = {}) {
      const dir = path.join(root, name.replace(/[@/]/g, '-')); await fs.mkdir(dir);
      const pkg = { name, version: '1.0.0', ...manifest };
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
      for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(dir, file), text);
      await npm(['pack', '--ignore-scripts'], dir);
      const archive = (await fs.readdir(dir)).find(file => file.endsWith('.tgz'));
      const bytes = await fs.readFile(path.join(dir, archive));
      registry.set(`/tar/${archive}`, bytes);
      pkg.dist = { tarball: `${base}/tar/${archive}`, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
      registry.set('/' + name, { name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': pkg } });
    }
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
    await waitFor(event => event.type === 'ready');
    const config = { agentDir: path.join(root, 'agent'), cwd: path.join(root, 'workspace'), cacheDir: path.join(root, 'cache'),
      models: { providers: { fixture: { baseUrl: base + '/v1', api: 'openai-completions', models: [{ id: 'fixture', name: 'Fixture' }] } } },
      auth: { fixture: { type: 'api_key', key: 'synthetic-only' } } };
    await fs.mkdir(config.agentDir, { recursive: true }); await fs.mkdir(path.join(config.cwd, '.pi'), { recursive: true });
    const globalFile = path.join(config.agentDir, 'settings.json'), projectFile = path.join(config.cwd, '.pi/settings.json');
    await fs.writeFile(globalFile, JSON.stringify({ npmCommand: [process.execPath, npmCli], defaultProvider: 'fixture',
      defaultModel: 'fixture', defaultTools: [], retry: { enabled: false }, compaction: { enabled: false } }));
    await fs.writeFile(projectFile, '{}');
    async function query(type, args = {}, succeeds = true) {
      const id = String(++sequence);
      const snapshot = { ...config, globalSettings: JSON.parse(await fs.readFile(globalFile)), projectSettings: JSON.parse(await fs.readFile(projectFile)) };
      socket.write(JSON.stringify({ type, id, config: snapshot, ...args }) + '\n');
      const end = await waitFor(event => event.id === id && event.type === 'end');
      const current = events.filter(event => event.id === id);
      assert.equal(end.status, succeeds ? 'completed' : 'error', JSON.stringify(current) + stderr);
      // Same persistence boundary as the native host: save settings before the next request snapshot.
      for (const event of current.filter(event => event.type === 'setting')) {
        const file = event.project ? projectFile : globalFile;
        const settings = JSON.parse(await fs.readFile(file));
        assert.deepEqual(settings[event.key] ?? null, event.previous);
        settings[event.key] = event.value; await fs.writeFile(file, JSON.stringify(settings));
      }
      return { result: current.find(event => event.type === 'result')?.result, events: current };
    }
    const initial = await query('prompt', { sdk: true, prompt: 'hello' });
    const history = initial.events.find(event => event.type === 'context').entries;
    const source = 'npm:@fixture/pi-probe@1.0.0';
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
    await query('install', { source, project: true });
    resources = (await query('resources')).result;
    assert(resources.packageExtensions.some(item => item.source === source && item.scope === 'project' && item.loaded));
    assert(!resources.packageExtensions.some(item => item.source === source && item.scope === 'user'), 'workspace override has explicit scope');
    await query('remove', { source, project: true });
    await query('install', { source: 'npm:fixture-dep' });
    assert(!(await query('resources')).result.packageExtensions.some(item => item.source === 'npm:fixture-dep'), 'ordinary npm package is not a Pi extension');
    const before = await fs.readFile(globalFile, 'utf8');
    await query('install', { source: 'npm:missing-fixture' }, false);
    assert.equal(await fs.readFile(globalFile, 'utf8'), before, 'failed npm install does not persist a source');
    await query('remove', { source });
    assert(!(await query('resources')).result.packageExtensions.some(item => item.source === source));
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
