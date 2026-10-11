// Real AlarmManager -> cold app process -> foreground service -> Pi -> configured model.
// node scripts/check-scheduled-alarms-device.mjs --serial=<explicit-adb-serial>
// Uses two temporary, text-only tasks. Keeps result conversations without changing the selected chat.
// Does not force-stop the app, replace configuration/preferences, or alter unrelated tasks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serial = process.argv.find(arg => arg.startsWith('--serial='))?.slice(9);
assert.ok(serial, 'Pass an explicit device serial');
const pkg = 'com.example.launcherprobe';
const artifacts = await mkdtemp(join(tmpdir(), 'e-launcher-alarm-device-'));
const checks = [];
const apkHash = createHash('sha256').update(await readFile(new URL('../app/build/outputs/apk/debug/app-debug.apk', import.meta.url))).digest('hex');
console.log('Artifacts: ' + artifacts);
let cdp, forwardPort, processRemoval;
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function adb(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ADB ?? 'adb', ['-s', serial, ...args], {stdio: ['pipe', 'pipe', 'pipe']});
    const out = [], err = [];
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error('adb ' + args.slice(0, 3).join(' ') + ': ' + Buffer.concat(err).toString() + Buffer.concat(out).toString()));
    });
    child.stdin.end(input);
  });
}
const shell = async command => (await adb(['shell', command])).toString().trim();
async function verifyApk() {
  const path = (await shell('pm path ' + pkg)).replace(/^package:/, '').trim();
  assert.equal((await shell('sha256sum ' + quote(path))).split(/\s+/)[0], apkHash, 'Installed APK changed or does not match this worktree build');
}
async function readPrivate(path) { return adb(['exec-out', 'run-as', pkg, 'cat', path]); }
const prefPath = 'shared_prefs/scheduled_tasks.xml';
const unescapeXml = value => value.replace(/&(quot|apos|lt|gt|amp|#\d+|#x[\da-fA-F]+);/g, (_, key) =>
  key[0] === '#' ? String.fromCodePoint(key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1)))
    : ({quot: '"', apos: "'", lt: '<', gt: '>', amp: '&'})[key]);
async function state() {
  const xml = (await readPrivate(prefPath)).toString();
  const value = /<string name="state">([\s\S]*?)<\/string>/.exec(xml);
  assert.ok(value, 'Native schedule state exists');
  return JSON.parse(unescapeXml(value[1]));
}
async function until(predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await predicate();
    if (last) return last;
    await pause(250);
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}
async function connect() {
  if (cdp) cdp.close();
  const pid = await until(async () => shell('pidof ' + pkg + ' || true'), 'app process', 30000);
  if (forwardPort) await adb(['forward', '--remove', 'tcp:' + forwardPort]);
  forwardPort = Number((await adb(['forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid])).toString().trim());
  const page = await until(async () => {
    try { return (await (await fetch('http://127.0.0.1:' + forwardPort + '/json')).json()).find(item => item.type === 'page'); }
    catch { return null; }
  }, 'debug WebView', 30000);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({data}) => {
    const message = JSON.parse(data), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  };
  socket.onclose = () => {
    for (const item of pending.values()) item.reject(new Error('WebView closed'));
    pending.clear();
  };
  cdp = {
    close: () => socket.close(),
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
    }),
  };
  await until(() => evaluate('!!window.Capacitor?.nativePromise'), 'native bridge', 30000);
}
async function evaluate(expression) {
  const result = await cdp.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const native = (method, input = {}) => evaluate('window.Capacitor.nativePromise("ScheduledTasks",' + JSON.stringify(method) + ',' + JSON.stringify(input) + ')');
async function open(taskId) {
  await shell('input keyevent KEYCODE_WAKEUP');
  await shell('wm dismiss-keyguard');
  await shell('am start -W -n ' + pkg + '/.MainActivity' + (taskId ? ' --es assistant_open_schedule ' + quote(taskId) : ''));
  await connect();
}
async function killBackground() {
  assert.equal(await evaluate('window.Capacitor.nativePromise("Chat","snapshot",{}).then(value=>value.activeRuns.length)'), 0, 'No active task may be interrupted');
  // Finish the Activity; a same-UID signal simulates process loss if the ROM ignores am kill.
  await evaluate('window.Capacitor.nativePromise("Device","close",{})').catch(() => {});
  cdp?.close(); cdp = null;
  await shell('am kill ' + pkg);
  processRemoval = 'am kill';
  const remaining = await shell('pidof ' + pkg + ' || true');
  if (remaining) {
    assert.match(remaining, /^\d+$/);
    await shell('run-as ' + pkg + ' kill -9 ' + remaining);
    processRemoval = 'same-UID SIGKILL (not force-stop)';
  }
  await until(async () => !(await shell('pidof ' + pkg + ' || true')), 'background process removed', 15000);
}
async function screenshot(name) { await writeFile(join(artifacts, name + '.png'), await adb(['exec-out', 'screencap', '-p'])); }
async function create(title, extra = {}) {
  const snap = await native('snapshot');
  const due = Math.ceil((snap.now + 45000) / 60000) * 60000;
  const time = new Intl.DateTimeFormat('en-GB', {timeZone: snap.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(due);
  const saved = await native('save', {title, prompt: title, repeat: 'once', time, vibrate: false, ...extra});
  return saved.tasks.find(task => task.title === title);
}
async function finished(task, expected = 'completed') {
  return until(async () => {
    const data = await state(), run = data.runs.find(item => item.taskId === task.id);
    if (run && ['completed', 'error', 'aborted', 'skipped'].includes(run.status)) {
      assert.equal(run.status, expected, JSON.stringify(run));
      return {data, run};
    }
    return null;
  }, task.title + ' -> ' + expected, 240000);
}
function pass(name, details = {}) {
  checks.push({name, ...details}); console.log('PASS: ' + name);
}
async function checkDevice() {
  const taskIds = [];
  const stamp = Date.now().toString(36);
  let originalConversation;
  const chat = (method, args = {}) => evaluate('window.Capacitor.nativePromise("Chat",' + JSON.stringify(method) + ',' + JSON.stringify(args) + ')');
  try {
    await verifyApk();
    await open();
    const original = await chat('snapshot');
    assert.equal(original.activeRuns.length, 0, 'Finish active conversations before cold-start verification');
    originalConversation = original.conversationId;
    assert.equal((await native('snapshot')).exactAlarmGranted, true, 'Allow alarms & reminders first');
    const selection = await evaluate('window.Capacitor.nativePromise("Settings","settings",{}).then(({settings})=>({provider:settings.defaultProvider,model:settings.defaultModel}))');
    assert.ok(selection.provider && selection.model, 'Configure a default model before device verification');
    for (const mode of ['alarmClock', 'exact']) {
      const marker = 'ALARM_OK_' + stamp + '_' + mode;
      const title = '定时验收 ' + stamp + ' ' + mode;
      const task = await create(title, {alarmMode: mode, deleteAfterRun: true,
        prompt: '这是一条定时功能连通性验证任务。不要调用任何工具，不要搜索，不要修改文件或操作其他应用。请只回复这一行：' + marker});
      taskIds.push(task.id);
      assert.equal(task.alarmMode, mode);
      const alarms = await shell('dumpsys alarm');
      await writeFile(join(artifacts, mode + '-alarms.txt'), alarms);
      assert.ok(alarms.includes(pkg) && alarms.includes('RUN_SCHEDULED_TASKS'));
      if (mode === 'alarmClock') assert.ok(alarms.includes('Alarm clock:') && alarms.includes('showIntent='));
      if (mode === 'exact') await killBackground();
      await open(task.id);
      await until(() => evaluate('document.querySelector("input[maxlength=\\"80\\"]")?.value === ' + JSON.stringify(title)), mode + ' task entry', 30000);
      await screenshot(mode + '-task-entry');
      assert.equal((await chat('snapshot')).activeRuns.length, 0, 'Do not interrupt unrelated active tasks');
      await killBackground();
      await shell('input keyevent KEYCODE_SLEEP');
      const delivered = await finished(task);
      assert.equal(delivered.data.runs.filter(run => run.taskId === task.id).length, 1, 'One receipt per occurrence');
      assert.ok(delivered.data.tasks.every(value => value.id !== task.id), 'Completed-only deletion');
      assert.equal(delivered.run.attempt, 1);
      await verifyApk();
      await open();
      assert.equal((await chat('snapshot')).conversationId, originalConversation, 'Background execution preserves the current chat');
      await until(async () => {
        const key = '<string name="history_' + delivered.run.conversationId + '">';
        const xml = await shell('run-as ' + pkg + ' grep -F ' + quote(key) + ' shared_prefs/chat.xml || true');
        const value = /<string[^>]*>([\s\S]*?)<\/string>/.exec(xml);
        if (!value) return false;
        const reply = JSON.parse(unescapeXml(value[1])).nodes.filter(node => node.role === 'assistant')
          .map(node => node.content ?? '').join('\n');
        return reply.includes(marker);
      }, 'actual model reply persisted with the expected marker', 15000);
      await screenshot(mode + '-result');
      pass('device ' + mode + ': process absent before alarm, screen off, real Pi/model result, no duplicate, completion-only deletion', {
        taskId: task.id, scheduledAt: delivered.run.scheduledAt, startedAt: delivered.run.startedAt,
        finishedAt: delivered.run.finishedAt, triggerDelayMs: delivered.run.startedAt - delivered.run.scheduledAt,
        conversationId: delivered.run.conversationId, marker, processRemoval,
      });
    }
    await evaluate('location.hash="/schedules/history"');
    await until(() => evaluate('!!document.querySelector(".schedule-record")'), 'device execution history', 15000);
    await screenshot('device-history');
    await verifyApk();
    await writeFile(join(artifacts, 'result.json'), JSON.stringify({serial, apkHash, selection, checks}, null, 2));
    console.log('Artifacts: ' + artifacts);
  } catch (error) {
    await writeFile(join(artifacts, 'failure.txt'), String(error.stack ?? error));
    const ownRuns = await state().then(data => data.runs.filter(run => taskIds.includes(run.taskId))).catch(() => []);
    await writeFile(join(artifacts, 'failure-state.json'), JSON.stringify({checks, ownRuns}, null, 2));
    throw error;
  } finally {
    // Never force-stop the phone, replace its preferences/configuration or touch unrelated definitions.
    if (taskIds.length) {
      if (!cdp) await open().catch(() => {});
      if (cdp) {
        const snap = await native('snapshot').catch(() => null);
        for (const task of snap?.tasks ?? []) {
          if (taskIds.includes(task.id)) await native('delete', {id: task.id, revision: task.revision});
        }
      }
    }
    cdp?.close();
    if (forwardPort) await adb(['forward', '--remove', 'tcp:' + forwardPort]).catch(() => {});
  }
}

await checkDevice();
