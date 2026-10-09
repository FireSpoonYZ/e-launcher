import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fitScale, phoneViewport, applyGridScale, gridGeometry, clampGridPan, revealGridAnchor, pinchScale, commitPinch } from '../src/RemoteTerminal/viewport.ts';
import { contentBottomRow, gridAnchorRow } from '../src/RemoteTerminal/orca/keyboard-avoidance-metrics.ts';
import { fontPxForScale, snapToTextScalePreset } from '../src/RemoteTerminal/orca/text-scaling.ts';
import { normalizeStatusDotPresentation } from '../src/RemoteTerminal/orca/status-dot.ts';
import { normalizeTerminalAccessoryLayoutPreference, setTerminalAccessoryBuiltInVisible, reorderTerminalAccessoryBuiltInIds } from '../src/RemoteTerminal/orca/terminal-accessory-layout.ts';
import { claimTerminalDraft } from '../src/RemoteTerminal/drafts.ts';
import { LiveInput, encodePaste } from '../src/RemoteTerminal/input.ts';
import { selectionLength, selectionRange, evictSelection, wordSelection, viewportCell } from '../src/RemoteTerminal/selection.ts';
import { activateOrcaTerminalUnicodeProvider } from '../src/RemoteTerminal/orca/terminal-unicode-provider.ts';
const require=createRequire(import.meta.url);
const {Terminal}=require('@xterm/xterm');
const {Unicode11Addon}=require('@xterm/addon-unicode11');

test('Orca font baseline, minimum, pinch range and nearest preset commits are exact',()=>{
 assert.deepEqual([.5,.75,1,1.25,1.5,2].map(fontPxForScale),[7,10,13,16,20,26]);
 assert.equal(fontPxForScale(.1),6);
 assert.equal(pinchScale(1,100,500),2);assert.equal(pinchScale(1,100,1),.5);
 assert.equal(pinchScale(1,0,100),1);
 assert.equal(commitPinch(pinchScale(1,100,137)),1.25);
 assert.equal(snapToTextScalePreset(.625),.5);
});
test('CSS fit follows canonical host cells and never resizes parser; phone viewport has min20x8 and host maximum',()=>{
 const term={cols:100,rows:24,element:{style:{}},_core:{_renderService:{dimensions:{css:{cell:{width:10,height:20}}}}}};
 let resized=false;term.resize=()=>resized=true;
 assert.equal(applyGridScale(term,{clientWidth:516,clientHeight:416}),true);
 assert.equal(term.element.style.transform,'scale(0.5)');assert.equal(resized,false);
 assert.deepEqual(phoneViewport(term,{clientWidth:516,clientHeight:416}),{cols:50,rows:20});
 assert.equal(phoneViewport(term,{clientWidth:115,clientHeight:416}),null);
 assert.deepEqual(phoneViewport(term,{clientWidth:216,clientHeight:36}),{cols:20,rows:8});
 assert.deepEqual(phoneViewport(term,{clientWidth:10000,clientHeight:10000}),{cols:400,rows:200});
 assert.equal(fitScale(10,100,970),1);assert.equal(fitScale(0,100,10),1);
 assert.equal(applyGridScale(term,{clientWidth:0,clientHeight:0}),false);
 assert.deepEqual([term.cols,term.rows],[100,24]);
});
test('status-dot text selector normalization is split-chunk stable and replay starts fresh',()=>{
 const scope={statusDotPendingSelector:false};
 assert.equal(normalizeStatusDotPresentation(scope,'⏺'),'⏺\ufe0e');
 assert.equal(normalizeStatusDotPresentation(scope,'\ufe0f\ufe0e'),'');
 assert.equal(normalizeStatusDotPresentation(scope,'\ufe0f ready'),' ready');
 assert.equal(normalizeStatusDotPresentation(scope,'⏺\ufe0f\ufe0e!'),'⏺\ufe0e!');
 scope.statusDotPendingSelector=false;
 assert.equal(normalizeStatusDotPresentation(scope,'\ufe0f'),'\ufe0f');
});
test('accessory layout upgrades v1, filters unknown/duplicate keys and inserts new keys beside canonical neighbors',()=>{
 const ids=['escape','tab','enter','new','up'];
 const v1=normalizeTerminalAccessoryLayoutPreference({version:1,knownBuiltInIds:['escape','tab','enter','up'],visibleBuiltInIds:['up','escape']},ids);
 assert.deepEqual(v1.visibleBuiltInIds,['escape','new','up']);
 const v2=normalizeTerminalAccessoryLayoutPreference({version:2,orderedBuiltInIds:['up','escape','escape','bad','tab','enter'],visibleBuiltInIds:['escape','bad','escape']},ids);
 assert.deepEqual(v2.orderedBuiltInIds,['up','escape','tab','enter','new']);
 assert.deepEqual(v2.visibleBuiltInIds,['escape','new']);
 const hidden=setTerminalAccessoryBuiltInVisible(v2,'new',false,ids);
 assert.deepEqual(hidden.visibleBuiltInIds,['escape']);
 const reordered=reorderTerminalAccessoryBuiltInIds(hidden,['enter','up','escape','tab','new'],ids);
 assert.deepEqual(reordered.visibleBuiltInIds,['escape']);
 assert.deepEqual(normalizeTerminalAccessoryLayoutPreference({version:2,orderedBuiltInIds:[],visibleBuiltInIds:5},ids).visibleBuiltInIds,ids);
});
test('draft handle leases isolate sessions, ignore stale saves and retain ambiguous mirror without replay',()=>{
 const key='parity-session',a=claimTerminalDraft(key),mirror=new LiveInput();mirror.sentText='gi';mirror.uncertain=true;
 a.save({live:{value:'git',mirror,rejected:true},bufferedDraft:{value:'buffered',mirror:new LiveInput(),rejected:false},buffered:true});
 const other=claimTerminalDraft('other-session');assert.equal(other.draft,undefined);
 const b=claimTerminalDraft(key);assert.equal(b.draft.live.value,'git');assert.equal(b.draft.live.mirror.change('git'),null);assert.equal(b.draft.bufferedDraft.value,'buffered');
 a.save({live:{value:'stale',mirror:new LiveInput(),rejected:false},bufferedDraft:{value:'',mirror:new LiveInput(),rejected:false},buffered:false});
 const c=claimTerminalDraft(key);assert.equal(c.draft.live.value,'git');assert.equal(c.draft.buffered,true);
});
test('inclusive selection uses absolute buffer rows and survives scrollback eviction, wide and ZWJ cells',()=>{
 const s={anchor:{col:3,row:100},focus:{col:1,row:99}};
 assert.deepEqual(selectionRange(s),{start:s.focus,end:s.anchor});assert.equal(selectionLength(s,80),83);
 assert.deepEqual(evictSelection(s,3),{anchor:{col:3,row:97},focus:{col:1,row:96}});
 assert.equal(evictSelection(s,100),null);
 assert.deepEqual(viewportCell({left:10,top:20,width:200,height:100},20,10,500,35,45),{col:2,row:502});
 const cells=[['你',2],['',0],['👩‍💻',2],['',0],['a',1],['b',1]];
 const line={getCell:col=>({getChars:()=>cells[col]?.[0]||'',getWidth:()=>cells[col]?.[1]??1})};
 assert.deepEqual(wordSelection(line,{row:7,col:3},6),{anchor:{row:7,col:2},focus:{row:7,col:3}});
 assert.equal(selectionLength(wordSelection(line,{row:7,col:5},6),6),2);
});
test('paste strips embedded bracket delimiters only when wrapped, never wraps alt screen or adds Enter',()=>{
 assert.equal(encodePaste('a\x1b[201~b\x1b[200~c',{applicationCursor:false,bracketedPaste:true}),'\x1b[200~abc\x1b[201~');
 assert.equal(encodePaste('a\nb',{applicationCursor:false,bracketedPaste:true,altScreen:true}),'a\nb');
});

const write=(term,text)=>new Promise(resolve=>term.write(text,resolve));
const cells=term=>Array.from({length:term.cols},(_,x)=>{const c=term.buffer.active.getLine(0).getCell(x);return [c.getChars(),c.getWidth()];});
test('actual pinned xterm Unicode11 + Orca provider agrees across live chunks, snapshots, grid changes and reset',async()=>{
 const source='你 👩‍💻 ⏺\ufe0e X';
 const live=new Terminal({allowProposedApi:true,cols:40,rows:8,showCursorImmediately:true});
 const replay=new Terminal({allowProposedApi:true,cols:40,rows:8});
 for(const term of [live,replay]){term.loadAddon(new Unicode11Addon());activateOrcaTerminalUnicodeProvider(term);assert.equal(term.unicode.activeVersion,'orca-11-zwj');}
 for(const chunk of ['你 ','👩','\u200d','💻 ','⏺','\ufe0e',' X'])await write(live,chunk);
 await write(replay,source);
 assert.deepEqual(cells(live),cells(replay));assert.equal(live.buffer.active.cursorX,9);
 assert.deepEqual(cells(live).slice(0,10),[['你',2],['',0],[' ',1],['👩‍💻',2],['',0],[' ',1],['⏺\ufe0e',1],[' ',1],['X',1],['',1]]);
 // Equivalent host replay at its authoritative new dimensions. Client does not
 // locally reflow while awaiting this boundary.
 live.reset();activateOrcaTerminalUnicodeProvider(live);live.resize(20,8);await write(live,source);
 replay.reset();activateOrcaTerminalUnicodeProvider(replay);replay.resize(20,8);await write(replay,source);
 assert.deepEqual(cells(live),cells(replay));assert.equal(live.unicode.activeVersion,'orca-11-zwj');
 live.dispose();replay.dispose();
});

test('Orca drawn-pitch anchor lift uses actual buffer content/footer and alt-screen bottom without height font scaling',async()=>{
 const term=new Terminal({allowProposedApi:true,cols:100,rows:40});
 try {
 await write(term,'\x1b[36;1H\x1b[44m \x1b[0m\x1b[3;1H');
 assert.equal(term.buffer.active.cursorY,2);assert.equal(contentBottomRow(term),35);assert.equal(gridAnchorRow(term),35);
 const view={cols:100,rows:40,_core:{_renderService:{dimensions:{css:{cell:{width:10,height:20}}}}}};
 const geometry=gridGeometry(view,{clientWidth:516,clientHeight:216});
 assert.equal(geometry.scale,.5);assert.equal(geometry.rowPitch,10);assert.equal(geometry.height,400);
 assert.equal(revealGridAnchor(geometry,gridAnchorRow(term),40),-170,'main-buffer footer plus one drawn row of margin');
 assert.equal(clampGridPan(geometry.minPanY,10000),0);assert.equal(clampGridPan(geometry.minPanY,-10000),-200);
 await write(term,'\x1b[?1049h');
 assert.equal(term.buffer.active.type,'alternate');assert.equal(gridAnchorRow(term),39);
 assert.equal(revealGridAnchor(geometry,gridAnchorRow(term),40),-200);
 assert.deepEqual([term.cols,term.rows],[100,40]);
 } finally {term.dispose();}
});
