import { SlidersHorizontal } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { useState } from 'react';
import { ErrorNotice, useText } from '../ui';
import { type Preset, loadPresets, savePresets, mutatePreset } from './presets';
import { TERMINAL_SHORTCUT_SPECIAL_KEYS, type TerminalShortcutModifier } from './orca/terminal-accessory-keys';

export function Presets({ disabled, send }: { disabled: boolean; send(preset: Preset): void }) {
  const t = useText();
  const [initial] = useState(() => { try { return {presets:loadPresets(localStorage),error:''}; } catch (e) { return {presets:[] as Preset[],error:String(e)}; } });
  const [error, setError] = useState(initial.error);
  const [presets, setPresets] = useState<Preset[]>(initial.presets);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Preset>();
  const update = (next: Preset[]) => {
    try { savePresets(localStorage, next); setPresets(next); setError(''); return true; } catch (e) { setError(String(e)); return false; }
  };
  return <section className="rt-presets" aria-label={t('快捷预设','Shortcut presets')}>
    <div className="rt-row"><button className="rt-edit-presets" aria-label={t('编辑预设','Edit presets')} onClick={() => { setEditing(!editing); setDraft(undefined); }}><SlidersHorizontal size={18}/></button>
      {presets.map(p => <button disabled={disabled} key={p.id} onClick={() => send(p)}>{p.label}</button>)}</div>
    <ErrorNotice error={error}/>
    <Dialog sheet className="rt-sheet" open={editing} onOpenChange={setEditing} title={t('快捷预设','Shortcut presets')}><div className="rt-preset-editor"><ErrorNotice error={error}/>
      <p>{t('文本不会自动回车；勾选后才会执行。预设仅保存在本机。','Text does not submit unless Enter is checked. Presets are saved on this device only.')}</p>
      {presets.map((p, index) => <div className="rt-row" key={p.id}><button onClick={() => setDraft(structuredClone(p))}>{p.label}</button>
        <button aria-label={t('上移','Move up')} disabled={!index} onClick={() => { const next = [...presets]; [next[index-1],next[index]]=[next[index],next[index-1]]; update(next); }}>↑</button>
        <button aria-label={t('下移','Move down')} disabled={index === presets.length-1} onClick={() => { const next = [...presets]; [next[index],next[index+1]]=[next[index+1],next[index]]; update(next); }}>↓</button>
        <button className="rt-danger" onClick={() => update(mutatePreset(presets,{type:'delete',id:p.id}))}>{t('删除','Delete')}</button></div>)}
      <button disabled={presets.length >= 40} onClick={() => setDraft({id:crypto.randomUUID(),label:'',kind:'text',text:'',appendEnter:false})}>{t('添加预设','Add preset')}</button>
      {draft && <form onSubmit={e => { e.preventDefault(); try { if (update(mutatePreset(presets,{type:'upsert',command:draft}))) setDraft(undefined); } catch (e) { setError(String(e)); } }}>
        <label>{t('名称','Label')}<input required maxLength={80} value={draft.label} onChange={e => setDraft({...draft,label:e.target.value})}/></label>
        <label>{t('类型','Type')}<select value={draft.kind} onChange={e => setDraft(e.target.value === 'text' ? {id:draft.id,label:draft.label,kind:'text',text:'',appendEnter:false} : {id:draft.id,label:draft.label,kind:'chord',chord:{key:'c',modifiers:['ctrl']}})}><option value="text">{t('文本宏','Text macro')}</option><option value="chord">{t('组合键','Key chord')}</option></select></label>
        {draft.kind === 'text' ? <><label>{t('文本','Text')}<textarea required maxLength={4000} value={draft.text} onChange={e => setDraft({...draft,text:e.target.value})}/></label><label><input type="checkbox" checked={draft.appendEnter} onChange={e => setDraft({...draft,appendEnter:e.target.checked})}/>{t('追加 Enter（执行）','Append Enter (execute)')}</label></> : <>
          <label>{t('按键','Key')}<input list="rt-special-keys" required value={draft.chord.key} onChange={e => setDraft({...draft,chord:{...draft.chord,key:e.target.value}})}/></label>
          <datalist id="rt-special-keys">{TERMINAL_SHORTCUT_SPECIAL_KEYS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</datalist>
          <div className="rt-row">{(['ctrl','alt','shift'] as TerminalShortcutModifier[]).map(m => <label key={m}><input type="checkbox" checked={draft.chord.modifiers.includes(m)} onChange={e => setDraft({...draft,chord:{...draft.chord,modifiers:e.target.checked ? [...draft.chord.modifiers,m] : draft.chord.modifiers.filter(v => v !== m)}})}/>{m}</label>)}</div>
        </>}
        <button type="submit">{t('保存','Save')}</button><button type="button" onClick={() => setDraft(undefined)}>{t('取消','Cancel')}</button>
      </form>}
    </div></Dialog>
  </section>;
}
