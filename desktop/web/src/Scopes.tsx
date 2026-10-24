import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopIdentity, DesktopViewApi } from './types';
import type {
  BotLiveState,
  BotRecord,
  MessageCursor,
  MessageMember,
  MessageHistoryPage,
  PendingEnqueueInput,
  PendingRecord,
  ScopeInfo,
  ScopeListCursor,
  StoredMessage,
  WorkActivity,
  WorkHistoryCursor,
  WorkLiveSnapshot,
} from '../../../host-core/index.js';
import { useDrafts } from './drafts';

type AnyRawEntry = { id: unknown; kind: string; model?: unknown; data?: unknown };

function sessionKey(id: DesktopIdentity | null): string {
  return id ? `${id.profileId}|${id.generation}|${id.targetDeviceId}` : '';
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const r = e as Record<string, unknown>;
    const code = typeof r.code === 'string' ? r.code : '';
    const message = typeof r.message === 'string' ? r.message : '';
    if (code) return message ? `${code}: ${message}` : code;
    if (message) return message;
  }
  return String(e);
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 只有 error.outcome 明确 not-sent（未派发）才可判定未入队；其余一律视为结果未知。 */
function isNotSent(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { outcome?: unknown }).outcome === 'not-sent';
}

/** 按 pi-ai Message（pi-durable EntryRecord.model）真实结构提取安全文本行。 */
function entryTextLines(entry: AnyRawEntry): string[] {
  const lines: string[] = [];
  if (!Array.isArray(entry.model)) return lines;
  for (const raw of entry.model) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role : '';
    const content = msg.content;
    if (typeof content === 'string') {
      lines.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const partRaw of content) {
        if (!partRaw || typeof partRaw !== 'object') continue;
        const part = partRaw as Record<string, unknown>;
        if (part.type === 'text' && typeof part.text === 'string') lines.push(part.text);
        else if (part.type === 'thinking' && typeof part.thinking === 'string') lines.push('[思考] ' + part.thinking);
        else if (part.type === 'image') lines.push('[图片内容]');
        else if (part.type === 'toolCall' && typeof part.name === 'string') {
          const args = part.arguments;
          const argsText = args && typeof args === 'object' ? JSON.stringify(args) : '';
          lines.push(`[工具调用] ${part.name}${argsText ? ' ' + argsText : ''}`);
        }
      }
      continue;
    }
    if (role === 'toolResult' && typeof msg.toolName === 'string') {
      lines.push(`[工具结果] ${msg.toolName}${msg.isError === true ? '（错误）' : ''}`);
    }
  }
  return lines.filter(Boolean);
}

function RawEntryRow({ entry }: { entry: AnyRawEntry }) {
  const summary = entryTextLines(entry).join('\n');
  return (
    <div className="raw-entry">
      <div className="raw-entry-head">
        <span className="raw-entry-id">{String(entry.id)}</span>
        <span className="raw-entry-kind">{entry.kind}</span>
      </div>
      {summary ? <p className="raw-entry-text">{summary}</p> : null}
      <details className="raw-entry-json">
        <summary>原始 JSON</summary>
        <pre>{JSON.stringify(entry, null, 2)}</pre>
      </details>
    </div>
  );
}

function authorLabel(m: StoredMessage): string {
  const author = m.message.author;
  // 只描述协议角色，不从 author.kind=user 认证真实人类身份，也不编造身份。
  return author.kind === 'bot' ? `Bot ${author.botId}` : '用户角色';
}

function MessageRow({ msg }: { msg: StoredMessage }) {
  const e = msg.message;
  return (
    <div className="message scope-message">
      <div className="message-head">
        <span className="message-role">{authorLabel(msg)}</span>
        <span className="message-category">{e.category}</span>
        <span className="message-time">{formatTime(e.createdAt)}</span>
      </div>
      {e.replyTo ? <div className="message-replyto">回复 {e.replyTo}</div> : null}
      <div className="message-text">{e.text}</div>
      {msg.missingRefs.length > 0 ? (
        <div className="metadata">
          <span>缺失引用:</span>
          {msg.missingRefs.map((r) => <span key={r} className="missing-ref">{r}</span>)}
        </div>
      ) : null}
      <div className="message-meta">{e.messageId} · localId {msg.localId}</div>
    </div>
  );
}

function MemberWorkPane({ api, scopeId, member, active, pageActive = true }: {
  api: DesktopViewApi;
  scopeId: string;
  member: MessageMember;
  active: boolean;
  pageActive?: boolean;
}) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const isLocalMember = identity ? member.deviceId === identity.targetDeviceId : false;
  const [live, setLive] = useState<BotLiveState | null>(null);
  const [liveLast, setLiveLast] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveEnded, setLiveEnded] = useState(false);
  const [watchTick, setWatchTick] = useState(0);
  const [activity, setActivity] = useState<WorkActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [workBusy, setWorkBusy] = useState(false);
  /** 只读查询序号：旧查询结果不得覆盖新请求。 */
  const querySeqRef = useRef(0);
  /** 显式 stop/resume 序号：显式结果优先于任何在途/后来的只读查询。 */
  const opSeqRef = useRef(0);
  /** 同步在途标记：手动与定时刷新合计最多一个未结束的 activity 查询。 */
  const activityInflightRef = useRef(false);
  /** 同步操作标记：显式 stop/resume 未结束时刷新入口不发新 query（按钮 disabled 仍保留）。 */
  const workBusyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    setLive(null);
    setLiveError(null);
    setLiveEnded(false);
    setLiveLast(null);
  }, [member.botId, scopeId]);

  useEffect(() => {
    // 离线/页面不可见（远端页切回本机）不发 observe：保留最后读取的数据，重连后被动重建。
    if (!identity || !active || !isLocalMember || !api.transportConnected || !pageActive) return;
    const localSess = sess;
    let disposed = false;
    let handle: { close(): Promise<void> } | null = null;
    void (async () => {
      if (disposed) return;
      setLive(null);
      setLiveError(null);
      setLiveEnded(false);
      setLiveLast(null);
      try {
        const h = api.observe(identity, { kind: 'work', botId: member.botId, scopeId }, (ev) => {
          if (disposed) return;
          if (sessionKey(api.identity) !== localSess) return;
          if ('error' in ev) {
            const err = ev as { error: { code?: string; message?: string } };
            setLiveError(`${err.error.code ?? '未知'}${err.error.message ? ': ' + err.error.message : ''}`);
            setLiveEnded(true);
            return;
          }
          const f = ev.frame;
          if (f.type === 'end') {
            setLiveEnded(true);
            setLiveLast(new Date().toISOString());
            return;
          }
          if (!('scopeId' in f)) return;
          const wf = f as WorkLiveSnapshot;
          if (wf.scopeId !== scopeId || wf.botId !== member.botId) return;
          setLive(wf.state);
          setLiveLast(new Date().toISOString());
        });
        h.ready.catch((e) => {
          if (!disposed) {
            setLiveError('观察建立失败：' + errText(e));
            setLiveEnded(true);
          }
        });
        handle = h;
      } catch (e) {
        if (!disposed) {
          setLiveError(errText(e));
          setLiveEnded(true);
        }
      }
    })();
    return () => {
      disposed = true;
      if (handle) void handle.close().catch(() => {});
    };
    // pageActive 必须在依赖里：组件保持挂载，只有依赖变化才会执行上面的 cleanup 关闭观察。
  }, [api, sess, scopeId, member.botId, member.deviceId, active, isLocalMember, watchTick, online, pageActive]);

  /**
   * 只读刷新工作状态（不 sync/不建会话/不唤醒模型）。
   * 同步 in-flight 标记保证手动与定时合计最多一个未结束查询；显式 stop/resume 未结束后不发新 query。
   * 结果按序号 fence：更新的查询或显式 stop/resume 之后返回的旧结果一律丢弃。
   */
  const refreshActivity = useCallback(async (): Promise<void> => {
    if (!identity || !active || !isLocalMember || !api.transportConnected) return;
    if (activityInflightRef.current || workBusyRef.current) return;
    activityInflightRef.current = true;
    const localSess = sess;
    const seq = ++querySeqRef.current;
    const opEpoch = opSeqRef.current;
    setActivityLoading(true);
    try {
      const a = await api.call(identity, 'getWorkActivity', { botId: member.botId, scopeId });
      if (!mountedRef.current || seq !== querySeqRef.current || opEpoch !== opSeqRef.current) return;
      if (sessionKey(api.identity) !== localSess) return;
      setActivity(a);
      setActivityError(null);
    } catch (e) {
      if (!mountedRef.current || seq !== querySeqRef.current || opEpoch !== opSeqRef.current) return;
      if (sessionKey(api.identity) === localSess) {
        setActivityError(errText(e));
        api.reportError(e);
      }
    } finally {
      // 只解除自己持有的 in-flight 标记，不影响其它操作。
      activityInflightRef.current = false;
      if (seq === querySeqRef.current) setActivityLoading(false);
    }
  }, [api, sess, identity, scopeId, member.botId, active, isLocalMember, online, pageActive]);

  // 仅 active && 本机成员 && 在线时存在的 1000ms 被动只读刷新（含初次即时读取）；
  // 清理时停止定时器并作废在途结果；离线/非 active/卸载不发新查询，不重建 observe。
  useEffect(() => {
    if (!identity || !active || !isLocalMember || !api.transportConnected || !pageActive) return;
    void refreshActivity();
    const timer = window.setInterval(() => { void refreshActivity(); }, 1000);
    return () => {
      window.clearInterval(timer);
      querySeqRef.current += 1; // 使旧查询结果失效
      // 旧查询的 finally 因 seq 已变不会再清 loading；这里恢复按钮可用，
      // in-flight 标记仍由旧请求自己释放，保持“最多一个未结束查询”。
      setActivityLoading(false);
    };
  }, [refreshActivity, identity, active, isLocalMember, online, pageActive]);

  async function runWorkOp(op: 'stopWork' | 'resumeWork') {
    if (!identity || workBusyRef.current || !api.transportConnected) return;
    workBusyRef.current = true;
    const localSess = sess;
    const opSeq = ++opSeqRef.current;
    querySeqRef.current += 1; // 在途只读查询全部过期，不得覆盖本次显式结果
    setWorkBusy(true);
    setActivityError(null);
    try {
      const a = await api.call(identity, op, { botId: member.botId, scopeId });
      if (mountedRef.current && opSeq === opSeqRef.current && sessionKey(api.identity) === localSess) {
        setActivity(a);
      }
    } catch (e) {
      if (mountedRef.current && opSeq === opSeqRef.current) {
        setActivityError(errText(e));
        api.reportError(e);
      }
    } finally {
      workBusyRef.current = false;
      if (mountedRef.current && opSeq === opSeqRef.current) {
        setWorkBusy(false);
        setActivityLoading(false); // 显式操作已接管：清掉被作废查询的加载态
      }
    }
  }

  const [rawItems, setRawItems] = useState<AnyRawEntry[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const rawCursorRef = useRef<WorkHistoryCursor | null>(null);
  const rawSessRef = useRef(sess);
  rawSessRef.current = sess;

  const loadRawWork = useCallback(async (reset: boolean) => {
    if (!identity || !active || !isLocalMember || !api.transportConnected) return;
    const localSess = rawSessRef.current;
    setRawLoading(true);
    try {
      const page = await api.call(identity, 'workHistory', {
        botId: member.botId,
        scopeId,
        limit: 30,
        cursor: reset ? null : rawCursorRef.current,
      });
      if (rawSessRef.current !== localSess) return;
      setRawItems((prev) => (reset ? [...page.items] : [...prev, ...page.items]) as AnyRawEntry[]);
      rawCursorRef.current = page.nextCursor;
      setRawError(null);
    } catch (e) {
      if (rawSessRef.current === localSess) {
        setRawError(errText(e));
        api.reportError(e);
      }
    } finally {
      if (rawSessRef.current === localSess) setRawLoading(false);
    }
  }, [api, scopeId, member.botId, member.deviceId, active, isLocalMember, identity]);

  // 只换 scope/成员才清旧显示；断开保留最后读取的数据。
  useEffect(() => {
    rawCursorRef.current = null;
    setRawItems([]);
    setRawError(null);
  }, [scopeId, member.botId, member.deviceId]);

  // 被动读取：离线不自动 call，重连后刷新。
  useEffect(() => {
    if (identity && active && isLocalMember && api.transportConnected) void loadRawWork(true);
  }, [loadRawWork, identity, active, isLocalMember, online]);

  if (!identity) return <div className="empty-state">请先连接。</div>;

  if (!isLocalMember) {
    return (
      <div className="member-work-pane">
        <div className="member-work-head">
          <span className="entity-title">{member.botId}</span>
          <span className="entity-sub">device {member.deviceId}（远端成员，仅显示归属，不对其发起请求）</span>
        </div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="member-work-pane">
        <div className="member-work-head">
          <span className="entity-title">{member.botId}</span>
          <span className="entity-sub">device {member.deviceId}</span>
        </div>
        <div className="empty-state">选择该成员查看 work 观察。</div>
      </div>
    );
  }

  return (
    <div className="member-work-pane">
      <div className="member-work-head">
        <span className="entity-title">{member.botId}</span>
        <span className="entity-sub">device {member.deviceId}</span>
      </div>
      <div className="status" aria-live="polite">
        {!online ? <span>离线：显示最后读取的数据，不自动请求。</span>
          : liveError ? <span className="error-text">{liveError}</span>
          : liveEnded ? (
            <span>观察已结束。<button onClick={() => setWatchTick((t) => t + 1)}>重新观察</button></span>
          ) : live ? (
            <span>
              {live.busy ? '● 工作中' : live.queuedCount > 0 ? `◐ 队列: ${live.queuedCount}` : '○ 空闲'}
              {' '}·{' '}最后观测 {liveLast ? formatTime(liveLast) : '等待初始帧'}
            </span>
          ) : <span>正在建立观察…</span>}
      </div>
      {activity ? (
        <div className="metadata">
          <span>状态: {activity.status}</span>
          {activity.stopped ? <span> · 已停止(需显式恢复)</span> : null}
          {activity.error ? <span> · 错误: {activity.error.code} {activity.error.message}</span> : null}
        </div>
      ) : null}
      {activityError ? <div className="error-banner" role="alert">{activityError}</div> : null}
      <div className="toolbar">
        <button disabled={workBusy || !online} onClick={() => void runWorkOp('stopWork')}>
          {workBusy ? '操作中…' : '停止工作'}
        </button>
        <button disabled={workBusy || !online} onClick={() => void runWorkOp('resumeWork')}>
          {workBusy ? '操作中…' : '恢复工作'}
        </button>
        <button disabled={!online || activityLoading || workBusy} onClick={() => void refreshActivity()}>
          {activityLoading ? '刷新中…' : '刷新工作状态'}
        </button>
      </div>
      <div className="live-pane">
        {live?.generation?.text ? (
          <div className="message assistant"><div className="message-text">{live.generation.text}</div></div>
        ) : null}
        {live?.tools.length ? (
          <div className="toolbar-summary">
            {live.tools.map((t) => (
              <span key={t.callId} className={`tool-chip ${t.status}`}>{t.name} · {t.status}</span>
            ))}
          </div>
        ) : null}
      </div>
      <details className="raw-history">
        <summary><h4>work 原始历史</h4></summary>
        <div className="raw-history-content">
          {!online ? <div className="status">离线：显示最后读取的 work 历史，不自动请求。</div> : null}
          <div className="toolbar">
            <button disabled={!online || rawLoading} onClick={() => void loadRawWork(true)}>
              {rawLoading ? '刷新中…' : '刷新历史'}
            </button>
          </div>
          {rawError ? (
            <div className="error-banner" role="alert">
              {rawError}
              <button onClick={() => void loadRawWork(true)} disabled={!online}>重试</button>
            </div>
          ) : null}
          {rawItems.length === 0 && !rawLoading && !rawError ? <div className="empty-state">暂无 history 条目。</div> : null}
          {rawItems.map((it) => <RawEntryRow key={String(it.id)} entry={it} />)}
          {rawLoading ? <div className="status">加载中…</div> : null}
          {rawCursorRef.current && !rawLoading ? (
            <button onClick={() => void loadRawWork(false)} disabled={!online}>加载更多</button>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function RoomComposer({ api, scopeId, replyTo, onReplyTo, onAccepted }: {
  api: DesktopViewApi;
  scopeId: string;
  replyTo: string | null;
  onReplyTo: (id: string | null) => void;
  /** 仅在“确定受理”后触发只读历史刷新；刷新失败不得改变发送结果。 */
  onAccepted: () => void;
}) {
  const identity = api.identity;
  const draftTarget = useMemo(() => ({ kind: 'room' as const, id: scopeId }), [scopeId]);
  const drafts = useDrafts({ api, identity, target: draftTarget });
  const [sendState, setSendState] = useState<'idle' | 'sending'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [recOutcome, setRecOutcome] = useState<{ action: string; found: boolean; recordId: string | null; recordState: string | null } | null>(null);
  const lockedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function onChangeText(v: string) {
    drafts.editText(v);
    if (sendError) setSendError(null);
  }

  function setReply(id: string | null) {
    onReplyTo(id);
    if (sendError) setSendError(null);
  }

  async function handleSend() {
    if (!identity || sendState !== 'idle' || lockedRef.current) return;
    const msg = drafts.text.trim();
    if (!msg) return;
    const messageId = crypto.randomUUID();
    const input: PendingEnqueueInput = {
      kind: 'room',
      targetDeviceId: identity.targetDeviceId,
      scopeId,
      messageId,
      text: msg,
      replyTo: replyTo,
    };
    const started = drafts.beginSend(input);
    if (!started) return;
    lockedRef.current = true;
    setSendState('sending');
    setSendError(null);
    setRecOutcome(null);
    await drafts.waitQuiet(started.handle);
    // 只发送冻结副本：await 后不重组 replyTo/业务 ID。
    const frozen = started.attempt.input;
    const businessId = frozen.kind === 'primary' ? frozen.requestId : frozen.messageId;
    try {
      let rec: PendingRecord | null = null;
      try {
        rec = await api.pending(identity, 'pending_enqueue', { input: frozen });
      } catch (e) {
        api.reportError(e);
        // 只有本阶段明确 not-sent（无队列记录）才可声称未入队。
        if (isNotSent(e)) {
          const errMsg = `发送未入队（not-sent）：${errText(e)}。原 messageId ${businessId} 已冻结，无队列记录，可恢复编辑后重试。`;
          drafts.markNotSent(started.handle, errMsg);
          setSendError(errMsg);
        } else {
          const errMsg = `入队结果未确认：${errText(e)}（原 messageId ${businessId}）；保持原 ID 锁，请查询原记录，不会自动补发。`;
          drafts.markUnconfirmed(started.handle);
          setSendError(errMsg);
        }
        return;
      }
      if (!rec) return;
      drafts.setPending(started.handle, rec.id);
      const pendingId = rec.id;
      const cleared = await drafts.confirmCleared(started.handle);
      if (cleared !== 'cleared') {
        const errMsg = cleared === 'conflict'
          ? `草稿尚未清空：磁盘草稿已被更新。原队列记录 ${pendingId} 保留，未发送；请查看新版草稿并选择“保留新版草稿，结束旧尝试”，不会自动清空或补发。`
          : `草稿尚未清空：消息已入队（${pendingId}）但未远程发送，请在待发送面板处理。`;
        drafts.markFailed(started.handle, errMsg);
        setSendError(errMsg);
        return;
      }
      onReplyTo(null);
      if (!api.transportConnected) {
        drafts.finishSend(started.handle);
        setSendError(`离线：已入队（${pendingId}），连接后请在待发送面板显式发送。`);
        return;
      }
      try {
        const sent = await api.pending(identity, 'pending_send', { id: pendingId });
        reportSendRecord(started.handle, sent, pendingId);
      } catch (e) {
        // 回执丢失/超时/未知：已入队，保留原 ID 锁，绝不标未入队。
        api.reportError(e);
        drafts.markUnconfirmed(started.handle);
        setSendError(`发送回执未确认：已入队（${pendingId}）· ${errText(e)}；保持原 ID 锁，请查询原记录，不会自动补发。`);
      }
    } finally {
      lockedRef.current = false;
      setSendState('idle');
    }
  }

  function reportSendRecord(handle: { key: string; attemptId: string }, rec: PendingRecord, originalPendingId: string) {
    if (rec.state === 'accepted') {
      drafts.finishSend(handle);
      // 受理只说明已受理；完成与否以 live/原回执为准，界面不断言。
      setSendError('已受理（accepted）。结果以 live 或原回执为准。');
      onAccepted();
    } else if (rec.state === 'rejected') {
      // 确定终态：本地 attempt 结束，原记录保留在待发送面板
      drafts.finishSend(handle);
      setSendError(`发送被拒：${rec.lastError?.code ?? '未知'}。原记录 ${rec.id} 可在待发送面板查看。`);
    } else if (rec.state === 'unconfirmed') {
      const errMsg = `发送结果未确认（unconfirmed），原记录 ${rec.id} 请等待待发送面板对账。`;
      drafts.markUnconfirmed(handle);
      setSendError(errMsg);
    } else {
      drafts.finishSend(handle);
      setSendError(`消息状态：${rec.state}（${originalPendingId}）。`);
    }
  }

  async function queryPending() {
    if (!identity || !drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const outcome = await drafts.reconcile(handle);
    if (!mountedRef.current) return;
    setRecOutcome(outcome);
    if (outcome.note) {
      setSendError(outcome.note);
    } else if (outcome.action === 'finished') {
      setSendError(`对账：原记录已确定（${outcome.recordState}），本地 attempt 已结束。`);
      // 只读对账也确认受理时刷新消息；读失败只进 histError。
      if (outcome.recordState === 'accepted') onAccepted();
    } else if (outcome.action === 'kept') {
      setSendError(`对账：找到原记录 ${outcome.recordId}，状态 ${outcome.recordState}；保持锁，等待终态。`);
    } else if (outcome.action === 'ready-clear-retry') {
      setSendError(`对账：找到原记录 ${outcome.recordId}，状态 ${outcome.recordState}；草稿尚未清空，可显式重试本地清空。`);
    } else {
      setSendError('未找到匹配原记录（按 kind/target/业务ID/文本 分页检索）；保持未确认与锁，绝不自动补发。');
    }
  }

  async function retryClearVerified() {
    if (!identity || !drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const r = await drafts.retryClearAfterVerify(handle);
    if (r === 'cleared') {
      setRecOutcome(null);
      setSendError('本地草稿已清空，原记录保留在待发送面板，由面板显式发送。');
    } else if (r === 'conflict') {
      setSendError('草稿尚未清空：磁盘草稿已被更新；请查看新版草稿并选择“保留新版草稿，结束旧尝试”。');
    } else {
      setSendError('重试本地清空失败，仍保持锁。');
    }
  }

  function adoptNewerDraft() {
    if (!drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const r = drafts.adoptNewerDraftAndFinish(handle);
    if (r.ok) {
      setRecOutcome(null);
      setSendError('已保留新版草稿并结束旧尝试；原队列记录仍在待发送面板，未清磁盘也未发送。');
    } else {
      setSendError(r.error ?? '无法采用新版草稿');
    }
  }

  function releaseNotSent() {
    if (!drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const r = drafts.releaseIfNotSent(handle);
    if (r.ok) {
      setRecOutcome(null);
      setSendError('已恢复编辑（确认未入队）。');
    } else {
      setSendError(r.error ?? '无法释放');
    }
  }

  const disabled = sendState === 'sending' || lockedRef.current || drafts.busy || !!drafts.attempt;

  return (
    <div className="composer">
      {drafts.error ? (
        <div className="error-banner" role="alert">
          {drafts.error}
          <button onClick={drafts.retrySave}>重试保存</button>
        </div>
      ) : null}
      {drafts.conflict ? (
        <div className="status">
          磁盘上的新版草稿：{truncate(drafts.conflict.text, 160) || '（空文本）'}
          {drafts.conflict.files.length > 0 ? `（${drafts.conflict.files.length} 个文件引用）` : ''}
        </div>
      ) : null}
      {drafts.attempt ? (
        <div className="error-banner" role="alert" aria-live="polite">
          {drafts.attempt.phase === 'not-sent' ? (
            <>
              发送未入队（not-sent）：{drafts.attempt.error}
              <button onClick={() => releaseNotSent()}>恢复编辑</button>
            </>
          ) : (
            <>
              发送冻结中 · 业务ID {drafts.attempt.input.kind === 'primary' ? drafts.attempt.input.requestId : drafts.attempt.input.messageId}{drafts.attempt.pendingId ? ` · pending ${drafts.attempt.pendingId}` : ''}（{drafts.attempt.phase}）。
              {drafts.attempt.phase === 'cleared' || drafts.attempt.phase === 'failed' || drafts.attempt.phase === 'unconfirmed' ? (
                <button onClick={() => void queryPending()}>查询原记录</button>
              ) : null}
              {drafts.conflict && recOutcome?.found ? (
                <button onClick={() => adoptNewerDraft()}>保留新版草稿，结束旧尝试</button>
              ) : null}
              {recOutcome?.action === 'ready-clear-retry' ? (
                <button onClick={() => void retryClearVerified()}>重试本地清空</button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {replyTo ? (
        <div className="message-replyto">正在回复 {replyTo} <button onClick={() => setReply(null)} disabled={disabled}>取消回复</button></div>
      ) : null}
      <textarea
        className="composer-input"
        value={drafts.text}
        onChange={(e) => onChangeText(e.target.value)}
        placeholder="输入房间人类消息…"
        rows={3}
        disabled={disabled}
      />
      <div className="composer-bar">
        <button type="button" className="composer-send" onClick={() => void handleSend()} disabled={disabled || !identity || !drafts.key || !drafts.text.trim() || drafts.savePaused}>
          {sendState === 'sending' ? '发送中…' : '发送'}
        </button>
      </div>
      {sendError ? <div className="error-banner" role="alert">{sendError}</div> : null}
    </div>
  );
}

interface MemberEditState {
  deviceId: string;
  botId: string;
}

function MemberEditor({ current, bots, onChange }: {
  current: MessageMember[];
  bots: BotRecord[];
  onChange: (members: MessageMember[]) => void;
}) {
  const [pairs, setPairs] = useState<MemberEditState>({ deviceId: '', botId: '' });
  const [formError, setFormError] = useState<string | null>(null);

  function addPair() {
    const deviceId = pairs.deviceId.trim();
    const botId = pairs.botId.trim();
    if (!deviceId || !botId) {
      setFormError('deviceId 与 botId 均必填');
      return;
    }
    if (current.some((m) => m.deviceId === deviceId && m.botId === botId)) {
      setFormError('该成员已存在');
      return;
    }
    onChange([...current, { deviceId, botId }]);
    setPairs({ deviceId: '', botId: '' });
    setFormError(null);
  }

  function fromLocalBot(b: BotRecord) {
    if (current.some((m) => m.deviceId === b.deviceId && m.botId === b.botId)) return;
    onChange([...current, { deviceId: b.deviceId, botId: b.botId }]);
  }

  return (
    <div className="form-grid">
      <div className="field">
        <label>显式成员（deviceId + botId，支持跨设备）</label>
        <div className="member-pair-row">
          <input
            value={pairs.deviceId}
            onChange={(e) => setPairs({ ...pairs, deviceId: e.target.value })}
            placeholder="deviceId"
          />
          <input
            value={pairs.botId}
            onChange={(e) => setPairs({ ...pairs, botId: e.target.value })}
            placeholder="botId"
          />
          <button type="button" onClick={addPair}>添加</button>
        </div>
      </div>
      {bots.length > 0 ? (
        <div className="field">
          <label>本地 Host 成员便捷选择</label>
          <div className="member-quick-row">
            {bots.map((b) => {
              const present = current.some((m) => m.deviceId === b.deviceId && m.botId === b.botId);
              return (
                <button
                  key={`${b.deviceId}:${b.botId}`}
                  type="button"
                  onClick={() => fromLocalBot(b)}
                  disabled={present}
                >
                  {present ? '✓ ' : ''}{b.role} — {b.botId}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {formError ? <div className="error-banner" role="alert">{formError}</div> : null}
      <ul className="member-list">
        {current.map((m) => (
          <li key={`${m.deviceId}:${m.botId}`} className="member-row">
            <span className="entity-title">{m.botId}</span>
            <span className="entity-sub">device {m.deviceId}</span>
            <button type="button" onClick={() => onChange(current.filter((x) => !(x.deviceId === m.deviceId && x.botId === m.botId)))}>
              移除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScopeDetail({ api, scope, bots, onChanged, pageActive = true }: {
  api: DesktopViewApi;
  scope: ScopeInfo;
  bots: BotRecord[];
  onChanged: (s: ScopeInfo) => void;
  pageActive?: boolean;
}) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const isRoom = scope.scope.kind === 'room';
  const [editMembers, setEditMembers] = useState<MessageMember[]>(scope.scope.members);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 显式进入编辑时冻结的 expectedRevision；被动刷新/重连不改它（当前选择由 editMembers state 保存）。 */
  const editBaselineRef = useRef<{ revision: number } | null>(null);
  const [roomReply, setRoomReply] = useState<string | null>(null);
  const [history, setHistory] = useState<MessageHistoryPage['items']>([]);
  const [histCursor, setHistCursor] = useState<MessageCursor | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);
  const histCursorRef = useRef<MessageCursor | null>(null);
  /** scopeHistory 请求序号：旧 reset/分页结果不得覆盖新请求或新视图。 */
  const histSeqRef = useRef(0);
  const [workSelection, setWorkSelection] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadHistory = useCallback(async (reset: boolean) => {
    // 卸载后（包括迟到的 onAccepted）不再发新读取。
    if (!identity || !api.transportConnected || !mountedRef.current) return;
    const localSess = sess;
    const localScope = scope.scope.scopeId;
    const seq = ++histSeqRef.current;
    const cursorAt = reset ? null : histCursorRef.current;
    setHistLoading(true);
    try {
      const page = await api.call(identity, 'scopeHistory', {
        scopeId: localScope,
        limit: 30,
        cursor: cursorAt,
      });
      // 更新的请求或换视图/卸载后返回：丢弃旧 reset/页。
      if (seq !== histSeqRef.current || !mountedRef.current) return;
      if (sessionKey(api.identity) !== localSess) return;
      setHistory((prev) => (reset ? [...page.items] : [...prev, ...page.items]));
      histCursorRef.current = page.nextCursor;
      setHistCursor(page.nextCursor);
      setHistError(null);
    } catch (e) {
      if (seq !== histSeqRef.current || !mountedRef.current) return;
      if (sessionKey(api.identity) === localSess) {
        setHistError(errText(e));
        api.reportError(e);
      }
    } finally {
      if (seq === histSeqRef.current) setHistLoading(false);
    }
  }, [api, scope.scope.scopeId, identity, sess]);

  // 被动 prop 刷新（同 revision 的 getScopeState/重连）不得覆盖编辑中的成员或基线。
  useEffect(() => {
    if (editMode) return;
    setEditMembers(scope.scope.members.map((m) => ({ ...m })));
  }, [scope.scope.scopeId, scope.scope.revision, scope.scope.members, editMode]);

  useEffect(() => {
    setWorkSelection((prev) => {
      if (prev && scope.scope.members.some((m) => `${m.deviceId}:${m.botId}` === prev)) return prev;
      return null;
    });
  }, [scope.scope.members]);

  // 真正换 scope：退出编辑、丢弃基线并使旧历史请求过期。
  useEffect(() => {
    histSeqRef.current += 1;
    histCursorRef.current = null;
    setHistory([]);
    setHistCursor(null);
    setHistError(null);
    setHistLoading(false);
    setEditMode(false);
    editBaselineRef.current = null;
    setSaveError(null);
  }, [scope.scope.scopeId]);

  // 被动读取：离线不自动 call，重连后刷新。
  useEffect(() => {
    if (identity && api.transportConnected) void loadHistory(true);
  }, [loadHistory, identity, online]);

  function enterEdit() {
    // 显式进入编辑才采集基线：只冻结 expectedRevision（成员选择在 editMembers state）。
    const members = scope.scope.members.map((m) => ({ ...m }));
    editBaselineRef.current = { revision: scope.scope.revision };
    setEditMembers(members);
    setSaveError(null);
    setEditMode(true);
  }

  function cancelEdit() {
    editBaselineRef.current = null;
    setEditMembers(scope.scope.members.map((m) => ({ ...m })));
    setSaveError(null);
    setEditMode(false);
  }

  async function saveMembers() {
    if (!identity || saving || !api.transportConnected) return;
    if (editMembers.length < 2) {
      // 后端已拒绝单成员房间，前端提前按事实纠正。
      setSaveError(isRoom ? '房间至少保留 2 个成员 Bot' : 'DM 固定两个 Bot');
      return;
    }
    const baseline = editBaselineRef.current;
    if (!baseline) {
      setSaveError('请重新进入编辑后再保存');
      return;
    }
    const localSess = sess;
    setSaving(true);
    setSaveError(null);
    const requestId = crypto.randomUUID();
    try {
      const updated = await api.mutateIntent(identity, 'updateScope', {
        scopeId: scope.scope.scopeId,
        input: {
          requestId,
          // 使用显式进入编辑时冻结的 revision，而不是后续 props。
          expectedRevision: baseline.revision,
          members: editMembers,
        },
      });
      if (sessionKey(api.identity) === localSess && mountedRef.current) {
        editBaselineRef.current = null;
        setEditMode(false);
        onChanged(updated);
      }
    } catch (e) {
      if (mountedRef.current) {
        setSaveError(`${errText(e)}（原 requestId: ${requestId}；未确认结果不会自动重发，可在待发送面板对账）`);
        api.reportError(e);
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <div className="scope-detail">
      <div className="scope-detail-scroll">
        <header className="chat-pane-header">
          <div className="chat-title">{isRoom ? '房间' : 'DM'} {scope.scope.scopeId}</div>
          <div className="metadata">
            <span>revision {scope.scope.revision}</span>
            {scope.authorityDeviceId ? <span> · authority {scope.authorityDeviceId}</span> : null}
            {scope.isAuthority ? <span> · 目标 Host 为 authority</span> : null}
            {scope.delivery ? (
              <span> · ack {scope.delivery.fullyAcknowledged ? '全部' : '部分'}</span>
            ) : null}
          </div>
        </header>

        <div className="data-list">
          <div className="data-list-head"><h3>成员（均为 Bot）</h3></div>
          {!editMode ? (
            <>
              <ul className="member-list">
                {scope.scope.members.map((m) => (
                  <li key={`${m.deviceId}:${m.botId}`} className="member-row">
                    <span className="entity-title">{m.botId}</span>
                    <span className="entity-sub">device {m.deviceId}</span>
                  </li>
                ))}
              </ul>
              {isRoom ? (
                <button onClick={() => enterEdit()}>编辑成员</button>
              ) : (
                <p className="hint">DM 固定两个 Bot，不提供成员更换或用户消息发送。</p>
              )}
            </>
          ) : (
            <div className="form-grid">
              <MemberEditor current={editMembers} bots={bots} onChange={setEditMembers} />
              {saveError ? <div className="error-banner" role="alert">{saveError}</div> : null}
              <div className="form-actions">
                <button disabled={saving || !online} onClick={() => void saveMembers()}>
                  {saving ? '保存中…' : '保存成员（expectedRevision CAS）'}
                </button>
                <button onClick={() => cancelEdit()}>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {/* room/DM 均可被动查看 scopeHistory 与分页；仅 room 允许用户消息输入。 */}
        <div className="message-list">
          <div className="message-list-head">
            <h3>{isRoom ? '房间消息' : 'DM 消息（只读）'}</h3>
            <button onClick={() => void loadHistory(true)} disabled={!online || histLoading}>刷新消息</button>
          </div>
          {!online ? <div className="status">离线：显示最后读取的消息，不自动请求。</div> : null}
          {histError ? (
            <div className="error-banner" role="alert">
              {histError}
              <button onClick={() => void loadHistory(true)} disabled={!online}>重试</button>
            </div>
          ) : null}
          {history.length === 0 && !histLoading && !histError ? <div className="empty-state">暂无消息。</div> : null}
          {history.map((msg) => (
            <div key={msg.message.messageId}>
              <MessageRow msg={msg} />
              {isRoom ? (
                <button className="reply-btn" onClick={() => { setRoomReply(msg.message.messageId); cancelEdit(); }}>直接回复</button>
              ) : null}
            </div>
          ))}
          {histLoading ? <div className="status">加载中…</div> : null}
          {histCursor && !histLoading ? (
            <button onClick={() => void loadHistory(false)} disabled={!online}>加载更多</button>
          ) : null}
        </div>

        <div className="data-list">
          <div className="data-list-head"><h3>成员 work 观察（一次一个）</h3></div>
          <div className="member-select-row">
            {scope.scope.members.map((m) => {
              const key = `${m.deviceId}:${m.botId}`;
              const local = identity ? m.deviceId === identity.targetDeviceId : false;
              return (
                <button
                  key={key}
                  className={`entity-row ${workSelection === key ? 'selected' : ''}`}
                  onClick={() => setWorkSelection(workSelection === key ? null : key)}
                >
                  {m.botId} · {m.deviceId}{local ? '（本目标 Host）' : '（远端）'}
                </button>
              );
            })}
          </div>
        </div>

        {scope.scope.members.map((m) => (
          <MemberWorkPane
            key={`${m.deviceId}:${m.botId}`}
            api={api}
            scopeId={scope.scope.scopeId}
            member={m}
            active={workSelection === `${m.deviceId}:${m.botId}`}
            pageActive={pageActive}
          />
        ))}
      </div>

      {isRoom ? (
        <RoomComposer
          api={api}
          scopeId={scope.scope.scopeId}
          replyTo={roomReply}
          onReplyTo={setRoomReply}
          onAccepted={() => void loadHistory(true)}
        />
      ) : null}
    </div>
  );
}

function ScopeCreateForm({ api, bots, onCreated }: {
  api: DesktopViewApi;
  bots: BotRecord[];
  onCreated: (s: ScopeInfo) => void;
}) {
  const identity = api.identity;
  const [kind, setKind] = useState<'room' | 'dm'>('room');
  const [members, setMembers] = useState<MessageMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function submit() {
    if (!identity || busy) return;
    // room 最少 2 个成员（后端已拒绝单成员房间）；DM 固定 2 个。
    if (kind === 'room' && members.length < 2) {
      setError('房间至少需要 2 个成员 Bot');
      return;
    }
    if (kind === 'dm' && members.length !== 2) {
      setError('DM 固定两个 Bot');
      return;
    }
    setBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    try {
      const scope = await api.mutateIntent(identity, 'createScope', {
        input: { requestId, kind, members },
      });
      if (!mountedRef.current) return;
      setKind('room');
      setMembers([]);
      onCreated(scope);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(`${errText(e)}（原 requestId: ${requestId}；未确认结果不会自动重发，可在待发送面板对账）`);
      api.reportError(e);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={(ev) => { ev.preventDefault(); void submit(); }}>
      <div className="field">
        <label>类型</label>
        <div className="kind-row">
          <label><input type="radio" checked={kind === 'room'} onChange={() => setKind('room')} disabled={busy} /> room</label>
          <label><input type="radio" checked={kind === 'dm'} onChange={() => setKind('dm')} disabled={busy} /> dm（固定两个 Bot）</label>
        </div>
      </div>
      <MemberEditor current={members} bots={bots} onChange={setMembers} />
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="form-actions">
        <button type="submit" disabled={busy || !identity || !api.transportConnected}>{busy ? '创建中…' : '创建 scope'}</button>
      </div>
    </form>
  );
}

export function Scopes({ api, pageActive = true }: { api: DesktopViewApi; pageActive?: boolean }) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const [items, setItems] = useState<ScopeInfo[]>([]);
  const [nextCursor, setNextCursor] = useState<ScopeListCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ScopeInfo | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [bots, setBots] = useState<BotRecord[]>([]);
  const cursorRef = useRef<ScopeListCursor | null>(null);
  const botsSessRef = useRef('');
  const targetKeyRef = useRef<string | null>(null);
  const targetKey = identity ? `${identity.profileId}|${identity.targetDeviceId}` : null;

  const loadScopes = useCallback(async (reset: boolean) => {
    if (!identity || !api.transportConnected) return;
    const localSess = sess;
    setLoading(true);
    try {
      const page = await api.call(identity, 'listScopeStates', {
        limit: 20,
        cursor: reset ? null : cursorRef.current,
      });
      if (sessionKey(api.identity) !== localSess) return;
      setItems((prev) => (reset ? [...page.items] : [...prev, ...page.items]));
      cursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (e) {
      if (sessionKey(api.identity) === localSess) {
        setError(errText(e));
        api.reportError(e);
      }
    } finally {
      if (sessionKey(api.identity) === localSess) setLoading(false);
    }
  }, [api, sess, identity]);

  useEffect(() => {
    // 断开（generation 变化）保留同 profile+target 已加载列表/选择，供离线草稿与入队；
    // 真正换 profile/target 才清旧显示。
    if (targetKey === null) {
      targetKeyRef.current = null;
      setItems([]);
      setNextCursor(null);
      setSelectedId(null);
      setSelected(null);
      setLoading(false);
      return;
    }
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      setItems([]);
      setNextCursor(null);
      setSelectedId(null);
      setSelected(null);
    }
    // 离线保留同目标最后读取的列表，不自动 call；重连后被动刷新。
    if (!online) {
      setLoading(false);
      return;
    }
    void loadScopes(true);
  }, [loadScopes, targetKey, online]);

  useEffect(() => {
    if (!identity || !selectedId) {
      setSelected(null);
      setDetailError(null);
      return;
    }
    // 离线不自动 call：保留同目标最后读取的详情。
    if (!api.transportConnected) return;
    const localSess = sess;
    let cancelled = false;
    void api.call(identity, 'getScopeState', { scopeId: selectedId }).then((s) => {
      if (!cancelled && sessionKey(api.identity) === localSess) {
        setSelected(s);
        setDetailError(null);
      }
    }).catch((e) => {
      if (!cancelled && sessionKey(api.identity) === localSess) {
        setDetailError(errText(e));
        api.reportError(e);
      }
    });
    return () => { cancelled = true; };
  }, [api, sess, identity, selectedId, online]);

  useEffect(() => {
    if (!identity || botsSessRef.current === sess || !api.transportConnected) return;
    const localSess = sess;
    let cancelled = false;
    void api.call(identity, 'listBots', {}).then((bs) => {
      if (!cancelled && sessionKey(api.identity) === localSess) {
        setBots(bs);
        botsSessRef.current = localSess;
      }
    }).catch((e) => {
      if (!cancelled && sessionKey(api.identity) === localSess) api.reportError(e);
    });
    return () => { cancelled = true; };
  }, [api, sess, identity, online]);

  function selectScope(id: string) {
    setSelectedId(id);
    const found = items.find((s) => s.scope.scopeId === id);
    if (found) setSelected(found);
  }

  return (
    <div className="conversation-layout">
      <aside className="entity-list">
        <div className="entity-list-head">
          <h2>群聊 / 房间与DM</h2>
          <button className="toolbar-btn" onClick={() => setShowCreate((v) => !v)} disabled={!identity}>
            {showCreate ? '取消' : '新建 scope'}
          </button>
        </div>
        {error ? (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => void loadScopes(true)}>重试</button>
          </div>
        ) : null}
        {!online ? <div className="status">离线：显示最后读取的 scope 列表，不自动请求。</div> : null}
        {showCreate && identity ? (
          <ScopeCreateForm
            api={api}
            bots={bots}
            onCreated={(s) => {
              setItems((prev) => prev.some((x) => x.scope.scopeId === s.scope.scopeId) ? prev : [s, ...prev]);
              setShowCreate(false);
              selectScope(s.scope.scopeId);
            }}
          />
        ) : null}
        {items.length === 0 && !loading && !error ? (
          <div className="empty-state">暂无 scope。{identity ? '点击“新建 scope”创建。' : '请先连接。'}</div>
        ) : (
          <ul className="entity-list-items">
            {items.map((s) => (
              <li key={s.scope.scopeId}>
                <button
                  className={`entity-row ${selectedId === s.scope.scopeId ? 'selected' : ''}`}
                  onClick={() => selectScope(s.scope.scopeId)}
                >
                  <span className="entity-title">{s.scope.kind === 'room' ? '房间' : 'DM'}</span>
                  <span className="entity-sub">{s.scope.scopeId} · rev {s.scope.revision} · {s.scope.members.length} 成员</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {nextCursor && !loading ? (
          <button className="load-more" onClick={() => void loadScopes(false)}>加载更多</button>
        ) : null}
        {loading ? <div className="status">加载中…</div> : null}
      </aside>
      <section className="chat-pane">
        {identity && selected ? (
          <ScopeDetail
            key={`${selected.scope.scopeId}_${targetKey}`}
            api={api}
            scope={selected}
            bots={bots}
            onChanged={(s) => {
              setItems((prev) => prev.map((x) => (x.scope.scopeId === s.scope.scopeId ? s : x)));
              setSelected(s);
            }}
            pageActive={pageActive}
          />
        ) : detailError ? (
          <div className="error-banner" role="alert">{detailError}</div>
        ) : (
          <div className="empty-state">选择左侧 scope 查看详情。</div>
        )}
      </section>
    </div>
  );
}
