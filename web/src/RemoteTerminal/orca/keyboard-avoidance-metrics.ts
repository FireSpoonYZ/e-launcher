// Orca: mobile/src/terminal/document/keyboard-avoidance-metrics.ts and
// mobile/src/terminal/terminal-keyboard-avoidance-lift.ts
// @ de8bffe24045b396212f4f63de8960ec8380ea07. MIT Lovecast Inc.; see ../LICENSE.orca.
// Adaptation: xterm's public buffer API; the Capacitor frame is already keyboard-
// resized, so lift is a bounded local grid translation, not an RN pane transform.
import type { Terminal, IBufferLine, IBufferCell } from '@xterm/xterm';

function lineHasVisibleContent(line:IBufferLine,cell:IBufferCell,cols:number) {
  if(line.translateToString(true).trim().length>0)return true;
  for(let x=0;x<Math.min(cols,line.length);x++) {
    const current=line.getCell(x,cell);
    if(current && (!current.isBgDefault() || current.isInverse() || current.isUnderline() || current.isStrikethrough() || current.isOverline()))return true;
  }
  return false;
}
export function contentBottomRow(term:Terminal) {
  const buffer=term.buffer.active,cell=buffer.getNullCell();
  for(let row=term.rows-1;row>=0;row--) {
    const line=buffer.getLine(buffer.viewportY+row);
    if(line && lineHasVisibleContent(line,cell,term.cols))return row;
  }
  return 0;
}
/** Main-buffer footers may be below the caret; alt-screen needs its bottom row. */
export function gridAnchorRow(term:Terminal) {
  return term.buffer.active.type==='alternate' ? term.rows-1 : Math.max(term.buffer.active.cursorY,contentBottomRow(term));
}
/** Orca's anchor plus one drawn row of margin, capped by the drawn grid. */
export function anchorBottom(anchorRow:number,rowPitch:number,rows:number) {
  return Math.min(rows*rowPitch,(anchorRow+2)*rowPitch);
}
