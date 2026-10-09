import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRecovery } from '../src/RemoteTerminal/recovery.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('foreground during connect coalesces; background-invalidated dial subscribes exactly once after resume', async () => {
  const dial=deferred(); let connects=0, subscribes=0;
  const recovery=createRecovery(async current => { connects++; await dial.promise; if(current()) subscribes++; }, assert.fail);
  const pending=recovery.wake(); await flush();
  assert.equal(recovery.resume(),pending);
  assert.equal(recovery.wake(),pending);
  recovery.pause(); recovery.resume(); recovery.resume();
  dial.resolve(); await pending; await flush();
  assert.equal(connects,2); assert.equal(subscribes,1);
  recovery.dispose();
});

test('foreground without background does not double subscribe an in-flight connect', async () => {
  const dial=deferred(); let subscribes=0;
  const recovery=createRecovery(async current => { await dial.promise; if(current()) subscribes++; }, assert.fail);
  const pending=recovery.wake(); recovery.resume(); recovery.resume();
  dial.resolve(); await pending; await flush();
  assert.equal(subscribes,1); recovery.dispose();
});

test('disconnect invalidates stale success and coalesces replacement; disposed view cannot publish', async () => {
  const dial=deferred(); const events=[]; let calls=0;
  const recovery=createRecovery(async current => { const id=++calls; await dial.promise; if(current()) events.push(id); }, assert.fail);
  const pending=recovery.wake(); await flush();
  recovery.invalidate(); recovery.wake(); recovery.wake();
  dial.resolve(); await pending; await flush();
  assert.deepEqual(events,[2]);
  const late=deferred(); const old=createRecovery(async current => { await late.promise; if(current()) events.push('old'); },assert.fail);
  const flight=old.wake(); old.dispose(); late.resolve(); await flight;
  assert.deepEqual(events,[2]); recovery.dispose();
});

for (const order of ['disconnect-first','rejection-first']) test('auth rejection remains terminal: '+order,async () => {
  const dial=deferred(); let calls=0; const errors=[];
  const recovery=createRecovery(async () => { calls++; await dial.promise; },e => errors.push(e.code));
  const pending=recovery.wake(); await flush();
  if(order === 'disconnect-first') { recovery.invalidate(); recovery.wake(); }
  dial.reject({code:'UNAUTHORIZED'}); await pending;
  if(order === 'rejection-first') { recovery.invalidate(); recovery.wake(); }
  await recovery.resume(); await flush();
  assert.equal(calls,1); assert.deepEqual(errors,['UNAUTHORIZED']); recovery.dispose();
});

test('coded pin event halts pending retry and NOT_FOUND does not loop',async () => {
  let calls=0;
  const recovery=createRecovery(async () => { calls++; throw {code:'NOT_FOUND'}; },() => {});
  await recovery.wake(); await recovery.resume(); assert.equal(calls,1);
  recovery.stop({code:'PIN_MISMATCH'}); await recovery.wake(); assert.equal(calls,1);
  recovery.dispose();
});

test('TerminalView subscription cleanup is scoped; recovery never sends mutations or resets canvas before snapshot', () => {
  const source=readFileSync(new URL('../src/RemoteTerminal/TerminalView.tsx',import.meta.url),'utf8');
  assert.match(source,/const subscriptionId = crypto.randomUUID\(\)/);
  assert.match(source,/'terminal.subscribe',\{sessionId,subscriptionId,displayMode:requestedDisplayMode.current/);
  assert.match(source,/'terminal.unsubscribe',\{sessionId,subscriptionId\}/);
  const recovery=source.slice(source.indexOf('const recovery = createRecovery'),source.indexOf('reconnect.current ='));
  assert.doesNotMatch(recovery,/terminal\.(send|create|close|claim|updateViewport)|term\.reset/);
  assert.match(source,/recovery\.pause\(\)/);
  assert.match(source,/recovery\.resume\(\)/);
});

test('failed dial plus disconnect backs off instead of hot-looping; dispose cancels timer', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const dial=deferred(); let calls=0, failures=0;
  const recovery=createRecovery(async () => { calls++; await dial.promise; },() => failures++);
  const pending=recovery.wake(); await flush();
  recovery.invalidate(); recovery.wake(); dial.reject({code:'CONNECT_FAILED'});
  await pending; await flush();
  assert.equal(calls,1); assert.equal(failures,1);
  t.mock.timers.tick(1999); await flush(); assert.equal(calls,1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls,2);
  recovery.dispose(); t.mock.timers.tick(5000); await flush(); assert.equal(calls,2);
});


test('session-change notification during delayed profiles refresh commits the newest list', async () => {
  const profiles=deferred(); let lists=0; let visible=[]; let sessions=['old'];
  const recovery=createRecovery(async current => {
    const captured=[...sessions]; lists++; await profiles.promise;
    if(current()) visible=captured;
  },assert.fail);
  const first=recovery.wake(); await flush();
  sessions=['old','new']; recovery.invalidate(); recovery.wake();
  profiles.resolve(); await first; await flush();
  assert.equal(lists,2); assert.deepEqual(visible,['old','new']);
  recovery.dispose();
  const source=readFileSync(new URL('../src/RemoteTerminal/index.tsx',import.meta.url),'utf8');
  assert.match(source,/terminal.listChanged'\) \{ recovery.invalidate\(\); void recovery.wake\(\); \}/);
});

test('taking control triggers mobile viewport fitting without a physical resize', () => {
  const source=readFileSync(new URL('../src/RemoteTerminal/TerminalView.tsx',import.meta.url),'utf8');
  assert.match(source,/void updateViewport\(\)[\s\S]*\[fontSize,owner\]\);/);
  assert.match(source,/setRecovering\(true\); setConnected\(false\); initialized = false/);
});
