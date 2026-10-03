import { SlidersHorizontal, ArrowUp, ArrowDown, Plus, Pencil, Trash2, CornerDownLeft } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { RemoteTerminal } from './native';
import { ErrorNotice, useText } from '../ui';
import { type Preset, describeShortcut, normalizePresets, loadPresets, savePresets, mutatePreset } from './presets';
import { TERMINAL_SHORTCUT_SPECIAL_KEYS, type TerminalShortcutModifier } from './orca/terminal-accessory-keys';
import { AccessoryButton } from './AccessoryButton';

// Layout/editor reference: Orca MobileSessionCommandDock and CustomKeyModal,
// de8bffe24045b396212f4f63de8960ec8380ea07. MIT, Lovecast Inc. See ATTRIBUTION.md.
export function Presets({disabled,send,accessoryKeys,activeModifiers=[]}: {disabled:boolean;send(preset:Preset):void;accessoryKeys?:ReactNode;activeModifiers?:TerminalShortcutModifier[]}) {
  const t=useText();
  const [initial]=useState(()=>{try{return {presets:loadPresets(localStorage),error:''};}catch(e){return {presets:[] as Preset[],error:String(e)};}});
  const [error,setError]=useState(initial.error);
  const [presets,setPresets]=useState<Preset[]>(initial.presets);
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState<Preset>();
  const [ready,setReady]=useState(!Capacitor.isNativePlatform());
  const [saving,setSaving]=useState(false); const savePending=useRef(false);
  useEffect(()=>{
    if (!Capacitor.isNativePlatform()) return;
    let disposed=false;
    void RemoteTerminal.loadShortcuts().then(async ({value})=>{
      const next=value===null ? initial.presets : normalizePresets(JSON.parse(value));
      if(disposed)return;
      if (value===null && localStorage.getItem('remote-terminal.shortcuts.v1')!==null && !initial.error)
        await RemoteTerminal.saveShortcuts({value:JSON.stringify(next)});
      if(!disposed) {try{savePresets(localStorage,next);}catch{};setPresets(next);setReady(true);setError(value===null ? initial.error : '');}
    }).catch(e=>{if(!disposed)setError(String(e));});
    return ()=>{disposed=true;};
  },[]);
  const update=async(next:Preset[])=>{
    if(!ready || savePending.current) return false;
    savePending.current=true;setSaving(true);
    try{
      const normalized=normalizePresets(next);
      if(Capacitor.isNativePlatform()) {await RemoteTerminal.saveShortcuts({value:JSON.stringify(normalized)});try{savePresets(localStorage,normalized);}catch{}}
      else savePresets(localStorage,normalized);
      setPresets(normalized);setError('');return true;
    }catch(e){setError(String(e));return false;}
    finally{savePending.current=false;setSaving(false);}
  };
  const add=()=>{setDraft({id:crypto.randomUUID(),label:'',kind:'chord',chord:{key:'c',modifiers:['ctrl']}});setEditing(true);};
  const preview=draft?.kind==='chord' ? describeShortcut(draft.chord) : null;
  const valid=!!draft && (draft.kind==='chord' ? !!preview : !!draft.label.trim() && !!draft.text);
  return <section className="rt-shortcuts" aria-label={t('终端快捷键','Terminal shortcuts')}>
    <div className="rt-accessory rt-key-scroll" aria-label={t('左右滑动查看更多快捷键','Swipe sideways for more shortcuts')}>
      {accessoryKeys}
      {presets.length>0 && <span className="rt-key-divider" aria-hidden="true"/>}
      {presets.map(p=><AccessoryButton key={p.id} className="rt-custom-key" disabled={disabled || !ready}
        label={p.label+(p.kind==='chord' ? ' · '+(describeShortcut(p.chord)?.accessibilityLabel || '') : p.appendEnter ? t(' · 执行',' · execute') : '')}
        onPress={()=>send(p)}>{p.label}{p.kind==='text'&&p.appendEnter&&<CornerDownLeft size={13}/>}</AccessoryButton>)}
      <AccessoryButton className="rt-add-key" label={t('添加快捷键','Add shortcut')} disabled={!ready || saving || presets.length>=40} onPress={add}><Plus size={18}/></AccessoryButton>
    </div>
    <button className="rt-manage-keys icon-button" data-active-modifiers={activeModifiers.length>0} aria-label={t('管理快捷键','Manage shortcuts')+(activeModifiers.length ? ' · '+activeModifiers.join('+')+t(' 已按住',' active') : '')} onClick={()=>{setDraft(undefined);setEditing(true);}}>{activeModifiers.length ? <span className="rt-modifier-indicator">{activeModifiers.map(m=>m==='ctrl'?'Ctrl':m==='alt'?'Alt':'Shift').join('+')}</span> : <SlidersHorizontal size={19}/>}</button>
    <Dialog sheet className="rt-sheet" open={editing} onOpenChange={open=>{setEditing(open);if(!open)setDraft(undefined);}}
      title={draft ? t('编辑快捷键','Edit shortcut') : t('管理快捷键','Manage shortcuts')}>
      <div className="rt-preset-editor"><ErrorNotice error={error}/>{!ready&&!error&&<p>{t('正在读取本机快捷键…','Loading saved shortcuts…')}</p>}
      {draft ? <form className="rt-shortcut-form" onSubmit={async e=>{e.preventDefault();if(!valid || saving)return;try{
        const command={...draft,label:draft.label.trim() || preview!.label};
        if(await update(mutatePreset(presets,{type:'upsert',command})))setDraft(undefined);
      }catch(e){setError(String(e));}}}>
        <div className="rt-shortcut-kind" aria-label={t('快捷键类型','Shortcut type')}>
          {(['chord','text'] as const).map(kind=><button type="button" key={kind} aria-pressed={draft.kind===kind} onClick={()=>{if(draft.kind===kind)return;setDraft(kind==='chord' ? {id:draft.id,label:draft.label,kind,chord:{key:'c',modifiers:['ctrl']}} : {id:draft.id,label:draft.label,kind,text:'',appendEnter:false});}}>{kind==='chord'?t('组合快捷键','Key combination'):t('文本宏','Text macro')}</button>)}
        </div>
        {draft.kind==='chord' ? <>
          <div className="rt-chord-preview" aria-live="polite"><small>{t('组合预览','Preview')}</small><strong>{preview?.label || t('请选择有效按键','Choose a valid key')}</strong></div>
          <div className="rt-modifier-picker" aria-label={t('修饰键','Modifiers')}>{(['ctrl','alt','shift'] as TerminalShortcutModifier[]).map(m=><button type="button" key={m} aria-pressed={draft.chord.modifiers.includes(m)} onClick={()=>setDraft({...draft,chord:{...draft.chord,modifiers:draft.chord.modifiers.includes(m)?draft.chord.modifiers.filter(v=>v!==m):[...draft.chord.modifiers,m]}})}>{m==='ctrl'?'Ctrl':m==='alt'?'Alt':'Shift'}</button>)}</div>
          <label>{t('按键','Key')}<select aria-label={t('选择按键','Choose key')} value={TERMINAL_SHORTCUT_SPECIAL_KEYS.some(k=>k.id===draft.chord.key)?draft.chord.key:'character'} onChange={e=>setDraft({...draft,chord:{...draft.chord,key:e.target.value==='character'?'c':e.target.value}})}>
            <option value="character">{t('字母、数字或符号','Letter, number or symbol')}</option>{TERMINAL_SHORTCUT_SPECIAL_KEYS.map(k=><option key={k.id} value={k.id}>{k.accessibilityLabel}</option>)}
          </select></label>
          {!TERMINAL_SHORTCUT_SPECIAL_KEYS.some(k=>k.id===draft.chord.key)&&<label>{t('单个字符','Single character')}<input aria-label={t('单个字符','Single character')} value={draft.chord.key} maxLength={1} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={e=>setDraft({...draft,chord:{...draft.chord,key:e.target.value}})}/></label>}
          {!preview&&<p className="rt-shortcut-validation" role="status">{t('此组合不受终端支持。请选择一个英文字母、数字、符号或特殊键；例如 Ctrl+C、Alt+K、Ctrl+Shift+→。','Unsupported combination. Choose one ASCII character or a special key, e.g. Ctrl+C, Alt+K or Ctrl+Shift+→.')}</p>}
          <p className="rt-shortcut-note">{t('发送终端按键，不是系统快捷键。部分组合在传统终端中相同，例如 Ctrl+Shift+C 与 Ctrl+C；Ctrl+1 等组合需要协商 Kitty 协议；不支持时不会发送。','These are terminal keys. Some combinations are identical in legacy terminals, such as Ctrl+Shift+C and Ctrl+C. Combinations such as Ctrl+1 require negotiated Kitty mode; unsupported input is not sent.')}</p>
        </> : <><label>{t('文本','Text')}<textarea required maxLength={4000} value={draft.text} onChange={e=>setDraft({...draft,text:e.target.value})}/></label><label><input type="checkbox" checked={draft.appendEnter} onChange={e=>setDraft({...draft,appendEnter:e.target.checked})}/>{t('追加 Enter（立即执行）','Append Enter (execute immediately)')}</label></>}
        <label>{draft.kind==='chord'?t('名称（可选）','Label (optional)'):t('名称','Label')}<input maxLength={80} required={draft.kind==='text'} value={draft.label} placeholder={preview?.label} onChange={e=>setDraft({...draft,label:e.target.value})}/></label>
        <div className="rt-dialog-actions"><button className="rt-primary" type="submit" disabled={!valid || saving || !ready}>{saving?t('正在保存…','Saving…'):t('保存快捷键','Save shortcut')}</button><button type="button" onClick={()=>setDraft(undefined)}>{t('取消','Cancel')}</button></div>
      </form> : <>
        <p>{t('左右滑动终端按键栏。自定义快捷键仅保存在本机，点按名称可编辑。','Swipe the terminal key row. Custom shortcuts are saved on this device; tap a name to edit.')}</p>
        <button className="rt-primary rt-add-shortcut" disabled={!ready || saving || presets.length>=40} onClick={add}><Plus size={18}/>{t('添加快捷键','Add shortcut')}</button>
        <div className="rt-saved-shortcuts">{presets.map((p,index)=><div className="rt-saved-shortcut" key={p.id}>
          <button className="rt-edit-shortcut" disabled={saving} onClick={()=>setDraft(structuredClone(p))}><span><strong>{p.label}</strong><small>{p.kind==='chord'?describeShortcut(p.chord)?.label:p.text}</small></span><Pencil size={15}/></button>
          <div className="rt-shortcut-actions"><button aria-label={t('上移 ','Move up ')+p.label} disabled={saving || !index} onClick={()=>{const next=[...presets];[next[index-1],next[index]]=[next[index],next[index-1]];update(next);}}><ArrowUp size={16}/></button>
          <button aria-label={t('下移 ','Move down ')+p.label} disabled={saving || index===presets.length-1} onClick={()=>{const next=[...presets];[next[index],next[index+1]]=[next[index+1],next[index]];update(next);}}><ArrowDown size={16}/></button>
          <button className="rt-danger" disabled={saving} aria-label={t('删除 ','Delete ')+p.label} onClick={()=>update(mutatePreset(presets,{type:'delete',id:p.id}))}><Trash2 size={16}/></button></div>
        </div>)}</div>
      </>}
      </div>
    </Dialog>
  </section>;
}
