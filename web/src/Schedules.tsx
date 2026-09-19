import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, ChevronRight, CircleAlert, Clock3, FileText, LoaderCircle, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Chat, ScheduledTasks, type SchedulePreview, type ScheduleRecord, type ScheduleRule, type ScheduleSnapshot, type ScheduledTask, type ScheduledTaskInput, type ConversationSummary } from './native';
import { Dialog } from './components/ui/dialog';
import { Toggle } from './Settings';
import { LatestRequest } from './latestRequest';
import { ErrorNotice, Header, Loading, errorText, useAction, useText } from './ui';
import './schedules.css';

type Text = ReturnType<typeof useText>;
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const englishDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ruleOf = (value: ScheduleRule): ScheduleRule => ({repeat: value.repeat, time: value.time, weekday: value.weekday, monthDay: value.monthDay});
function ruleLabel(rule: ScheduleRule, t: Text) {
  if (rule.repeat === 'weekly') return t(`每周${weekdays[rule.weekday - 1]} ${rule.time}`, `Every ${englishDays[rule.weekday - 1]} at ${rule.time}`);
  if (rule.repeat === 'monthly') return t(`每月 ${rule.monthDay} 日 ${rule.time}`, `Monthly on day ${rule.monthDay} at ${rule.time}`);
  return t(`每天 ${rule.time}`, `Daily at ${rule.time}`);
}
function dateLabel(timestamp: number, zone: string, t: Text) {
  return new Intl.DateTimeFormat(t('zh-CN', 'en-GB'), {
    timeZone: zone, month: t('long', 'short') as 'long'|'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(new Date(timestamp).getFullYear() !== new Date().getFullYear() ? {year: 'numeric' as const} : {}),
  }).format(timestamp);
}
function useSchedules() {
  const [data, setData] = useState<ScheduleSnapshot>();
  const [error, setError] = useState('');
  const gate = useRef(new LatestRequest()).current;
  const refresh = useCallback(async () => {
    const request = gate.begin();
    try {
      const value = await ScheduledTasks.snapshot();
      if (gate.current(request)) { setData(value); setError(''); }
    } catch (e) { if (gate.current(request)) setError(errorText(e)); }
  }, [gate]);
  const accept = (value: ScheduleSnapshot) => { gate.begin(); setData(value); setError(''); };
  useEffect(() => {
    let live = true;
    const listener = ScheduledTasks.addListener('scheduleEvent', () => { if (live) void refresh(); });
    void listener.then(() => { if (live) void refresh(); }).catch(e => { if (live) setError(errorText(e)); });
    window.addEventListener('focus', refresh);
    return () => {
      live = false; gate.begin(); window.removeEventListener('focus', refresh);
      void listener.then(handle => handle.remove()).catch(() => {});
    };
  }, [refresh, gate]);
  return {data, error, refresh, accept};
}
function FetchError({error, retry}: {error: string; retry(): void}) {
  const t = useText();
  return error ? <div><ErrorNotice error={error}/><button type="button" className="quiet-button" onClick={retry}>{t('重新加载', 'Reload')}</button></div> : null;
}
function ScheduleEmpty({title, children}: {title: string; children?: ReactNode}) {
  return <div className="schedule-empty"><Clock3 aria-hidden="true"/><h2>{title}</h2>{children && <p>{children}</p>}</div>;
}

export function SchedulesPage() {
  const t = useText(); const nav = useNavigate(); const state = useSchedules(); const action = useAction();
  const [filter, setFilter] = useState<'all'|'enabled'|'paused'>('all');
  const [editing, setEditing] = useState<ScheduledTask|'new'|null>(null);
  const [menu, setMenu] = useState<ScheduledTask>();
  const [removing, setRemoving] = useState<ScheduledTask>();
  const [notice, setNotice] = useState('');
  const tasks = state.data?.tasks ?? [];
  const enabled = tasks.filter(task => task.enabled).length;
  const visible = tasks.filter(task => filter === 'all' || task.enabled === (filter === 'enabled'));
  const mutateEnabled = (task: ScheduledTask, checked: boolean) => action.run(async () => {
    state.accept(await ScheduledTasks.setEnabled({id: task.id, revision: task.revision, enabled: checked}));
    setNotice(checked ? t('任务已启用', 'Task enabled') : t('任务已暂停', 'Task paused'));
  });
  return <main className="page schedules-page">
    <Header title={t('定时任务', 'Scheduled tasks')} actions={<button className="icon-button" aria-label={t('新建任务', 'New task')} disabled={!state.data} onClick={() => setEditing('new')}><Plus/></button>}/>
    <div className="schedule-scroll">
      <FetchError error={state.error} retry={state.refresh}/><ErrorNotice error={action.error}/>
      {!state.data && !state.error && <Loading/>}
      {state.data && <>
        {!state.data.exactAlarmGranted && <div className="schedule-permission"><Clock3 aria-hidden="true"/><div><strong>{t('开启定时执行', 'Enable scheduled execution')}</strong><p>{t('允许闹钟与提醒权限后，任务才能按时启动。', 'Allow alarms & reminders to start scheduled tasks.')}</p><button className="quiet-button" disabled={action.busy} onClick={() => action.run(() => ScheduledTasks.requestExactAlarm())}>{t('去设置', 'Open settings')}<ChevronRight/></button></div></div>}
        <FetchError error={state.data.schedulingError} retry={() => void action.run(async () => state.accept(await ScheduledTasks.retryScheduling()))}/>
        {tasks.length > 0 && <>
          <p className="schedule-summary">{t(`${enabled} 个已启用 · ${tasks.length - enabled} 个已暂停`, `${enabled} enabled · ${tasks.length - enabled} paused`)}</p>
          <div className="segments schedule-filters" role="group" aria-label={t('筛选任务', 'Filter tasks')}>
            {(['all', 'enabled', 'paused'] as const).map((value, i) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{[t('全部', 'All'), t('已启用', 'Enabled'), t('已暂停', 'Paused')][i]}</button>)}
          </div>
        </>}
        {notice && <p className="schedule-notice" role="status">{notice}</p>}
        {!tasks.length ? <ScheduleEmpty title={t('还没有定时任务', 'No scheduled tasks yet')}>{t('把重复的事交给 Pi，到时间自动开始。', 'Let Pi handle recurring work at the time you choose.')}</ScheduleEmpty>
          : !visible.length ? <ScheduleEmpty title={t('没有符合条件的任务', 'No matching tasks')}/>
          : <div className="schedule-list">{visible.map(task => <article className={`schedule-row${task.enabled ? '' : ' is-paused'}`} key={task.id}>
            <button className="schedule-row-main" onClick={() => { action.setError(''); setEditing(task); }} aria-label={t(`编辑 ${task.title}`, `Edit ${task.title}`)}>
              <Clock3 className="schedule-row-icon" aria-hidden="true"/><span><strong>{task.title}</strong><span>{ruleLabel(task, t)}</span><small>{!task.enabled ? t('已暂停', 'Paused') : !state.data!.exactAlarmGranted ? t('等待闹钟与提醒权限', 'Waiting for alarm permission') : t('下次：', 'Next: ') + dateLabel(task.nextRunAt, state.data!.timeZone, t)}</small></span>
            </button>
            <div className="schedule-toggle-target"><Toggle label={t(`启用 ${task.title}`, `Enable ${task.title}`)} checked={task.enabled} disabled={action.busy} onChange={checked => void mutateEnabled(task, checked)}/></div>
            <button className="icon-button" aria-label={t(`${task.title} 的更多操作`, `More actions for ${task.title}`)} disabled={action.busy} onClick={() => { action.setError(''); setMenu(task); }}><MoreHorizontal/></button>
          </article>)}</div>}
        {(tasks.length > 0 || state.data.records.length > 0) && <button className="schedule-history-link" onClick={() => nav('/schedules/history')}><FileText/><span>{t('执行记录', 'Execution history')}</span><ChevronRight/></button>}
      </>}
    </div>
    <footer className="schedule-page-footer"><button className="button full" disabled={!state.data} onClick={() => setEditing('new')}><Plus/>{t('新建任务', 'New task')}</button></footer>
    {editing && <TaskEditor task={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={next => {
      state.accept(next); setEditing(null); setFilter('all');
      setNotice(editing === 'new' ? t('定时任务已创建', 'Scheduled task created') : t('修改已保存', 'Changes saved'));
    }}/>}
    {menu && <Dialog open sheet title={menu.title} onOpenChange={open => !open && setMenu(undefined)}>
      <p className="secondary">{ruleLabel(menu, t)}</p>
      <button className="wide-action" onClick={() => { setEditing(menu); setMenu(undefined); }}><Pencil/>{t('编辑任务', 'Edit task')}</button>
      <button className="wide-action" onClick={() => { nav(`/schedules/history?taskId=${encodeURIComponent(menu.id)}`); setMenu(undefined); }}><FileText/>{t('执行记录', 'Execution history')}</button>
      <button className="wide-action danger" onClick={() => { setRemoving(menu); setMenu(undefined); }}><Trash2/>{t('删除任务', 'Delete task')}</button>
    </Dialog>}
    {removing && <Dialog open title={t('删除定时任务？', 'Delete scheduled task?')} onOpenChange={open => !open && !action.busy && setRemoving(undefined)}>
      <p className="secondary">{t(`“${removing.title}”将不再定时执行。已开始的任务、会话和执行记录会保留。`, `“${removing.title}” will no longer run on a schedule. Started runs, conversations and history will be kept.`)}</p>
      <ErrorNotice error={action.error}/><div className="dialog-actions"><button className="button secondary-button" disabled={action.busy} onClick={() => setRemoving(undefined)}>{t('取消', 'Cancel')}</button><button className="button danger-button" disabled={action.busy} onClick={() => action.run(async () => {
        state.accept(await ScheduledTasks.delete({id: removing.id, revision: removing.revision})); setRemoving(undefined); setNotice(t('定时任务已删除', 'Scheduled task deleted'));
      })}>{action.busy ? t('正在删除…', 'Deleting…') : t('删除', 'Delete')}</button></div>
    </Dialog>}
  </main>;
}

function useNextRun(rule: ScheduleRule) {
  const [value, setValue] = useState<SchedulePreview>(); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true; setValue(undefined); setError('');
    if (!rule.time) return () => { live = false; };
    void ScheduledTasks.preview(rule).then(next => { if (live) setValue(next); }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [rule.repeat, rule.time, rule.weekday, rule.monthDay, retry]);
  return {value, error, retry: () => setRetry(value => value + 1)};
}
function TaskEditor({task, onClose, onSaved}: {task?: ScheduledTask; onClose(): void; onSaved(value: ScheduleSnapshot): void}) {
  const t = useText(); const action = useAction();
  const initial = useRef<ScheduledTaskInput>(task
    ? {id: task.id, revision: task.revision, title: task.title, prompt: task.prompt, conversationId: task.conversationId, ...ruleOf(task)}
    : {title: '', prompt: '', repeat: 'daily', time: '08:00', weekday: 1, monthDay: 1}).current;
  const [draft, setDraft] = useState(initial);
  const [owners, setOwners] = useState<ConversationSummary[]>([]);
  useEffect(() => {
    let live = true;
    void Chat.listConversations().then(value => { if (live) setOwners(value.conversations); })
      .catch(error => { if (live) action.setError(errorText(error)); });
    return () => { live = false; };
  }, []);
  const [cycle, setCycle] = useState<ScheduleRule>();
  const [discard, setDiscard] = useState(false);
  const activeRule = cycle ?? draft;
  const preview = useNextRun(activeRule);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || (!!cycle && JSON.stringify(cycle) !== JSON.stringify(ruleOf(draft)));
  const requestClose = () => {
    if (action.busy) return;
    if (discard) setDiscard(false); else if (dirty) setDiscard(true); else onClose();
  };
  const back = discard ? () => setDiscard(false) : cycle ? () => setCycle(undefined) : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (action.busy || !preview.value) return;
    if (cycle) { setDraft({...draft, ...cycle}); setCycle(undefined); return; }
    if (!draft.conversationId) { action.setError(t('请选择执行任务的 Bot / 会话。', 'Choose the bot / conversation that will run this task.')); return; }
    if (!draft.title.trim() || !draft.prompt.trim()) { action.setError(t('请填写任务名称和内容。', 'Enter a task name and instructions.')); return; }
    void action.run(async () => onSaved(await ScheduledTasks.save(draft)));
  };
  return <Dialog open sheet className="schedule-sheet" title={discard ? t('放弃修改？', 'Discard changes?') : cycle ? t('执行周期', 'Repeat schedule') : task ? t('编辑定时任务', 'Edit scheduled task') : t('新建定时任务', 'New scheduled task')} onOpenChange={open => !open && requestClose()} onBack={back}>
    {discard ? <div className="schedule-discard"><p className="secondary">{t('未保存的内容将丢失。', 'Unsaved changes will be lost.')}</p><div className="dialog-actions"><button className="button secondary-button" onClick={() => setDiscard(false)}>{t('继续编辑', 'Keep editing')}</button><button className="button danger-button" onClick={onClose}>{t('放弃修改', 'Discard')}</button></div></div>
      : <form className="schedule-editor" onSubmit={submit}>
        <div className="schedule-editor-scroll">
          {cycle ? <>
            <div className="segments schedule-filters" role="group" aria-label={t('重复周期', 'Repeat interval')}>
              {(['daily', 'weekly', 'monthly'] as const).map((repeat, i) => <button type="button" key={repeat} aria-pressed={cycle.repeat === repeat} onClick={() => setCycle({...cycle, repeat})}>{[t('每天', 'Daily'), t('每周', 'Weekly'), t('每月', 'Monthly')][i]}</button>)}
            </div>
            {cycle.repeat === 'weekly' && <fieldset className="schedule-field"><legend>{t('执行日', 'Day of week')}</legend><div className="schedule-day-grid schedule-weekdays">{weekdays.map((label, i) => <button type="button" key={i} aria-label={t(`周${label}`, englishDays[i])} aria-pressed={cycle.weekday === i + 1} onClick={() => setCycle({...cycle, weekday: i + 1})}>{t(label, englishDays[i].slice(0, 2))}</button>)}</div><p className="secondary">{t(`每周${weekdays[cycle.weekday - 1]}执行`, `Runs every ${englishDays[cycle.weekday - 1]}`)}</p></fieldset>}
            {cycle.repeat === 'monthly' && <fieldset className="schedule-field"><legend>{t('每月几日', 'Day of month')}</legend><div className="schedule-day-grid">{Array.from({length: 31}, (_, i) => <button type="button" key={i} aria-label={t(`${i + 1} 日`, `Day ${i + 1}`)} aria-pressed={cycle.monthDay === i + 1} onClick={() => setCycle({...cycle, monthDay: i + 1})}>{i + 1}</button>)}</div><p className="secondary">{t('当月没有这一天时，跳过当月。', 'Months without this date are skipped.')}</p></fieldset>}
            <label className="schedule-field"><span>{t('执行时间', 'Time')}</span><span className="schedule-time-field"><input type="time" step="60" required aria-label={t('执行时间', 'Time')} value={cycle.time} onChange={e => setCycle({...cycle, time: e.target.value})}/></span></label>
            {cycle.repeat === 'daily' && <p className="secondary">{t('每天在指定时间执行。', 'Runs at this time every day.')}</p>}
          </> : <>
            <label className="schedule-field"><span>{t('任务名称', 'Task name')}</span><input required maxLength={80} placeholder={t('例如：早间简报', 'e.g. Morning briefing')} value={draft.title} disabled={action.busy} onChange={e => setDraft({...draft, title: e.target.value})}/></label>
            <label className="schedule-field"><span>{t('任务内容', 'Instructions')}</span><textarea required maxLength={8000} rows={3} placeholder={t('告诉 Pi，这个时间要做什么…', 'Tell Pi what to do at this time…')} value={draft.prompt} disabled={action.busy} onChange={e => setDraft({...draft, prompt: e.target.value})}/></label>
            <div className="schedule-field"><span>{t('执行周期', 'Repeat schedule')}</span><button type="button" className="schedule-cycle-link" disabled={action.busy} onClick={() => setCycle(ruleOf(draft))}><Clock3/><span>{ruleLabel(draft, t)}</span><ChevronRight/></button></div>
            <label className="schedule-field"><span>{t('所属 Bot / 会话', 'Owner bot / conversation')}</span>
              <select required aria-label={t('所属 Bot / 会话', 'Owner bot / conversation')} disabled={!!task || action.busy} value={draft.conversationId ?? ''} onChange={event => setDraft({...draft, conversationId: event.target.value})}>
                <option value="">{t('选择执行任务的会话', 'Choose a conversation')}</option>
                {owners.map(owner => <option key={owner.id} value={owner.id}>{owner.title || owner.id}</option>)}
                {draft.conversationId && !owners.some(owner => owner.id === draft.conversationId) && <option value={draft.conversationId}>{draft.conversationId}</option>}
              </select>
            </label>
            <div className="schedule-destination"><p className="secondary">{t('每次执行会继续所属 Bot 的原会话，使用该 Bot 的模型和上下文。Bot 忙碌或等待回答时，任务会排队。', 'Each run continues the owner bot’s conversation with its model and context. Tasks queue while the bot is busy or waiting for an answer.')}</p></div>
          </>}
          <ErrorNotice error={action.error}/><FetchError error={preview.error} retry={preview.retry}/>
        </div>
        <footer className="schedule-editor-footer">
          <div className="schedule-preview" aria-live="polite">{preview.value ? <><span>{task && !task.enabled ? t('启用后执行：', 'When enabled: ') : t('下次执行：', 'Next run: ')}{dateLabel(preview.value.nextRunAt, preview.value.timeZone, t)}</span><small>{t('按设备时区', 'Device time zone')} · {preview.value.timeZone}</small></> : <span className="secondary">{activeRule.time ? t('正在计算下次执行时间…', 'Calculating next run…') : t('请选择执行时间', 'Choose a time')}</span>}</div>
          <button className="button full" type="submit" disabled={action.busy || !preview.value}>{action.busy ? <><LoaderCircle className="spin"/>{t('正在保存…', 'Saving…')}</> : cycle ? t('确定', 'Confirm') : task ? t('保存修改', 'Save changes') : t('创建任务', 'Create task')}</button>
        </footer>
      </form>}
  </Dialog>;
}

function recordStatus(status: ScheduleRecord['status'], t: Text) {
  return {queued: t('已排队', 'Queued'), interrupted: t('已中断', 'Interrupted'), cancelled: t('已取消', 'Cancelled'), running: t('执行中', 'Running'), completed: t('已完成', 'Completed'), error: t('失败', 'Failed'), aborted: t('已中断', 'Interrupted'), skipped: t('已跳过', 'Skipped')}[status];
}
function recordMessage(record: ScheduleRecord, t: Text) {
  if (record.message) return record.message;
  if (record.reason === 'missed') return t('已跳过过期任务，将按下一次计划执行。', 'Missed run skipped. The next occurrence remains scheduled.');
  if (record.reason === 'overlap') return t('上一次任务仍在执行，已跳过本次。', 'The previous run is still active; this occurrence was skipped.');
  if (record.reason === 'interrupted') return t('应用进程已结束，本次执行已中断。', 'The app process ended before this run completed.');
  return {queued: t('等待所属 Bot 空闲后执行。', 'Waiting for the owner bot to become available.'), interrupted: t('执行已中断，未自动重试。', 'Run interrupted; it was not automatically retried.'), cancelled: t('本次投递已取消。', 'This delivery was cancelled.'), running: t('Pi 正在执行，可打开会话查看进度。', 'Pi is working. Open the conversation to follow progress.'), completed: t('任务已完成', 'Task completed'), error: t('执行失败，请查看会话。', 'Run failed. See the conversation for details.'), aborted: t('本次执行已停止', 'This run was stopped'), skipped: t('本次执行已跳过', 'This occurrence was skipped')}[record.status];
}
export function ScheduleHistoryPage() {
  const t = useText(); const nav = useNavigate(); const [params] = useSearchParams();
  const state = useSchedules(); const action = useAction(); const [filter, setFilter] = useState<'all'|'completed'|'error'>('all');
  const taskId = params.get('taskId');
  const records = (state.data?.records ?? []).filter(record => !taskId || record.taskId === taskId);
  const visible = records.filter(record => filter === 'all' || (filter === 'completed' ? record.status === 'completed' : ['error', 'aborted', 'interrupted', 'cancelled', 'skipped'].includes(record.status)));
  const title = state.data?.tasks.find(task => task.id === taskId)?.title ?? records[0]?.title;
  return <main className="page schedules-page">
    <Header title={t('执行记录', 'Execution history')}/>
    <div className="schedule-scroll">
      <FetchError error={state.error} retry={state.refresh}/><ErrorNotice error={action.error}/>
      {!state.data && !state.error && <Loading/>}
      {state.data && <>
        {taskId && <div className="schedule-history-scope"><strong>{title ?? t('已删除的任务', 'Deleted task')}</strong><button className="quiet-button" onClick={() => nav('/schedules/history', {replace: true})}>{t('查看全部', 'View all')}</button></div>}
        <p className="schedule-summary">{t('保留最近 100 条执行记录', 'The latest 100 runs are kept')}</p>
        <div className="segments schedule-filters" role="group" aria-label={t('筛选执行记录', 'Filter history')}>{(['all', 'completed', 'error'] as const).map((value, i) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{[t('全部', 'All'), t('已完成', 'Completed'), t('异常', 'Issues')][i]}</button>)}</div>
        {!visible.length ? <ScheduleEmpty title={t('暂无执行记录', 'No runs yet')}>{t('任务执行后，结果会显示在这里。', 'Run results will appear here.')}</ScheduleEmpty> : visible.map(record => <article key={record.id} className={`schedule-record record-${record.status}`}>
          <div className="schedule-record-icon" aria-hidden="true">{record.status === 'completed' ? <Check/> : record.status === 'error' || record.status === 'aborted' ? <CircleAlert/> : record.status === 'running' ? <LoaderCircle className="spin"/> : <Clock3/>}</div>
          <div className="schedule-record-body"><div className="schedule-record-title"><strong>{record.title}</strong><span>{recordStatus(record.status, t)}</span></div><time dateTime={new Date(record.scheduledAt).toISOString()}>{dateLabel(record.scheduledAt, state.data!.timeZone, t)}</time><p>{recordMessage(record, t)}</p>
            {record.conversationAvailable && record.conversationId ? <button className="quiet-button schedule-open-chat" disabled={action.busy} onClick={() => action.run(async () => { await Chat.selectConversation({conversationId: record.conversationId!}); nav(`/chat/${record.conversationId}`); })}>{t('查看会话', 'Open conversation')}<ChevronRight/></button> : record.conversationId && <small>{t('会话已删除或未创建', 'Conversation deleted or not created')}</small>}
          </div>
        </article>)}
      </>}
    </div>
  </main>;
}
