import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encodeModifiedText} from '../src/RemoteTerminal/input.ts';
import {createAccessoryPress} from '../src/RemoteTerminal/accessory-press.ts';
import {normalizePresets,mutatePreset,savePresets,loadPresets,presetInput} from '../src/RemoteTerminal/presets.ts';
const legacy={applicationCursor:false,bracketedPaste:false,kittyFlags:0};
test('accessory tap dispatches on release exactly once, never on press-in',()=>{
 let calls=0;const p=createAccessoryPress(()=>calls++);p.start(1,100,100);assert.equal(calls,0);p.end(1,102,100);p.end(1,102,100);assert.equal(calls,1);
});
test('horizontal and vertical swipes cancel activation including return to origin',()=>{
 let calls=0;const p=createAccessoryPress(()=>calls++);for(const [x,y]of [[30,0],[0,30]]){p.start(1,100,100);p.move(1,100+x,100+y);p.end(1,100,100);}assert.equal(calls,0);
});
test('hold starts after stationary threshold and release does not duplicate',context=>{
 context.mock.timers.enable({apis:['setTimeout']});let taps=0,holds=0,releases=0;const p=createAccessoryPress(()=>taps++,()=>holds++,()=>releases++);
 p.start(1,0,0);context.mock.timers.tick(449);assert.equal(holds,0);context.mock.timers.tick(1);assert.equal(holds,1);p.end(1,0,0);assert.equal(taps,0);assert.ok(releases>0);
 p.start(2,0,0);p.move(2,10,0);context.mock.timers.tick(1000);p.end(2,10,0);assert.equal(holds,1);assert.equal(taps,0);
});
test('pointer cancellation and cleanup cannot dispatch or repeat',context=>{
 context.mock.timers.enable({apis:['setTimeout']});let calls=0;const p=createAccessoryPress(()=>calls++,()=>calls++);p.start(1,0,0);p.cancel();context.mock.timers.tick(1000);p.end(1,0,0);assert.equal(calls,0);p.start(2,0,0);p.end(3,0,0);assert.equal(calls,0);
});
test('custom combination persists editable binding, order and deletion with legacy/Kitty encoding',()=>{
 const stored=new Map(),storage={getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)};let list=[];
 for(const [i,modifiers]of [['ctrl','shift'],['ctrl','alt']].entries())list=mutatePreset(list,{type:'upsert',command:{id:String(i),label:'combo '+i,kind:'chord',chord:{key:i?'k':'arrowRight',modifiers}}});
 assert.equal(presetInput(list[0],legacy),'\x1b[1;6C');assert.equal(presetInput(list[1],legacy),'\x1b\x0b');
 list=mutatePreset(list,{type:'upsert',command:{...list[1],label:'Word key'}}).reverse();savePresets(storage,list);assert.deepEqual(loadPresets(storage),list);
 list=mutatePreset(list,{type:'delete',id:'0'});savePresets(storage,list);assert.equal(loadPresets(storage).length,1);assert.equal(presetInput(list[0],{...legacy,kittyFlags:1}),'\x1b[107;7u');
 const enhanced=normalizePresets([{id:'number',label:'Ctrl+1',kind:'chord',chord:{key:'1',modifiers:['ctrl']}}])[0];
 assert.equal(presetInput(enhanced,legacy),'');assert.equal(presetInput(enhanced,{...legacy,kittyFlags:1}),'\x1b[49;5u');
 assert.throws(()=>normalizePresets([{id:'bad',label:'bad',kind:'chord',chord:{key:'invalid',modifiers:['ctrl']}}]));
});
test('Android minimum is 33 in host/server and target remains 36',()=>{
 for(const name of ['app/build.gradle','shower-server/build.gradle']){const text=readFileSync(new URL('../../'+name,import.meta.url),'utf8');assert.match(text,/minSdk 33\b/);assert.match(text,/targetSdk 36\b/);}
});
test('swipe strip keeps keys nonshrinking, native pan-x and customization reachable',()=>{
 const css=readFileSync(new URL('../src/RemoteTerminal/terminal.css',import.meta.url),'utf8'),button=readFileSync(new URL('../src/RemoteTerminal/AccessoryButton.tsx',import.meta.url),'utf8'),editor=readFileSync(new URL('../src/RemoteTerminal/PresetPanel.tsx',import.meta.url),'utf8');
 assert.match(css,/\.rt-key-scroll \{ overflow-x:auto;/);assert.match(css,/touch-action:pan-x/);assert.match(css,/flex:0 0 auto/);assert.match(button,/if\(e.detail===0 && !disabled\) onPress\(\)/);assert.match(button,/onMouseDown=\{e=>e.preventDefault\(\)\}/);assert.match(editor,/disabled=\{!valid \|\| saving \|\| !ready\}/);assert.match(editor,/describeShortcut\(draft.chord\)/);assert.match(editor,/rt-manage-keys/);
});

test('mixed unsupported modified text is rejected atomically and Kitty can encode it',()=>{
 assert.equal(encodeModifiedText('a1b',['ctrl'],legacy),null);
 assert.equal(encodeModifiedText('a1b',['ctrl'],{...legacy,kittyFlags:1}),'\x1b[97;5u\x1b[49;5u\x1b[98;5u');
 assert.equal(encodeModifiedText('abc',['ctrl'],legacy),'\x01\x02\x03');
 assert.equal(encodeModifiedText('你好',[],legacy),'你好');
});
