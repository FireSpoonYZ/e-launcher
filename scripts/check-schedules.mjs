// Browser interaction checks against the real React UI and an explicit in-memory native bridge fixture.
// No Android alarms or model requests are made. Native recurrence/delivery is covered by Java tests.
// Statutory calendar info below is an explicit UI fixture, NOT an official calendar implementation.
// node scripts/check-schedules.mjs [--serve] [--port=5178]
// --serve exposes http://127.0.0.1:5178/__schedule-check for visual inspection only.
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
  const listeners = name => subscriptions.get(name) ?? new Map();
  const emit = (name, value = {}) => { for (const fn of listeners(name).values()) fn(clone(value)); };
  const date = value => Date.parse(value + '+08:00');
  const device = {language: 'zh', theme: 'light', launchRoute: '/schedules', background: 'solid', backgroundMask: 63, homeRole: true, gestureStatus: '', canWriteSecureSettings: false, accessibilityConnected: false};
  let conversationId = 'chat-a';
  const conversations = [{id: 'chat-a', title: '整理本周计划', updated: Date.now()}, {id: 'chat-b', title: '阅读笔记', updated: Date.now()}];
  const state = {timeZone: 'Asia/Shanghai', now: Date.now(), localNow: new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00'), exactAlarmGranted: true, schedulingError: '', tasks: [
    {id: 'task-a', revision: 1, title: '早间简报', prompt: '汇总今天的重要资讯，整理成一份简报。', repeat: 'daily', time: '08:00', weekday: 1, monthDay: 1, enabled: true, createdAt: 1, nextRunAt: date('2026-09-16T08:00:00')},
    {id: 'task-b', revision: 1, title: '每周复盘', prompt: '总结本周进展。', repeat: 'weekly', time: '18:00', weekday: 5, monthDay: 1, enabled: true, createdAt: 2, nextRunAt: date('2026-09-18T18:00:00')},
    {id: 'task-c', revision: 1, title: '月度总结', prompt: '总结本月进展。', repeat: 'monthly', time: '20:00', weekday: 1, monthDay: 31, enabled: false, createdAt: 3, nextRunAt: 0},
  ], records: [
    {id: 'run-a', taskId: 'task-a', title: '早间简报', scheduledAt: date('2026-09-15T08:00:00'), startedAt: 1, finishedAt: 2, status: 'completed', reason: '', message: '', conversationId: 'chat-a', conversationAvailable: true},
    {id: 'run-b', taskId: 'task-b', title: '每周复盘', scheduledAt: date('2026-09-11T18:00:00'), startedAt: 1, finishedAt: 2, status: 'error', reason: '', message: '模型服务连接失败', conversationId: 'chat-b', conversationAvailable: true},
    {id: 'run-c', taskId: 'task-c', title: '月度总结', scheduledAt: date('2026-08-31T20:00:00'), startedAt: 0, finishedAt: 2, status: 'skipped', reason: 'missed', message: '', conversationId: null, conversationAvailable: false},
  ]};
  const original = clone(state);
  let calendarInfo = {calendarCoverage: '中国大陆 · 2026 年节假日安排'};
  const preview = rule => {
    if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(rule.time)) throw new Error('执行时间无效');
    const days = rule.weekdays ?? [rule.weekday];
    if (rule.repeat === 'weekly' && (!days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(days).size !== days.length)) throw new Error('请选择执行日');
    const now = Date.now(), local = new Date(now + 8 * 3600000);
    const [hour, minute] = rule.time.split(':').map(Number);
    for (let offset = 0; offset < 370; offset++) {
      const candidate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offset, hour, minute));
      if (rule.repeat === 'weekly' && !days.includes(candidate.getUTCDay() || 7)) continue;
      if (rule.repeat === 'monthly' && candidate.getUTCDate() !== rule.monthDay) continue;
      if (rule.repeat === 'statutoryWorkday' && (candidate.getUTCDay() || 7) > 5) continue;
      if (rule.repeat === 'statutoryHoliday' && (candidate.getUTCDay() || 7) <= 5) continue;
      if (candidate.getTime() - 8 * 3600000 > now) return {timeZone: state.timeZone, nextRunAt: candidate.getTime() - 8 * 3600000,
        ...(rule.repeat.startsWith('statutory') ? calendarInfo : {})};
    }
    throw new Error('无有效执行时间');
  };
  const fixture = window.scheduleFixture = {
    calls: [], state, failNextSave: false,
    calendar(value) { calendarInfo = clone(value); },
    set(value) { Object.assign(state, clone(value)); emit('ScheduledTasks:scheduleEvent'); },
    reset() { Object.assign(state, clone(original)); emit('ScheduledTasks:scheduleEvent'); },
    appearance(theme, language = 'zh') { Object.assign(device, {theme, language}); emit('Device:deviceEvent', device); },
  };
  const methods = {
    Device: {state: () => device, keyboardState: () => ({visible: false}), hideKeyboard: () => ({}), close: () => ({})},
    Settings: {settings: () => ({settings: {defaultModel: '测试模型'}})},
    Chat: {
      snapshot: () => ({sequence: 0, running: false, requestId: null, conversationId, conversation: {id: conversationId, leaf: null, nodes: [], draft: '', draftAttachments: [], piSelection: {}, archivedAt: 0}, activeRuns: [], extensionUi: {}}),
      listConversations: () => ({conversations}),
      listArchivedConversations: () => ({conversations: []}),
      selectConversation: ({conversationId: id}) => { conversationId = id; return methods.Chat.snapshot(); },
      newConversation: () => { conversationId = 'new-chat'; return methods.Chat.snapshot(); },
      archiveConversation: ({conversationId: id}) => { conversationId = id === conversationId ? 'new-chat' : conversationId; return methods.Chat.snapshot(); },
      restoreConversation: ({conversationId: id}) => { conversationId = id; return methods.Chat.snapshot(); },
      deleteConversation: ({conversationId: id}) => { conversationId = id === conversationId ? 'new-chat' : conversationId; return methods.Chat.snapshot(); },
    },
    ScheduledTasks: {
      snapshot: () => state,
      retryScheduling: () => { state.schedulingError = ''; emit('ScheduledTasks:scheduleEvent'); return state; },
      preview,
      save: input => {
        if (fixture.failNextSave) { fixture.failNextSave = false; throw new Error('模拟保存失败，请重试'); }
        if (!input.title.trim() || !input.prompt.trim()) throw new Error('不能为空');
        const index = state.tasks.findIndex(task => task.id === input.id);
        if (input.id && (index < 0 || state.tasks[index].revision !== input.revision)) throw new Error('任务已更改');
        const saved = {...(index < 0 ? {vibrate: false, deleteAfterRun: false} : state.tasks[index]), ...input, id: input.id ?? 'created-' + nextId++, revision: (input.revision ?? 0) + 1, enabled: index < 0 || state.tasks[index].enabled, createdAt: Date.now(), ...preview(input)};
        if (saved.repeat === 'weekly' && saved.weekdays?.length === 7) { saved.repeat = 'daily'; delete saved.weekdays; }
        if (!saved.enabled) saved.nextRunAt = 0;
        if (index < 0) state.tasks.push(saved); else state.tasks[index] = saved;
        emit('ScheduledTasks:scheduleEvent'); return state;
      },
      setEnabled: input => {
        const task = state.tasks.find(task => task.id === input.id);
        if (!task || task.revision !== input.revision) throw new Error('任务已更改');
        Object.assign(task, {enabled: input.enabled, revision: task.revision + 1, nextRunAt: input.enabled ? preview(task).nextRunAt : 0});
        emit('ScheduledTasks:scheduleEvent'); return state;
      },
      delete: ({id}) => { state.tasks = state.tasks.filter(task => task.id !== id); emit('ScheduledTasks:scheduleEvent'); return state; },
      requestExactAlarm: () => { state.exactAlarmGranted = true; emit('ScheduledTasks:scheduleEvent'); },
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

const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] ?? 5178);
const server = await createServer({server: {host: '127.0.0.1', port, strictPort: true}, plugins: [{
  name: 'schedule-ui-check-fixture',
  configureServer(server) {
    server.middlewares.use('/__schedule-check', async (_request, response) => {
      const html = await server.transformIndexHtml('/__schedule-check', `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Scheduled tasks UI check</title></head><body><div id="root"></div><script>(${installFixture.toString()})()</script><script type="module" src="/src/main.tsx"></script></body></html>`);
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
    });
  },
}]});
await server.listen();
const url = `http://127.0.0.1:${port}/__schedule-check`;
if (process.argv.includes('--serve')) {
  console.log('Browser fixture (not Android): ' + url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(); });
} else {
  const chrome = [process.env.CHROME_PATH, `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`, `${process.env['ProgramFiles(x86)']}/Microsoft/Edge/Application/msedge.exe`].find(path => path && existsSync(path));
  assert.ok(chrome, 'Set CHROME_PATH to Chrome or Edge');
  const output = await mkdtemp(join(tmpdir(), 'e-launcher-schedule-check-'));
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
    const wait = expression => evaluate(`new Promise((resolve,reject)=>{const observer=new MutationObserver(check);const timeout=setTimeout(()=>{observer.disconnect();reject(new Error('UI wait timed out: '+${JSON.stringify(expression)}))},10000);function check(){if(${expression}){clearTimeout(timeout);observer.disconnect();resolve(true)}}observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});check()})`);
    const click = selector => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});el.click()})()`);
    const clickText = text => evaluate(`(()=>{const el=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!el)throw new Error('Missing button '+${JSON.stringify(text)});el.scrollIntoView({block:'nearest'});el.click()})()`);
    const fill = (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing input');const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    const screenshot = async name => { const result = await call('Page.captureScreenshot', {format: 'png'}); await writeFile(join(output, name + '.png'), Buffer.from(result.data, 'base64')); };
    const resize = async (width, height) => {
      await call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: true});
      // App updates its viewport CSS from visualViewport asynchronously after CDP resize.
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    };
    const noHorizontalOverflow = async () => assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal page overflow');
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 1});
    await resize(390, 844);
    await call('Page.navigate', {url});
    await wait('document.querySelectorAll(".schedule-row").length===3');
    await screenshot('list'); await noHorizontalOverflow();
    await clickText('已暂停'); await wait('document.querySelectorAll(".schedule-row").length===1');
    await clickText('已启用'); await wait('document.querySelectorAll(".schedule-row").length===2');
    await clickText('全部');
    await click('.schedule-row [role="switch"]');
    await wait('document.querySelector(".schedule-row").classList.contains("is-paused")');
    await click('.schedule-row [role="switch"]');
    await wait('!document.querySelector(".schedule-row").classList.contains("is-paused")');

    await click('.schedule-page-footer button');
    await wait('document.querySelector(".schedule-editor")');
    await fill('input[maxlength="80"]', '验证任务'); await fill('textarea', '整理阅读笔记');
    await screenshot('editor');
    assert.equal(await evaluate('document.querySelectorAll(".schedule-editor input[type=date]").length'), 0, 'Once uses the next matching local time without an absolute date');
    assert.equal(await evaluate('document.querySelectorAll("[role=spinbutton]").length'), 2);
    await evaluate('document.querySelector("[aria-label=小时]").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}));document.querySelector("[aria-label=分钟]").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))');
    await wait('document.querySelector("[aria-label=小时]").getAttribute("aria-valuenow")==="23" && document.querySelector("[aria-label=分钟]").getAttribute("aria-valuenow")==="59"');
    await evaluate('document.querySelector("[aria-label=小时]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));document.querySelector("[aria-label=分钟]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
    await wait('document.querySelector("[aria-label=小时]").getAttribute("aria-valuenow")==="0" && document.querySelector("[aria-label=分钟]").getAttribute("aria-valuenow")==="0"');
    await evaluate('document.querySelector("[aria-label=小时]").scrollTop=18*48;document.querySelector("[aria-label=分钟]").scrollTop=30*48');
    await wait('document.querySelector("[aria-label=小时]").getAttribute("aria-valuenow")==="18" && document.querySelector("[aria-label=分钟]").getAttribute("aria-valuenow")==="30" && !document.querySelector(".schedule-save").disabled');
    await click('.schedule-cycle-link'); await screenshot('repeat-presets'); await clickText('自定义星期');
    await wait('document.querySelector(".schedule-repeat-days")');
    assert.ok(await evaluate('document.querySelector(".schedule-save").disabled'), 'Empty custom repeat cannot save');
    await click('[aria-label="周五"]'); await click('[aria-label="周一"]');
    await wait('!document.querySelector(".schedule-save").disabled');
    await screenshot('weekly'); await clickText('确定');
    await wait('document.querySelector(".schedule-cycle-link")');
    assert.match(await evaluate('document.querySelector(".schedule-cycle-link").textContent'), /每周 一、五/);
    await click('[aria-label="执行后删除"]');
    await wait('!document.querySelector(".schedule-save").disabled');
    await evaluate('scheduleFixture.failNextSave=true'); await clickText('保存');
    await wait('document.querySelector(".schedule-editor .inline-error")');
    assert.equal(await evaluate('document.querySelector("input[maxlength]").value'), '验证任务', 'Failed save lost form');
    await clickText('保存'); await wait('!document.querySelector(".schedule-sheet") && document.querySelectorAll(".schedule-row").length===4');
    let saved = await evaluate('scheduleFixture.state.tasks.find(task=>task.title==="验证任务")');
    assert.equal(saved.repeat, 'weekly'); assert.deepEqual(saved.weekdays, [1, 5]); assert.equal(saved.time, '18:30');
    assert.equal(saved.prompt, '整理阅读笔记'); assert.equal(saved.vibrate, true); assert.equal(saved.deleteAfterRun, true);

    await click('[aria-label="编辑 验证任务"]'); await wait('document.querySelector(".schedule-cycle-link")');
    await click('.schedule-cycle-link');
    assert.ok(await evaluate('[...document.querySelectorAll(".schedule-repeat-options button")].some(el=>el.textContent==="周一至周五")'));
    assert.ok(await evaluate('[...document.querySelectorAll(".schedule-repeat-options button")].some(el=>el.textContent==="周六日")'));
    await clickText('法定工作日'); await wait('document.querySelector(".schedule-editor").textContent.includes("中国大陆 · 2026 年节假日安排")');
    assert.ok(await evaluate('document.querySelector(".schedule-editor").textContent.includes("包含普通周末和公告放假，不含补班")'));
    await clickText('确定'); await wait('document.querySelector(".schedule-cycle-link") && !document.querySelector(".schedule-save").disabled');
    await clickText('保存'); await wait('!document.querySelector(".schedule-sheet")');
    saved = await evaluate('scheduleFixture.state.tasks.find(task=>task.title==="验证任务")');
    assert.equal(saved.repeat, 'statutoryWorkday'); assert.equal(saved.weekdays, undefined);
    await evaluate('scheduleFixture.calendar({calendarNotice:"所在国家或地区暂不支持法定节假日查询",calendarFallback:"暂按周六日执行"});scheduleFixture.set({timeZone:"Asia/Singapore"})');
    await click('[aria-label="编辑 验证任务"]'); await wait('document.querySelector(".schedule-cycle-link")');
    await click('.schedule-cycle-link'); await clickText('法定节假日');
    await wait('document.querySelector(".schedule-editor").textContent.includes("所在国家或地区暂不支持法定节假日查询")');
    assert.ok(await evaluate('document.querySelector(".schedule-editor").textContent.includes("暂按周六日执行")'));
    await screenshot('statutory-unsupported'); await clickText('确定');
    await wait('document.querySelector(".schedule-cycle-link") && !document.querySelector(".schedule-save").disabled');
    await clickText('保存'); await wait('!document.querySelector(".schedule-sheet")');
    saved = await evaluate('scheduleFixture.state.tasks.find(task=>task.title==="验证任务")');
    assert.equal(saved.repeat, 'statutoryHoliday');
    await evaluate('scheduleFixture.calendar({calendarCoverage:"中国大陆 · 2026 年节假日安排",calendarNotice:"2027 年法定节假日数据暂未公布或未更新",calendarFallback:"暂按周六日执行"});scheduleFixture.set({timeZone:"Asia/Shanghai"})');
    await click('[aria-label="编辑 验证任务"]');
    await wait('document.querySelector(".schedule-editor").textContent.includes("2027 年法定节假日数据暂未公布或未更新")');
    await screenshot('statutory-unknown-year');
    await evaluate('scheduleFixture.calendar({calendarCoverage:"中国大陆 · 2026, 2027 年节假日安排"});scheduleFixture.set({calendarVersion:"downloaded-2027"})');
    await wait('document.querySelector(".schedule-editor").textContent.includes("2026, 2027 年节假日安排") && !document.querySelector(".schedule-editor").textContent.includes("暂未公布")');
    await evaluate('scheduleFixture.calendar({calendarNotice:"所在国家或地区暂不支持法定节假日查询",calendarFallback:"暂按周六日执行"});scheduleFixture.set({timeZone:"Asia/Singapore"})');
    await wait('document.querySelector(".schedule-editor").textContent.includes("所在国家或地区暂不支持法定节假日查询") && !document.querySelector(".schedule-editor").textContent.includes("中国大陆 ·")');
    await evaluate('scheduleFixture.calendar({calendarCoverage:"中国大陆 · 2026 年节假日安排"});scheduleFixture.set({timeZone:"Asia/Shanghai"})');
    await wait('document.querySelector(".schedule-editor").textContent.includes("中国大陆 · 2026 年节假日安排") && !document.querySelector(".schedule-editor").textContent.includes("所在国家或地区暂不支持")');
    await click('.schedule-cancel');
    await wait('!document.querySelector(".schedule-sheet")');
    await evaluate('scheduleFixture.calendar({calendarCoverage:"中国大陆 · 2026 年节假日安排"})');

    await click('[aria-label="编辑 验证任务"]'); await wait('document.querySelector(".schedule-cycle-link")');
    // Synthetic touch exercises actual scroll snap, not Android finger acceptance.
    const wheel = await evaluate('document.querySelector("[aria-label=小时]").getBoundingClientRect().toJSON()');
    const touchX = Math.round(wheel.x + wheel.width / 2), touchY = Math.round(wheel.y + wheel.height / 2);
    await call('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: touchX, y: touchY}]});
    for (let step = 1; step <= 12; step++) {
      await call('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: touchX, y: touchY - step * 10}]});
      await evaluate('new Promise(resolve=>setTimeout(resolve,20))');
    }
    await call('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await evaluate('new Promise(resolve=>setTimeout(resolve,600))');
    await wait('!document.querySelector(".schedule-save").disabled');
    const touchTime = await evaluate('[...document.querySelectorAll("[role=spinbutton]")].map(el=>String(el.getAttribute("aria-valuenow")).padStart(2,"0")).join(":")');
    assert.notEqual(touchTime, '18:30', 'Touch gesture must move the hour wheel');
    assert.ok(await evaluate('[...document.querySelectorAll("[role=spinbutton]")].every(el=>Math.abs(el.scrollTop-Number(el.getAttribute("aria-valuenow"))*48)<1)'), 'Wheels snap to the selected time');
    await click('.schedule-cycle-link'); await clickText('每月（高级）'); await click('[aria-label="31 日"]');
    await wait('!document.querySelector(".schedule-save").disabled');
    assert.equal(await evaluate('document.querySelectorAll(".schedule-day-grid button").length'), 31);
    await screenshot('monthly'); await resize(320, 640); await noHorizontalOverflow();
    for (const selector of ['.schedule-save', '.schedule-cancel']) {
      const bounds = await evaluate('document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect().toJSON()');
      assert.ok(bounds.top >= 0 && bounds.bottom <= 640 && bounds.height >= 44 && bounds.right <= 320, 'Small-screen top action must stay visible');
    }
    await screenshot('monthly-small'); await clickText('确定'); await wait('document.querySelector(".schedule-cycle-link") && !document.querySelector(".schedule-save").disabled');
    await clickText('保存'); await wait('!document.querySelector(".schedule-sheet")');
    saved = await evaluate('scheduleFixture.state.tasks.find(task=>task.title==="验证任务")');
    assert.equal(saved.repeat, 'monthly'); assert.equal(saved.monthDay, 31); assert.equal(saved.time, touchTime);
    assert.equal(saved.prompt, '整理阅读笔记'); assert.equal(saved.deleteAfterRun, true);
    await click('[aria-label="编辑 月度总结"]'); await wait('document.querySelector(".schedule-cycle-link")');
    assert.match(await evaluate('document.querySelector(".schedule-cycle-link").textContent'), /每月 31 日/);
    await wait('!document.querySelector(".schedule-save").disabled');
    await clickText('保存'); await wait('!document.querySelector(".schedule-sheet")');
    assert.equal(await evaluate('scheduleFixture.state.tasks.find(task=>task.id==="task-c").repeat'), 'monthly');
    await resize(390, 844);
    await click('[aria-label="编辑 验证任务"]'); await fill('input[maxlength="80"]', '未保存');
    await click('.schedule-cancel'); await wait('document.querySelector(".schedule-discard")');
    await clickText('继续编辑'); await wait('document.querySelector("input[maxlength]")');
    assert.equal(await evaluate('document.querySelector("input[maxlength]").value'), '未保存');
    await click('.schedule-cancel'); await clickText('放弃修改');
    await wait('!document.querySelector(".schedule-sheet")');
    assert.ok(await evaluate('scheduleFixture.state.tasks.some(task=>task.title==="验证任务")'));
    await click('[aria-label="验证任务 的更多操作"]'); await clickText('删除任务');
    await clickText('取消'); await wait('!document.querySelector("[role=dialog]")');
    await click('[aria-label="验证任务 的更多操作"]'); await clickText('删除任务'); await clickText('删除');
    await wait('document.querySelectorAll(".schedule-row").length===3 && !document.querySelector("[role=dialog]")');
    assert.equal(await evaluate('scheduleFixture.state.records.length'), 3, 'Deleting a definition removed history');

    await click('.schedule-history-link'); await wait('document.querySelectorAll(".schedule-record").length===3');
    await screenshot('history'); await clickText('异常'); await wait('document.querySelectorAll(".schedule-record").length===2');
    await clickText('全部'); await click('.schedule-open-chat'); await wait('document.querySelector(".chat-page")');
    await click('[aria-label="会话列表"]'); await wait('document.querySelector(".drawer-schedules")');
    await screenshot('drawer'); await click('.drawer-schedules'); await wait('document.querySelectorAll(".schedule-row").length===3');
    await evaluate('scheduleFixture.appearance("dark")'); await wait('document.documentElement.dataset.theme==="dark"');
    await screenshot('dark-list'); await noHorizontalOverflow();
    await evaluate('scheduleFixture.set({schedulingError:"模拟闹钟安装失败"})');
    await wait('document.querySelector(".inline-error")'); await clickText('重新加载');
    await wait('!document.querySelector(".inline-error")');
    assert.ok(await evaluate('scheduleFixture.calls.some(call=>call.plugin==="ScheduledTasks" && call.name==="retryScheduling")'), 'Retry must reinstall the alarm, not only reload the snapshot');
    await evaluate('scheduleFixture.set({tasks:[],records:[],exactAlarmGranted:false});scheduleFixture.appearance("light")');
    await wait('document.querySelector(".schedule-permission") && document.querySelector(".schedule-empty")');
    await screenshot('empty-permission'); await clickText('去设置'); await wait('!document.querySelector(".schedule-permission")');
    await evaluate('scheduleFixture.reset();scheduleFixture.appearance("light","en")'); await resize(320, 640);
    await wait('document.documentElement.lang==="en" && document.querySelectorAll(".schedule-row").length===3');
    await noHorizontalOverflow(); await screenshot('english-small');
    assert.deepEqual(browserErrors, [], 'Browser runtime exceptions');
    const report = 'PASS: navigation; filters; switches; keyboard wrap; scroll and touch snap/save consistency; empty custom repeat blocked; multi-day create; switches and prompt retained; save failure; monthly and legacy round-trip; independent statutory rules/coverage/unsupported/unknown-year notices; 320px top actions; discard/delete; history; permission/retry; dark/English.\nNative bridge is a fixture, not real Android scheduling.\nScreenshots: ' + output;
    await writeFile(join(output, 'result.txt'), report); console.log(report);
  } finally { socket?.close(); browser.kill(); await server.close(); }
}
