import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);

function harness(overrides = {}) {
  const slots = [], effects = [], calls = [], navigation = []; let cursor = 0;
  const action = {busy: false, error: '', async run(fn) { try { return await fn(); } catch (error) { action.error = error.message; } }};
  const fixture = {token: 'preview-1', title: 'Complete branches', nodes: 3, files: 7, bytes: 4096, workspace: true, excluded: 2, missingContexts: 0, encrypted: false};
  const api = {
    async prepareExport(value) { calls.push(['prepare', value]); return fixture; },
    async saveExport(value) { calls.push(['save', value]); return {cancelled: false}; },
    async chooseImport() { calls.push(['choose']); return fixture; },
    async restoreImport(value) { calls.push(['restore', value]); return {conversationId: 'new-copy'}; },
    async discard() { calls.push(['discard']); }, ...overrides,
  };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = {current: initial}; return slots[i]; },
    useEffect(fn) { const i = cursor++; if (!(i in slots)) { slots[i] = true; effects.push(fn); } },
  };
  const mocks = {
    react, 'react-router-dom': {useNavigate: () => (...args) => navigation.push(args)},
    '@capacitor/core': {registerPlugin: name => { assert.equal(name, 'ConversationBackup'); return api; }},
    './native': {Chat: {listConversations: async () => ({conversations: [{id: 'active', title: 'Active'}]}),
      listArchivedConversations: async () => ({conversations: [{id: 'archived', title: 'Archived', archivedAt: 1}]}),
      snapshot: async () => ({conversationId: 'active'})}},
    './ui': {Header: 'Header', Section: 'Section', ErrorNotice: 'ErrorNotice', useText: () => (_, en) => en, useAction: () => action},
  };
  const {outputText} = ts.transpileModule(readFileSync(new URL('../src/Backups.tsx', import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
  });
  const module = {exports: {}};
  new Function('require', 'module', 'exports', outputText)(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  const render = () => { cursor = 0; return module.exports.BackupsPage(); };
  const nodes = node => node && typeof node === 'object' ? [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)] : [];
  const find = (type, predicate = () => true) => nodes(render()).find(node => node.type === type && predicate(node.props));
  const button = label => find('button', props => [props.children].flat(Infinity).includes(label));
  render(); const cleanups = effects.map(effect => effect());
  return {calls, navigation, action, render, find, button, nodes, fixture,
    async ready() { await new Promise(resolve => setImmediate(resolve)); },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}

test('backup export binds the chosen conversation and defaults workspace off; save requires confirmation', async () => {
  const h = harness(); await h.ready();
  assert.equal(h.find('input').props.checked, false);
  h.find('select').props.onChange({target: {value: 'archived'}});
  h.button('Prepare and inspect backup').props.onClick(); await h.ready();
  assert.deepEqual(h.calls[0], ['prepare', {conversationId: 'archived', workspace: false}]);
  assert.equal(h.calls.some(([kind]) => kind === 'save'), false);
  assert.ok(h.button('Save unencrypted backup…'));
  h.button('Save unencrypted backup…').props.onClick(); await h.ready();
  assert.deepEqual(h.calls[1], ['save', {token: 'preview-1'}]);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.button('Save unencrypted backup…'), undefined);
});

test('import is inspected before clone confirmation and workspace restore defaults off', async () => {
  const h = harness(); await h.ready();
  h.button('Choose and inspect backup').props.onClick(); await h.ready();
  assert.deepEqual(h.calls, [['choose']]);
  assert.equal(h.nodes(h.render()).filter(node => node.type === 'input').at(-1).props.checked, false);
  h.button('Confirm restore as new conversation').props.onClick(); await h.ready();
  assert.deepEqual(h.calls[1], ['restore', {token: 'preview-1', workspace: false}]);
  assert.deepEqual(h.navigation, [['/chat/new-copy']]);
});

test('cancelled picker and failed restore never navigate or claim success', async () => {
  const cancelled = harness({chooseImport: async () => ({cancelled: true})}); await cancelled.ready();
  cancelled.button('Choose and inspect backup').props.onClick(); await cancelled.ready();
  assert.equal(cancelled.button('Confirm restore as new conversation'), undefined);
  assert.equal(cancelled.navigation.length, 0);
  const failed = harness({restoreImport: async () => { throw Error('Integrity check failed'); }}); await failed.ready();
  failed.button('Choose and inspect backup').props.onClick(); await failed.ready();
  failed.button('Confirm restore as new conversation').props.onClick(); await failed.ready();
  assert.equal(failed.navigation.length, 0); assert.equal(failed.action.error, 'Integrity check failed');
  assert.ok(failed.button('Confirm restore as new conversation'));
});

test('late backup preparation after unmount discards its staged preview', async () => {
  let finish;
  const h = harness({prepareExport: () => new Promise(resolve => { finish = resolve; })}); await h.ready();
  h.button('Prepare and inspect backup').props.onClick();
  h.unmount(); finish(h.fixture); await h.ready();
  assert.equal(h.calls.filter(([kind]) => kind === 'discard').length, 2);
  assert.equal(h.button('Save unencrypted backup…'), undefined);
});
