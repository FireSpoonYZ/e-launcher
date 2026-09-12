import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Braces, FileCode2, FilePlus, History, RotateCcw, Save, Shield, Upload } from 'lucide-react';
import { NativeSettings } from './native';
import { Dialog } from './components/ui/dialog';
import { ErrorNotice, Header, Loading, Scope, SearchField, Section, useAction, useBack, useText } from './ui';
import { Toggle } from './Settings';

interface Field {key:string;label:string;group:string;type:string;options?:string[];description:string;globalOnly:boolean;default?:string}
export function AdvancedPage() {
  const t = useText(); const nav = useNavigate(); const action = useAction();
  const [project,setProject] = useState(false); const [fields,setFields] = useState<Field[]>([]); const [sources,setSources] = useState<Record<string,string>>({}); const [revision,setRevision] = useState(''); const [group,setGroup] = useState(''); const [search,setSearch] = useState('');
  const load = async () => { const [schema,settings] = await Promise.all([NativeSettings.schema(),NativeSettings.settings({project})]); setFields(schema.fields as unknown as Field[]); setSources(settings.sources ?? {}); setRevision(settings.revision || ''); };
  useEffect(() => { void action.run(load); },[project]);
  const groups = [...new Set(fields.map(field => field.group))];
  return <main className="page"><Header title={t('高级配置','Advanced')} actions={<button className="icon-button" aria-label={t('文件编辑器','File editor')} onClick={() => nav(`/settings/editor?project=${project}`)}><FileCode2/></button>}/><Scope project={project} onChange={setProject}/><SearchField value={search} onChange={setSearch} placeholder={t('搜索配置字段','Search settings')}/><p className="secondary">{t('修改用于后续请求；工作区继承全局配置。','Changes apply to subsequent requests. Workspace settings inherit global values.')}</p><ErrorNotice error={action.error}/>
    {!group && !search ? <><Section title={t('配置分组','Groups')}>{groups.map(name => <button className="wide-action" key={name} onClick={() => setGroup(name)}>{name}<span className="secondary">{fields.filter(f => f.group === name).length}</span></button>)}</Section><button className="wide-action" onClick={() => nav(`/settings/editor?project=${project}`)}><FileCode2/>{t('完整配置与文件','Full configuration & files')}</button></> : <><button className="quiet-button" onClick={() => {setGroup('');setSearch('');}}>{t('全部分组','All groups')}</button><h2>{group}</h2>{fields.filter(f => (!group || f.group === group) && `${f.key} ${f.label}`.toLowerCase().includes(search.toLowerCase())).map(field => <FieldEditor key={`${project}/${field.key}`} field={field} source={sources[field.key] ?? 'null'} project={project} revision={revision} onSaved={load}/>)}</>}
  </main>;
}
function FieldEditor({field,source,project,revision,onSaved}: {field:Field;source:string;project:boolean;revision:string;onSaved():Promise<void>}) {
  const t = useText(); const action = useAction(); const [draft,setDraft] = useState(source); const [editing,setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(source); },[source,editing]);
  const stringValue = (s:string) => { try { return JSON.parse(s) as string; } catch {return s;} };
  const disabled = project && field.globalOnly;
  const save = (value:string) => action.run(async () => { await NativeSettings.updateSetting({project,key:field.key,value,previous:source}); setEditing(false); await onSaved(); });
  return <div className="schema-field"><div className="field-heading"><span><strong>{field.label}</strong><code>{field.key}</code></span>{field.type === 'boolean' && <Toggle label={field.label} checked={source === 'true'} disabled={disabled || action.busy} onChange={v => save(String(v))}/>}</div><p className="secondary">{field.description}</p>{disabled ? <small>{t('仅全局可配置','Global setting only')}</small> : <>
    {field.type !== 'boolean' && <>{field.options ? <select aria-label={field.label} value={source === 'null' ? '' : stringValue(draft)} onChange={e => {setDraft(JSON.stringify(e.target.value));setEditing(true);}}><option value="" disabled>{t('继承','Inherited')}</option>{field.options.map(option => <option key={option}>{option}</option>)}</select> : field.type === 'string' ? <input aria-label={field.label} placeholder={source === 'null' ? t('继承','Inherited') : ''} value={draft === 'null' ? '' : stringValue(draft)} onChange={e => {setDraft(JSON.stringify(e.target.value));setEditing(true);}}/> : <textarea aria-label={field.label} rows={field.type === 'number' ? 1 : 4} spellCheck={false} value={draft === 'null' ? '' : draft} placeholder={t('继承；支持 JSON 原文','Inherited; enter JSON')} onChange={e => {setDraft(e.target.value);setEditing(true);}}/>}{editing && <div className="action-row"><button className="button" disabled={action.busy} onClick={() => save(draft)}>{t('保存','Save')}</button><button className="quiet-button" onClick={() => setEditing(false)}>{t('取消','Cancel')}</button></div>}</>}
    {source !== 'null' && <button className="quiet-button" disabled={action.busy} onClick={() => action.run(async () => {await NativeSettings.resetSetting({project,key:field.key,revision}); await onSaved();})}><RotateCcw/>{t('恢复继承','Reset to inherited')}</button>}
  </>}<ErrorNotice error={action.error}/></div>;
}
interface Buffer {source:string;base:string}
export function EditorPage() {
  const [params] = useSearchParams(); const t = useText(); const back = useBack(); const action = useAction();
  const [project,setProject] = useState(params.get('project') === 'true'); const [name,setName] = useState(params.get('file') || 'settings.json'); const [files,setFiles] = useState<string[]>([]);
  const [buffer,setBuffer] = useState<Buffer>(); const [backup,setBackup] = useState<Buffer>(); const [secret,setSecret] = useState(false); const [conflict,setConflict] = useState(false); const [saved,setSaved] = useState('');
  const [pending,setPending] = useState<(() => void)>(); const [newFile,setNewFile] = useState(false); const [newName,setNewName] = useState('');
  const dirty = !!buffer && buffer.source !== buffer.base;
  const load = async () => {
    const listing = await NativeSettings.files({project}); setFiles([...new Set([...listing.files,name])]);
    const result = await NativeSettings.readFile({project,name,allowSecrets:secret,warningAccepted:secret});
    setBuffer({source:result.draft ?? result.source,base:result.draftBase ?? result.source});
    setConflict(result.draft !== undefined && result.draftBase !== undefined && result.draftBase !== result.source);
  };
  useEffect(() => { setBuffer(undefined);setSaved('');setBackup(undefined); if(name === 'auth.json' && !secret) return; void action.run(load); },[name,project,secret]);
  const storeDraft = (value:Buffer) => NativeSettings.saveDraft({project,name,source:value.source,base:value.base});
  const edit = (source:string) => { if (!buffer) return; const next={...buffer,source};setBuffer(next);setSaved('');void storeDraft(next).catch(e => action.setError(String(e))); };
  const leave = (next:() => void) => { if(dirty) setPending(() => next); else next(); };
  useEffect(() => {
    const handler = (event:Event) => { if(dirty){event.preventDefault();setPending(() => back);} };
    window.addEventListener('app-back',handler); return () => window.removeEventListener('app-back',handler);
  },[dirty]);
  const save = async () => {
    if(!buffer)return;
    try {const result=await NativeSettings.saveFile({project,name,source:buffer.source,expected:buffer.base});setBuffer({source:result.source,base:result.source});setConflict(false);setSaved(t('已保存','Saved'));}
    catch(e){await storeDraft(buffer);if(/其他操作修改|配置已变化/.test(String(e)))setConflict(true);throw e;}
  };
  const reload = () => action.run(async () => {
    if (buffer && dirty) {await storeDraft(buffer);setBackup(buffer);}
    const latest=await NativeSettings.readFile({project,name,allowSecrets:secret,warningAccepted:secret});
    setBuffer({source:latest.source,base:latest.source});setConflict(false);setSaved(t('已载入磁盘版本，原草稿仍可恢复','Disk version loaded; original draft is recoverable'));
  });
  return <main className="editor-page"><Header title={t('高级配置','Configuration editor')} onBack={() => leave(back)} actions={<button className="save-header" disabled={!dirty || action.busy} onClick={() => action.run(save)}><Save/>{t('保存','Save')}</button>}/><Scope project={project} onChange={next => leave(() => {setProject(next);setSecret(false);})}/><div className="editor-file-row"><FileCode2/><select aria-label={t('文件','File')} value={name} onChange={e => {const next=e.target.value;leave(() => {setName(next);setSecret(false);});}}>{[...new Set([...files,name])].map(file => <option key={file}>{file}</option>)}</select><span>{dirty?t('已修改','Modified'):saved || t('已保存','Saved')}</span></div>
    {name === 'auth.json' && !secret ? <div className="secret-warning"><Shield/><h2>{t('此文件包含凭据','This file contains credentials')}</h2><p>{t('打开后会显示 API 密钥或登录令牌。','Opening this file reveals API keys or login tokens.')}</p><button className="button" onClick={() => setSecret(true)}>{t('确认并打开','Confirm and open')}</button></div> : <>
    <div className="editor-tools"><button disabled={!buffer || !name.endsWith('.json')} onClick={() => action.run(async () => edit((await NativeSettings.formatFile({source:buffer!.source})).source))}><Braces/>{t('格式化','Format')}</button><button disabled={!buffer} onClick={() => action.run(async () => edit((await NativeSettings.previous({project,name,allowSecrets:secret,warningAccepted:secret})).source))}><History/>{t('上一版','Previous')}</button><button disabled={!buffer} onClick={() => action.run(() => NativeSettings.exportFile({name,source:buffer!.source,json:name.endsWith('.json')}))}><Upload/>{t('导出','Export')}</button><button disabled={!buffer} onClick={() => action.run(async () => edit((await NativeSettings.importFile()).source))}>{t('导入','Import')}</button><button onClick={() => setNewFile(true)}><FilePlus/>{t('新建','New')}</button><button disabled={!buffer} onClick={reload}><RotateCcw/>{t('重新载入','Reload')}</button></div>
    {!buffer ? <Loading/> : <div className="code-area"><textarea className="code-editor" aria-label={name} autoCapitalize="off" autoCorrect="off" spellCheck={false} value={buffer.source} onChange={e => edit(e.target.value)}/></div>}
    {conflict && <div className="conflict"><strong>{t('文件已在其他位置修改','File changed elsewhere')}</strong><p>{t('草稿及其原始版本已保留。载入磁盘版本后再合并。','Your draft and its original version are preserved. Reload to merge.')}</p><button className="button secondary-button" onClick={reload}>{t('重新载入','Reload')}</button></div>}
    {backup && <button className="quiet-button" onClick={() => {setBuffer(backup);setBackup(undefined);}}>{t('恢复原草稿','Restore original draft')}</button>}
    </>}<ErrorNotice error={action.error}/>
    <Dialog open={!!pending} title={t('保留修改？','Keep your changes?')} onOpenChange={v => !v && setPending(undefined)}><p className="secondary">{t('可以保存文件、仅保留草稿，或继续编辑。','Save the file, keep a draft, or continue editing.')}</p><div className="form"><button className="button" onClick={() => action.run(async () => {await save();const next=pending;setPending(undefined);next?.();})}>{t('保存并离开','Save and leave')}</button><button className="button secondary-button" onClick={() => action.run(async () => {if(buffer)await storeDraft(buffer);const next=pending;setPending(undefined);next?.();})}>{t('保留草稿并离开','Keep draft and leave')}</button><button className="quiet-button" onClick={() => setPending(undefined)}>{t('继续编辑','Continue editing')}</button><ErrorNotice error={action.error}/></div></Dialog>
    <Dialog open={newFile} title={t('新建文件','New file')} onOpenChange={setNewFile}><form className="form" onSubmit={e => {e.preventDefault();setNewFile(false);leave(() => {setName(newName);setSecret(false);});}}><label>{t('相对文件名','Relative filename')}<input required value={newName} onChange={e => setNewName(e.target.value)} placeholder="extensions/config.yaml"/></label><button className="button">{t('创建','Create')}</button></form></Dialog>
  </main>;
}
