import { useEffect, useState } from 'react';
import { Chat, NativeSettings, type Conversation } from './native';
import { type CatalogProvider } from './Chat';
import { Dialog } from './components/ui/dialog';
import { ErrorNotice, Loading, errorText, query, useText } from './ui';

const scale = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const names: Record<string, [string,string]> = {
  off:['关闭','Off'], minimal:['极低','Minimal'], low:['低','Low'], medium:['中','Medium'],
  high:['高','High'], xhigh:['极高','Extra high'], max:['最高','Maximum'],
};
function Gauge({level}: {level:string}) {
  const fraction = Math.max(0,scale.indexOf(level)) / (scale.length-1);
  return <svg className="reasoning-gauge" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path className="gauge-track" d="M6.808 25.192 A13 13 0 1 1 25.192 25.192" pathLength="100"/>
    <path className="gauge-fill" d="M6.808 25.192 A13 13 0 1 1 25.192 25.192" pathLength="100" strokeDasharray={`${fraction*100} 100`}/>
    <g className="gauge-needle" style={{transform:`rotate(${135+fraction*270}deg)`}}><path d="M16 16H24"/></g>
    <circle cx="16" cy="16" r="2" className="gauge-pivot"/>
  </svg>;
}
export function ThinkingControl({conversation,level,disabled,onChange}: {conversation:Conversation;level:string;disabled:boolean;onChange():Promise<void>}) {
  const t=useText();const [open,setOpen]=useState(false);
  const label=names[level] ?? [level || '默认',level || 'Default'];
  return <><button className="icon-button reasoning-button" aria-label={`${t('思考强度','Thinking level')}：${t(...label)}`} aria-haspopup="dialog" disabled={disabled} onClick={()=>setOpen(true)}><Gauge level={level}/></button>
    {open&&<ThinkingSheet conversation={conversation} level={level} onChange={onChange} close={()=>setOpen(false)}/>}</>;
}
function ThinkingSheet({conversation,level,onChange,close}: {conversation:Conversation;level:string;onChange():Promise<void>;close():void}) {
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
  return <Dialog open onOpenChange={v=>!v&&close()} title={t('思考强度','Thinking level')} sheet>
    <div className="reasoning-picker">
      {!model&&!error?<Loading/>:levels.length>1?<>
        <output className="reasoning-readout" aria-live="polite"><span>{t(...label)}</span>{t('推理强度',' reasoning')}</output>
        <div className="reasoning-slider" style={{'--progress':`${position/(levels.length-1)*100}%`} as React.CSSProperties}>
          <div className="reasoning-rail" aria-hidden="true"><div className="reasoning-fill"/><div className="reasoning-ticks">{levels.map(value=><i key={value}/>)}</div></div>
          <input type="range" min="0" max={levels.length-1} step="1" value={position} disabled={busy} aria-label={t('思考强度','Thinking level')} aria-valuetext={index<0?t('使用模型默认值','Model default'):t(...label)} onChange={e=>setSelected(levels[Number(e.target.value)])} onPointerUp={e=>void commit(levels[Number(e.currentTarget.value)])} onKeyUp={e=>void commit(levels[Number(e.currentTarget.value)])} onBlur={()=>void commit(selected)}/>
        </div>
        <div className="reasoning-labels" aria-hidden="true">{levels.map(value=><span key={value} className={value===selected?'active':''}>{names[value]?t(...names[value]):value}</span>)}</div>
        <p className="reasoning-hint">{busy?t('正在保存…','Saving…'):index<0?t('拖动以选择强度，仅用于当前会话','Drag to choose a level for this conversation'):t('仅用于当前会话','Only for this conversation')}</p>
      </>:model&&<p className="secondary">{t('此模型不支持调整思考强度。','This model does not support adjustable thinking levels.')}</p>}
      <ErrorNotice error={error}/>
    </div>
  </Dialog>;
}
