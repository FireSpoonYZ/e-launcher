import { useEffect, useRef, useState } from 'react';
import { registerPlugin } from '@capacitor/core';
import { Chat } from './native';
import { Dialog, ConfirmDialog } from './components/ui/dialog';
import { ErrorNotice, errorText, useText } from './ui';
import './bots.css';

type Profile = { id: string; name: string; rolePrompt: string; revision: number;
  history: { name: string; rolePrompt: string; revision: number; changedAt: number; source: string }[] };
type Task = { id?: string; revision?: number; title: string; prompt: string;
  repeat: 'daily' | 'weekly' | 'monthly'; time: string; weekday: number; monthDay: number;
  enabled?: boolean; nextRunAt?: number; conversationId?: string };
type Delivery = { id: string; from: string; to: string; name?: string; kind: 'bot' | 'reply' | 'schedule' | 'user';
  body: string; status: string; error: string; replyTo: string; requestId: string; createdAt: number };
type Snapshot = { profile: Profile; messages: Delivery[]; error: string;
  schedules: { tasks: Task[]; records: { id: string; title: string; status: string; message: string; scheduledAt: number }[];
    exactAlarmGranted: boolean; schedulingError: string; timeZone: string; archived: boolean } };
interface BotsPlugin {
  snapshot(args: { conversationId: string }): Promise<Snapshot>;
  saveProfile(args: { conversationId: string; name: string; rolePrompt: string; revision: number }): Promise<Profile>;
  action(args: { conversationId: string; operationId: string; arguments: Record<string, unknown> }): Promise<unknown>;
}
const Bots = registerPlugin<BotsPlugin>('Bots');
const emptyTask = (): Task => ({ title: '', prompt: '', repeat: 'daily', time: '09:00', weekday: 1, monthDay: 1 });
function editable(task: Task) {
  return { ...(task.id ? { id: task.id, revision: task.revision } : {}), title: task.title,
    prompt: task.prompt, repeat: task.repeat, time: task.time, weekday: task.weekday, monthDay: task.monthDay };
}

/** Presentation reads trusted host metadata, never tries to infer message authority from body text. */
export function BotOrigin({ message }: { message: { origin?: Delivery } }) {
  const origin = message.origin; const t = useText();
  if (!origin || origin.kind === 'user') return null;
  const label = origin.kind === 'schedule' ? t('定时任务', 'Routine') : origin.kind === 'reply' ? t('Bot 回复', 'Bot reply') : t('Bot 来信', 'Bot message');
  return <aside className="bot-origin"><strong>{label}</strong><span>{origin.name || origin.from}</span>
    {origin.replyTo && <small>{t('回复于 ', 'In reply to ')}{origin.replyTo.slice(0, 8)}</small>}</aside>;
}

function TaskForm({ value, change }: { value: Task; change(value: Task): void }) {
  const t = useText();
  return <fieldset className="bot-form"><label>{t('任务名称', 'Routine name')}<input maxLength={80} value={value.title} onChange={e => change({ ...value, title: e.target.value })}/></label>
    <label>{t('任务指令', 'Instructions')}<textarea rows={3} maxLength={8000} value={value.prompt} onChange={e => change({ ...value, prompt: e.target.value })}/></label>
    <div className="bot-form-row"><label>{t('重复', 'Repeat')}<select value={value.repeat} onChange={e => change({ ...value, repeat: e.target.value as Task['repeat'] })}>
      <option value="daily">{t('每天', 'Daily')}</option><option value="weekly">{t('每周', 'Weekly')}</option><option value="monthly">{t('每月', 'Monthly')}</option></select></label>
      <label>{t('时间', 'Time')}<input type="time" value={value.time} onChange={e => change({ ...value, time: e.target.value })}/></label>
      {value.repeat === 'weekly' && <label>{t('星期（1=周一）', 'Weekday (1=Mon)')}<input type="number" min={1} max={7} value={value.weekday} onChange={e => change({ ...value, weekday: Number(e.target.value) })}/></label>}
      {value.repeat === 'monthly' && <label>{t('每月几日', 'Day of month')}<input type="number" min={1} max={31} value={value.monthDay} onChange={e => change({ ...value, monthDay: Number(e.target.value) })}/></label>}</div></fieldset>;
}

export function BotPanel({ conversationId, close, changed }: { conversationId: string; close(): void; changed(): Promise<void> }) {
  const t = useText(); const [state, setState] = useState<Snapshot>();
  const [name, setName] = useState(''), [role, setRole] = useState(''), [revision, setRevision] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [task, setTask] = useState<Task>(); const [confirmRun, setConfirmRun] = useState<Task>();
  const [create, setCreate] = useState(false), [newName, setNewName] = useState(''), [newRole, setNewRole] = useState('');
  const [initialRoutine, setInitialRoutine] = useState(false), [newTask, setNewTask] = useState<Task>(emptyTask);
  const live = useRef(true), sequence = useRef(0), profileLoaded = useRef(false);
  const load = async (resetProfile = false) => {
    const token = ++sequence.current;
    const next = await Bots.snapshot({ conversationId });
    if (!live.current || token !== sequence.current) return;
    setState(next);
    if (resetProfile || !profileLoaded.current) { profileLoaded.current = true; setName(next.profile.name); setRole(next.profile.rolePrompt); setRevision(next.profile.revision); }
  };
  useEffect(() => {
    live.current = true; void load(true).catch(e => { if (live.current) setError(errorText(e)); });
    const listener = Chat.addListener('chatEvent', event => {
      if (event.conversationId === conversationId && ['end', 'botChanged', 'snapshot', 'conversationArchived', 'conversationRestored'].includes(event.type))
        void load().catch(e => { if (live.current) setError(errorText(e)); });
    });
    return () => { live.current = false; ++sequence.current; void listener.then(handle => handle.remove()).catch(() => {}); };
  }, [conversationId]);
  const run = async (operation: () => Promise<unknown>, reset = false) => {
    if (busy) return; setBusy(true); setError('');
    try { await operation(); await load(reset); await changed(); }
    catch (e) { if (live.current) setError(errorText(e)); }
    finally { if (live.current) setBusy(false); }
  };
  const act = (arguments_: Record<string, unknown>) => Bots.action({ conversationId, operationId: crypto.randomUUID(), arguments: arguments_ });
  return <Dialog open onOpenChange={open => !open && close()} title={t('Bot 设置与定时任务', 'Bot settings and routines')} sheet className="bot-panel">
    <ErrorNotice error={error || state?.error || state?.schedules.schedulingError}/>
    {!state ? <p>{t('正在读取…', 'Loading…')}</p> : <>
      <section className="bot-form"><p className="secondary">ID: {state.profile.id}</p>
        <label>{t('名称', 'Name')}<input value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label>
        <label>{t('角色说明', 'Role prompt')}<textarea rows={6} maxLength={16000} value={role} onChange={e => setRole(e.target.value)}/></label>
        <small>{t('下一轮生效，不替换全局规则。', 'Applies next turn; does not replace global rules.')}</small>
        {revision !== state.profile.revision && <p role="status">{t('角色说明已在其他位置修改，请重新载入后编辑。', 'This profile changed elsewhere. Reload before editing.')}</p>}
        <div className="bot-actions"><button className="button" disabled={busy || !name.trim()} onClick={() => void run(() => Bots.saveProfile({ conversationId, name, rolePrompt: role, revision }), true)}>{t('保存角色说明', 'Save profile')}</button>
          <button className="quiet-button" disabled={busy} onClick={() => void run(() => load(true))}>{t('重新载入', 'Reload')}</button></div>
        <details><summary>{t('角色修改历史', 'Profile history')}</summary>{state.profile.history.slice().reverse().map(item => <article key={item.revision} className="bot-item"><small>v{item.revision} · {item.source} · {new Date(item.changedAt).toLocaleString()}</small>
          <pre>{item.rolePrompt}</pre><button disabled={busy} onClick={() => { setRole(item.rolePrompt); setName(item.name); setRevision(state.profile.revision); }}>{t('载入此版本，保存后恢复', 'Load this version, then save to restore')}</button></article>)}</details>
      </section>
      <section><h3>{t('定时任务', 'Routines')}</h3><p className="secondary">{t('在此 bot 的原会话中执行。时区：', 'Runs in this bot’s existing conversation. Time zone: ')}{state.schedules.timeZone}</p>
        {state.schedules.archived && <p role="status">{t('Bot 已归档，自动投递暂停；不会自动删除。', 'Archived: automatic delivery is paused; the bot will not expire.')}</p>}
        {!state.schedules.exactAlarmGranted && <p role="alert">{t('尚未授予精确闹钟权限，任务可以保存，但定时触发不可用。请在系统设置授予权限。', 'Exact alarm access is missing. Routines can be saved, but scheduled triggering is unavailable. Grant access in system settings.')}</p>}
        {state.schedules.tasks.map(item => <article className="bot-item" key={item.id}><strong>{item.title}</strong><p>{item.repeat} · {item.time} · {item.enabled ? t('已启用', 'Enabled') : t('已暂停', 'Paused')}</p>
          <small>{t('下次：', 'Next: ')}{item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : '—'}</small>
          <div className="bot-actions"><button disabled={busy} onClick={() => setTask({ ...item })}>{t('编辑', 'Edit')}</button>
            <button disabled={busy} onClick={() => void run(() => act({ action: 'schedule_enable', taskId: item.id, revision: item.revision, enabled: !item.enabled }))}>{item.enabled ? t('暂停', 'Pause') : t('启用', 'Enable')}</button>
            <button disabled={busy || state.schedules.archived} onClick={() => setConfirmRun(item)}>{t('立即运行', 'Run now')}</button>
            <button disabled={busy} onClick={() => void run(() => act({ action: 'schedule_delete', taskId: item.id, revision: item.revision }))}>{t('删除任务', 'Delete routine')}</button></div></article>)}
        <button className="button" disabled={busy} onClick={() => setTask(emptyTask())}>{t('添加定时任务', 'Add routine')}</button>
        {task && <div className="bot-item"><TaskForm value={task} change={setTask}/><div className="bot-actions"><button disabled={busy} onClick={() => void run(async () => { await act({ action: 'schedule_save', schedule: editable(task) }); setTask(undefined); })}>{t('保存，不立即执行', 'Save without running')}</button><button disabled={busy} onClick={() => setTask(undefined)}>{t('取消', 'Cancel')}</button></div></div>}
        <details><summary>{t('运行记录', 'Run history')}</summary>{state.schedules.records.slice(0, 30).map(item => <p key={item.id}>{item.title} · {item.status} · {new Date(item.scheduledAt).toLocaleString()} {item.message}</p>)}</details>
      </section>
      <section><h3>{t('Bot 通信', 'Bot messages')}</h3>{state.messages.slice(-30).reverse().map(item => <article key={item.id} className="bot-item"><small>{item.from === conversationId ? '→' : '←'} {item.kind} · {item.status} · {item.id.slice(0, 8)}</small><p>{item.body.slice(0, 240)}</p>{item.error && <p role="alert">{item.error}</p>}
        {item.kind !== 'schedule' && <button disabled={busy} onClick={() => void Chat.selectConversation({ conversationId: item.from === conversationId ? item.to : item.from }).then(changed).then(close).catch(e => setError(errorText(e)))}>{t('打开对方会话', 'Open other bot')}</button>}</article>)}</section>
      <section><button className="button" disabled={busy} onClick={() => setCreate(!create)}>{t('创建其他 Bot', 'Create another bot')}</button>
        {create && <div className="bot-form"><label>{t('新 bot 名称', 'New bot name')}<input maxLength={80} value={newName} onChange={e => setNewName(e.target.value)}/></label>
          <label>{t('初始角色说明', 'Initial role prompt')}<textarea rows={4} maxLength={16000} value={newRole} onChange={e => setNewRole(e.target.value)}/></label>
          <label><input type="checkbox" checked={initialRoutine} onChange={e => setInitialRoutine(e.target.checked)}/>{t('同时添加定时任务', 'Add an initial routine')}</label>
          {initialRoutine && <TaskForm value={newTask} change={setNewTask}/>}<button disabled={busy || !newName.trim()} onClick={() => void run(async () => {
            const result = await act({ action: 'create', name: newName, rolePrompt: newRole, schedules: initialRoutine ? [editable(newTask)] : [] }) as { scheduleErrors?: { error: string }[] };
            setCreate(false); if (result.scheduleErrors?.length) throw new Error(t('Bot 已创建，但部分任务未保存：', 'Bot created; some routines failed: ') + result.scheduleErrors.map(e => e.error).join('; '));
          })}>{t('创建', 'Create')}</button></div>}
      </section><p className="secondary">{t('删除 bot 只能由用户在会话列表中手动操作。', 'Bots can only be deleted manually from the conversation list.')}</p>
    </>}
    <ConfirmDialog open={!!confirmRun} title={t('立即执行此任务？', 'Run this routine now?')} description={t('这会调用模型并实际执行操作，不是预览。', 'This calls the model and performs real actions; it is not a preview.')} onCancel={() => setConfirmRun(undefined)} onConfirm={() => { if (confirmRun) void run(async () => { await act({ action: 'schedule_run', taskId: confirmRun.id, revision: confirmRun.revision }); setConfirmRun(undefined); }); }}/>
  </Dialog>;
}
