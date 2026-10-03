import { useEffect, useRef, type ReactNode } from 'react';
import { createAccessoryPress } from './accessory-press';

export function AccessoryButton({children,disabled,label,pressed,className,onPress,onHold,onRelease}: {
  children:ReactNode; disabled?:boolean; label:string; pressed?:boolean; className?:string;
  onPress():void; onHold?:()=>void; onRelease?:()=>void;
}) {
  const callbacks=useRef({onPress,onHold,onRelease,disabled});
  callbacks.current={onPress,onHold,onRelease,disabled};
  const gesture=useRef(createAccessoryPress(
    ()=>{if(!callbacks.current.disabled) callbacks.current.onPress();},
    onHold ? ()=>{if(!callbacks.current.disabled) callbacks.current.onHold?.();} : undefined,
    ()=>callbacks.current.onRelease?.(),
  ));
  useEffect(()=>{if(disabled) gesture.current.cancel();},[disabled]);
  useEffect(()=>{
    const cancel=()=>gesture.current.cancel();
    window.addEventListener('blur',cancel); document.addEventListener('visibilitychange',cancel);
    return ()=>{cancel();window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',cancel);};
  },[]);
  return <button type="button" className={className} disabled={disabled} aria-label={label} aria-pressed={pressed}
    onMouseDown={e=>e.preventDefault()}
    onPointerDown={e=>{if(e.button!==0 || !e.isPrimary) return; if(e.pointerType==='mouse') e.preventDefault(); gesture.current.start(e.pointerId,e.clientX,e.clientY);}}
    onPointerMove={e=>gesture.current.move(e.pointerId,e.clientX,e.clientY)}
    onPointerUp={e=>{gesture.current.end(e.pointerId,e.clientX,e.clientY);}}
    onPointerCancel={()=>gesture.current.cancel()} onLostPointerCapture={()=>gesture.current.cancel()}
    onPointerLeave={()=>gesture.current.cancel()}
    onClick={e=>{if(e.detail===0 && !disabled) onPress();}}>{children}</button>;
}
