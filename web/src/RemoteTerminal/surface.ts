import type { Terminal, IDisposable } from '@xterm/xterm';
import { wordSelection, viewportCell, selectionRange, selectionLength, evictSelection, type CellSelection } from './selection.ts';
import { gridAnchorRow } from './orca/keyboard-avoidance-metrics.ts';
import { applyGridScale, gridGeometry, clampGridPan, revealGridAnchor, pinchScale, commitPinch } from './viewport.ts';
// DOM adapter of Orca mobile/src/terminal/document/tap-dispatch.ts,
// surface-touch-gestures.ts and selection-overlay.ts
// @ de8bffe24045b396212f4f63de8960ec8380ea07. MIT Lovecast Inc.; see LICENSE.orca.
export function attachTerminalSurface(term:Terminal, frame:HTMLElement, options:{
  scale():number; commitScale(scale:number):void;
  scroll(lines:number,x:number,y:number):void; tap(x:number,y:number):void;
  copy(text:string):Promise<void>; error(error:unknown):void;
  copyLabel:string; clearLabel:string; allLabel:string;
  panUpLabel?:string;panDownLabel?:string;revealLabel?:string;
}) {
  let stopped=false, selection:CellSelection|null=null, applying=false;
  let hold:ReturnType<typeof setTimeout>|undefined, edge:ReturnType<typeof setInterval>|undefined;
  const pointers=new Map<number,{x:number;y:number}>();
  let single:{x:number;y:number;startX:number;startY:number;at:number;moved:boolean}|null=null;
  let pinch:{distance:number;startScale:number;scale:number;surfaceY:number}|null=null;
  let panY=0,manualPan=false,geometryKey='';
  let drag:{id:number;handle:'anchor'|'focus';x:number;y:number}|null=null;
  const overlay=document.createElement('div'); overlay.className='rt-selection-overlay'; overlay.hidden=true;
  const handles=(['anchor','focus'] as const).map(handle=>{
    const button=document.createElement('button'); button.className='rt-selection-handle rt-selection-'+handle;
    button.setAttribute('aria-label',handle==='anchor'?'Selection start':'Selection end');
    button.dataset.handle=handle; overlay.append(button); return button;
  });
  const menu=document.createElement('div');menu.className='rt-selection-tools'; overlay.append(menu);
  for(const [label,action] of [
    [options.copyLabel,()=>{void options.copy(term.getSelection()).catch(options.error);}],
    [options.allLabel,()=>{selection={anchor:{col:0,row:0},focus:{col:term.cols-1,row:term.buffer.active.length-1}};apply();}],
    [options.clearLabel,()=>reset()],
  ] as const) { const button=document.createElement('button');button.textContent=label;button.addEventListener('click',action);menu.append(button); }
  frame.append(overlay);
  const panTools=document.createElement('div');panTools.className='rt-grid-pan';panTools.hidden=true;
  const panButtons=([
    [options.panUpLabel || 'Earlier screen rows','↑',()=>panBy((gridGeometry(term,frame)?.visibleHeight || 0)*.8)],
    [options.panDownLabel || 'Later screen rows','↓',()=>panBy(-(gridGeometry(term,frame)?.visibleHeight || 0)*.8)],
    [options.revealLabel || 'Reveal cursor','⌖',()=>revealCursor()],
  ] as const).map(([label,glyph,action])=>{
    const button=document.createElement('button');button.setAttribute('aria-label',label);button.textContent=glyph;
    button.addEventListener('pointerdown',event=>event.preventDefault());
    button.addEventListener('click',action);panTools.append(button);return button;
  });
  frame.append(panTools);
  const rect=()=>frame.querySelector('.xterm-screen')?.getBoundingClientRect();
  const point=(x:number,y:number)=>{const r=rect();return r && r.width>0 && r.height>0 ? viewportCell(r,term.cols,term.rows,term.buffer.active.viewportY,x,y) : null;};
  const stopHold=()=>{clearTimeout(hold);hold=undefined;};
  const stopEdge=()=>{clearInterval(edge);edge=undefined;};
  function reposition() {
    if(stopped || !selection) {overlay.hidden=true;return;}
    const r=rect();if(!r)return;
    overlay.hidden=false;
    const {start,end}=selectionRange(selection),parent=frame.getBoundingClientRect();
    const width=r.width/term.cols,height=r.height/term.rows;
    for(const [index,p] of [start,end].entries()) {
      const x=r.left-parent.left+(p.col+(index?1:0))*width;
      const y=r.top-parent.top+(p.row-term.buffer.active.viewportY+(index?1:0))*height;
      handles[index].style.left=x+'px';handles[index].style.top=y+'px';
      handles[index].style.visibility=y>=0 && y<=frame.clientHeight ? 'visible':'hidden';
    }
    menu.style.left=Math.max(8,Math.min(frame.clientWidth-menu.offsetWidth-8,r.left-parent.left+start.col*width))+'px';
    menu.style.top=Math.max(8,Math.min(frame.clientHeight-56,r.top-parent.top+(start.row-term.buffer.active.viewportY)*height-56))+'px';
  }
  const transientScale=()=>pinch ? pinch.scale/pinch.startScale : 1;
  function draw() {
    const geometry=gridGeometry(term,frame,transientScale());
    if(geometry) {
      panY=clampGridPan(geometry.minPanY,panY);panTools.hidden=geometry.minPanY===0;
      panButtons[0].disabled=panY===0;panButtons[1].disabled=panY===geometry.minPanY;
    }
    const applied=applyGridScale(term,frame,transientScale(),panY);reposition();return applied;
  }
  function fit(reveal=false) {
    const geometry=gridGeometry(term,frame);
    if(!geometry)return false;
    const key=[frame.clientWidth,frame.clientHeight,term.cols,term.rows,geometry.rowPitch,term.buffer.active.type].join(':');
    const geometryChanged=key!==geometryKey;
    if(geometryChanged) {geometryKey=key;manualPan=false;}
    // A keyboard/frame change must reveal the anchor; ordinary output must
    // not pull someone who is manually inspecting rows/scrollback to the caret.
    const buffer=term.buffer.active;
    if(reveal || (geometryChanged && !pinch) || (!manualPan && !selection && !pinch)) {
      if(buffer.type==='alternate' || buffer.viewportY===buffer.baseY)panY=revealGridAnchor(geometry,gridAnchorRow(term),term.rows);
      if(reveal)manualPan=false;
    }
    return draw();
  }
  function revealCursor() {
    const buffer=term.buffer.active;
    if(buffer.type==='normal' && buffer.viewportY!==buffer.baseY)term.scrollToBottom();
    return fit(true);
  }
  function panBy(delta:number) {
    const geometry=gridGeometry(term,frame,transientScale());if(!geometry)return false;
    const next=clampGridPan(geometry.minPanY,panY+delta);
    if(next===panY)return false;
    panY=next;manualPan=true;draw();return true;
  }
  function scrollSelection(dir:number) {
    const pitch=gridGeometry(term,frame)?.rowPitch || 18;
    if(!panBy(-dir*pitch))term.scrollLines(dir);
  }
  function apply() {
    if(!selection)return;
    const {start}=selectionRange(selection);
    applying=true;term.select(start.col,start.row,selectionLength(selection,term.cols));applying=false;reposition();
  }
  function reset() {selection=null;drag=null;single=null;pinch=null;pointers.clear();stopHold();stopEdge();term.clearSelection();overlay.hidden=true;manualPan=false;fit();term.refresh(0,term.rows-1);}
  function seed(x:number,y:number) {const p=point(x,y);if(!p)return;selection=wordSelection(term.buffer.active.getLine(p.row),p,term.cols);apply();}
  function dragMove() {
    if(!drag || !selection)return;
    const p=point(drag.x,drag.y);if(p)selection[drag.handle]=p;apply();
  }
  function down(e:PointerEvent) {
    const handle=(e.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle;
    if((e.target as HTMLElement).closest('.rt-selection-tools') || (e.target as HTMLElement).closest('.rt-grid-pan'))return;
    if(e.pointerType==='mouse' && !handle)return;
    e.preventDefault();e.stopPropagation();frame.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(handle && selection) {
      stopHold();
      // Normalize crossed handles to the displayed start/end on each new drag.
      const range=selectionRange(selection);selection={anchor:range.start,focus:range.end};
      drag={id:e.pointerId,handle:handle as 'anchor'|'focus',x:e.clientX,y:e.clientY};return;
    }
    if(pointers.size>=2) {
      stopHold();stopEdge();drag=null;single=null;
      const [a,b]=[...pointers.values()];const distance=Math.hypot(a.x-b.x,a.y-b.y);
      const midY=(a.y+b.y)/2,geometry=gridGeometry(term,frame);
      pinch={distance,startScale:options.scale(),scale:options.scale(),surfaceY:(midY-frame.getBoundingClientRect().top-8-panY)/(geometry?.scale || 1)};return;
    }
    single={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,at:Date.now(),moved:false};
    if(selection) {seed(e.clientX,e.clientY);single.moved=true;return;}
    hold=setTimeout(()=>{hold=undefined;if(single && !single.moved){single.moved=true;seed(e.clientX,e.clientY);}},500);
  }
  function move(e:PointerEvent) {
    if(!pointers.has(e.pointerId))return;
    e.preventDefault();e.stopPropagation();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pinch) {
      const [a,b]=[...pointers.values()];if(!a || !b)return;
      pinch.scale=pinchScale(pinch.startScale,pinch.distance,Math.hypot(a.x-b.x,a.y-b.y));
      const geometry=gridGeometry(term,frame,transientScale());
      if(geometry)panY=clampGridPan(geometry.minPanY,(a.y+b.y)/2-frame.getBoundingClientRect().top-8-pinch.surfaceY*geometry.scale);
      manualPan=true;draw();return;
    }
    if(drag && drag.id===e.pointerId) {
      drag.x=e.clientX;drag.y=e.clientY;dragMove();stopEdge();
      const r=frame.getBoundingClientRect(),dir=e.clientY<r.top+40?-1:e.clientY>r.bottom-40?1:0;
      if(dir)edge=setInterval(()=>{scrollSelection(dir);dragMove();},60);return;
    }
    if(!single)return;
    if(Math.hypot(e.clientX-single.startX,e.clientY-single.startY)>10)stopHold();
    const delta=single.y-e.clientY;
    if(Math.abs(delta)>=18) {single.moved=true;single.y=e.clientY;
      if(selection) {if(!panBy(-delta))term.scrollLines(Math.trunc(delta/18));}else options.scroll(Math.trunc(delta/18),e.clientX,e.clientY);}
  }
  function up(e:PointerEvent) {
    if(!pointers.has(e.pointerId))return;
    e.preventDefault();e.stopPropagation();pointers.delete(e.pointerId);stopHold();stopEdge();
    if(pinch) {
      const scale=pinch.scale;pinch=null;single=null;
      draw();
      if(e.type!=='pointercancel')options.commitScale(commitPinch(scale));
    } else if(!drag && single && !single.moved && Date.now()-single.at<500 && e.type!=='pointercancel')options.tap(e.clientX,e.clientY);
    drag=null;single=null;
  }
  const events=[['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]] as const;
  for(const [name,listener] of events)frame.addEventListener(name,listener,true);
  const scroll=term.onScroll(()=>{draw();});
  const changed=term.onSelectionChange(()=>{
    if(applying || stopped)return;
    const pos=term.getSelectionPosition();
    if(pos){selection={anchor:{col:pos.start.x,row:pos.start.y},focus:{col:pos.end.x?pos.end.x-1:term.cols-1,row:pos.end.x?pos.end.y:pos.end.y-1}};}
    else selection=null;
    reposition();
  });
  const core=term as unknown as {_core?:{_bufferService?:{buffers?:{normal?:{lines?:{onTrim(fn:(count:number)=>void):IDisposable}}}}}};
  const trim=core._core?._bufferService?.buffers?.normal?.lines?.onTrim(count=>{
    if(!selection || term.buffer.active.type!=='normal')return;
    selection=evictSelection(selection,count);if(selection)apply();else reset();
  });
  return { reset, reposition, fit, panBy, revealCursor, selectCenter(){const r=rect();if(r)seed(r.left+r.width/2,r.top+r.height/2);},
    dispose(){if(stopped)return;stopped=true;stopHold();stopEdge();pointers.clear();scroll.dispose();changed.dispose();trim?.dispose();
      for(const [name,listener] of events)frame.removeEventListener(name,listener,true);overlay.remove();panTools.remove();}
  };
}
