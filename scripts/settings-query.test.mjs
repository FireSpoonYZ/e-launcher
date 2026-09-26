import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function loadSource(path, mocks, extra = '') {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8') + extra;
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }});
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(
    name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  return module.exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const listeners = new Set(), starts = [], cancels = [];
  let removed = 0;
  const native = {
    async addListener(_, receive) {
      listeners.add(receive);
      return { async remove() { assert.ok(listeners.delete(receive)); removed++; } };
    },
    async query(options) {
      assert.ok(listeners.size, 'subscribe before starting');
      const start = { ...deferred(), options };
      starts.push(start);
      return start.promise;
    },
    async cancelQuery({ requestId }) { cancels.push(requestId); },
  };
  const ui = loadSource('../web/src/ui.tsx', { './native': { NativeSettings: native } });
  const emit = event => { for (const receive of listeners) receive(event); };
  const end = (id, result) => { emit({ id, type: 'result', result }); emit({ id, type: 'end', status: 'completed' }); };
  return { native, ui, starts, cancels, listeners, emit, end, removed: () => removed };
}

test('parallel queries keep IDs isolated, including buffered fast completion and old end', async () => {
  const h = harness(), controller = new AbortController();
  const old = h.ui.query('catalog');
  const login = h.ui.query('login', {}, undefined, controller.signal);
  const cancelled = assert.rejects(login, { name: 'AbortError' });
  await tick();
  h.end('old', ['catalog']);
  h.starts[0].resolve({ requestId: 'old', cancellable: true });
  h.starts[1].resolve({ requestId: 'login', cancellable: true });
  assert.deepEqual(await old, ['catalog']);
  h.end('old', 'duplicate');
  assert.equal(h.listeners.size, 1);
  controller.abort();
  await cancelled;
  assert.deepEqual(h.cancels, ['login']);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.removed(), 2);
});

test('aborting a completed query does not cancel a newer request', async () => {
  const h = harness(), controller = new AbortController();
  const completed = h.ui.query('login', {}, undefined, controller.signal);
  await tick();
  h.end('completed', 'signed in');
  h.starts[0].resolve({ requestId: 'completed', cancellable: true });
  assert.equal(await completed, 'signed in');
  const newer = h.ui.query('catalog');
  await tick();
  controller.abort();
  assert.deepEqual(h.cancels, []);
  h.starts[1].resolve({ requestId: 'newer', cancellable: true });
  h.end('newer', []);
  await newer;
  assert.equal(h.listeners.size, 0);
});

test('cancel while native startup is pending settles immediately and cancels its late ID', async () => {
  const h = harness(), controller = new AbortController();
  const pending = h.ui.query('login', {}, undefined, controller.signal);
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  await tick();
  controller.abort();
  await cancelled;
  assert.equal(h.listeners.size, 0);
  h.starts[0].resolve({ requestId: 'late-login', cancellable: true });
  await tick();
  assert.deepEqual(h.cancels, ['late-login']);
  assert.equal(h.removed(), 1);
});

test('cancel before subscription resolves removes the late listener without starting a query', async () => {
  const h = harness(), subscription = deferred(), controller = new AbortController();
  const subscribe = h.native.addListener;
  h.native.addListener = async (...args) => { await subscription.promise; return subscribe(...args); };
  const pending = h.ui.query('login', {}, undefined, controller.signal);
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  subscription.resolve();
  await tick();
  assert.equal(h.starts.length, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.removed(), 1);
});

test('already aborted signals never subscribe or start', async () => {
  const h = harness(), controller = new AbortController();
  controller.abort();
  await assert.rejects(h.ui.query('login', {}, undefined, controller.signal), { name: 'AbortError' });
  assert.equal(h.starts.length, 0);
  assert.equal(h.removed(), 0);
});

test('startup failures, buffered errors, and throwing event handlers reject and clean listeners', async () => {
  for (const mode of ['startup', 'event', 'callback', 'subscribe']) {
    const h = harness();
    if (mode === 'subscribe') h.native.addListener = async () => { throw new Error('subscribe failed'); };
    const pending = h.ui.query('catalog', {}, mode === 'callback' ? () => { throw new Error('callback failed'); } : undefined);
    const rejected = assert.rejects(pending, new RegExp(`${mode} failed`));
    await tick();
    if (mode === 'startup') h.starts[0].reject(new Error('startup failed'));
    else if (mode !== 'subscribe') {
      h.emit({ id: 'fast', type: 'error', message: 'event failed' });
      h.emit({ id: 'fast', type: 'end', status: 'error' });
      h.starts[0].resolve({ requestId: 'fast', cancellable: true });
    }
    await rejected;
    assert.equal(h.listeners.size, 0);
    assert.equal(h.removed(), mode === 'subscribe' ? 0 : 1);
  }
});

test('package mutations remain non-cancellable', async () => {
  for (const operation of ['install', 'update', 'remove']) {
    const h = harness(), controller = new AbortController();
    const pending = h.ui.query(operation, {}, undefined, controller.signal);
    await tick();
    controller.abort();
    h.starts[0].resolve({ requestId: operation, cancellable: false });
    h.end(operation, 'done');
    assert.equal(await pending, 'done');
    assert.deepEqual(h.cancels, []);
    assert.equal(h.listeners.size, 0);
  }
});

test('LoginFlow close and effect cleanup cancel only their own late login, not concurrent queries', async () => {
  for (const dismiss of ['close', 'unmount']) {
    const h = harness(), effects = [], cleanups = [];
    let closed = 0;
    const react = {
      useState: initial => [initial, () => {}], useRef: current => ({ current }),
      useEffect: effect => effects.push(effect),
    };
    const { LoginFlow } = loadSource('../web/src/Resources.tsx', {
      react, './native': { NativeSettings: h.native }, './Settings': {}, './components/ui/dialog': {},
      './ui': { ...h.ui, useText: () => (_, en) => en, useAction: () => ({ setError: assert.fail }) },
    }, '\nexport { LoginFlow };');
    const dialog = LoginFlow({ provider: { id: 'provider' }, method: 'oauth', close: () => closed++ });
    for (const effect of effects) cleanups.push(effect());
    const catalog = h.ui.query('catalog');
    await tick();
    if (dismiss === 'close') dialog.props.onOpenChange(false);
    for (const cleanup of cleanups) cleanup();
    await tick();
    h.starts[0].resolve({ requestId: 'login', cancellable: true });
    h.starts[1].resolve({ requestId: 'catalog', cancellable: true });
    h.end('catalog', []);
    await catalog;
    await tick();
    assert.deepEqual(h.cancels, ['login']);
    assert.equal(closed, dismiss === 'close' ? 1 : 0);
    assert.equal(h.listeners.size, 0);
  }
});
