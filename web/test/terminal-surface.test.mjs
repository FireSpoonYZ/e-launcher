import assert from 'node:assert/strict';
import test from 'node:test';
import { attachTerminalSurface } from '../src/RemoteTerminal/surface.ts';
class Element {
 constructor(){this.style={};this.dataset={};this.children=[];this.listeners=new Map();this.hidden=false;this.className='';this.offsetWidth=160;this.clientWidth=216;this.clientHeight=176;}
 append(child){this.children.push(child);child.parent=this;}
 remove(){this.removed=true;}
 setAttribute(){}
 addEventListener(type,listener){this.listeners.set(type,listener);}
 removeEventListener(type,listener){if(this.listeners.get(type)===listener)this.listeners.delete(type);}
 setPointerCapture(){}
 querySelector(){return {getBoundingClientRect:()=>({left:8,top:8,width:200,height:160})};}
 getBoundingClientRect(){return {left:0,top:0,bottom:176};}
 closest(selector){if(selector==='[data-handle]' && this.dataset.handle)return this;if(selector==='.rt-selection-tools' && this.className==='rt-selection-tools')return this;return null;}
}
function harness(){
 const previous=globalThis.document;globalThis.document={createElement:()=>new Element()};
 const frame=new Element(),events=[],term={cols:20,rows:8,element:new Element(),
   _core:{_renderService:{dimensions:{css:{cell:{width:10,height:20}}}}},
   buffer:{active:{type:'normal',viewportY:50,baseY:50,cursorY:7,length:100,getNullCell:()=>({}),getLine:()=>({length:20,translateToString:()=> 'aaaa',getCell:col=>({getChars:()=>col<4?'a':' ',getWidth:()=>1})})}},
   select(x,y,length){events.push(['select',x,y,length]);},clearSelection(){},refresh(){},
   getSelection:()=> 'selected',getSelectionPosition:()=>null,
   onScroll(fn){this.scrollListener=fn;return{dispose(){}};},
   onSelectionChange(){return{dispose(){}};},
   scrollLines(n){this.buffer.active.viewportY+=n;events.push(['history',n]);},
   scrollToBottom(){this.buffer.active.viewportY=this.buffer.active.baseY;events.push('history-bottom');},
 };
 frame.querySelector=()=>({getBoundingClientRect:()=>{
   const transform=term.element.style.transform || 'scale(1)';
   const scale=Number(transform.match(/scale\(([^)]+)\)/)?.[1] || 1),pan=Number(transform.match(/translateY\(([^p]+)px\)/)?.[1] || 0);
   return {left:8,top:8+pan,width:term.cols*10*scale,height:term.rows*20*scale};
 }});
 let trim;
 term._core._bufferService={buffers:{normal:{lines:{onTrim(fn){trim=fn;return{dispose(){}};}}}}};
 const controller=attachTerminalSurface(term,frame,{scale:()=>1,commitScale:scale=>events.push(['scale',scale]),
   scroll:(lines)=>events.push(['scroll',lines]),tap:()=>events.push('tap'),copy:async text=>events.push(['copy',text]),
   error:e=>events.push(['error',String(e)]),copyLabel:'Copy',clearLabel:'Done',allLabel:'All'});
 const pointer=(type,id,x,y,target=frame,pointerType='touch')=>frame.listeners.get(type)?.({type,pointerId:id,clientX:x,clientY:y,pointerType,target,preventDefault(){},stopPropagation(){}});
 return {frame,term,events,controller,pointer,trim:count=>trim(count),cleanup(){controller.dispose();globalThis.document=previous;}};
}
test('surface long press enters direct word selection at 500ms, copy tool and handles use absolute cells',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness();
 try{
 h.pointer('pointerdown',1,23,33);t.mock.timers.tick(499);assert.equal(h.events.length,0);
 t.mock.timers.tick(1);assert.deepEqual(h.events[0],['select',0,51,4]);
 const overlay=h.frame.children[0];assert.equal(overlay.hidden,false);
 h.pointer('pointerup',1,23,33);assert.equal(h.events.includes('tap'),false);
 const end=overlay.children[1];h.pointer('pointerdown',2,48,53,end);h.pointer('pointermove',2,68,53,end);h.pointer('pointerup',2,68,53,end);
 assert.deepEqual(h.events.at(-1),['select',0,51,27]);
 overlay.children[2].children[0].listeners.get('click')();await Promise.resolve();assert.deepEqual(h.events.at(-1),['copy','selected']);
 h.trim(52);assert.equal(overlay.hidden,true);
 }finally{h.cleanup();}
});
test('surface 10px slop cancels selection timer; scrolling does not turn into a mouse tap',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness();
 try{
 h.pointer('pointerdown',1,30,60);h.pointer('pointermove',1,45,60);t.mock.timers.tick(500);
 assert.equal(h.events.length,0);h.pointer('pointermove',1,45,20);h.pointer('pointerup',1,45,20);
 assert.deepEqual(h.events,[['scroll',2]]);
 }finally{h.cleanup();}
});
test('surface pinch provides transient CSS pitch, preserves it through output fit and commits snapped font scale once',()=>{
 const h=harness();
 try{
 h.pointer('pointerdown',1,20,50);h.pointer('pointerdown',2,120,50);
 h.pointer('pointermove',2,160,50);assert.match(h.term.element.style.transform,/scale\(1.4\)/);
 const transformed=h.term.element.style.transform;h.controller.fit();assert.equal(h.term.element.style.transform,transformed);
 h.pointer('pointerup',2,160,50);h.pointer('pointerup',1,20,50);
 assert.deepEqual(h.events,[['scale',1.5]]);assert.equal(h.term.element.style.transform,'scale(1)');
 h.pointer('pointerdown',3,20,50);h.pointer('pointerdown',4,120,50);h.pointer('pointermove',4,180,50);
 h.controller.reset();h.pointer('pointerup',4,180,50);assert.deepEqual(h.events,[['scale',1.5]]);
 }finally{h.cleanup();}
});
test('surface cancellation and disposal cancel long press and leave mouse selection to xterm',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness();
 try{
 h.pointer('pointerdown',1,20,50,h.frame,'mouse');t.mock.timers.tick(500);assert.deepEqual(h.events,[]);
 h.pointer('pointerdown',2,20,50);h.pointer('pointercancel',2,20,50);t.mock.timers.tick(500);assert.deepEqual(h.events,[]);
 h.pointer('pointerdown',3,20,50);h.controller.dispose();t.mock.timers.tick(500);assert.deepEqual(h.events,[]);assert.equal(h.frame.listeners.size,0);
 }finally{h.cleanup();}
});

test('tall desktop grid reveals bottom anchor after frame shrink; local pan reaches top and bottom without host resize/input',()=>{
 const h=harness();
 try {
 h.term.cols=100;h.term.rows=40;h.term.buffer.active.cursorY=39;h.frame.clientWidth=516;h.frame.clientHeight=416;
 h.term.resize=()=>{throw new Error('must not resize parser or PTY');};
 h.controller.fit();assert.equal(h.term.element.style.transform,'scale(0.5)');
 h.frame.clientHeight=216;h.controller.fit();assert.equal(h.term.element.style.transform,'translateY(-200px) scale(0.5)');
 const controls=h.frame.children[1];assert.equal(controls.hidden,false);
 let keptFocus=false;controls.children[0].listeners.get('pointerdown')({preventDefault(){keptFocus=true;}});assert.equal(keptFocus,true,'local controls do not dismiss composer/keyboard');
 assert.equal(h.controller.panBy(10000),true);assert.equal(h.term.element.style.transform,'scale(0.5)');
 h.controller.fit();assert.equal(h.term.element.style.transform,'scale(0.5)','ordinary output retains manual inspection');
 controls.children[1].listeners.get('click')();assert.equal(h.term.element.style.transform,'translateY(-160px) scale(0.5)');
 assert.equal(h.controller.panBy(-10000),true);assert.equal(h.term.element.style.transform,'translateY(-200px) scale(0.5)');
 assert.equal(h.controller.panBy(-1),false);
 h.controller.panBy(10000);h.controller.revealCursor();assert.equal(h.term.element.style.transform,'translateY(-200px) scale(0.5)');
 assert.deepEqual(h.events,[]);assert.deepEqual([h.term.cols,h.term.rows],[100,40]);
 } finally {h.cleanup();}
});
test('local pan retains absolute selection/handle coordinates and single-finger PTY mouse/scroll path',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness();
 try {
 h.term.cols=100;h.term.rows=40;h.term.buffer.active.cursorY=39;h.frame.clientWidth=516;h.frame.clientHeight=216;
 h.controller.fit();h.pointer('pointerdown',1,13,13);t.mock.timers.tick(500);h.pointer('pointerup',1,13,13);
 assert.deepEqual(h.events[0],['select',0,70,4],'translated screen top maps to viewportY + row20');
 const overlay=h.frame.children[0],start=overlay.children[0];
 assert.equal(start.style.top,'8px');h.controller.panBy(100);assert.equal(start.style.top,'108px');
 h.controller.reset();h.pointer('pointerdown',2,40,100);h.pointer('pointermove',2,40,60);h.pointer('pointerup',2,40,60);
 assert.deepEqual(h.events.at(-1),['scroll',2],'ordinary gesture still routes through PTY mouse/scroll adapter');
 h.term.buffer.active.type='alternate';h.controller.fit();h.controller.panBy(10000);
 h.pointer('pointerdown',3,40,100);h.pointer('pointermove',3,40,60);h.pointer('pointerup',3,40,60);
 assert.deepEqual(h.events.at(-1),['scroll',2]);assert.equal(h.term.element.style.transform,'scale(0.5)');
 } finally {h.cleanup();}
});
test('two-finger vertical pan reaches clipped screen rows without generating wheel or arrow input',()=>{
 const h=harness();
 try {
 h.term.cols=100;h.term.rows=40;h.term.buffer.active.cursorY=39;h.frame.clientWidth=516;h.frame.clientHeight=216;h.controller.fit();
 h.pointer('pointerdown',1,40,40);h.pointer('pointerdown',2,140,40);
 h.pointer('pointermove',1,40,240);h.pointer('pointermove',2,140,240);
 h.pointer('pointerup',1,40,240);h.pointer('pointerup',2,140,240);
 assert.equal(h.term.element.style.transform,'scale(0.5)');assert.deepEqual(h.events,[['scale',1]]);
 h.term.buffer.active.viewportY=30;h.term.buffer.active.baseY=50;h.controller.fit();
 h.controller.panBy(-100);h.term.scrollListener();assert.equal(h.term.element.style.transform,'translateY(-100px) scale(0.5)');
 assert.deepEqual(h.term.buffer.active.viewportY,30,'local pan never changes history viewport');
 h.controller.revealCursor();assert.equal(h.term.buffer.active.viewportY,50);assert.equal(h.term.element.style.transform,'translateY(-200px) scale(0.5)');
 assert.deepEqual(h.events,[['scale',1],'history-bottom'],'only explicit reveal returns to latest; no PTY scroll/input');
 } finally {h.cleanup();}
});
