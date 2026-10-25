import { useCallback, useEffect, useRef, useState } from 'react';
import { BotHost, type HostBot, type HostCallResult, type HostFrameEvent, type HostHistoryPage, type HostLiveFrame, type HostPhase, type HostSettings, type HostSettingsPayload, type HostSnapshot, type HostSubmission, type HostVoiceEvent, type HostVoiceRemote, type HostVoiceSaveInput, type HostVoiceSettings } from './native';
import { Dialog } from './components/ui/dialog';
import { ErrorNotice, Header, Row, Section, useAction, useText, array, errorText, record } from './ui';
import { HostLegacyImport } from './HostLegacyImport';
import { HostBotSettings, HostExtensionCatalog } from './HostBotSettings';
// 窄接口：只用于知道“事件传输已失败”，以便暂停只读轮询；不存在其它注入。
import { onMobileStreamFailure } from './native/tauri-host';

type Home = (zh: string, en: string) => string;

type PendingText = { kind: 'text'; botId: string; requestId: string; text: string };
type PendingCreate = { kind: 'create'; requestId: string; role: string; cwd: string; modelRef: string | null };
// 语音只冻结业务 ID，不带转写文本：未知语音不得被当成空文本重发。
type PendingVoice = { kind: 'voice'; botId: string; requestId: string };
// 存储里存在但无法识别的记录：保留原文，挡住新的发送，只能显式本地清除。
type PendingUnknown = { kind: 'unknown'; raw: string };
type Pending = PendingText | PendingCreate | PendingVoice | PendingUnknown;
type LifecycleShape = {target:'running'|'stopped'; since:number; deadline:number};

const uuid = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const phaseLabel = (phase: HostPhase, t: Home) => ({
  stopped: t('已停止','Stopped'),
  starting: t('启动中','Starting'),
  running: t('运行中','Running'),
  stopping: t('停止中','Stopping'),
  failed: t('失败','Failed'),
}[phase]);
// Restore only validated pending records; drop anything malformed.
const parsePending = (value: unknown): Pending | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = record(value);
  if (raw.kind === 'text' && typeof raw.botId === 'string' && typeof raw.requestId === 'string' && typeof raw.text === 'string') {
    return {kind:'text', botId: raw.botId, requestId: raw.requestId, text: raw.text};
  }
  if (raw.kind === 'create' && typeof raw.requestId === 'string' && typeof raw.role === 'string' && typeof raw.cwd === 'string') {
    // modelRef 只接受缺失（旧 sessionStorage）、null 或字符串；其它类型保留为 unknown，重发时不改载荷。
    const modelRef = raw.modelRef;
    if (modelRef !== undefined && modelRef !== null && typeof modelRef !== 'string') return undefined;
    return {kind:'create', requestId: raw.requestId, role: raw.role, cwd: raw.cwd, modelRef: typeof modelRef === 'string' ? modelRef : null};
  }
  if (raw.kind === 'voice' && typeof raw.botId === 'string' && typeof raw.requestId === 'string') {
    return {kind:'voice', botId: raw.botId, requestId: raw.requestId};
  }
  return undefined;
};
// 冻结的待确认记录只含业务 ID/正文，不含凭据、设置或 CA。
// Tauri 独立 UI 进程退出后仍需保留原 ID，所以由调用方选 localStorage；旧 Capacitor 入口保持 sessionStorage。
const PENDING_KEY = 'bot-host-pending';
const pendingStore = (persistent: boolean): Storage => persistent ? window.localStorage : window.sessionStorage;
// 只读：raw 存在但无法解析时保留原文，boot 绝不删除或覆盖未知记录。
type StoredPending = { record?: Pending; raw?: string; error?: boolean };
const readPending = (persistent: boolean): StoredPending => {
  let raw: string | null;
  try { raw = pendingStore(persistent).getItem(PENDING_KEY); } catch { return { error: true }; }
  // 只有 getItem 返回 null 才算不存在；空字符串也是已有记录，必须保留。
  if (raw === null) return {};
  try { return { record: parsePending(JSON.parse(raw)), raw }; } catch { return { raw }; }
};
// 存储里的原记录必须 kind、业务 ID 与不可变内容全部一致，才允许删除或替换。
const samePending = (current: Pending, original: Pending): boolean => {
  if (current.kind !== original.kind) return false;
  if (current.kind === 'unknown' && original.kind === 'unknown') return current.raw === original.raw;
  if (current.kind === 'create' && original.kind === 'create') {
    return current.requestId === original.requestId && current.role === original.role
      && current.cwd === original.cwd && current.modelRef === original.modelRef;
  }
  if (current.kind === 'create' || original.kind === 'create' || current.kind === 'unknown' || original.kind === 'unknown') return false;
  if (current.requestId !== original.requestId || current.botId !== original.botId) return false;
  if (current.kind === 'voice' || original.kind === 'voice') return true;
  return current.text === original.text;
};
// Host 对不存在的提交返回 404 SUBMISSION_NOT_FOUND（responded）；其它错误不证明缺失。
const MISSING_SUBMISSION = 'SUBMISSION_NOT_FOUND';
const RECEIPT_STATUSES = ['queued', 'placed', 'done', 'unanswered'];
// reject 的 outcome 可能在顶层（Tauri 适配器）或 data.outcome（Capacitor reject）。
const errorOutcome = (error: unknown): string => {
  const shape = record(error);
  if (typeof shape.outcome === 'string') return shape.outcome;
  const data = record(shape.data);
  return typeof data.outcome === 'string' ? data.outcome : '';
};
// 语音一次性提交的回执必须完整、同 bot/request、状态受支持；缺失或畸形不猜造字段。
const completeVoiceReceipt = (value: Record<string, unknown> | undefined, botId: string, requestId: string): boolean => {
  if (!value) return false;
  if (typeof value.botId !== 'string' || value.botId !== botId) return false;
  if (typeof value.requestId !== 'string' || value.requestId !== requestId) return false;
  if (typeof value.conversationId !== 'string' || value.conversationId.length === 0) return false;
  if (typeof value.submissionId !== 'number' || !Number.isInteger(value.submissionId) || value.submissionId <= 0) return false;
  if (typeof value.status !== 'string' || RECEIPT_STATUSES.indexOf(value.status) < 0) return false;
  const safeAnswer = typeof value.answerText === 'string' || value.answerText === null || value.answerText === undefined;
  const safeReason = typeof value.reason === 'string' || value.reason === null || value.reason === undefined;
  return safeAnswer && safeReason;
};
const liveSummary = (frame: HostLiveFrame): string => {
  if (frame.type === 'end') return `end · ${frame.reason ?? ''}`;
  const state = frame.type === 'snapshot' ? frame.state : frame.changes;
  const parts: string[] = [];
  if (state?.busy === true) parts.push('busy');
  if (typeof state?.queuedCount === 'number' && state.queuedCount > 0) parts.push(`queued ${state.queuedCount}`);
  const generation = state?.generation as {text?: string; truncated?: boolean} | null | undefined;
  if (generation?.text) parts.push(generation.truncated ? `${generation.text}…` : generation.text);
  return parts.join(' · ') || '—';
};
// History items are EntryRecords; render only user/assistant text, never raw tool/thinking payload.
const historyEntry = (item: Record<string, unknown>): string => {
  const model = array<unknown>(item.model);
  return model.map(message => {
    if (typeof message === 'string') return message;
    const entry = record(message);
    const role = entry.role;
    if (role !== 'user' && role !== 'assistant') return '';
    const content = entry.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(block => {
        if (typeof block === 'string') return block;
        const part = record(block);
        return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
      }).filter(Boolean).join(' ');
    }
    return '';
  }).filter(Boolean).join(' ');
};
const receiptDetail = (receipt: HostSubmission): string =>
  [receipt.status, receipt.answerText ?? '', receipt.reason ?? '', receipt.requestId].filter(Boolean).join(' · ');
const voiceEventText = (event: HostVoiceEvent, t: Home): string => {
  if (event.type === 'partial') return `${t('转录中','Partial')}: ${event.text ?? ''}`;
  if (event.type === 'submitted') {
    const status = typeof event.receipt?.status === 'string' ? event.receipt.status : '';
    return `${t('已提交','Submitted')}: ${[status, event.receipt?.requestId ?? event.requestId].filter(Boolean).join(' · ')}`;
  }
  return `${t('错误','Error')}: ${[event.code ?? '', event.outcome ?? '', event.message ?? ''].filter(Boolean).join(' · ')}`;
};
const remoteDetail = (remote: HostVoiceRemote, t: Home): string =>
  remote.baseUrl ? `${remote.model} · ${remote.baseUrl}${remote.hasApiKey ? ` · ${t('已保存 API Key','API key saved')}` : ''}` : t('未配置','Not configured');
const rates = [0.75, 1, 1.25, 1.5, 2];

// active=false（本机页因远端页而保持挂载但不可见）：停止观察与只读轮询，但不停止 Host。
export function HostPage({onBack, persistentPending = false, connectionEpoch = 0, active = true}: {onBack?(): void; persistentPending?: boolean; connectionEpoch?: number; active?: boolean} = {}) {
  const t = useText(); const action = useAction();
  const [host, setHost] = useState<HostSnapshot>();
  const [snapshotError, setSnapshotError] = useState('');
  const [bots, setBots] = useState<HostBot[]>();
  const [selected, setSelected] = useState<HostBot>();
  const [draft, setDraft] = useState('');
  // boot 只读一次：合法记录直接显示（不写不删）；存在但无法识别的原文保留为“未知”记录。
  const [boot] = useState(() => readPending(persistentPending));
  const [pending, setPending] = useState<Pending | undefined>((): Pending | undefined => {
    if (boot.record) return boot.record;
    // 空字符串也是“存储里已有记录”，按原文保留为 unknown 并阻止派发。
    if (boot.raw !== undefined) return {kind:'unknown', raw: boot.raw};
    return undefined;
  });
  const [storageNotice, setStorageNotice] = useState(() => boot.error
    ? t('无法读取本地待确认记录（存储不可用）；清理前不会发送新请求。','Unable to read the local pending record (storage unavailable); sends stay blocked until cleared.')
    : boot.raw !== undefined && !boot.record
      ? t('检测到无法识别的本地待确认记录，未自动清除；清理前不会发送新请求。','An unrecognized local pending record was found; nothing was cleared and sends stay blocked.')
      : '');
  // 渲染用状态 + 同步持有者：事件回调与转换不依赖 setState 时序。
  const pendingRef = useRef<Pending | undefined>(pending);
  // 发送尝试代际：旧的缺失确认/旧的对账结果一律失效。
  const attemptRef = useRef(0);
  // 缺失确认只属某一条冻结记录与某一次尝试；跨 attempt 一律失效。
  const [missing, setMissing] = useState<{requestId: string; botId: string; attempt: number}>();
  const [reconcileNotice, setReconcileNotice] = useState('');
  const [receipt, setReceipt] = useState<HostSubmission>();
  // 事件传输失败后暂停只读轮询；只有显式重连（connectionEpoch 变化）才恢复。
  const [transportFailed, setTransportFailed] = useState(false);
  const connectionRef = useRef(connectionEpoch);
  const [observeId, setObserveId] = useState<string>();
  const [live, setLive] = useState<HostLiveFrame>();
  const [frames, setFrames] = useState<HostFrameEvent[]>([]);
  const [history, setHistory] = useState<HostHistoryPage>();
  const [settings, setSettings] = useState<HostSettingsPayload>();
  const [settingsDraft, setSettingsDraft] = useState('');
  const [credDraft, setCredDraft] = useState('');
  const [voice, setVoice] = useState<HostVoiceSettings>();
  const [capture, setCapture] = useState<{botId:string; requestId:string}>();
  const [voiceEvents, setVoiceEvents] = useState<HostVoiceEvent[]>([]);
  const [remoteKind, setRemoteKind] = useState<'stt'|'tts'>();
  const [createReqId, setCreateReqId] = useState(() => uuid());
  const [role, setRole] = useState('');
  const [cwd, setCwd] = useState('');
  const [modelRef, setModelRef] = useState('');
  const [focusTab, setFocusTab] = useState<'all' | 'chat' | 'soul' | 'config' | 'voice'>('all');
  const observeIdRef = useRef<string | undefined>(undefined);
  const captureRef = useRef<{botId:string; requestId:string} | undefined>(undefined);
  // 正在等原生 startVoice（Tauri 授权弹窗会暂停 Activity 并触发 hidden）的那一次 capture。
  const startingRef = useRef<{botId:string; requestId:string} | undefined>(undefined);
  const selectedRef = useRef<HostBot | undefined>(undefined);
  const listenersReady = useRef<Promise<void>>(Promise.resolve());
  captureRef.current = capture;
  selectedRef.current = selected;
  // Single pending lifecycle request; one effect-owned observer polls snapshots
  // until it is replaced (opposite direction) or removed (done/timeout).
  const [lifecycle, setLifecycle] = useState<LifecycleShape>();
  const [lifecycleNotice, setLifecycleNotice] = useState('');
  const lifecycleRef = useRef<LifecycleShape | undefined>(undefined);

  const refreshSnapshot = async () => {
    try {
      const snap = await BotHost.snapshot();
      setHost(snap); setSnapshotError('');
      // Page opened/mid-transit with no pending request: re-attach the same
      // observer read-only (never sends start/stop).
      if ((snap.phase === 'starting' || snap.phase === 'stopping') && !lifecycleRef.current) {
        const req = {target: snap.phase === 'starting' ? 'running' as const : 'stopped' as const, since: snap.lastUpdated, deadline: Date.now() + 60000};
        lifecycleRef.current = req;
        setLifecycle(req);
      }
    } catch (error) { setSnapshotError(errorText(error)); }
  };
  useEffect(() => {
    if (!lifecycle || !active) return;
    let alive = true;
    let attempts = 0;
    let timer = 0;
    let inFlight = false;
    const wait = t('等待状态确认…','Waiting for status…');
    const timeoutMsg = t('等待超时，已显示最后快照；可点“刷新”对账。','Timed out waiting; showing the last snapshot. Use Refresh to reconcile.');
    setLifecycleNotice(wait);
    const settle = (timedOut?: boolean) => {
      // Only the observer owning the current request may complete it; a newer
      // opposite request (or unmount) must never be cleared by a stale one.
      if (!alive || lifecycleRef.current !== lifecycle) return;
      lifecycleRef.current = undefined;
      setLifecycle(undefined);
      setLifecycleNotice(timedOut ? timeoutMsg : '');
    };
    const expired = () => Date.now() >= lifecycle.deadline || attempts >= 60;
    const schedule = () => {
      if (!alive || lifecycleRef.current !== lifecycle || inFlight) return;
      window.clearTimeout(timer); timer = 0;
      if (expired()) {
        // Hidden expiry: stop the timer quietly; the visibility event reconciles.
        if (!document.hidden) settle(true);
        return;
      }
      timer = window.setTimeout(tick, 1000);
    };
    const tick = async () => {
      if (!alive || lifecycleRef.current !== lifecycle || inFlight) return;
      // One chain only: drop any leftover timer before starting a new cycle.
      window.clearTimeout(timer); timer = 0;
      // Bounds first at every tick/schedule; failed attempts count too.
      if (expired()) { if (!document.hidden) settle(true); return; }
      if (document.hidden) { schedule(); return; }
      inFlight = true;
      let snap: HostSnapshot;
      try { snap = await BotHost.snapshot(); } catch { inFlight = false; attempts++; schedule(); return; }
      inFlight = false;
      // Re-check after the await: unmounted, stale observer, or hidden mid-read
      // must not update.
      if (!alive || lifecycleRef.current !== lifecycle) return;
      if (document.hidden) { schedule(); return; }
      attempts++;
      setHost(snap); setSnapshotError('');
      // Target phase completes regardless of timestamp; FAILED counts only when
      // lastUpdated changed since the request (not a previous failure).
      const done = (lifecycle.target === 'running' && snap.phase === 'running') ||
        (lifecycle.target === 'stopped' && snap.phase === 'stopped') ||
        (snap.phase === 'failed' && snap.lastUpdated !== lifecycle.since);
      if (done) { settle(); return; }
      schedule();
    };
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [lifecycle, active]);
  // On mount only read the cold snapshot; never start/read settings/model.
  useEffect(() => { void refreshSnapshot(); }, []);
  useEffect(() => { if (host?.workspace && !cwd) setCwd(host.workspace); }, [host?.workspace]);

  // 传输层报告事件流失败：只暂停轮询/只读读取；显式重连成功后恢复。
  useEffect(() => onMobileStreamFailure(() => setTransportFailed(true)), []);
  useEffect(() => {
    if (connectionRef.current === connectionEpoch) return;
    connectionRef.current = connectionEpoch;
    // 显式重连成功：只恢复只读能力。旧代的观察/实时画面/录音 UI 身份作废
    //（旧事件流已不可用），但不自动 cancel/observe、不删冻结 pending 也不删草稿；
    // 冻结的语音 ID 保留供后续只读对账。
    setTransportFailed(false);
    observeIdRef.current = undefined;
    setObserveId(undefined);
    setLive(undefined);
    captureRef.current = undefined;
    startingRef.current = undefined;
    setCapture(undefined);
  }, [connectionEpoch]);

  // 回执被动刷新：已受理（queued/placed）的回执用只读 getSubmission 跟进到终态；
  // 不新增 submit、不 resume、不并入 history。隐藏/传输故障/Host 未运行/卸载即停。
  useEffect(() => {
    if (!receipt || (receipt.status !== 'queued' && receipt.status !== 'placed')) return;
    if (!active || transportFailed || host?.phase !== 'running') return;
    const owner = {botId: receipt.botId, requestId: receipt.requestId};
    let alive = true;
    let timer = 0;
    let inFlight = false;
    const schedule = () => {
      if (!alive || timer) return;
      timer = window.setTimeout(() => { timer = 0; void tick(); }, 1000);
    };
    const tick = async () => {
      if (!alive || inFlight) return;
      if (document.hidden) return; // 隐藏时不读；可见事件再重新安排
      inFlight = true;
      let next: HostSubmission | undefined;
      try {
        const envelope = await BotHost.call({method:'getSubmission', params:{botId: owner.botId, requestId: owner.requestId}});
        next = envelope.result as HostSubmission;
      } catch { next = undefined; } // 只读失败不改写现有回执，下一轮再读
      inFlight = false;
      if (!alive) return;
      // await 之后重新检查可见性：隐藏后不写回也不排程（可见事件再重新安排）。
      if (document.hidden) return;
      // 迟到的旧读不得覆盖新的回执或已切换的目标；只接受受支持的状态。
      const nextStatus = next && typeof next.status === 'string' ? next.status : '';
      if (next && next.botId === owner.botId && next.requestId === owner.requestId && RECEIPT_STATUSES.indexOf(nextStatus) >= 0) {
        setReceipt(prev => prev && prev.botId === owner.botId && prev.requestId === owner.requestId ? next : prev);
      }
      schedule();
    };
    schedule();
    const onVisible = () => {
      if (document.hidden) { window.clearTimeout(timer); timer = 0; return; }
      schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [receipt?.botId, receipt?.requestId, receipt?.status, transportFailed, host?.phase, active]);

  const clearObserveId = useCallback(() => { observeIdRef.current = undefined; setObserveId(undefined); }, []);
  const cancelObserve = useCallback(() => {
    const id = observeIdRef.current;
    if (!id) return;
    clearObserveId();
    void BotHost.cancelObservation({observationId: id}).catch(() => {});
  }, [clearObserveId]);
  const clearCapture = useCallback((cap: {botId:string; requestId:string}) => {
    if (captureRef.current !== cap) return; // identity-guarded: only this capture
    captureRef.current = undefined;
    setCapture(undefined);
  }, []);
  const cancelCaptureVoice = useCallback((cap: {botId:string; requestId:string}) => {
    if (captureRef.current !== cap) return;
    void BotHost.cancelVoice().catch(() => {});
    clearCapture(cap);
  }, [clearCapture]);
  // 状态与 ref 同步更新：存储副作用绝不放进 setState updater。
  const setFrozen = (next: Pending | undefined) => {
    pendingRef.current = next;
    setPending(next);
  };
  const storageFailure = () => setStorageNotice(t('无法保存本地待确认记录（存储不可用）','Unable to save pending record locally (storage unavailable)'));
  // 读失败单独提示：读不到不等于写不了，也不能据此去写/删。
  const verifyFailure = () => setStorageNotice(t('无法读取本地待确认记录，未发送。','Unable to read the local pending record; nothing was sent.'));
  // 同步写入冻结记录：写前先核对存储现状，读不到/未知/不同/已被移除都禁止分派并保留输入。
  // expected 为 undefined 表示新尝试（存储必须为空）；提供时表示重发/替换（存储必须仍是那条原记录）。
  const freeze = (record: Pending, expected?: Pending): boolean => {
    const stored = readPending(persistentPending);
    if (stored.error) { verifyFailure(); return false; }
    if (expected) {
      if (stored.raw === undefined || !stored.record || !samePending(stored.record, expected)) {
        setStorageNotice(t('本地待确认记录已变化或缺失，未发送。','The local pending record changed or is missing; nothing was sent.'));
        return false;
      }
    } else if (stored.raw !== undefined) {
      setStorageNotice(t('已有本地待确认记录，未发送。','A local pending record already exists; nothing was sent.'));
      return false;
    }
    try { pendingStore(persistentPending).setItem(PENDING_KEY, JSON.stringify(record)); }
    catch { storageFailure(); return false; }
    attemptRef.current += 1; // 新一次尝试：旧缺失确认与旧读结果全部失效
    setStorageNotice('');
    setFrozen(record);
    return true;
  };
  // 条件删除：存储里必须仍是这条原记录（kind/ID/不可变内容）才删除。
  const clearFrozen = (original: Pending): boolean => {
    const stored = readPending(persistentPending);
    if (stored.error) { verifyFailure(); return false; }
    if (stored.raw !== undefined) {
      const matches = original.kind === 'unknown'
        ? stored.raw === original.raw
        : !!stored.record && samePending(stored.record, original);
      if (!matches) {
        setStorageNotice(t('本地待确认记录已变化，未自动删除。','The local pending record changed; nothing was deleted.'));
        return false;
      }
    }
    try { pendingStore(persistentPending).removeItem(PENDING_KEY); }
    catch { storageFailure(); return false; }
    setStorageNotice('');
    setFrozen(undefined);
    return true;
  };
  // 语音终态回调：只删除存储中确属本次 capture 的记录（voice 或同 ID 的 text）。
  const clearFrozenCapture = (botId: string, requestId: string): boolean => {
    const stored = readPending(persistentPending);
    if (stored.error) { verifyFailure(); return false; }
    const current = stored.record;
    if (stored.raw !== undefined && (!current || current.kind === 'create' || current.kind === 'unknown'
      || current.botId !== botId || current.requestId !== requestId)) return false;
    try { pendingStore(persistentPending).removeItem(PENDING_KEY); }
    catch { storageFailure(); return false; }
    setStorageNotice('');
    setFrozen(undefined);
    return true;
  };
  // 语音 error 带最终文本时替换本次 capture 自己的记录；其它记录（含 create）一律保留。
  const replaceFrozenCapture = (botId: string, requestId: string, expected: Pending | undefined, text: string): boolean => {
    const stored = readPending(persistentPending);
    if (stored.error) { verifyFailure(); return false; }
    const current = stored.record;
    // 必须仍是同一 capture 的记录（voice 或同 ID 的 text），且与本地已知记录一致。
    const belongs = !!current && current.kind !== 'create' && current.kind !== 'unknown'
      && current.botId === botId && current.requestId === requestId
      && (!expected || samePending(current, expected));
    if (stored.raw !== undefined && !belongs) return false;
    const record: PendingText = {kind:'text', botId, requestId, text};
    try { pendingStore(persistentPending).setItem(PENDING_KEY, JSON.stringify(record)); }
    catch { storageFailure(); return false; }
    setStorageNotice('');
    setFrozen(record);
    return true;
  };
  // 记录换代就丢弃上一条的缺失确认与对账提示（只动状态，不碰存储）。
  useEffect(() => {
    setMissing(undefined);
    setReconcileNotice('');
  }, [pending]);

  // Listeners register (and are awaited before observe) so no event is missed.
  // Registration rejection is surfaced through listenersReady (action.run shows
  // it); a successful registration still retains/cleans its handle because
  // Promise.all rejection does not cancel sibling promises. Exactly this page's
  // handles are removed on cleanup/late success.
  useEffect(() => {
    let alive = true;
    const handles: Array<{remove(): void}> = [];
    const retainHandle = (handle: {remove(): void}) => {
      if (!alive) { handle.remove(); return; }
      handles.push(handle);
    };
    const hostListener = (event: HostFrameEvent) => {
      if (!alive || event.observationId !== observeIdRef.current) return;
      setFrames(f => [...f.slice(-9), event]);
      if (event.error) { clearObserveId(); setLive(undefined); return; }
      const frame = event.frame;
      if (!frame) return;
      if (frame.type === 'snapshot') setLive(frame);
      else if (frame.type === 'update') {
        setLive(prev => prev && prev.type !== 'end'
          ? {...prev, state: {...(prev.state ?? {}), ...(frame.changes ?? {})} as HostLiveFrame['state']}
          : prev);
      } else if (frame.type === 'end') { setLive(frame); clearObserveId(); }
    };
    const voiceListener = (event: HostVoiceEvent) => {
      if (!alive) return;
      setVoiceEvents(v => [...v.slice(-9), event]);
      const cap = captureRef.current;
      // Only the terminal event for the current capture may clear it. Never
      // clear the independent text draft or an unmatched pending.
      const matches = !!cap && event.botId === cap.botId && event.requestId === cap.requestId;
      if (event.type === 'submitted') {
        if (matches) {
          clearCapture(cap);
          // 完整且同 bot/request 的回执：直接保留真实字段作为当前 Bot 的主回执，
          // 后续由既有只读采样器跟进到 done/unanswered；不触发 submit/resume/history。
          const receipt = event.receipt;
          if (receipt && completeVoiceReceipt(receipt, cap.botId, cap.requestId) && selectedRef.current?.botId === cap.botId) {
            setReceipt(receipt as unknown as HostSubmission);
            // 只有真实回执才条件清除冻结记录。
            clearFrozenCapture(cap.botId, cap.requestId);
          }
          // 无效/缺失回执：已清录音 UI，但保留冻结记录供只读核对（不猜造字段）。
        }
      } else if (event.type === 'error') {
        if (!matches) return;
        clearCapture(cap);
        // 只在原生给出最终文本时替换本次 capture 自己的记录；不编造文本、不覆盖别的记录。
        const finalText = event.text;
        if (finalText && finalText.length > 0) replaceFrozenCapture(event.botId, event.requestId, pendingRef.current, finalText);
      }
    };
    listenersReady.current = Promise.all([
      BotHost.addListener('hostFrame', hostListener).then(retainHandle),
      BotHost.addListener('voiceEvent', voiceListener).then(retainHandle),
    ]).then(() => undefined);
    // Keep the rejection for readiness consumers; suppress only the unhandled
    // rejection warning at mount without replacing the resolved value.
    void listenersReady.current.catch(() => {});
    return () => {
      alive = false;
      handles.forEach(handle => handle.remove());
    };
  }, [clearObserveId, connectionEpoch]);

  // Cancel owned observer and voice capture on page leave/hidden; never Agent abort.
  // Cleanup immediately clears the UI capture state too, so no lingering
  // “recording” label survives navigation/hide.
  useEffect(() => () => { cancelObserve(); if (captureRef.current) cancelCaptureVoice(captureRef.current); }, [cancelObserve, cancelCaptureVoice]);
  // 被远端页替换后（active=false）立刻取消本页观察与录音 UI；不停止 Host/Agent、不重发。
  useEffect(() => {
    if (active) return;
    cancelObserve();
    if (captureRef.current) cancelCaptureVoice(captureRef.current);
  }, [active, cancelObserve, cancelCaptureVoice]);
  useEffect(() => {
    const onHidden = () => {
      if (!document.hidden) return;
      const cap = captureRef.current;
      // Tauri：授权弹窗会暂停 Activity 并触发隐藏，此时 startVoice 仍在途，不得取消；
      // 真进入后台由原生 ON_STOP / 作用域 voiceEvent.error 处理，旧入口行为不变。
      if (cap && !(persistentPending && startingRef.current === cap)) cancelCaptureVoice(cap);
      cancelObserve(); // Native onPause already closes observations; clear client id too
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [cancelObserve, cancelCaptureVoice, persistentPending]);


  const startHost = () => {
    if (lifecycle?.target === 'running') return; // one same-direction request at a time
    const since = host?.lastUpdated ?? -1;
    const req = {target:'running' as const, since, deadline: Date.now() + 60000};
    lifecycleRef.current = req;
    setLifecycle(req);
    void action.run(async () => {
      try { await BotHost.start(); }
      catch (error) {
        // ACK rejected: clear only this request, never a later opposite one.
        if (lifecycleRef.current === req) {
          lifecycleRef.current = undefined;
          setLifecycle(undefined);
          setLifecycleNotice('');
        }
        throw error; // action.run displays it
      }
    });
  };
  const stopHost = () => {
    if (lifecycle?.target === 'stopped') return; // one same-direction request at a time
    const since = host?.lastUpdated ?? -1;
    const req = {target:'stopped' as const, since, deadline: Date.now() + 60000};
    lifecycleRef.current = req;
    setLifecycle(req);
    void action.run(async () => {
      try { await BotHost.stop(); }
      catch (error) {
        // ACK rejected: clear only this request, never a later opposite one.
        if (lifecycleRef.current === req) {
          lifecycleRef.current = undefined;
          setLifecycle(undefined);
          setLifecycleNotice('');
        }
        throw error; // action.run displays it
      }
    });
  };
  const listBots = () => action.run(async () => {
    const envelope = await BotHost.call({method:'listBots', params:{}});
    setBots(array<HostBot>(envelope.result));
  });
  const createBot = () => action.run(async () => {
    if (captureRef.current || pending) return; // single pending design: no parallel input
    if (!role.trim() || !cwd.trim()) return;
    const payload: PendingCreate = {kind:'create', requestId: createReqId, role, cwd, modelRef: modelRef.trim() || null};
    // 先同步落盘再分派；写失败则不发送，输入保留。
    if (!freeze(payload)) return;
    const envelope = await BotHost.call({method:'createBot', params:{requestId: payload.requestId, role: payload.role, cwd: payload.cwd, modelRef: payload.modelRef}});
    setSelected(envelope.result as HostBot);
    clearFrozen(payload);
    setCreateReqId(uuid());
    const list = await BotHost.call({method:'listBots', params:{}});
    setBots(array<HostBot>(list.result));
  });
  const chooseBot = (bot: HostBot) => action.run(async () => {
    if (captureRef.current) return;
    cancelObserve();
    setSelected(bot);
    setReceipt(undefined);
    setLive(undefined);
    setHistory(undefined);
  });
  const submit = () => action.run(async () => {
    if (captureRef.current) return; // single pending design: no parallel input
    if (!selected || !draft.trim() || pending) return;
    const payload: PendingText = {kind:'text', botId: selected.botId, requestId: uuid(), text: draft};
    // 先同步落盘再分派；写失败则不发送，草稿保留。
    if (!freeze(payload)) return;
    const envelope = await BotHost.call({method:'submit', params:{botId: payload.botId, requestId: payload.requestId, text: payload.text}});
    setReceipt(envelope.result as HostSubmission);
    clearFrozen(payload);
    setDraft('');
  });
  // 只读核对：Host 无此提交返回 SUBMISSION_NOT_FOUND（responded）；其它错误不得当作缺失，也不清除记录。
  const reconcile = (frozen: PendingText | PendingVoice) => action.run(async () => {
    setReconcileNotice('');
    const attempt = attemptRef.current;
    // 过期读：期间已换记录/开始新尝试，不得标记缺失、替换回执或清除记录。
    const stillCurrent = () => {
      const current = pendingRef.current;
      return attemptRef.current === attempt && !!current && samePending(current, frozen);
    };
    let envelope: HostCallResult;
    try {
      envelope = await BotHost.call({method:'getSubmission', params:{botId: frozen.botId, requestId: frozen.requestId}});
    } catch (error) {
      if (!stillCurrent()) return;
      // 只有真实 responded 的 SUBMISSION_NOT_FOUND 才算确认缺失。
      if (record(error).code === MISSING_SUBMISSION && errorOutcome(error) === 'responded') {
        setMissing({requestId: frozen.requestId, botId: frozen.botId, attempt});
        setReconcileNotice(t('Host 未找到该请求的回执；这不证明未执行。','Host has no receipt for this request; that does not prove it never ran.'));
        return;
      }
      throw error; // 不支持/未确认的核对不得改动冻结记录
    }
    if (!stillCurrent()) return;
    const answer = envelope.result as HostSubmission;
    const status = answer && typeof answer.status === 'string' ? answer.status : '';
    if (!answer || answer.botId !== frozen.botId || answer.requestId !== frozen.requestId || RECEIPT_STATUSES.indexOf(status) < 0) {
      setReconcileNotice(t('回执归属或状态不可用，保留本地记录。','Receipt identity or status is not usable; local record kept.'));
      return;
    }
    setReceipt(answer);
    clearFrozen(frozen);
    setMissing(undefined);
  });
  // 缺失已确认后的独立用户动作：同 ID 同正文重发（Host 对同 ID 同正文幂等返回原提交）。
  const retryPending = () => action.run(async () => {
    if (!pending || pending.kind !== 'text') return;
    const frozen = pending;
    if (!missing || missing.attempt !== attemptRef.current
      || missing.requestId !== frozen.requestId || missing.botId !== frozen.botId) return;
    // 新一次发送即作废旧缺失确认：即使结果 unconfirmed，也必须重新只读核对后才能再重发。
    setMissing(undefined);
    // 重发属于替换：存储里必须仍是那条冻结记录，否则不分派也不动输入。
    if (!freeze(frozen, frozen)) return;
    const envelope = await BotHost.call({method:'submit', params:{botId: frozen.botId, requestId: frozen.requestId, text: frozen.text}});
    setReceipt(envelope.result as HostSubmission);
    clearFrozen(frozen);
    setDraft('');
  });
  const findCreate = () => action.run(async () => {
    if (!pending || pending.kind !== 'create') return;
    const frozen = pending;
    const attempt = attemptRef.current;
    const envelope = await BotHost.call({method:'findByRequest', params:{requestId: frozen.requestId}});
    const current = pendingRef.current;
    if (attemptRef.current !== attempt || !current || !samePending(current, frozen)) return;
    setSelected(envelope.result as HostBot);
    clearFrozen(frozen);
  });
  const abortAgent = () => action.run(async () => {
    if (!selected) return;
    await BotHost.call({method:'abort', params:{botId: selected.botId}});
  });
  const observeSelected = () => action.run(async () => {
    if (!selected || observeIdRef.current) return;
    await listenersReady.current;
    if (observeIdRef.current) return;
    const observationId = uuid();
    const targetBotId = selected.botId;
    // Claim ownership before the async call so cleanup can cancel even pre-resolution.
    observeIdRef.current = observationId;
    setObserveId(observationId);
    try {
      await BotHost.observe({observationId, target:{kind:'primary', botId: targetBotId}});
      if (observeIdRef.current !== observationId || selectedRef.current?.botId !== targetBotId) {
        void BotHost.cancelObservation({observationId}).catch(() => {});
      }
    } catch (error) {
      if (observeIdRef.current === observationId) clearObserveId();
      throw error;
    }
  });
  const showHistory = () => action.run(async () => {
    if (!selected) return;
    const envelope = await BotHost.call({method:'history', params:{botId: selected.botId, limit: 20}});
    setHistory(envelope.result as HostHistoryPage);
  });
  const loadSettings = () => action.run(async () => {
    const payload = await BotHost.settingsGet();
    setSettings(payload);
    setSettingsDraft(JSON.stringify(payload.settings, null, 2));
  });
  const saveSettings = () => action.run(async () => {
    if (!settings) return;
    const parsed = JSON.parse(settingsDraft) as HostSettings;
    const payload = await BotHost.settingsSet({input:{expectedRevision: settings.revision, settings: parsed}});
    setSettings(payload);
    setSettingsDraft(JSON.stringify(payload.settings, null, 2));
    await refreshSnapshot(); // reflect restartRequired immediately
  });
  const saveCredentials = () => action.run(async () => {
    const aliases = credDraft.trim() ? JSON.parse(credDraft) as Record<string, unknown> : {};
    await BotHost.saveCredentials({aliases});
    setCredDraft('');
    await refreshSnapshot(); // reflect restartRequired immediately
  });
  const applyVoice = (patch: Partial<HostVoiceSettings>) => action.run(async () => {
    if (!voice) return;
    const next = {...voice, ...patch};
    await BotHost.saveVoiceSettings({settings: next});
    // Read back the public descriptor; never keep optimistic state (no key getter).
    setVoice(await BotHost.voiceSettings());
  });
  const applyRemote = (kind: 'stt'|'tts', next: HostVoiceRemote & {apiKey?: string}) => action.run(async () => {
    if (!voice) return;
    const {apiKey, ...remote} = next;
    const settings: HostVoiceSaveInput = kind === 'stt'
      ? apiKey === undefined ? {...voice, stt: remote} : {...voice, stt: {...remote, apiKey}}
      : apiKey === undefined ? {...voice, tts: remote} : {...voice, tts: {...remote, apiKey}};
    await BotHost.saveVoiceSettings({settings});
    // Read back the public descriptor; hasApiKey comes from the native truth.
    setVoice(await BotHost.voiceSettings());
  });
  const startCapture = () => action.run(async () => {
    if (!selected || pending || captureRef.current) return;
    // Freeze ownership before awaiting listeners so leaving the page during the
    // await cannot start a mic afterwards.
    const cap = {botId: selected.botId, requestId: uuid()};
    // Tauri：原生开始录音前先同步落盘语音业务 ID（无转写文本）；写失败则不录音。
    const voiceRecord: PendingVoice = {kind:'voice', botId: cap.botId, requestId: cap.requestId};
    if (persistentPending && !freeze(voiceRecord)) return;
    captureRef.current = cap;
    setCapture(cap);
    try {
      await listenersReady.current;
      // Re-check after the await: still the same capture, page visible.
      if (captureRef.current !== cap || document.hidden) {
        clearCapture(cap);
        if (persistentPending) clearFrozen(voiceRecord);
        return;
      }
      // Tauri：原生 startVoice 期间（含授权弹窗）用本次 cap 精确标记，
      // 让 hidden 处理器不要提前 cancelVoice；结束后在身份守卫的 finally 里清除。
      if (persistentPending) startingRef.current = cap;
      await BotHost.startVoice(cap);
    } catch (error) {
      clearCapture(cap); // identity guard keeps a newer capture intact
      // 仅平台明确 not-sent（未派发）才撤销语音记录；其它情况保留原 ID 供显式对账。
      if (persistentPending && errorOutcome(error) === 'not-sent') clearFrozen(voiceRecord);
      throw error;
    } finally {
      if (startingRef.current === cap) startingRef.current = undefined;
    }
  });
  const finishCapture = () => action.run(async () => { await BotHost.finishVoice(); });
  const cancelCapture = () => action.run(async () => {
    const cap = captureRef.current;
    if (!cap) return;
    await BotHost.cancelVoice();
    clearCapture(cap);
    // 取消回执不能证明原生尚未受理提交：保留冻结的语音 ID，由只读核对或显式本地清除处理。
    if (persistentPending) setReconcileNotice(t('已停止录音；本地语音记录保留（取消不代表未提交），可用只读查询对账或显式清除。','Recording stopped; the local voice record is kept because cancelling does not prove it was never submitted. Use the read-only lookup or clear it explicitly.'));
  });
  const lastFrameError = [...frames].reverse().find(frame => frame.error)?.error;
  const openImportedBot = (bot: HostBot) => { void chooseBot(bot); };
  const refreshBotsAfterImport = () => { void listBots(); };
  const applyImportedDraft = (botId: string, text: string) => {
    if (selected?.botId !== botId) return false;
    setDraft(prev => prev ? `${prev}\n\n${text}` : text);
    return true;
  };
  // 显式本地丢弃：只删本地记录（含无法识别的记录），不假装停止已提交的 Host 工作。
  const clearLocalPending = () => {
    const frozen = pending;
    if (!frozen) return;
    if (!clearFrozen(frozen)) return;
    setMissing(undefined);
    setReconcileNotice('');
  };

  return <main className="page">
    <Header title={t('本机 Host','Local Host')} onBack={onBack} actions={<button className="button secondary-button" onClick={() => void refreshSnapshot()}>{t('刷新','Refresh')}</button>}/>
    <div className="host-focus-bar" role="group" aria-label={t('工作区聚焦模式','Workspace focus')}>
      {([
        { key: 'all', zh: '📋 全部视图', en: 'All' },
        { key: 'chat', zh: '💬 极简对话', en: 'Chat' },
        { key: 'soul', zh: '🎭 灵魂与插件', en: 'SOUL & Ext' },
        { key: 'config', zh: '🧩 Host 配置', en: 'Config' },
        { key: 'voice', zh: '🎙️ 语音与迁移', en: 'Voice' },
      ] as const).map(item => (
        <button
          key={item.key}
          type="button"
          className={`host-focus-chip${focusTab === item.key ? ' active' : ''}`}
          onClick={() => setFocusTab(item.key)}
        >
          {t(item.zh, item.en)}
        </button>
      ))}
    </div>
    <div hidden={focusTab !== 'all' && focusTab !== 'chat' && focusTab !== 'config'}>
    <Section title={t('运行状态','Host status')}>
      {!host && <p className="secondary">{t('正在读取状态…','Loading status…')}</p>}
      {host && <>
        <Row title={t('状态','Status')}><span className={host.phase === 'running' ? 'success' : host.phase === 'failed' ? 'inline-error' : 'secondary'}>{phaseLabel(host.phase, t)}</span></Row>
        <Row title={t('设备 ID','Device ID')} detail={host.deviceId ?? '—'}/>
        {host.restartRequired && <Row title={t('重启后生效','Restart required')}><span className="secondary">{t('配置变更将在下次重启 Host 后生效','Changes apply on the next Host restart')}</span></Row>}
        {host.phase === 'failed' && host.errorCode && <Row title={t('错误','Error')} detail={host.errorCode}/>}
        <div className="action-row">
          {(host.phase === 'stopped' || host.phase === 'failed') && <button className="button" disabled={action.busy || lifecycle?.target === 'running'} onClick={startHost}>{t('启动 Host','Start Host')}</button>}
          {host.phase !== 'stopped' && host.phase !== 'failed' && <button className="button secondary-button" disabled={action.busy || lifecycle?.target === 'stopped'} onClick={stopHost}>{t('停止 Host','Stop Host')}</button>}
        </div>
        {lifecycleNotice && <p className="secondary" role="status">{lifecycleNotice}</p>}
      </>}
    </Section>
    </div>
    <div hidden={focusTab !== 'all' && focusTab !== 'chat' && focusTab !== 'soul'}>
    <Section title={t('Bot','Bots')}>
      {host?.phase === 'running'
        ? <>
            <Row title={t('列出 Bot','List bots')} onClick={listBots}/>
            {bots?.map(bot => <Row key={bot.botId} title={bot.role} detail={`${bot.botId} · ${bot.cwd}${bot.modelRef ? ` · ${bot.modelRef}` : ''}`} onClick={() => chooseBot(bot)}/>)}
            {pending?.kind === 'create' && <div className="form"><p className="secondary" role="status">{t('创建未确认：','Unconfirmed create: ')}<code>{pending.requestId}</code> · {pending.role} · {pending.cwd}</p><div className="action-row"><button type="button" className="button secondary-button" onClick={findCreate}>{t('按请求查找','Find by request')}</button><button type="button" className="button secondary-button" onClick={clearLocalPending}>{t('清除本地记录（不停止已提交任务）','Clear local record (accepted work keeps running)')}</button></div></div>}
            <form className="form" onSubmit={e => { e.preventDefault(); void createBot(); }}>
              <label>{t('角色','Role')}<input required aria-label={t('角色','Role')} value={role} disabled={pending?.kind === 'create'} onChange={e => setRole(e.target.value)}/></label>
              <label>{t('工作目录','Working directory')}<input required aria-label={t('工作目录','Working directory')} value={cwd} disabled={pending?.kind === 'create'} placeholder={host.workspace ?? ''} onChange={e => setCwd(e.target.value)}/></label>
              <label>{t('模型引用（可选）','Model ref (optional)')}<input aria-label={t('模型引用（可选）','Model ref (optional)')} value={modelRef} disabled={pending?.kind === 'create'} onChange={e => setModelRef(e.target.value)}/></label>
              <p className="secondary">{t('请求 ID：','Request ID: ')}<code>{createReqId}</code></p>
              <button className="button" disabled={action.busy || !!pending || !!capture}>{t('创建 Bot','Create bot')}</button>
            </form>
          </>
        : <p className="secondary">{t('Host 运行后可用。','Available while the Host is running.')}</p>}
    </Section>
    </div>
    <div hidden={focusTab !== 'all' && focusTab !== 'voice'}>
      <HostLegacyImport phase={host?.phase ?? 'stopped'} workspace={host?.workspace} locked={!!pending || !!capture} activeBotId={selected?.botId} onOpenBot={openImportedBot} onRefreshBots={refreshBotsAfterImport} onApplyDraft={applyImportedDraft}/>
    </div>
    {pending && pending.kind !== 'create' && <Section title={t('待确认请求','Pending requests')}>
      {pending.kind === 'text' && <>
        <p className="secondary" role="status">{t('冻结的请求（目标与内容已锁定）：','Frozen request (target and content locked): ')}<br/><code>{pending.botId}</code> · <code>{pending.requestId}</code><br/>{pending.text}</p>
        <div className="action-row">
          <button className="button secondary-button" onClick={() => reconcile(pending)}>{t('查询提交（只读）','Get submission (read-only)')}</button>
          {missing && missing.attempt === attemptRef.current && missing.requestId === pending.requestId && missing.botId === pending.botId && <button className="button secondary-button" onClick={retryPending}>{t('重发原请求（同 ID 同正文）','Resend original (same id and text)')}</button>}
          <button className="button secondary-button" onClick={clearLocalPending}>{t('清除本地记录（不停止已提交任务）','Clear local record (accepted work keeps running)')}</button>
        </div>
      </>}
      {pending.kind === 'voice' && <>
        <p className="secondary" role="status">{t('语音请求（只冻结业务 ID，无转写文本）：','Voice request (business ids only, no transcript): ')}<br/><code>{pending.botId}</code> · <code>{pending.requestId}</code></p>
        <div className="action-row">
          <button className="button secondary-button" onClick={() => reconcile(pending)}>{t('查询提交（只读）','Get submission (read-only)')}</button>
          <button className="button secondary-button" onClick={clearLocalPending}>{t('清除本地记录（不停止已提交任务）','Clear local record (accepted work keeps running)')}</button>
        </div>
      </>}
      {pending.kind === 'unknown' && <>
        <p className="secondary" role="status">{t('检测到无法识别的本地待确认记录，未自动清除；清理前不会发送新的请求。','An unrecognized local pending record was found. Nothing was cleared and new sends stay blocked until you clear it.')}</p>
        <div className="action-row">
          <button className="button secondary-button" onClick={clearLocalPending}>{t('清除本地记录','Clear local record')}</button>
        </div>
      </>}
      {reconcileNotice && <p className="secondary" role="status">{reconcileNotice}</p>}
    </Section>}
    <div hidden={focusTab !== 'all' && focusTab !== 'chat'}>
    {selected && <Section title={t('主会话','Primary chat')}>
      <Row title={selected.role} detail={`${selected.botId} · ${selected.cwd}${selected.modelRef ? ` · ${selected.modelRef}` : ''}`}/>
      <form className="form" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <label>{t('消息','Message')}<textarea aria-label={t('消息','Message')} rows={3} value={draft} onChange={e => setDraft(e.target.value)}/></label>
        <div className="action-row">
          <button className="button" disabled={action.busy || !draft.trim() || !!pending || !!capture || host?.phase !== 'running'}>{t('发送','Send')}</button>
          <button type="button" className="button secondary-button" onClick={abortAgent} disabled={host?.phase !== 'running'}>{t('中止当前 Agent','Abort current agent')}</button>
          <button type="button" className="button secondary-button" onClick={observeSelected} disabled={!!observeId || host?.phase !== 'running'}>{t('观察','Observe')}</button>
          <button type="button" className="button secondary-button" onClick={() => { cancelObserve(); setLive(undefined); }} disabled={!observeId}>{t('取消观察','Cancel observation')}</button>
          <button type="button" className="button secondary-button" onClick={showHistory}>{t('历史','History')}</button>
        </div>
      </form>
      {receipt && <Row title={t('提交回执','Receipt')} detail={receiptDetail(receipt)}/>}
      {lastFrameError && <Row title={t('观察错误','Observation error')} detail={`${lastFrameError.code} · ${lastFrameError.outcome} · ${lastFrameError.message}`}/>}
      {live && <Row title={t('实时画面','Live')} detail={liveSummary(live)}/>}
      {history && <>
        <p className="secondary">{t('历史条目数：','History entries: ')}{history.items.length}</p>
        {history.items.map((item, index) => <p key={index} className="secondary">{historyEntry(item)}</p>)}
      </>}
    </Section>}
    </div>
    <div hidden={focusTab !== 'all' && focusTab !== 'soul'}>
    {selected && <Section title={t('Bot 扩展与 SOUL','Bot extensions & SOUL')}>
      <HostBotSettings bot={selected} disabled={host?.phase !== 'running'}/>
    </Section>}
    </div>
    <div hidden={focusTab !== 'all' && focusTab !== 'config'}>
    <Section title={t('配置','Configuration')}>
      <Row title={t('读取配置','Read configuration')} detail={settings ? `${t('修订号','Revision')} ${settings.revision}${settings.activeRevision !== undefined ? ` · active ${settings.activeRevision}` : ''}` : undefined} onClick={loadSettings}/>
      {settings && <>
        <form className="form" onSubmit={e => { e.preventDefault(); void saveSettings(); }}>
          <label>{t('运行时/中继设置 JSON（不含密钥值）','Runtime/relay settings JSON (no secret values)')}<textarea rows={8} aria-label={t('运行时/中继设置 JSON','Runtime/relay settings JSON')} value={settingsDraft} onChange={e => setSettingsDraft(e.target.value)} spellCheck={false}/></label>
          <button className="button" disabled={action.busy}>{t('保存（CAS）','Save (CAS)')}</button>
        </form>
        <form className="form" onSubmit={e => { e.preventDefault(); void saveCredentials(); }}>
          <label>{t('别名凭据映射（仅写入，遮盖显示）','Alias credential map (write-only, masked)')}<input type="password" autoComplete="new-password" aria-label={t('别名凭据映射','Alias credential map')} placeholder='{"OPENAI_API_KEY": "sk-…"}' value={credDraft} onChange={e => setCredDraft(e.target.value)}/></label>
          <p className="secondary">{t('保存将整体替换现有别名映射；留空会清空。省略的别名会被移除。','Saving replaces the entire alias map; leave blank to clear it. Omitted aliases are removed.')}</p>
          <button className="button" disabled={action.busy}>{t('保存凭据','Save credentials')}</button>
        </form>
      </>}
    </Section>
    </div>
    <div hidden={focusTab !== 'all' && focusTab !== 'soul' && focusTab !== 'config'}>
    <Section title={t('扩展','Extensions')}>
      <HostExtensionCatalog disabled={host?.phase !== 'running'}/>
    </Section>
    </div>
    <div hidden={focusTab !== 'all' && focusTab !== 'voice'}>
    <Section title={t('语音','Host voice')}>
      {!voice && <Row title={t('读取语音设置','Read voice settings')} onClick={() => action.run(async () => setVoice(await BotHost.voiceSettings()))}/>}
      {voice && <>
        <Row title={t('识别引擎','Recognition engine')}><select aria-label={t('识别引擎','Recognition engine')} value={voice.sttEngine} onChange={e => applyVoice({sttEngine: e.target.value as HostVoiceSettings['sttEngine']})}><option value="system">{t('系统内置','Built-in')}</option><option value="remote">{t('远程模型','Remote model')}</option></select></Row>
        {voice.sttEngine === 'remote' && <Row title={t('远程识别模型','Remote recognition model')} detail={remoteDetail(voice.stt, t)} onClick={() => setRemoteKind('stt')}/>}
        <Row title={t('朗读引擎','Speech engine')}><select aria-label={t('朗读引擎','Speech engine')} value={voice.ttsEngine} onChange={e => applyVoice({ttsEngine: e.target.value as HostVoiceSettings['ttsEngine']})}><option value="system">{t('系统内置','Built-in')}</option><option value="remote">{t('远程模型','Remote model')}</option></select></Row>
        {voice.ttsEngine === 'remote' && <Row title={t('远程朗读模型','Remote speech model')} detail={remoteDetail(voice.tts, t)} onClick={() => setRemoteKind('tts')}/>}
        <Row title={t('语速','Speech rate')}><select aria-label={t('语速','Speech rate')} value={String(voice.speechRate)} onChange={e => applyVoice({speechRate: Number(e.target.value)})}>{rates.map(rate => <option key={rate} value={String(rate)}>{rate}×</option>)}</select></Row>
        <Row title={t('识别与朗读语言','Recognition & speech language')}><input aria-label={t('识别与朗读语言','Recognition & speech language')} placeholder="zh-CN" defaultValue={voice.language} onBlur={e => applyVoice({language: e.target.value})}/></Row>
        <div className="action-row">
          <button className="button" onClick={startCapture} disabled={action.busy || !!capture || !selected || !!pending}>{t('开始录音','Start mic')}</button>
          <button className="button secondary-button" onClick={finishCapture} disabled={action.busy || !capture}>{t('完成','Finish')}</button>
          <button className="button secondary-button" onClick={cancelCapture} disabled={action.busy || !capture}>{t('取消','Cancel')}</button>
        </div>
        {capture && <p className="secondary" role="status">{t('录制中（完成后由原生提交一次）：','Capturing (native submits once on finish): ')}<code>{capture.requestId}</code></p>}
        {voiceEvents.map((event, index) => <p key={index} className="secondary">{voiceEventText(event, t)}</p>)}
      </>}
    </Section>
    </div>
    <ErrorNotice error={action.error || snapshotError || storageNotice}/>
    {remoteKind && voice && <RemoteVoiceForm kind={remoteKind} remote={remoteKind === 'stt' ? voice.stt : voice.tts} close={() => setRemoteKind(undefined)} save={next => applyRemote(remoteKind, next)}/>}
  </main>;
}

function RemoteVoiceForm({kind, remote, close, save}: {kind: 'stt'|'tts'; remote: HostVoiceRemote; close(): void; save(next: HostVoiceRemote & {apiKey?: string}): Promise<void> | undefined}) {
  const t = useText(); const action = useAction();
  const [url, setUrl] = useState(remote.baseUrl);
  const [model, setModel] = useState(remote.model);
  const [voice, setVoice] = useState(remote.voice);
  const [key, setKey] = useState('');
  const doSave = (extra: {apiKey?: string}) => action.run(async () => {
    await save({baseUrl: url, model, voice, configured: true, ...extra});
    close();
  });
  return <Dialog open title={kind === 'tts' ? t('远程朗读模型','Remote speech model') : t('远程识别模型','Remote recognition model')} onOpenChange={value => !value && close()}>
    <form className="form" onSubmit={e => { e.preventDefault(); void doSave(key.trim() ? {apiKey: key} : {}); }}>
      <p className="secondary">{t('地址须为 https；API Key 仅保存在本机，不会显示或导出。','Base URL must be https; API keys stay on this device and are never shown or exported.')}</p>
      <label>{t('接口地址','Base URL')}<input inputMode="url" placeholder="https://api.openai.com/v1" value={url} onChange={e => setUrl(e.target.value)}/></label>
      <label>API Key<input type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} placeholder={remote.hasApiKey ? t('已保存，留空保持不变','Saved; leave blank to keep') : t('可选','Optional')}/></label>
      <label>{t('模型','Model')}<input value={model} onChange={e => setModel(e.target.value)}/></label>
      <label>{t('音色（voice）','Voice')}<input value={voice} onChange={e => setVoice(e.target.value)}/></label>
      <ErrorNotice error={action.error}/>
      <div className="dialog-actions"><button type="button" className="button secondary-button" disabled={action.busy || !remote.hasApiKey} onClick={() => void doSave({apiKey: ''})}>{t('清除 API Key','Remove API key')}</button><button className="button" disabled={action.busy}>{t('保存','Save')}</button></div>
    </form>
  </Dialog>;
}
