// Browser layout checks for expanded tool text. Does not touch a device.
// node scripts/check-tool-details.mjs [--port=5181]
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';

const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] ?? 5181);
const server = await createServer({server: {host: '127.0.0.1', port, strictPort: true}});
await server.listen();
const url = `http://127.0.0.1:${port}/test/tool-preview.html`;
const chrome = [process.env.CHROME_PATH, `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`, `${process.env['ProgramFiles(x86)']}/Microsoft/Edge/Application/msedge.exe`].find(path => path && existsSync(path));
assert.ok(chrome, 'Set CHROME_PATH to Chrome or Edge');
const profile = join(await mkdtemp(join(tmpdir(), 'e-launcher-tool-details-')), 'browser-profile');
await mkdir(profile);
const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('Chrome startup timed out: ' + log)), 20000);
    browser.once('error', error => { clearTimeout(timeout); reject(error); });
    browser.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(new URL(match[1]).origin.replace('ws:', 'http:')); }
    });
  });
  const page = (await (await fetch(endpoint + '/json')).json()).find(item => item.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.onmessage = ({data}) => {
    const event = JSON.parse(data);
    if (event.method === 'Runtime.exceptionThrown') browserErrors.push(event.params.exceptionDetails);
    const request = pending.get(event.id);
    if (!request) return;
    pending.delete(event.id);
    event.error ? request.reject(new Error(JSON.stringify(event.error))) : request.resolve(event.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  const runAt = async (width, height) => {
    await call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 800});
    await call('Page.navigate', {url});
    await evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => window.toolPreview ? resolve(true) : Date.now() - start > 15000 ? reject(new Error('fixture timeout')) : setTimeout(tick, 50); tick(); })`);
    return evaluate(`import('/test/tool-preview-check.js').then(module => module.checkToolPreview())`);
  };
  const phone = await runAt(390, 844);
  const desktop = await runAt(1280, 720);
  assert.deepEqual(browserErrors, [], 'Browser runtime exceptions');
  console.log(`PASS tool details ${phone.passed} checks at ${phone.width}x${phone.height}; ${desktop.passed} checks at ${desktop.width}x${desktop.height}`);
} finally {
  socket?.close();
  browser.kill();
  await server.close();
}
