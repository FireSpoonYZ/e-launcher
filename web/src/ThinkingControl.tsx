import { useEffect, useRef, useState } from 'react';
import { Chat, NativeSettings, type Conversation } from './native';
import { type CatalogProvider } from './Chat';
import { ComposerPopover } from './ComposerPopover';
import { ErrorNotice, errorText, query, useText } from './ui';

const scale = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const names: Record<string, [string,string]> = {
  off:['关闭','Off'], minimal:['极低','Minimal'], low:['低','Low'], medium:['中','Medium'],
  high:['高','High'], xhigh:['极高','Extra high'], max:['最高','Maximum'],
};
function Gauge({level}: {level:string}) {
  const fraction = Math.max(0,scale.indexOf(level)) / (scale.length-1);
  return <svg className="reasoning-gauge" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path className="gauge-track" d="M6.808 25.192 A13 13 0 1 1 25.192 25.192" pathLength="100"/>
    <path className="gauge-fill" visibility={fraction > 0 ? 'visible' : 'hidden'} d="M6.808 25.192 A13 13 0 1 1 25.192 25.192" pathLength="100" strokeDasharray={`${fraction*100} 100`}/>
    <g className="gauge-needle" style={{transform:`rotate(${135+fraction*270}deg)`}}><path d="M16 16H24"/></g>
    <circle cx="16" cy="16" r="2" className="gauge-pivot"/>
  </svg>;
}
export function ThinkingControl({conversation,level,disabled,onChange,open,onOpenChange,visible}: {conversation:Conversation;level:string;disabled:boolean;onChange():Promise<void>;open:boolean;onOpenChange(open:boolean):void;visible:boolean}) {
  const t=useText();
  const label=names[level] ?? [level || '默认',level || 'Default'];
  return <><button style={visible ? undefined : {display:'none'}} className="icon-button reasoning-button" aria-label={`${t('思考强度','Thinking level')}：${t(...label)}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onPointerDown={e=>e.preventDefault()} onMouseDown={e=>e.preventDefault()} onClick={()=>onOpenChange(true)}><Gauge level={level}/></button>
    <ThinkingSheet key={JSON.stringify([conversation.id,conversation.piSelection.provider,conversation.piSelection.model])} open={open && visible} conversation={conversation} level={level} onChange={onChange} close={()=>onOpenChange(false)}/></>;
}
function ThinkingSheet({conversation,level,onChange,close,open}: {conversation:Conversation;level:string;onChange():Promise<void>;close():void;open:boolean}) {
  const t=useText();const [levels,setLevels]=useState<string[]>([]);const [model,setModel]=useState<{provider:string;id:string}>();
  const [selected,setSelected]=useState(level);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let live=true;
    (async()=>{
      const defaults=(await NativeSettings.settings({effective:true})).settings;
      const provider=String(conversation.piSelection.provider || defaults.defaultProvider || '');
      const id=String(conversation.piSelection.model || defaults.defaultModel || '');
      const providers=await query<CatalogProvider[]>('catalog');
      const current=providers.find(p=>p.id===provider)?.models.find(m=>m.id===id);
      if(!current)throw new Error(t('请先选择模型','Choose a model first'));
      if(live){setLevels(current.thinkingLevels);setModel({provider,id});}
    })().catch(e=>{if(live)setError(errorText(e));});
    return()=>{live=false;};
  },[]);
  useEffect(()=>{setSelected(level);},[level,open]);
  const commit=async(value:string)=>{
    if(!model || busy || value===level || !levels.includes(value))return;
    setBusy(true);setError('');
    try {
      await Chat.selectThinkingLevel({conversationId:conversation.id,providerId:model.provider,modelId:model.id,thinkingLevel:value,expectedSelection:JSON.stringify(conversation.piSelection)});
      await onChange();
    } catch(e){setSelected(level);setError(errorText(e));}
    finally{setBusy(false);}
  };
  const index=levels.indexOf(selected);const position=Math.max(0,index);const label=names[selected] ?? [selected || '默认',selected || 'Default'];
  const slider = useRef<HTMLDivElement>(null);
  const pick = (x:number) => {
    const rect = slider.current!.getBoundingClientRect();
    const value = levels[Math.round(Math.max(0,Math.min(1,(x-rect.left)/rect.width))*(levels.length-1))];
    setSelected(value); return value;
  };
  return <ComposerPopover compact open={open && (!!model || !!error)} close={close} title={t('思考强度','Thinking level')}>
    <div className="reasoning-picker" aria-busy={busy}>
      {levels.length>1?<>
        <output className="reasoning-readout" aria-live="polite"><span>{t(...label)}</span>{t('推理强度',' reasoning')}</output>
        <div className="reasoning-slider" role="slider" tabIndex={0} aria-label={t('思考强度','Thinking level')} aria-valuemin={0} aria-valuemax={levels.length-1} aria-valuenow={position} aria-valuetext={t(...label)} aria-disabled={busy}
          onPointerDown={e=>{e.preventDefault(); if(!busy){e.currentTarget.setPointerCapture(e.pointerId);pick(e.clientX);}}}
          onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))pick(e.clientX);}}
          onPointerUp={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId)){e.currentTarget.releasePointerCapture(e.pointerId);void commit(pick(e.clientX));}}}
          onPointerCancel={()=>setSelected(level)}
          onKeyDown={e=>{if(busy)return;const delta=['ArrowRight','ArrowUp'].includes(e.key)?1:['ArrowLeft','ArrowDown'].includes(e.key)?-1:0;if(delta || e.key==='Home' || e.key==='End'){e.preventDefault();const next=levels[e.key==='Home'?0:e.key==='End'?levels.length-1:Math.max(0,Math.min(levels.length-1,position+delta))];setSelected(next);void commit(next);}}}
          style={{'--progress':`${position/(levels.length-1)*100}%`} as React.CSSProperties}>
          <div ref={slider} className="reasoning-rail" aria-hidden="true"><div className="reasoning-fill"/><div className="reasoning-ticks">{levels.map(value=><i key={value}/>)}</div><div className="reasoning-thumb"/></div>
        </div>
        <div className="reasoning-labels" aria-hidden="true">{levels.map(value=><span key={value} className={value===selected?'active':''}>{names[value]?t(...names[value]):value}</span>)}</div>
      </>:model&&<p className="secondary">{t('此模型不支持调整思考强度。','This model does not support adjustable thinking levels.')}</p>}
      <ErrorNotice error={error}/>
    </div>
  </ComposerPopover>;
}
