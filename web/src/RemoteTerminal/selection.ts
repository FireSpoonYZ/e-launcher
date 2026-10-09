import type { IBufferLine } from '@xterm/xterm';
// Orca: mobile/src/terminal/document/selection-range.ts and selection-state-and-eviction.ts
// @ de8bffe24045b396212f4f63de8960ec8380ea07. MIT Lovecast Inc. See LICENSE.orca. Adaptation: inclusive cell coordinates, including wide/ZWJ
// cells instead of indexing a UTF-16 string; actual CircularList trim events.
export type CellPoint = { col:number; row:number };
export type CellSelection = { anchor:CellPoint; focus:CellPoint };
export function selectionRange(selection:CellSelection) {
  const {anchor:a,focus:b}=selection;
  return a.row < b.row || (a.row===b.row && a.col<=b.col) ? {start:a,end:b} : {start:b,end:a};
}
export function selectionLength(selection:CellSelection, cols:number) {
  const {start,end}=selectionRange(selection);
  return (end.row-start.row)*cols + end.col-start.col+1;
}
export function evictSelection(selection:CellSelection, count:number):CellSelection | null {
  const next={anchor:{...selection.anchor,row:selection.anchor.row-count},focus:{...selection.focus,row:selection.focus.row-count}};
  return Math.min(next.anchor.row,next.focus.row)<0 ? null : next;
}
export function wordSelection(line:IBufferLine | undefined, point:CellPoint, cols:number):CellSelection {
  let start=Math.min(cols-1,Math.max(0,point.col)),end=start;
  while(start>0 && line?.getCell(start)?.getWidth()===0) start--;
  const word=(col:number)=> /[\p{L}\p{N}_./:@~+=?&#%-]/u.test(line?.getCell(col)?.getChars() || '');
  end=start+Math.max(1,line?.getCell(start)?.getWidth() || 1)-1;
  if(word(start)) {
    while(start>0) {
      let previous=start-1;while(previous>0 && line?.getCell(previous)?.getWidth()===0)previous--;
      if(!word(previous))break;start=previous;
    }
    while(end+1<cols && word(end+1)) end+=Math.max(1,line?.getCell(end+1)?.getWidth() || 1);
  }
  return {anchor:{row:point.row,col:start},focus:{row:point.row,col:end}};
}
export function viewportCell(rect:{left:number;top:number;width:number;height:number}, cols:number, rows:number, viewportY:number, x:number,y:number):CellPoint {
  return {col:Math.max(0,Math.min(cols-1,Math.floor((x-rect.left)/rect.width*cols))),
    row:viewportY+Math.max(0,Math.min(rows-1,Math.floor((y-rect.top)/rect.height*rows)))};
}
