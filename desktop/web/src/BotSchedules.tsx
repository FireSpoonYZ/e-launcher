// 桌面端与远程控制端共用的 Bot 定时任务面板。
// 通过远端/本机统一控制协议 `scheduleTask` 读写目标 Bot 的主私聊定时任务（CAS 乐观锁）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { toError } from './api';
import type { DesktopIdentity, DesktopPanelApi } from './types';

type ScheduleRepeat =
  | 'once'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'statutoryWorkday'
  | 'statutoryHoliday';

interface ScheduleTaskItem {
  id: string;
  revision: number;
  enabled: boolean;
  title: string;
  prompt?: string;
  repeat: ScheduleRepeat;
  time: string;
  weekday?: number;
  weekdays?: number[];
  monthDay?: number;
  alarmMode?: 'exact' | 'alarmClock';
  vibrate?: boolean;
  deleteAfterRun?: boolean;
  nextRunAt?: number;
  latestRun?: {
    status: string;
    occurrence: number;
    submissionStatus?: string;
    finishedAt?: number;
  } | null;
}

interface ScheduleDraft {
  id?: string;
  revision?: number;
  title: string;
  prompt: string;
  repeat: ScheduleRepeat;
  time: string;
  weekdays: number[];
  monthDay: number;
  alarmMode: 'exact' | 'alarmClock';
  vibrate: boolean;
  deleteAfterRun: boolean;
}

const WEEKDAY_NAMES: Record<number, string> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
};

function formatRepeatLabel(task: ScheduleTaskItem): string {
  switch (task.repeat) {
    case 'once':
      return task.deleteAfterRun ? '单次执行后删除' : '单次执行';
    case 'daily':
      return '每天';
    case 'statutoryWorkday':
      return '法定工作日';
    case 'statutoryHoliday':
      return '法定节假日';
    case 'monthly':
      return `每月 ${task.monthDay ?? 1} 日`;
    case 'weekly': {
      const days =
        Array.isArray(task.weekdays) && task.weekdays.length > 0
          ? task.weekdays.slice().sort((a, b) => a - b)
          : [task.weekday ?? 1];
      const key = days.join(',');
      if (key === '1,2,3,4,5') return '每周一至周五';
      if (key === '6,7') return '每周末';
      return `每周 ${days.map((d) => WEEKDAY_NAMES[d] ?? d).join('、')}`;
    }
    default:
      return task.repeat;
  }
}

function formatNextRun(nextRunAt?: number, timeZone?: string): string {
  if (!nextRunAt || nextRunAt <= 0) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timeZone || undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(nextRunAt));
  } catch {
    return new Date(nextRunAt).toLocaleString();
  }
}

export function BotSchedules({
  api,
  identity,
  botId,
}: {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  botId: string;
}) {
  const online = api.transportConnected;
  const [tasks, setTasks] = useState<ScheduleTaskItem[]>([]);
  const [timeZone, setTimeZone] = useState<string>('');
  const [schedulingError, setSchedulingError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>({
    title: '',
    prompt: '',
    repeat: 'daily',
    time: '08:00',
    weekdays: [1, 2, 3, 4, 5],
    monthDay: 1,
    alarmMode: 'alarmClock',
    vibrate: true,
    deleteAfterRun: false,
  });

  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSchedules = useCallback(async () => {
    if (!online) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const res = (await api.call(identity, 'scheduleTask', {
        botId,
        input: { action: 'list', limit: 50 },
      })) as Record<string, unknown>;
      if (!mountedRef.current || seq !== seqRef.current) return;
      const list = Array.isArray(res.tasks) ? (res.tasks as ScheduleTaskItem[]) : [];
      setTasks(list);
      setTimeZone(typeof res.timeZone === 'string' ? res.timeZone : '');
      setSchedulingError(typeof res.schedulingError === 'string' ? res.schedulingError : '');
      setError(null);
    } catch (e) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(`读取定时任务失败：${toError(e).message}`);
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false);
    }
  }, [api, identity, botId, online]);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  function openCreate() {
    setDraft({
      title: '',
      prompt: '',
      repeat: 'daily',
      time: '08:00',
      weekdays: [1, 2, 3, 4, 5],
      monthDay: 1,
      alarmMode: 'alarmClock',
      vibrate: true,
      deleteAfterRun: false,
    });
    setEditing('new');
    setError(null);
    setNotice(null);
  }

  function openEdit(task: ScheduleTaskItem) {
    const days =
      Array.isArray(task.weekdays) && task.weekdays.length > 0
        ? task.weekdays.slice().sort((a, b) => a - b)
        : [task.weekday ?? 1];
    setDraft({
      id: task.id,
      revision: task.revision,
      title: task.title,
      prompt: task.prompt ?? '',
      repeat: task.repeat,
      time: task.time || '08:00',
      weekdays: days,
      monthDay: task.monthDay ?? 1,
      alarmMode: task.alarmMode === 'exact' ? 'exact' : 'alarmClock',
      vibrate: Boolean(task.vibrate),
      deleteAfterRun: Boolean(task.deleteAfterRun),
    });
    setEditing('edit');
    setError(null);
    setNotice(null);
  }

  async function toggleEnabled(task: ScheduleTaskItem) {
    if (!online || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.call(identity, 'scheduleTask', {
        botId,
        input: {
          action: 'setEnabled',
          id: task.id,
          revision: task.revision,
          enabled: task.enabled === false,
        },
      });
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) setError(`切换任务状态失败：${toError(e).message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function deleteTask(task: ScheduleTaskItem) {
    if (!online || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.call(identity, 'scheduleTask', {
        botId,
        input: {
          action: 'delete',
          id: task.id,
          revision: task.revision,
        },
      });
      setEditing(null);
      setNotice(`已删除定时任务「${task.title}」。`);
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) setError(`删除定时任务失败：${toError(e).message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function saveDraft() {
    if (!online || busy) return;
    const title = draft.title.trim();
    const prompt = draft.prompt.trim();
    if (!title || !prompt) {
      setError('请填写任务标题与执行指令（Prompt）。');
      return;
    }
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.time)) {
      setError('触发时间格式须为 HH:mm（例如 08:30）。');
      return;
    }
    if (draft.repeat === 'weekly' && draft.weekdays.length === 0) {
      setError('每周重复请至少选择一个星期。');
      return;
    }

    const basePayload: Record<string, unknown> = {
      title,
      prompt,
      repeat: draft.repeat,
      time: draft.time,
      alarmMode: draft.alarmMode,
      vibrate: draft.vibrate,
      deleteAfterRun: draft.deleteAfterRun,
    };
    if (draft.repeat === 'weekly') {
      basePayload.weekdays = draft.weekdays.slice().sort((a, b) => a - b);
    } else if (draft.repeat === 'monthly') {
      basePayload.monthDay = Math.min(31, Math.max(1, Math.round(draft.monthDay)));
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (editing === 'edit' && draft.id && draft.revision) {
        await api.call(identity, 'scheduleTask', {
          botId,
          input: {
            action: 'update',
            id: draft.id,
            revision: draft.revision,
            ...basePayload,
          },
        });
        setNotice(`已更新定时任务「${title}」。`);
      } else {
        await api.call(identity, 'scheduleTask', {
          botId,
          input: {
            action: 'create',
            ...basePayload,
          },
        });
        setNotice(`已创建定时任务「${title}」。`);
      }
      setEditing(null);
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) setError(`保存定时任务失败：${toError(e).message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="bot-schedules-panel">
      <div className="metadata" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span>
          {`共 ${tasks.length} 个定时任务（${tasks.filter((t) => t.enabled !== false).length} 个启用）${timeZone ? ` · 时区 ${timeZone}` : ''}`}
        </span>
        <div className="form-actions" style={{ margin: 0 }}>
          <button type="button" onClick={() => void loadSchedules()} disabled={!online || loading || busy}>
            {loading ? '刷新中…' : '↻ 刷新任务'}
          </button>
          {!editing ? (
            <button type="button" onClick={openCreate} disabled={!online || busy}>
              ＋ 新建定时任务
            </button>
          ) : (
            <button type="button" onClick={() => setEditing(null)} disabled={busy}>
              返回列表
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>关闭</button>
        </div>
      ) : null}
      {schedulingError ? (
        <div className="error-banner" role="alert">
          {`调度提示：${schedulingError}`}
        </div>
      ) : null}
      {notice ? <div className="status online">{notice}</div> : null}

      {editing ? (
        <div className="field" style={{ border: '1px solid rgba(148,163,184,0.25)', borderRadius: 8, padding: 12 }}>
          <h5 style={{ margin: '0 0 8px' }}>
            {editing === 'edit' ? `编辑定时任务（revision ${draft.revision}）` : '新建定时任务'}
          </h5>
          <label>
            任务名称（最多 80 字符）
            <input
              type="text"
              maxLength={80}
              value={draft.title}
              disabled={busy}
              placeholder="例如：每日早报汇总 / 定时代码巡检"
              onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label>
              触发时间 (HH:mm)
              <input
                type="time"
                value={draft.time}
                disabled={busy}
                onChange={(e) => setDraft((prev) => ({ ...prev, time: e.target.value || '08:00' }))}
              />
            </label>
            <label>
              重复规则
              <select
                value={draft.repeat}
                disabled={busy}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    repeat: e.target.value as ScheduleRepeat,
                  }))
                }
              >
                <option value="once">单次执行 (once)</option>
                <option value="daily">每天 (daily)</option>
                <option value="weekly">每周指定星期 (weekly)</option>
                <option value="monthly">每月指定日期 (monthly)</option>
                <option value="statutoryWorkday">法定工作日 (statutoryWorkday)</option>
                <option value="statutoryHoliday">法定节假日 (statutoryHoliday)</option>
              </select>
            </label>
          </div>

          {draft.repeat === 'weekly' ? (
            <div className="field" style={{ marginTop: 6 }}>
              <span>选择执行星期：</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                  const active = draft.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`snippet-chip${active ? ' active' : ''}`}
                      disabled={busy}
                      onClick={() =>
                        setDraft((prev) => {
                          const exists = prev.weekdays.includes(day);
                          const next = exists
                            ? prev.weekdays.filter((d) => d !== day)
                            : [...prev.weekdays, day].sort((a, b) => a - b);
                          return { ...prev, weekdays: next };
                        })
                      }
                    >
                      {WEEKDAY_NAMES[day]}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {draft.repeat === 'monthly' ? (
            <label>
              每月几号 (1–31)
              <input
                type="number"
                min={1}
                max={31}
                value={draft.monthDay}
                disabled={busy}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)),
                  }))
                }
              />
            </label>
          ) : null}

          <label>
            到点发送给该 Bot 的指令 (Prompt)
            <textarea
              rows={4}
              value={draft.prompt}
              disabled={busy}
              placeholder="编写到点时自动发送给该 Bot 主私聊执行的详细指令…"
              onChange={(e) => setDraft((prev) => ({ ...prev, prompt: e.target.value }))}
            />
          </label>

          {draft.repeat === 'once' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={draft.deleteAfterRun}
                disabled={busy}
                onChange={(e) => setDraft((prev) => ({ ...prev, deleteAfterRun: e.target.checked }))}
              />
              单次执行完成后自动删除该任务
            </label>
          ) : null}

          <div className="form-actions">
            <button type="button" onClick={() => void saveDraft()} disabled={busy || !online}>
              {busy ? '保存中…' : '保存定时任务'}
            </button>
            <button type="button" onClick={() => setEditing(null)} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      ) : tasks.length === 0 ? (
        <div className="metadata">
          {loading
            ? '正在读取定时任务…'
            : '当前 Bot 暂无定时任务。可点击上方“＋ 新建定时任务”，或在聊天中直接让 Bot 使用 schedule_task 工具创建。'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tasks.map((task) => {
            const isEnabled = task.enabled !== false;
            return (
              <div
                key={task.id}
                style={{
                  border: '1px solid rgba(148,163,184,0.22)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  opacity: isEnabled ? 1 : 0.65,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div>
                    <strong style={{ fontSize: 15, marginRight: 8 }}>{task.time}</strong>
                    <span>{task.title}</span>
                    <span className="studio-pill purple" style={{ marginLeft: 8 }}>
                      {formatRepeatLabel(task)}
                    </span>
                    <span className={`studio-pill ${isEnabled ? 'emerald' : 'amber'}`} style={{ marginLeft: 6 }}>
                      {isEnabled ? '已启用' : '已暂停'}
                    </span>
                  </div>
                  <div className="form-actions" style={{ margin: 0 }}>
                    <button type="button" disabled={!online || busy} onClick={() => void toggleEnabled(task)}>
                      {isEnabled ? '暂停' : '启用'}
                    </button>
                    <button type="button" disabled={!online || busy} onClick={() => openEdit(task)}>
                      编辑
                    </button>
                    <button type="button" disabled={!online || busy} onClick={() => void deleteTask(task)}>
                      删除
                    </button>
                  </div>
                </div>
                {task.prompt ? (
                  <div className="metadata" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                    {task.prompt}
                  </div>
                ) : null}
                <div className="metadata" style={{ marginTop: 4 }}>
                  {`下次执行: ${isEnabled ? formatNextRun(task.nextRunAt, timeZone) : '已暂停'} · rev ${task.revision}`}
                  {task.latestRun ? ` · 最近执行: ${task.latestRun.status}` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
