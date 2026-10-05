import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const {outputText} = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
  });
  const module = {exports: {}};
  new Function('require', 'module', 'exports', outputText)(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports);
  return module.exports;
}
const logic = load('../src/readiness.ts');
const model = {provider:'fixture', model:'chosen', revision:'r1', selectionConfigured:true, credentialSaved:true};
const passed = {provider:'fixture', model:'chosen', revision:'r1', checkedAt:1000, passed:true};
test('saved configuration is untested; provider checks are scoped to model, config and time', () => {
  assert.equal(logic.modelTestState(model, undefined, 1001), 'untested');
  assert.equal(logic.modelTestState(model, passed, 1001), 'passed');
  assert.equal(logic.modelTestState(model, {...passed, model:'first'}, 1001), 'otherModel');
  assert.equal(logic.modelTestState({...model, revision:'rotated-auth'}, passed, 1001), 'stale');
  assert.equal(logic.modelTestState({...model, provider:'another'}, passed, 1001), 'stale');
  assert.equal(logic.modelTestState(model, passed, 61000), 'stale');
  assert.equal(logic.modelTestState(model, passed, 999), 'stale');
  assert.equal(logic.modelTestState(undefined, passed, 1001), 'stale');
  assert.equal(logic.modelTestState(model, {...passed, passed:false}, 1001), 'failed');
});
test('missing, disconnected, denied and granted phone states have concrete localized next steps', () => {
  for (const t of [(zh,en)=>en, (zh,en)=>zh]) {
    const state = {shizukuInstalled:true, shizukuRunning:true, shizukuPermission:'granted', showerInstalled:true};
    const messages = [undefined, {...state,shizukuInstalled:false}, {...state,shizukuRunning:false},
      {...state,shizukuPermission:'denied'}, {...state,shizukuPermission:'notGranted'},
      {...state,showerInstalled:false}, state].map(value => logic.phoneGuidance(value,t));
    assert.equal(new Set(messages).size, messages.length);
    assert.ok(messages.every(message=>message.length>10));
  }
});
test('saved computers are never inferred connected or tested', () => {
  const t = (zh,en)=>en;
  assert.match(logic.computerGuidance({paired:1,connected:0},t), /no authenticated connection/);
  assert.match(logic.computerGuidance({paired:0,connected:0},t), /one-time pairing/);
  assert.match(logic.computerGuidance({paired:1,connected:1},t), /no commands/);
  assert.match(logic.computerGuidance(undefined,t), /not read/);
});
test('failed and timed-out reads are unknown and do not expose secret-bearing errors', async () => {
  const failed = await logic.observe(async()=>{throw new Error('private-api-token');});
  assert.equal(failed.value,undefined);
  assert.ok(!JSON.stringify(failed).includes('private'));
  const timed = await logic.observe(()=>new Promise(()=>{}), 5);
  assert.equal(timed.value,undefined);
  const good = await logic.observe(async()=>({paired:1,connected:0}));
  assert.equal(good.value.connected,0);
  assert.equal(logic.fresh(0,100),false);
});
test('screen renders three accessible localized sections and only safe refresh on mount', async () => {
  for (const english of [true,false]) {
    const effects=[], calls=[], refs=[];
    const hooks = {...require('react'), useState: value=>[typeof value==='function'?value():value,()=>{}],
      useRef:value=>{const ref={current:value}; refs.push(ref); return ref;}, useEffect:fn=>effects.push(fn)};
    const method = name=>async()=>{calls.push(name); return {};};
    const listen = async()=>({remove:async()=>{}});
    const {ReadinessPage}=load('../src/Readiness.tsx',{
      react:hooks,'react-router-dom':{useNavigate:()=>()=>{}},'./readiness':logic,
      './native':{Device:{capabilities:method('capabilities'),addListener:listen},NativeSettings:{readiness:method('readiness')}},
      './RemoteTerminal/native':{RemoteTerminal:{readiness:method('terminal-readiness'),addListener:listen}},
      './components/ui/dialog':{ConfirmDialog:'ConfirmDialog'},
      './ui':{Header:'Header',Row:'Row',Section:'Section',useText:()=>((zh,en)=>english?en:zh),query:method('forbidden-query')},
    });
    const tree=ReadinessPage();
    const children = Array.isArray(tree.props.children)?tree.props.children:[tree.props.children];
    const sections=children.filter(child=>child?.type==='Section');
    assert.equal(sections.length,3);
    assert.deepEqual(sections.map(section=>section.props.title),english?['Chat','Phone control','Connect a computer']:['聊天','操作手机','连接电脑']);
    assert.ok(children.some(child=>child?.props?.role==='status'&&child.props['aria-live']==='polite'));
    const dialog=children.find(child=>child?.type==='ConfirmDialog');
    assert.equal(dialog.props.open,false);
    assert.match(dialog.props.description,english ? /charges may apply/ : /可能产生费用/);
    const oldWindow=globalThis.window, oldDocument=globalThis.document;
    globalThis.window={setInterval:()=>1};
    globalThis.document={hidden:false,addEventListener(){},removeEventListener(){}};
    try {
      const cleanup=effects[0](); await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(calls.sort(),['capabilities','readiness','terminal-readiness']);
      cleanup();
    } finally { globalThis.window=oldWindow; globalThis.document=oldDocument; }
  }
});

test('stale observations are not rendered as current connections or grants', () => {
  const snapshot = {
    model:{value:model,checkedAt:1000},
    device:{value:{piInstalled:true,shizukuInstalled:true,shizukuRunning:true,shizukuPermission:'granted',showerInstalled:true,showerDisplayActive:true},checkedAt:1000},
    computer:{value:{paired:1,connected:1},checkedAt:1000},
  };
  let index=0;
  const states=[snapshot,61000,false,false,undefined,passed,''];
  const {ReadinessPage}=load('../src/Readiness.tsx',{
    react:{...require('react'),useState:()=>[states[index++],()=>{}],useRef:value=>({current:value}),useEffect(){}},
    'react-router-dom':{useNavigate:()=>()=>{}},'./readiness':logic,
    './native':{},'./RemoteTerminal/native':{},'./components/ui/dialog':{ConfirmDialog:'ConfirmDialog'},
    './ui':{Header:'Header',Row:'Row',Section:'Section',useText:()=>((zh,en)=>en)},
  });
  const tree=ReadinessPage();
  const encoded=JSON.stringify(tree,(key,value)=>typeof value==='symbol'?undefined:value);
  assert.ok(encoded.includes('Status is stale'));
  assert.ok(encoded.includes('Result is stale'));
  assert.ok(!encoded.includes('Binder currently reachable'));
  assert.ok(!encoded.includes('1 current connections'));
  assert.ok(!encoded.includes('Current chat has a display'));
});
test('confirmed probe refuses changed settings and repeated confirmation starts one request', async () => {
  for (const changed of [true,false]) {
    let stateIndex=0, requests=0;
    const effects=[], refs=[], states=[undefined,Date.now(),false,false,model,undefined,''];
    const {ReadinessPage}=load('../src/Readiness.tsx',{
      react:{...require('react'),useState:()=>[states[stateIndex++],()=>{}],useRef:value=>{const ref={current:value};refs.push(ref);return ref;},useEffect:fn=>effects.push(fn)},
      'react-router-dom':{useNavigate:()=>()=>{}},'./readiness':logic,
      './native':{Device:{capabilities:async()=>({}),addListener:async()=>({remove(){}})},NativeSettings:{readiness:async()=>changed?{...model,revision:'new'}:model}},
      './RemoteTerminal/native':{RemoteTerminal:{readiness:async()=>({}),addListener:async()=>({remove(){}})}},
      './components/ui/dialog':{ConfirmDialog:'ConfirmDialog'},
      './ui':{Header:'Header',Row:'Row',Section:'Section',useText:()=>((zh,en)=>en),query:async(operation,args)=>{
        requests++; assert.equal(operation,'test_provider'); assert.deepEqual(args,{providerId:'fixture',expectedReadinessRevision:'r1'});return {model:'chosen'};
      }},
    });
    const oldWindow=globalThis.window, oldDocument=globalThis.document;
    globalThis.window={setInterval:()=>1,setTimeout};
    globalThis.document={hidden:false,addEventListener(){},removeEventListener(){}};
    try {
      const tree=ReadinessPage(), cleanup=effects[0]();
      const dialog=tree.props.children.find(child=>child?.type==='ConfirmDialog');
      dialog.props.onConfirm(); dialog.props.onConfirm();
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(requests,changed?0:1);
      cleanup();
    } finally { globalThis.window=oldWindow;globalThis.document=oldDocument; }
  }
});

test('hiding during postflight cannot publish success or repopulate hidden observations', async () => {
  const effects=[], writes=[], states=[undefined,Date.now(),false,false,model,undefined,''];
  let stateIndex=0, reads=0, visibility, resolvePostflight;
  const {ReadinessPage}=load('../src/Readiness.tsx',{
    react:{...require('react'),useState:()=>{
      const index=stateIndex++; return [states[index],value=>writes.push({index,value})];
    },useRef:value=>({current:value}),useEffect:fn=>effects.push(fn)},
    'react-router-dom':{useNavigate:()=>()=>{}},'./readiness':logic,
    './native':{Device:{capabilities:async()=>({}),addListener:async()=>({remove(){}})},NativeSettings:{readiness:async()=>{
      reads++; if(reads===3) return new Promise(resolve=>{resolvePostflight=resolve;}); return model;
    }}},
    './RemoteTerminal/native':{RemoteTerminal:{readiness:async()=>({}),addListener:async()=>({remove(){}})}},
    './components/ui/dialog':{ConfirmDialog:'ConfirmDialog'},
    './ui':{Header:'Header',Row:'Row',Section:'Section',useText:()=>((zh,en)=>en),query:async()=>({model:'chosen'})},
  });
  const oldWindow=globalThis.window, oldDocument=globalThis.document;
  globalThis.window={setInterval:()=>1,setTimeout};
  globalThis.document={hidden:false,addEventListener:(_name,fn)=>{visibility=fn;},removeEventListener(){}};
  try {
    const tree=ReadinessPage(), cleanup=effects[0]();
    tree.props.children.find(child=>child?.type==='ConfirmDialog').props.onConfirm();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(reads,3);
    globalThis.document.hidden=true; visibility(); resolvePostflight(model);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(reads,3);
    assert.ok(!writes.some(write=>write.index===5&&write.value?.passed===true));
    cleanup();
  } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
});
