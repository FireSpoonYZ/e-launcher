// Browser checks for conversation archive UI against an in-memory Chat bridge.
// Native persistence/purge is covered by Java tests after the Android worker lands.
// node scripts/check-archive.mjs [--serve] [--port=5179]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

function installFixture() {
  const clone = value => structuredClone(value);
  const subscriptions = new Map();
  let nextId = 1;
  let sequence = 0;
  const listeners = name => subscriptions.get(name) ?? new Map();
  const emit = (name, value = {}) => { for (const fn of listeners(name).values()) fn(clone(value)); };
  const device = {language: 'zh', theme: 'light', launchRoute: '/chat', background: 'solid', backgroundMask: 63, canWriteSecureSettings: false, legacyNavigationPending: false, legacyNavigationStatus: '', shizukuStatus: ''};
  const now = Date.now();
  let conversationId = 'chat-a';
  const conversations = [
    {id: 'chat-a', title: '整理本周计划', updated: now - 1000},
    {id: 'chat-b', title: '阅读笔记', updated: now},
  ];
  const archived = [
    {id: 'chat-c', title: '旧对话', updated: now - 3 * 86400000, archivedAt: now - 2 * 86400000},
  ];
  const find = id => conversations.find(item => item.id === id) ?? archived.find(item => item.id === id);
  const snapshot = () => {
    const item = find(conversationId);
    return {
      sequence, running: false, requestId: null, conversationId,
      conversation: {id: conversationId, leaf: null, nodes: [], draft: '', draftAttachments: [], piSelection: {}, archivedAt: item?.archivedAt ?? 0},
      activeRuns: [], extensionUi: {},
    };
  };
  const emitChat = (type, id) => {
    sequence += 1;
    emit('Chat:chatEvent', {sequence, type, conversationId: id, requestId: null, payload: {}});
  };
  const fixture = window.archiveFixture = {
    calls: [],
    conversations, archived,
    active: () => conversationId,
  };
  const methods = {
    Device: {state: () => device, keyboardState: () => ({visible: false}), hideKeyboard: () => ({}), close: () => ({})},
    Settings: {settings: () => ({settings: {defaultModel: '测试模型'}})},
    ScheduledTasks: {snapshot: () => ({tasks: [], records: [], exactAlarmGranted: true, schedulingError: '', timeZone: 'Asia/Shanghai'})},
    Chat: {
      snapshot,
      listConversations: () => ({conversations: conversations.map(item => ({id: item.id, title: item.title, updated: item.updated}))}),
      listArchivedConversations: ({query} = {}) => {
        const needle = (query ?? '').trim().toLowerCase();
        const items = archived.map(item => ({id: item.id, title: item.title, updated: item.updated, archivedAt: item.archivedAt}));
        return {conversations: needle ? items.filter(item => item.title.toLowerCase().includes(needle)) : items};
      },
      selectConversation: ({conversationId: id}) => {
        if (!find(id)) throw new Error('会话不存在');
        conversationId = id;
        return snapshot();
      },
      newConversation: () => { conversationId = 'blank-' + nextId++; return snapshot(); },
      archiveConversation: ({conversationId: id}) => {
        const index = conversations.findIndex(item => item.id === id);
        if (index < 0) throw new Error('会话不存在');
        const item = conversations.splice(index, 1)[0];
        item.archivedAt = Date.now();
        archived.unshift(item);
        if (conversationId === id) conversationId = 'blank-' + nextId++;
        emitChat('conversationArchived', id);
        return snapshot();
      },
      restoreConversation: ({conversationId: id}) => {
        const index = archived.findIndex(item => item.id === id);
        if (index < 0) throw new Error('会话不存在');
        const item = archived.splice(index, 1)[0];
        const updated = item.updated;
        delete item.archivedAt;
        item.updated = updated;
        conversations.unshift(item);
        emitChat('conversationRestored', id);
        return snapshot();
      },
      deleteConversation: ({conversationId: id}) => {
        const before = conversations.length + archived.length;
        conversations.splice(0, conversations.length, ...conversations.filter(item => item.id !== id));
        archived.splice(0, archived.length, ...archived.filter(item => item.id !== id));
        if (conversations.length + archived.length === before) throw new Error('会话不存在');
        if (conversationId === id) conversationId = conversations[0]?.id ?? ('blank-' + nextId++);
        emitChat('conversationDeleted', id);
        return snapshot();
      },
      saveDraft: () => ({}),
      markTaskRead: () => ({}),
      send: ({conversationId: id}) => {
        if (find(id)?.archivedAt) throw new Error('请先恢复此会话');
        return {accepted: true, requestId: 'req-1'};
      },
    },
    App: {}, SystemBars: {setStyle: () => ({})},
  };
  window.Capacitor = {
    PluginHeaders: Object.entries(methods).map(([name, values]) => ({name, methods: [...Object.keys(values).map(name => ({name, rtype: 'promise'})), {name: 'addListener', rtype: 'callback'}, {name: 'removeListener', rtype: 'promise'}]})),
    nativePromise: async (plugin, name, args = {}) => {
      if (name === 'removeListener') { listeners(plugin + ':' + args.eventName).delete(args.callbackId); return; }
      fixture.calls.push({plugin, name, args: clone(args)});
      if (!methods[plugin]?.[name]) throw new Error('Fixture method not implemented: ' + plugin + '.' + name);
      return clone(await methods[plugin][name](args));
    },
    nativeCallback: (plugin, name, args, callback) => {
      if (name !== 'addListener') throw new Error('Unexpected native callback');
      const key = plugin + ':' + args.eventName;
      if (!subscriptions.has(key)) subscriptions.set(key, new Map());
      const id = 'listener-' + nextId++;
      subscriptions.get(key).set(id, callback);
      return Promise.resolve(id);
    },
  };
}

const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] ?? 5179);
const server = await createServer({server: {host: '127.0.0.1', port, strictPort: true}, plugins: [{
  name: 'archive-ui-check-fixture',
  configureServer(server) {
    server.middlewares.use('/__archive-check', async (_request, response) => {
      const html = await server.transformIndexHtml('/__archive-check', `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Archive UI check</title></head><body><div id="root"></div><script>(${installFixture.toString()})()</script><script type="module" src="/src/main.tsx"></script></body></html>`);
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
    });
  },
}]});
await server.listen();
const url = `http://127.0.0.1:${port}/__archive-check`;
if (process.argv.includes('--serve')) {
  console.log('Browser fixture (not Android): ' + url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(); });
} else {
  const chrome = [process.env.CHROME_PATH, `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`, `${process.env['ProgramFiles(x86)']}/Microsoft/Edge/Application/msedge.exe`].find(path => path && existsSync(path));
  assert.ok(chrome, 'Set CHROME_PATH to Chrome or Edge');
  const output = await mkdtemp(join(tmpdir(), 'e-launcher-archive-check-'));
  const profile = join(output, 'browser-profile');
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
        const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(new URL(match[1]).origin.replace('ws:', 'http:')); }
      });
    });
    const pages = await (await fetch(endpoint + '/json')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0; const pending = new Map(); const browserErrors = [];
    socket.onmessage = ({data}) => {
      const event = JSON.parse(data);
      if (event.method === 'Runtime.exceptionThrown') browserErrors.push(event.params.exceptionDetails);
      const request = pending.get(event.id); if (!request) return;
      pending.delete(event.id);
      event.error ? request.reject(new Error(JSON.stringify(event.error))) : request.resolve(event.result);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params}));
    });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const wait = expression => evaluate(`new Promise((resolve,reject)=>{
      const observer=new MutationObserver(check);
      const timeout=setTimeout(()=>{cleanup();reject(new Error('UI wait timed out: '+${JSON.stringify(expression)}+'; hash='+location.hash+'; active='+archiveFixture.active()+'; text='+document.body.innerText))},10000);
      function cleanup(){clearTimeout(timeout);observer.disconnect();window.removeEventListener('hashchange',check);window.removeEventListener('popstate',check)}
      function check(){if(${expression}){cleanup();resolve(true)}}
      observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
      window.addEventListener('hashchange',check);window.addEventListener('popstate',check);check();
    })`);
    const click = selector => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});el.click()})()`);
    const clickText = text => evaluate(`(()=>{const el=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('Missing button '+${JSON.stringify(text)});el.scrollIntoView({block:'nearest'});el.click()})()`);
    const screenshot = async name => { const result = await call('Page.captureScreenshot', {format: 'png'}); await writeFile(join(output, name + '.png'), Buffer.from(result.data, 'base64')); };
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    await call('Page.navigate', {url});
    await wait('document.querySelector(".chat-page") && location.hash === "#/chat/chat-a"');
    await click('[aria-label="会话列表"]');
    await wait('document.querySelectorAll(".conversation-row").length===2');
    await click('.conversation-row:not(.selected) > button:first-child');
    await wait('location.hash === "#/chat/chat-b" && !document.querySelector(".drawer")');
    await click('[aria-label="会话列表"]');
    await wait('document.querySelectorAll(".conversation-row").length===2');
    await click('.conversation-row:not(.selected) > button:first-child');
    await wait('location.hash === "#/chat/chat-a" && !document.querySelector(".drawer")');
    await click('[aria-label="会话列表"]');
    await wait('document.querySelectorAll(".conversation-row").length===2');
    assert.equal(await evaluate('!!document.querySelector("[role=dialog] .conversation-row .icon-button[aria-label=\\"归档会话\\"]")'), true);
    assert.equal(await evaluate('document.querySelectorAll("[role=dialog] .conversation-row [aria-label=\\"永久删除\\"]").length'), 1, 'Only the current conversation keeps permanent delete');
    await screenshot('drawer');
    await click('.conversation-row:not(.selected) [aria-label="归档会话"]');
    await wait('document.querySelector(".archive-undo") && document.querySelectorAll(".conversation-row").length===1');
    assert.equal(await evaluate('!!document.querySelector("[role=dialog].dialog-content:not(.drawer)")'), false, 'Archive must not open a confirm dialog');
    assert.equal(await evaluate('archiveFixture.archived.some(item=>item.title==="阅读笔记")'), true);
    assert.equal(await evaluate('archiveFixture.conversations.some(item=>item.title==="阅读笔记")'), false);
    await screenshot('undo');
    await clickText('撤销');
    await wait('!document.querySelector(".archive-undo")');
    await click('[aria-label="会话列表"]');
    await wait('document.querySelectorAll(".conversation-row").length===2');
    await click('.drawer-archived');
    await wait('document.querySelector(".archived-page")');
    assert.match(await evaluate('document.querySelector(".archive-ttl").textContent'), /14 天/);
    assert.match(await evaluate('[...document.querySelectorAll(".conversation-row")].find(row=>row.textContent.includes("旧对话")).textContent'), /剩余/);
    await screenshot('archived');
    await click('.conversation-row button');
    await wait('document.querySelector(".archive-banner")');
    assert.equal(await evaluate('document.querySelector(".composer textarea").disabled'), true);
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"发送\\"]").disabled'), true);
    await screenshot('readonly');
    await clickText('恢复会话');
    await wait('!document.querySelector(".archive-banner")');
    assert.equal(await evaluate('document.querySelector(".composer textarea").disabled'), false);
    await click('[aria-label="会话列表"]');
    await wait('document.querySelector(".conversation-row.selected [aria-label=\\"归档会话\\"]")');
    await click('.conversation-row.selected [aria-label="归档会话"]');
    await wait('document.querySelector(".archive-undo") && !document.querySelector("[role=dialog].drawer, .dialog-content.drawer")');
    assert.ok(await evaluate('archiveFixture.active().startsWith("blank-")'), 'Archiving the current conversation must leave it');
    assert.equal(await evaluate('location.hash'), '#/chat/' + await evaluate('archiveFixture.active()'), 'The native read-state gate must see the active conversation route');
    await click('[aria-label="会话列表"]');
    await click('.drawer-archived');
    await wait('document.querySelectorAll(".archived-page .conversation-row").length>=1');
    await click('.archived-page .conversation-row [aria-label="永久删除"]');
    await wait('document.querySelector(".danger-button")');
    await clickText('取消');
    await wait('!document.querySelector(".danger-button")');
    await click('.archived-page .conversation-row [aria-label="永久删除"]');
    await clickText('确认');
    await wait('!document.querySelector(".danger-button")');
    assert.deepEqual(browserErrors, [], 'Browser runtime exceptions');
    const report = 'PASS: drawer archive without confirm; undo; 14-day archived list; restore-before-send; current-session archive leaves chat; confirmed permanent delete.\nNative bridge is a fixture.\nScreenshots: ' + output;
    await writeFile(join(output, 'result.txt'), report); console.log(report);
  } finally { socket?.close(); browser.kill(); await server.close(); }
}
