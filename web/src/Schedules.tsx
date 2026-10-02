import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, ChevronRight, CircleAlert, Clock3, FileText, LoaderCircle, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Chat, ScheduledTasks, type ScheduleCalendarInfo, type SchedulePreview, type ScheduleRecord, type ScheduleRule, type ScheduleSnapshot, type ScheduleSource, type ScheduledTask, type ScheduledTaskInput } from './native';
import { Dialog } from './components/ui/dialog';
import { Toggle } from './Settings';
import { LatestRequest } from './latestRequest';
import { ErrorNotice, Header, Loading, errorText, useAction, useText } from './ui';
import './schedules.css';

type Text = ReturnType<typeof useText>;
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const englishDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ruleOf = (value: ScheduleRule): ScheduleRule => ({repeat: value.repeat, time: value.time, weekday: value.weekday, weekdays: value.weekdays, monthDay: value.monthDay, date: value.date, delayMinutes: value.delayMinutes, runAt: value.runAt});
const daysOf = (rule: ScheduleRule) => rule.weekdays ?? [rule.weekday];
function repeatLabel(rule: ScheduleRule, t: Text) {
  if (rule.repeat === 'once') return t('只执行一次', 'Once');
  if (rule.repeat === 'statutoryWorkday') return t('法定工作日', 'Statutory workdays');
  if (rule.repeat === 'statutoryHoliday') return t('法定节假日', 'Statutory days off');
  if (rule.repeat === 'weekly') {
    const days = daysOf(rule).slice().sort((a, b) => a - b);
    if (days.join() === '1,2,3,4,5') return t('周一至周五', 'Monday–Friday');
    if (days.join() === '6,7') return t('周六日', 'Saturday–Sunday');
    if (days.length === 7) return t('每天', 'Every day');
    return t(`每周 ${days.map(day => weekdays[day - 1]).join('、')}`, days.map(day => englishDays[day - 1].slice(0, 3)).join(', '));
  }
  if (rule.repeat === 'monthly') return t(`每月 ${rule.monthDay} 日`, `Monthly on day ${rule.monthDay}`);
  return t('每天', 'Every day');
}
function CalendarStatus({value}: {value?: ScheduleCalendarInfo}) {
  return <>{value?.calendarCoverage && <p className="secondary">{value.calendarCoverage}</p>}
    {value?.calendarNotice && <p className="secondary" role="status">{value.calendarNotice}；{value.calendarFallback}</p>}</>;
}
function ruleLabel(rule: ScheduleRule, t: Text) { return `${repeatLabel(rule, t)} ${rule.time}`; }
function countdown(nextRunAt: number, now: number, t: Text) {
  const minutes = Math.max(1, Math.ceil((nextRunAt - now) / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return t(`距执行还有 ${days ? `${days} 天 ` : ''}${hours ? `${hours} 小时 ` : ''}${rest || (!days && !hours) ? `${rest} 分钟` : ''}`,
    `Runs in ${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${rest || (!days && !hours) ? `${rest}m` : ''}`);
}
function wallTime(timestamp: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(timestamp);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return {date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}`};
}
function dateLabel(timestamp: number, zone: string, t: Text) {
  return new Intl.DateTimeFormat(t('zh-CN', 'en-GB'), {
    timeZone: zone, month: t('long', 'short') as 'long'|'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    year: 'numeric',
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

function SourceConversation({value, busy, onOpen}: {value: ScheduleSource; busy: boolean; onOpen(id: string): void}) {
  const t = useText();
  return value.sourceConversationId ? value.sourceConversationAvailable
    ? <button type="button" className="quiet-button" disabled={busy} onClick={() => onOpen(value.sourceConversationId!)}>{t('来源会话', 'Source conversation')}<ChevronRight/></button>
    : <small className="secondary">{t('来源会话不可用', 'Source conversation unavailable')}</small>
    : <small className="secondary">{t('无来源会话', 'No source conversation')}</small>;
}

export function SchedulesPage() {
  const t = useText(); const nav = useNavigate(); const state = useSchedules(); const action = useAction();
  const [filter, setFilter] = useState<'all'|'enabled'|'paused'>('all');
  const [editing, setEditing] = useState<ScheduledTask|'new'|null>(null);
  const [menu, setMenu] = useState<ScheduledTask>();
  const [removing, setRemoving] = useState<ScheduledTask>();
  const [notice, setNotice] = useState('');
  const [params, setParams] = useSearchParams();
  const taskId = params.get('taskId');
  useEffect(() => {
    if (taskId === null || !state.data) return;
    const task = state.data.tasks.find(item => item.id === taskId);
    if (task) setEditing(task);
    else setNotice(t('任务已删除或不存在', 'This task was deleted or no longer exists'));
    const next = new URLSearchParams(params); next.delete('taskId');
    setParams(next, {replace: true});
  }, [taskId, state.data, params, setParams, t]);
  const openConversation = (conversationId: string) => void action.run(async () => { await Chat.selectConversation({conversationId}); nav(`/chat/${conversationId}`); });
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
        <p className="secondary">{t('设备时区：', 'Device time zone: ')}{state.data.timeZone}</p>
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
          : <div className="schedule-list">{visible.map(task => <div key={task.id}><article className={`schedule-row${task.enabled ? '' : ' is-paused'}`} key={task.id}>
            <button className="schedule-row-main" onClick={() => { action.setError(''); setEditing(task); }} aria-label={t(`编辑 ${task.title}`, `Edit ${task.title}`)}>
              <span><time className="schedule-clock">{task.repeat === 'once' && task.runAt ? wallTime(task.runAt, state.data!.timeZone).time : task.time}</time><span>{repeatLabel(task, t)}</span>{task.repeat === 'once' && task.runAt && <small>{t('执行日期：', 'Execution date: ')}{wallTime(task.runAt, state.data!.timeZone).date}</small>}<strong>{task.title}</strong>{task.calendarNotice && <small>{task.calendarNotice}；{task.calendarFallback}</small>}<small>{!task.enabled ? t('已暂停', 'Paused') : !state.data!.exactAlarmGranted ? t('等待闹钟与提醒权限', 'Waiting for alarm permission') : t('下次：', 'Next: ') + dateLabel(task.nextRunAt, state.data!.timeZone, t)}</small></span>
            </button>
            <div className="schedule-toggle-target"><Toggle label={t(`启用 ${task.title}`, `Enable ${task.title}`)} checked={task.enabled} disabled={action.busy} onChange={checked => void mutateEnabled(task, checked)}/></div>
            <button className="icon-button" aria-label={t(`${task.title} 的更多操作`, `More actions for ${task.title}`)} disabled={action.busy} onClick={() => { action.setError(''); setMenu(task); }}><MoreHorizontal/></button>
          </article><SourceConversation value={task} busy={action.busy} onOpen={openConversation}/></div>)}</div>}
        {(tasks.length > 0 || state.data.records.length > 0) && <button className="schedule-history-link" onClick={() => nav('/schedules/history')}><FileText/><span>{t('执行记录', 'Execution history')}</span><ChevronRight/></button>}
      </>}
    </div>
    <footer className="schedule-page-footer"><button className="button full" disabled={!state.data} onClick={() => setEditing('new')}><Plus/>{t('新建任务', 'New task')}</button></footer>
    {editing && <TaskEditor task={editing === 'new' ? undefined : editing} timeZone={state.data!.timeZone} hostNow={state.data!.now} localNow={state.data!.localNow} calendarVersion={state.data?.calendarVersion} onClose={() => setEditing(null)} onSaved={next => {
      state.accept(next); setEditing(null); setFilter('all');
      setNotice(editing === 'new' ? t('定时任务已创建', 'Scheduled task created') : t('修改已保存', 'Changes saved'));
    }}/>}
    {menu && <Dialog open sheet title={menu.title} onOpenChange={open => !open && setMenu(undefined)}>
      <p className="secondary">{menu.repeat === 'once' && menu.runAt ? dateLabel(menu.runAt, state.data!.timeZone, t) : ruleLabel(menu, t)}</p>
      <SourceConversation value={menu} busy={action.busy} onOpen={id => { setMenu(undefined); openConversation(id); }}/>
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

function useNextRun(rule: ScheduleRule, timeZone?: string, calendarVersion?: string) {
  const [value, setValue] = useState<SchedulePreview>(); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const days = JSON.stringify(rule.weekdays);
  useEffect(() => {
    let live = true; setValue(undefined); setError('');
    if (!rule.time || (rule.repeat === 'weekly' && daysOf(rule).length === 0)) return () => { live = false; };
    void ScheduledTasks.preview(rule).then(next => { if (live) setValue(next); }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [rule.repeat, rule.time, rule.weekday, rule.monthDay, rule.date, rule.delayMinutes, rule.runAt, days, retry, timeZone, calendarVersion]);
  useEffect(() => {
    if (!value || value.nextRunAt <= Date.now()) return;
    const timer = window.setTimeout(() => setRetry(count => count + 1), Math.min(2147483647, Math.max(1, value.nextRunAt - Date.now() + 100)));
    return () => window.clearTimeout(timer);
  }, [value]);
  return {value, error, retry: () => setRetry(value => value + 1)};
}

function TimeWheel({label, count, value, disabled, onChange, onMoving}: {
  label: string; count: number; value: number; disabled: boolean; onChange(value: number): void; onMoving(value: boolean): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const callbacks = useRef({onChange, onMoving}); callbacks.current = {onChange, onMoving};
  const select = (next: number) => {
    ref.current?.scrollTo({top: next * 48, behavior: 'instant'});
    callbacks.current.onChange(next);
    callbacks.current.onMoving(false);
  };
  useEffect(() => { if (ref.current) ref.current.scrollTop = value * 48; }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <div className="schedule-wheel" ref={ref} role="spinbutton" tabIndex={disabled ? -1 : 0}
    aria-label={label} aria-valuemin={0} aria-valuemax={count - 1} aria-valuenow={value}
    aria-valuetext={String(value).padStart(2, '0')} aria-disabled={disabled}
    onKeyDown={event => {
      if (disabled) return;
      const next = event.key === 'ArrowUp' ? (value + count - 1) % count : event.key === 'ArrowDown' ? (value + 1) % count
        : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : event.key === 'PageUp' ? Math.max(0, value - 5)
        : event.key === 'PageDown' ? Math.min(count - 1, value + 5) : undefined;
      if (next !== undefined) { event.preventDefault(); window.clearTimeout(timer.current); select(next); }
    }}
    onScroll={() => {
      if (disabled || !ref.current) return;
      window.clearTimeout(timer.current);
      // Initial/controlled positioning is already settled; only user movement blocks saving.
      if (Math.abs(ref.current.scrollTop - value * 48) < 1) { callbacks.current.onMoving(false); return; }
      callbacks.current.onMoving(true);
      timer.current = window.setTimeout(() => {
        if (ref.current) select(Math.max(0, Math.min(count - 1, Math.round(ref.current.scrollTop / 48))));
      }, 140);
    }}>
    {Array.from({length: count}, (_, i) => <div aria-hidden="true" className={i === value ? 'is-selected' : ''} key={i}
      onClick={() => { if (!disabled) { window.clearTimeout(timer.current); select(i); } }}>{String(i).padStart(2, '0')}</div>)}
  </div>;
}
function TaskEditor({task, timeZone, hostNow, localNow, calendarVersion, onClose, onSaved}: {task?: ScheduledTask; timeZone: string; hostNow: number; localNow: string; calendarVersion?: string; onClose(): void; onSaved(value: ScheduleSnapshot): void}) {
  const t = useText(); const action = useAction();
  const defaultDay = new Date(`${localNow.slice(0, 10)}T00:00:00Z`);
  if (localNow.slice(11, 16) >= '08:00') defaultDay.setUTCDate(defaultDay.getUTCDate() + 1);
  const defaultDate = defaultDay.toISOString().slice(0, 10);
  const initial = useRef<ScheduledTaskInput>(task
    ? {id: task.id, revision: task.revision, title: task.title, prompt: task.prompt, ...ruleOf(task), ...(task.repeat === 'once' && task.runAt ? {time: wallTime(task.runAt, timeZone).time, date: undefined, delayMinutes: undefined} : {}), vibrate: task.vibrate ?? false, deleteAfterRun: task.deleteAfterRun ?? false}
    : {title: '', prompt: '', repeat: 'once', date: defaultDate, time: '08:00', weekday: 1, monthDay: 1, vibrate: true, deleteAfterRun: false}).current;
  const [draft, setDraft] = useState(initial);
  const [cycle, setCycle] = useState<ScheduleRule>();
  const [custom, setCustom] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [moving, setMoving] = useState({hour: false, minute: false});
  const [now, setNow] = useState(hostNow);
  useEffect(() => {
    const receivedAt = Date.now(); setNow(hostNow);
    const timer = window.setInterval(() => setNow(hostNow + Date.now() - receivedAt), 1000);
    return () => window.clearInterval(timer);
  }, [hostNow]);
  const executionDate = draft.date ?? (draft.runAt ? wallTime(draft.runAt, timeZone).date : '');
  const changeTime = (time: string) => setDraft(value => time === value.time ? value : {...value, time, date: value.date ?? (value.runAt ? wallTime(value.runAt, timeZone).date : undefined), runAt: undefined, delayMinutes: undefined});
  const selectRepeat = (repeat: ScheduleRule['repeat'], days?: number[]) => {
    if (!cycle) return;
    setCycle({...cycle, repeat, weekdays: days,
      runAt: repeat === 'once' ? cycle.runAt : undefined,
      date: repeat === 'once' ? cycle.date ?? (cycle.repeat !== 'once' ? defaultDate : undefined) : undefined,
      delayMinutes: undefined});
  };
  const activeRule = cycle ?? draft;
  const preview = useNextRun(activeRule.runAt && task ? {...activeRule, time: task.time} : activeRule, timeZone, calendarVersion);
  const invalidDays = activeRule.repeat === 'weekly' && daysOf(activeRule).length === 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || (!!cycle && JSON.stringify(cycle) !== JSON.stringify(ruleOf(draft)));
  const requestClose = () => {
    if (action.busy) return;
    if (discard) setDiscard(false); else if (cycle) setCycle(undefined); else if (dirty) setDiscard(true); else onClose();
  };
  const back = discard ? () => setDiscard(false) : cycle ? () => setCycle(undefined) : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (action.busy || moving.hour || moving.minute || !preview.value || invalidDays) return;
    if (cycle) {
      const rule = cycle.repeat === 'weekly' && daysOf(cycle).length === 7 ? {...cycle, repeat: 'daily' as const, weekdays: undefined} : cycle;
      setDraft({...draft, ...rule}); setCycle(undefined); return;
    }
    if (!draft.title.trim() || !draft.prompt.trim()) { action.setError(t('请填写备注和任务内容。', 'Enter a note and task instructions.')); return; }
    void action.run(async () => onSaved(await ScheduledTasks.save({...draft, time: draft.runAt && task ? task.time : draft.time})));
  };
  const canSave = !action.busy && !moving.hour && !moving.minute && !!preview.value && !invalidDays;
  return <Dialog open sheet className="schedule-sheet" title={discard ? t('放弃修改？', 'Discard changes?') : cycle ? t('重复', 'Repeat') : task ? t('编辑定时任务', 'Edit scheduled task') : t('新建定时任务', 'New scheduled task')}
    actions={!discard && <><button type="button" className="quiet-button schedule-cancel" disabled={action.busy} onClick={requestClose}>{t('取消', 'Cancel')}</button><button className="quiet-button schedule-save" type="submit" form="schedule-editor-form" disabled={!canSave}>{action.busy ? <LoaderCircle className="spin"/> : cycle ? t('确定', 'Done') : t('保存', 'Save')}</button></>}
    onOpenChange={open => !open && requestClose()} onBack={back}>
    {discard ? <div className="schedule-discard"><p className="secondary">{t('未保存的内容将丢失。', 'Unsaved changes will be lost.')}</p><div className="dialog-actions"><button className="button secondary-button" onClick={() => setDiscard(false)}>{t('继续编辑', 'Keep editing')}</button><button className="button danger-button" onClick={onClose}>{t('放弃修改', 'Discard')}</button></div></div>
      : <form id="schedule-editor-form" className="schedule-editor" onSubmit={submit}>
        <div className="schedule-editor-scroll">
          {cycle ? <>
            <div className="schedule-repeat-options" role="group" aria-label={t('重复周期', 'Repeat interval')}>
              {([
                ['once', t('只执行一次', 'Once'), []], ['daily', t('每天', 'Every day'), []],
                ['weekly', t('周一至周五', 'Monday–Friday'), [1, 2, 3, 4, 5]], ['weekly', t('周六日', 'Saturday–Sunday'), [6, 7]],
                ['statutoryWorkday', t('法定工作日', 'Statutory workdays'), []], ['statutoryHoliday', t('法定节假日', 'Statutory days off'), []],
              ] as const).map(([repeat, label, days], i) => <button type="button" key={i}
                aria-pressed={!custom && cycle.repeat === repeat && (repeat !== 'weekly' || daysOf(cycle).join() === days.join())}
                onClick={() => { setCustom(false); selectRepeat(repeat, repeat === 'weekly' ? [...days] : undefined); }}>{label}<Check aria-hidden="true"/></button>)}
              <button type="button" aria-pressed={custom} onClick={() => { setCustom(true); selectRepeat('weekly', cycle.repeat === 'weekly' ? daysOf(cycle) : []); }}>{t('自定义星期', 'Custom days')}<Check aria-hidden="true"/></button>
              <button type="button" aria-pressed={cycle.repeat === 'monthly'} onClick={() => { setCustom(false); selectRepeat('monthly'); }}>{t('每月（高级）', 'Monthly (advanced)')}<Check aria-hidden="true"/></button>
            </div>
            {custom && cycle.repeat === 'weekly' && <fieldset className="schedule-field"><legend>{t('选择执行日，可多选', 'Select repeat days')}</legend>
              <div className="schedule-repeat-days">{weekdays.map((label, i) => {
                const checked = daysOf(cycle).includes(i + 1);
                return <button type="button" key={i} aria-label={t(`周${label}`, englishDays[i])} aria-pressed={checked}
                  onClick={() => setCycle({...cycle, weekdays: (checked ? daysOf(cycle).filter(day => day !== i + 1) : [...daysOf(cycle), i + 1]).sort((a, b) => a - b)})}>
                  {t(`星期${label}`, englishDays[i])}<Check aria-hidden="true"/></button>;
              })}</div>
            </fieldset>}
            {cycle.repeat === 'monthly' && <fieldset className="schedule-field"><legend>{t('每月几日', 'Day of month')}</legend><div className="schedule-day-grid">{Array.from({length: 31}, (_, i) => <button type="button" key={i} aria-label={t(`${i + 1} 日`, `Day ${i + 1}`)} aria-pressed={cycle.monthDay === i + 1} onClick={() => setCycle({...cycle, monthDay: i + 1})}>{i + 1}</button>)}</div><p className="secondary">{t('当月没有这一天时，跳过当月。', 'Months without this date are skipped.')}</p></fieldset>}
          </> : <>
            <div className="schedule-preview" aria-live="polite">{preview.value ? <>
              <strong>{preview.value.nextRunAt > now ? countdown(preview.value.nextRunAt, now, t) : t('执行时间已过，请重设未来日期后启用。', 'The execution time has passed. Choose a future date before enabling.')}</strong>
              {preview.value.nextRunAt > 0 && <span>{task && !task.enabled ? t('启用后执行：', 'When enabled: ') : t('下次执行：', 'Next run: ')}{dateLabel(preview.value.nextRunAt, preview.value.timeZone, t)}</span>}
            </> : <span className="secondary">{preview.error ? t('无法计算执行时间', 'Unable to calculate execution time') : t('正在计算下次执行时间…', 'Calculating next run…')}</span>}<small>{t('按设备时区', 'Device time zone')} · {timeZone}</small></div>
            {draft.repeat === 'once' && <label className="schedule-field"><span>{t('执行日期', 'Execution date')}</span><input type="date" required={!task || !!task.runAt} min={draft.runAt ? undefined : wallTime(now, timeZone).date} value={executionDate} disabled={action.busy}
              onChange={e => setDraft({...draft, date: e.target.value || undefined, runAt: undefined, delayMinutes: undefined})}/><small>{t('日期和时间按设备时区解释；旧任务未指定日期时，保留下一次此时刻行为。', 'Date and time use the device time zone. Legacy tasks without a date keep the next occurrence of this time.')}</small></label>}
            <div className="schedule-wheels" role="group" aria-label={t('执行时间', 'Time')}>
              <TimeWheel label={t('小时', 'Hours')} count={24} value={Number(draft.time.slice(0, 2))} disabled={action.busy}
                onMoving={hour => setMoving(value => value.hour === hour ? value : {...value, hour})}
                onChange={hour => changeTime(String(hour).padStart(2, '0') + draft.time.slice(2))}/>
              <span aria-hidden="true">:</span>
              <TimeWheel label={t('分钟', 'Minutes')} count={60} value={Number(draft.time.slice(3))} disabled={action.busy}
                onMoving={minute => setMoving(value => value.minute === minute ? value : {...value, minute})}
                onChange={minute => changeTime(draft.time.slice(0, 3) + String(minute).padStart(2, '0'))}/>
            </div>
            <p className="schedule-wheel-hint secondary">{t('上下滑动选择时间，键盘可用方向键。', 'Scroll to choose; arrow keys also work.')}</p>
            <div className="schedule-alarm-options">
              <button type="button" className="schedule-cycle-link" disabled={action.busy} onClick={() => {
                setCycle(ruleOf(draft)); setCustom(draft.repeat === 'weekly' && !['1,2,3,4,5', '6,7'].includes(daysOf(draft).join()));
              }}><span>{t('重复', 'Repeat')}</span><small>{repeatLabel(draft, t)}</small><ChevronRight/></button>
              <div className="schedule-option"><span>{t('执行时振动', 'Vibrate on start')}</span><Toggle label={t('执行时振动', 'Vibrate on start')} checked={draft.vibrate ?? false} disabled={action.busy} onChange={vibrate => setDraft({...draft, vibrate})}/></div>
              <div className="schedule-option"><span>{t('执行后删除', 'Delete after start')}</span><Toggle label={t('执行后删除', 'Delete after start')} checked={draft.deleteAfterRun ?? false} disabled={action.busy} onChange={deleteAfterRun => setDraft({...draft, deleteAfterRun})}/></div>
            </div>
            <p className="secondary schedule-option-hint">{t('成功发起后删除定时任务，执行会话和记录保留；发起失败不会删除。', 'Deletes the schedule only after a successful start. Conversations and history remain; failed starts are not deleted.')}</p>
            <label className="schedule-field"><span>{t('备注', 'Note')}</span><input required maxLength={80} placeholder={t('例如：早间简报', 'e.g. Morning briefing')} value={draft.title} disabled={action.busy} onChange={e => setDraft({...draft, title: e.target.value})}/></label>
            <label className="schedule-field"><span>{t('任务内容', 'Task instructions')}</span><textarea required maxLength={8000} rows={3} placeholder={t('告诉 Pi，这个时间要做什么…', 'Tell Pi what to do at this time…')} value={draft.prompt} disabled={action.busy} onChange={e => setDraft({...draft, prompt: e.target.value})}/><small>{t('备注用于识别任务；这里的内容会原样交给 AI 执行。', 'The note identifies the task; these instructions are sent to AI.')}</small></label>
            <div className="schedule-destination"><div><span>{t('结果发送到', 'Results')}</span><span className="secondary">{t('新会话', 'New conversation')}</span></div><p className="secondary">{t('每次执行会新建独立会话，使用全局默认模型，不复制来源聊天。一次性任务发起后会停用，过期任务需重设未来日期后启用。', 'Each run creates an independent conversation using the global default model, without copying the source chat. One-time tasks pause on start; expired tasks need a future date before enabling.')}</p></div>
          </>}
          {(cycle || activeRule.repeat === 'statutoryWorkday' || activeRule.repeat === 'statutoryHoliday') && <p className="secondary">{t('法定工作日包含调休补班；法定节假日包含普通周末和公告放假，不含补班。', 'Statutory workdays include makeup shifts; statutory days off include ordinary weekends and official holidays, excluding makeup shifts.')}</p>}
          <CalendarStatus value={preview.value}/>
          <ErrorNotice error={invalidDays ? t('请至少选择一个执行日。', 'Select at least one repeat day.') : action.error}/><FetchError error={preview.error} retry={preview.retry}/>
        </div>
      </form>}
  </Dialog>;
}
function recordStatus(status: ScheduleRecord['status'], t: Text) {
  return {running: t('执行中', 'Running'), completed: t('已完成', 'Completed'), error: t('失败', 'Failed'), aborted: t('已中断', 'Interrupted'), skipped: t('已跳过', 'Skipped')}[status];
}
function recordMessage(record: ScheduleRecord, t: Text) {
  if (record.message) return record.message;
  if (record.reason === 'missed') return t('错过计划时间，本次未执行。可返回任务列表查看后续安排。', 'This run missed its scheduled time. Check the task list for future plans.');
  if (record.reason === 'overlap') return t('上一次任务仍在执行，已跳过本次。', 'The previous run is still active; this occurrence was skipped.');
  if (record.reason === 'interrupted') return t('应用进程已结束，本次执行已中断。', 'The app process ended before this run completed.');
  return {running: t('Pi 正在执行，可打开会话查看进度。', 'Pi is working. Open the conversation to follow progress.'), completed: t('任务已完成', 'Task completed'), error: t('执行失败，请查看会话。', 'Run failed. See the conversation for details.'), aborted: t('本次执行已停止', 'This run was stopped'), skipped: t('本次执行已跳过', 'This occurrence was skipped')}[record.status];
}
export function ScheduleHistoryPage() {
  const t = useText(); const nav = useNavigate(); const [params] = useSearchParams();
  const state = useSchedules(); const action = useAction(); const [filter, setFilter] = useState<'all'|'completed'|'error'>('all');
  const taskId = params.get('taskId');
  const openConversation = (conversationId: string) => void action.run(async () => { await Chat.selectConversation({conversationId}); nav(`/chat/${conversationId}`); });
  const records = (state.data?.records ?? []).filter(record => !taskId || record.taskId === taskId);
  const visible = records.filter(record => filter === 'all' || (filter === 'completed' ? record.status === 'completed' : ['error', 'aborted', 'skipped'].includes(record.status)));
  const title = state.data?.tasks.find(task => task.id === taskId)?.title ?? records[0]?.title;
  return <main className="page schedules-page">
    <Header title={t('执行记录', 'Execution history')}/>
    <div className="schedule-scroll">
      <FetchError error={state.error} retry={state.refresh}/><ErrorNotice error={action.error}/>
      {!state.data && !state.error && <Loading/>}
      {state.data && <>
        {taskId && <div className="schedule-history-scope"><strong>{title ?? t('已删除的任务', 'Deleted task')}</strong><button className="quiet-button" onClick={() => nav('/schedules/history', {replace: true})}>{t('查看全部', 'View all')}</button></div>}
        <p className="secondary">{t('设备时区：', 'Device time zone: ')}{state.data.timeZone}</p>
        <p className="schedule-summary">{t('保留最近 100 条执行记录', 'The latest 100 runs are kept')}</p>
        <div className="segments schedule-filters" role="group" aria-label={t('筛选执行记录', 'Filter history')}>{(['all', 'completed', 'error'] as const).map((value, i) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{[t('全部', 'All'), t('已完成', 'Completed'), t('异常', 'Issues')][i]}</button>)}</div>
        {!visible.length ? <ScheduleEmpty title={t('暂无执行记录', 'No runs yet')}>{t('任务执行后，结果会显示在这里。', 'Run results will appear here.')}</ScheduleEmpty> : visible.map(record => <article key={record.id} className={`schedule-record record-${record.status}`}>
          <div className="schedule-record-icon" aria-hidden="true">{record.status === 'completed' ? <Check/> : record.status === 'error' || record.status === 'aborted' ? <CircleAlert/> : record.status === 'running' ? <LoaderCircle className="spin"/> : <Clock3/>}</div>
          <div className="schedule-record-body"><div className="schedule-record-title"><strong>{record.title}</strong><span>{recordStatus(record.status, t)}</span></div><time dateTime={new Date(record.scheduledAt).toISOString()}>{dateLabel(record.scheduledAt, state.data!.timeZone, t)}</time><p>{recordMessage(record, t)}</p>
            {record.conversationAvailable && record.conversationId ? <button className="quiet-button schedule-open-chat" disabled={action.busy} onClick={() => action.run(async () => { await Chat.selectConversation({conversationId: record.conversationId!}); nav(`/chat/${record.conversationId}`); })}>{t('查看执行会话', 'Open execution conversation')}<ChevronRight/></button> : record.conversationId && <small>{t('执行会话已删除或未创建', 'Execution conversation deleted or not created')}</small>}
            <SourceConversation value={record} busy={action.busy} onOpen={openConversation}/>
          </div>
        </article>)}
      </>}
    </div>
  </main>;
}
