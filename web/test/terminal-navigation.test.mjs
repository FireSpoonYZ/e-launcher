import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createSessionListLoader, terminalDraftNeedsGuard } from '../src/RemoteTerminal/session-navigation.ts';
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
test('session tabs commit only the newest independent list response',async()=>{
 const a=deferred(),b=deferred(),values=[],errors=[];let i=0;
 const loader=createSessionListLoader(()=>[a,b][i++].promise,value=>values.push(value),()=>errors.push(true));
 const first=loader.refresh(),second=loader.refresh();b.resolve(['new']);await second;a.resolve(['old']);await first;
 assert.deepEqual(values,[['new']]);assert.deepEqual(errors,[]);
});
test('disposed tab list ignores late responses and failures',async()=>{
 const a=deferred(),values=[],errors=[];
 const loader=createSessionListLoader(()=>a.promise,value=>values.push(value),()=>errors.push(true));
 const pending=loader.refresh();loader.dispose();a.reject(new Error('offline'));await pending;
 assert.deepEqual(values,[]);assert.deepEqual(errors,[]);
});
test('list failure is contained and a later refresh recovers',async()=>{
 let failing=true;const values=[],errors=[];
 const loader=createSessionListLoader(async()=>{if(failing)throw new Error('offline');return ['session'];},v=>values.push(v),()=>errors.push(true));
 await loader.refresh();failing=false;await loader.refresh();assert.deepEqual(errors,[true]);assert.deepEqual(values,[['session']]);
});
test('session navigation protects composing, unsent, queued and ambiguous input',()=>{
 const clean={composing:false,uncertain:false,rejected:false,queuedBytes:0,pending:false,value:'sent',sentText:'sent'};
 assert.equal(terminalDraftNeedsGuard(clean),false);
 for(const patch of [{composing:true},{uncertain:true},{rejected:true},{queuedBytes:1},{pending:true},{value:'unsent'}]) assert.equal(terminalDraftNeedsGuard({...clean,...patch}),true);
 assert.equal(terminalDraftNeedsGuard({...clean,value:'',sentText:''}),false);
});
test('tabs and dock retain route, theme and keyboard safety contracts',()=>{
 const source=readFileSync(new URL('../src/RemoteTerminal/TerminalView.tsx',import.meta.url),'utf8');
 const tabs=readFileSync(new URL('../src/RemoteTerminal/SessionTabs.tsx',import.meta.url),'utf8');
 const css=readFileSync(new URL('../src/RemoteTerminal/terminal.css',import.meta.url),'utf8');
 assert.match(source,/getComputedStyle\(element.current!\)/);
 assert.match(source,/navigate=\{leave\}/);
 assert.match(source,/window.addEventListener\('app-back',back\)/);
 assert.match(source,/className="rt-keyboard-toggle"/);
 assert.match(source,/accessoryKeys=/);
 assert.match(tabs,/event.event === 'terminal.listChanged'/);
 assert.doesNotMatch(tabs,/terminal.close|terminal.claim|terminal.send/);
 assert.match(css,/\.rt-dock \{ flex-shrink:0;/);
 assert.match(css,/min-height:48px; padding:6px 12px;/);
 assert.doesNotMatch(css,/position:fixed/);
});

test('scrolled keys expose active modifiers and preset errors remain in the editor',()=>{
 const source=readFileSync(new URL('../src/RemoteTerminal/TerminalView.tsx',import.meta.url),'utf8');
 const presets=readFileSync(new URL('../src/RemoteTerminal/PresetPanel.tsx',import.meta.url),'utf8');
 assert.match(source,/activeModifiers=\{modifiers\}/);
 assert.match(presets,/data-active-modifiers=\{activeModifiers.length>0\}/);
 assert.match(presets,/className="rt-modifier-indicator"/);
 assert.match(presets,/<ErrorNotice error=\{error\}\/>/);
});

test('remote keyboard viewport removes only the duplicated bottom inset',()=>{
 const source=readFileSync(new URL('../src/RemoteTerminal/TerminalView.tsx',import.meta.url),'utf8');
 const css=readFileSync(new URL('../src/RemoteTerminal/terminal.css',import.meta.url),'utf8');
 assert.match(source,/data-keyboard-open=\{keyboardOpen\}/);
 assert.match(css,/#root:has\(\.rt-terminal \.rt-dock\[data-keyboard-open=true\]\) \{ padding-bottom:0; \}/);
 assert.doesNotMatch(css,/#[a-f\d]{6}\b/i,'remote layout must use the existing app palette');
});
