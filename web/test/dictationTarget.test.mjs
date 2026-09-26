import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

// Run the real composer handlers with a tiny hook host; no browser, microphone or new test dependency.
const output = new URL('../../build/web-tests/dictation-target.mjs', import.meta.url);
await mkdir(new URL('.', output), {recursive:true});
await build({entryPoints:[fileURLToPath(new URL('../src/Chat.tsx', import.meta.url))],
  outfile:fileURLToPath(output), bundle:true, platform:'node', format:'esm',
  packages:'external', jsx:'automatic', logLevel:'silent', plugins:[{
    name:'composer-host', setup(build) {
      build.onResolve({filter:/^(react|\.\/ui|\.\/native|\.\/useKeyboardVisible)$/}, args => {
        if (args.namespace === 'composer-host' && args.path === 'react') return {path:'react', external:true};
        if (args.importer.endsWith('Chat.tsx')) return {path:args.path, namespace:'composer-host'};
      });
      build.onLoad({filter:/.*/, namespace:'composer-host'}, ({path}) => ({contents: {
        react:`export {memo} from 'react';
          export const useState = (...args) => globalThis.dictationHost.useState(...args);
          export const useRef = (...args) => globalThis.dictationHost.useRef(...args);
          export const useEffect = (...args) => globalThis.dictationHost.useEffect(...args);
          export const useLayoutEffect = useEffect;`,
        './ui':`export const useAction = () => globalThis.dictationHost.action;
          export const useText = () => zh => zh;
          export const errorText = String;
          export const Empty=()=>null, ErrorNotice=()=>null, Header=()=>null, Loading=()=>null, SearchField=()=>null, query=()=>null;`,
        './native':`export const Chat = {saveDraft: value => globalThis.dictationHost.saveDraft(value)};
          export const Device = {voice: value => globalThis.dictationHost.voice(value)};
          export const NativeSettings={}, ScheduledTasks={};`,
        './useKeyboardVisible':'export const useKeyboardVisible = () => false;',
      }[path]}));
    },
  }]});
const {ConversationComposer} = await import(output.href);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const conversation = (id, draft='') => ({id, draft, nodes:[], leaf:null, draftAttachments:[], piSelection:{}});
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
};

function host() {
  const slots = []; let cursor = 0; let effects = []; let tree; let props;
  const h = {
    saved:[], heard:[], running:null,
    action:{error:'', busy:false, setError:()=>{}, run: task => (h.running = task())},
    useState(initial) {
      const index = cursor++; slots[index] ??= {value:initial};
      return [slots[index].value, value => { slots[index].value = value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= {current:initial}; },
    useEffect(effect, deps) {
      const index = cursor++; const prior = slots[index];
      if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
        effects.push(() => { prior?.cleanup?.(); slots[index] = {deps, cleanup:effect()}; });
      }
    },
    async saveDraft(value) { h.saved.push(value); },
    voice(value) { const result = deferred(); h.heard.push({...value, ...result}); return result.promise; },
    render(next=props) {
      props = next; globalThis.dictationHost = h;
      // Second render observes state updates from effects, just as a committed React update does.
      for (let i = 0; i < 2; i++) {
        cursor = 0; effects = [];
        tree = ConversationComposer({running:false, selection:{}, refresh:async()=>{}, ...props});
        effects.forEach(effect => effect());
      }
    },
    start() { find(tree, node => node.props?.['aria-label'] === '语音输入').props.onClick(); return h.running; },
    draft() { h.render(); return find(tree, node => node.type === 'textarea').props.value; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
  return h;
}

for (const ids of [['A','B'], ['A','B','A']]) {
  test(`late dictation cannot replace input after ${ids.join(' → ')}`, async () => {
    const h = host(); h.render({conversation:conversation('A', 'original')});
    const pending = h.start(); await Promise.resolve();
    assert.deepEqual(h.saved, [{conversationId:'A', text:'original'}]);
    assert.equal(h.heard[0].conversationId, 'A');
    for (const id of ids.slice(1)) h.render({conversation:conversation(id, `${id} new input`)});
    h.heard[0].resolve({conversationId:'A', text:'original heard'});
    await pending;
    assert.equal(h.draft(), `${ids.at(-1)} new input`);
    h.unmount();
  });
}

test('normal completion applies text; only the latest request may update the input', async () => {
  const h = host(); h.render({conversation:conversation('A', 'prefix')});
  const first = h.start(); await Promise.resolve();
  const second = h.start(); await Promise.resolve();
  h.heard[1].resolve({conversationId:'A', text:'prefix newest'}); await second;
  assert.equal(h.draft(), 'prefix newest');
  h.heard[0].resolve({conversationId:'A', text:'prefix stale'}); await first;
  assert.equal(h.draft(), 'prefix newest'); h.unmount();
});

test('switching while draft save is pending does not start stale native listening', async () => {
  const h = host(); const save = deferred(); h.saveDraft = () => save.promise;
  h.render({conversation:conversation('A')}); const pending = h.start();
  h.render({conversation:conversation('B', 'keep')});
  save.resolve(); await pending;
  assert.equal(h.heard.length, 0); assert.equal(h.draft(), 'keep'); h.unmount();
});

test('archive, unmount and mismatched result targets invalidate completion', async () => {
  for (const change of ['archive', 'unmount', 'wrong-target']) {
    const h = host(); h.render({conversation:conversation('A', 'keep')});
    const pending = h.start(); await Promise.resolve();
    if (change === 'archive') h.render({conversation:conversation('A', 'keep'), archived:true});
    if (change === 'unmount') h.unmount();
    h.heard[0].resolve({conversationId:change === 'wrong-target' ? 'B' : 'A', text:'late'});
    await pending;
    assert.equal(h.draft(), 'keep'); h.unmount();
  }
});
