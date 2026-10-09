import type { Terminal } from '@xterm/xterm';
import { fitDimensionsFromCell } from './orca/terminal-grid-fit.ts';
import { anchorBottom } from './orca/keyboard-avoidance-metrics.ts';
import { snapToTextScalePreset } from './orca/text-scaling.ts';

// Orca: mobile/src/terminal/document/viewport-transform.ts + fit-scale.ts
// @ de8bffe24045b396212f4f63de8960ec8380ea07. MIT Lovecast Inc. See LICENSE.orca.
// Canonical grid width is measured cells × host cols, never buffer text width.
// Only host snapshots resize xterm. CSS fit cannot change parser coordinates.
export function fitScale(cellWidth: number, cols: number, width: number): number {
  if (!(cellWidth > 0 && cols > 0 && width > 0)) return 1;
  const scale = Math.min(1, width / (cellWidth * cols));
  return scale >= .95 ? 1 : scale;
}
export function cellBox(term: Terminal) {
  return (term as unknown as { _core?: { _renderService?: { dimensions?: { css: { cell: { width:number; height:number } } } } } })._core?._renderService?.dimensions?.css.cell;
}
export function phoneViewport(term: Terminal, frame: HTMLElement) {
  const cell = cellBox(term);
  if (!cell || !(cell.width > 0 && cell.height > 0)) return null;
  const dimensions = fitDimensionsFromCell({cellWidth:cell.width,cellHeight:cell.height},frame.clientWidth-16,frame.clientHeight-16);
  return dimensions ? {cols:Math.min(400,dimensions.cols),rows:Math.min(200,dimensions.rows)} : null;
}
export function gridGeometry(term:Terminal,frame:HTMLElement,userScale=1) {
  const cell=cellBox(term);
  if(!cell || !(cell.width>0 && cell.height>0 && frame.clientWidth>16 && frame.clientHeight>16))return null;
  const scale=fitScale(cell.width,term.cols,frame.clientWidth-16)*userScale;
  const rowPitch=cell.height*scale,visibleHeight=frame.clientHeight-16;
  return {scale,rowPitch,visibleHeight,height:rowPitch*term.rows,minPanY:Math.min(0,visibleHeight-rowPitch*term.rows)};
}
export function clampGridPan(minPanY:number,panY:number) {return Math.max(minPanY,Math.min(0,panY));}
export function revealGridAnchor(geometry:NonNullable<ReturnType<typeof gridGeometry>>,anchorRow:number,rows:number) {
  return clampGridPan(geometry.minPanY,geometry.visibleHeight-anchorBottom(anchorRow,geometry.rowPitch,rows));
}
export function applyGridScale(term: Terminal, frame: HTMLElement, userScale = 1, panY = 0) {
  const cell = cellBox(term), surface = term.element;
  if (!surface || !cell || !(frame.clientWidth > 16 && cell.width > 0)) return false;
  const scale = fitScale(cell.width,term.cols,frame.clientWidth-16);
  surface.style.width = cell.width * term.cols + 'px';
  surface.style.height = cell.height * term.rows + 'px';
  surface.style.transformOrigin = 'top left';
  const geometry=gridGeometry(term,frame,userScale);
  const offset=geometry ? clampGridPan(geometry.minPanY,panY) : 0;
  surface.style.transform = (offset ? 'translateY('+offset+'px) ' : '') + 'scale(' + scale * userScale + ')';
  return true;
}
export function pinchScale(startScale: number, startDistance: number, distance: number) {
  return Math.max(.5,Math.min(2,startDistance > 0 ? startScale * distance / startDistance : startScale));
}
export function commitPinch(scale: number) { return snapToTextScalePreset(scale); }
