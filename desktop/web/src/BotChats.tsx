import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopIdentity, DesktopViewApi } from './types';
import type { DesktopObservationEvent } from './types';
import type {
  BotLiveState,
  BotRecord,
  LiveMessage,
  ModelCatalog,
  PendingEnqueueInput,
  PendingRecord,
} from '../../../host-core/index.js';
import { useDrafts } from './drafts';
import type { DraftSnapshot } from './drafts';
import { BotSettings } from './BotSettings';
import { ShowerPreview } from './ShowerPreview';

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

/** 只有 error.outcome 明确 not-sent（未派发）才可判定未入队；其余一律视为结果未知。 */
function isNotSent(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { outcome?: unknown }).outcome === 'not-sent';
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function renderLiveMessage(m: LiveMessage): string {
  return m.role === 'toolResult' ? `[工具结果]${m.text}` : m.text;
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

function RawHistoryPane({ items, loading, error, onLoadMore, hasMore, onRetry, offline }: {
  items: AnyRawEntry[];
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
  hasMore: boolean;
  onRetry: () => void;
  offline: boolean;
}) {
  return (
    <details className="raw-history">
      <summary><h3>原始历史（与 live 分开）</h3></summary>
      <div className="raw-history-content">
        {offline ? <div className="status">离线：显示最后读取的原始历史，不自动请求。</div> : null}
        {error ? (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={onRetry} disabled={offline}>重试</button>
          </div>
        ) : null}
        {items.length === 0 && !loading && !error ? (
          <div className="empty-state">暂无历史条目。</div>
        ) : null}
        {items.map((it) => <RawEntryRow key={String(it.id)} entry={it} />)}
        {loading ? <div className="status">加载中…</div> : null}
        {hasMore && !loading ? <button onClick={onLoadMore} disabled={offline}>加载更多</button> : null}
      </div>
    </details>
  );
}

function CreateBotForm({ api, catalog, onCreated }: {
  api: DesktopViewApi;
  catalog: ModelCatalog | null;
  onCreated: (b: BotRecord) => void;
}) {
  const identity = api.identity;
  const [role, setRole] = useState('');
  const [cwd, setCwd] = useState('');
  const [modelRef, setModelRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function submit() {
    if (!identity || busy) return;
    const r = role.trim();
    const c = cwd.trim();
    if (!r || !c) {
      setError('role 与 cwd 必填');
      return;
    }
    setBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    try {
      const bot = await api.mutateIntent(identity, 'createBot', {
        requestId,
        role: r,
        cwd: c,
        modelRef: modelRef.trim() || null,
      });
      if (!mountedRef.current) return;
      setRole('');
      setCwd('');
      setModelRef('');
      onCreated(bot);
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
      <label className="field">
        role
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例如 researcher" disabled={busy} />
      </label>
      <label className="field">
        cwd（目标 Host 路径，由 Host 现场校验）
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/workspace" disabled={busy} />
      </label>
      <label className="field">
        modelRef
        <select value={modelRef} onChange={(e) => setModelRef(e.target.value)} disabled={busy}>
          <option value="">（Host 默认模型）</option>
          {(catalog?.models ?? []).map((m) => (
            <option key={m.modelRef} value={m.modelRef}>{m.name} — {m.modelRef}</option>
          ))}
        </select>
      </label>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="form-actions">
        <button type="submit" disabled={busy || !identity || !api.transportConnected}>{busy ? '创建中…' : '创建 Bot'}</button>
      </div>
    </form>
  );
}

function Composer({ text, onChangeText, files, onAddFile, onRemoveFile, canPick, onPick, draftError, draftHint, draftConflict, sendState, sendError, onSend, canSend, disabled, onRetryDraft, attempt, recOutcome, onReconcile, onReleaseNotSent, onRetryClearVerified, onAdoptNewerDraft }: {
  text: string;
  onChangeText: (v: string) => void;
  files: { name: string; path: string; size: number }[];
  onAddFile: (ref: { name: string; path: string; size: number }) => void;
  onRemoveFile: (i: number) => void;
  canPick: boolean;
  onPick: () => void;
  draftError: string | null;
  draftHint: string | null;
  draftConflict: DraftSnapshot | null;
  sendState: 'idle' | 'sending';
  sendError: string | null;
  onSend: () => void;
  canSend: boolean;
  disabled: boolean;
  onRetryDraft: () => void;
  attempt: { id: string; phase: string; pendingId: string | null; error: string | null; businessId: string } | null;
  recOutcome: { action: string; found: boolean; recordId: string | null; recordState: string | null } | null;
  onReconcile: () => void;
  onReleaseNotSent: () => void;
  onRetryClearVerified: () => void;
  onAdoptNewerDraft: () => void;
}) {
  return (
    <div className="composer">
      {draftError ? (
        <div className="error-banner" role="alert">
          {draftError}
          <button onClick={onRetryDraft}>重试保存</button>
        </div>
      ) : null}
      {draftConflict ? (
        <div className="status">
          磁盘上的新版草稿：{truncate(draftConflict.text, 160) || '（空文本）'}
          {draftConflict.files.length > 0 ? `（${draftConflict.files.length} 个文件引用）` : ''}
        </div>
      ) : null}
      {attempt ? (
        <div className="error-banner" role="alert" aria-live="polite">
          {attempt.phase === 'not-sent' ? (
            <>
              发送未入队（not-sent）：{attempt.error}
              <button onClick={() => onReleaseNotSent()}>恢复编辑</button>
            </>
          ) : (
            <>
              发送冻结中 · 业务ID {attempt.businessId}{attempt.pendingId ? ` · pending ${attempt.pendingId}` : ''}（{attempt.phase}）。
              {attempt.phase === 'cleared' || attempt.phase === 'failed' || attempt.phase === 'unconfirmed' ? (
                <button onClick={() => onReconcile()}>查询原记录</button>
              ) : null}
              {draftConflict && recOutcome?.found ? (
                <button onClick={() => onAdoptNewerDraft()}>保留新版草稿，结束旧尝试</button>
              ) : null}
              {recOutcome?.action === 'ready-clear-retry' ? (
                <button onClick={() => onRetryClearVerified()}>重试本地清空</button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="file-refs">
          {files.map((f, i) => (
            <span key={`${f.path}#${i}`} className="file-ref">
              {f.name} · {f.path} · {f.size} B
              <button type="button" onClick={() => onRemoveFile(i)} disabled={disabled}>移除</button>
            </span>
          ))}
        </div>
      ) : null}
      <textarea
        className="composer-input"
        value={text}
        onChange={(e) => onChangeText(e.target.value)}
        placeholder="输入消息…"
        rows={3}
        disabled={disabled}
      />
      <div className="composer-bar">
        {canPick ? (
          <button type="button" onClick={() => onPick()} disabled={disabled}>添加本地文件引用</button>
        ) : draftHint ? (
          <span className="hint">{draftHint}</span>
        ) : null}
        <button type="button" className="composer-send" onClick={() => onSend()} disabled={disabled || !canSend}>
          {sendState === 'sending' ? '发送中…' : '发送'}
        </button>
      </div>
      {sendError ? <div className="error-banner" role="alert">{sendError}</div> : null}
      <p className="hint">发送：冻结 ID → 入队 → 清空草稿 → 显式发送；结果以回执/live 为准。</p>
    </div>
  );
}

function PrimaryChatPane({ api, bot, pageActive = true }: { api: DesktopViewApi; bot: BotRecord; pageActive?: boolean }) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const draftTarget = useMemo(() => ({ kind: 'primary' as const, id: bot.botId }), [bot.botId]);
  const drafts = useDrafts({ api, identity, target: draftTarget });

  const [sendState, setSendState] = useState<'idle' | 'sending'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [recOutcome, setRecOutcome] = useState<{ action: string; found: boolean; recordId: string | null; recordState: string | null } | null>(null);
  const lockedRef = useRef(false);
  const [showerOpen, setShowerOpen] = useState(false);
  /** 统一 Shower 面板的平台无关 RPC 适配：方法名/扁平参数由面板给出，身份仍取当前连接。 */
  const callShower = useCallback(
    (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const current = api.identity;
      if (!current) return Promise.reject(new Error('NOT_CONNECTED: 没有活动连接身份'));
      // 直接从 api 调用同一方法（保留 this 绑定）；方法名由面板限定为六个 Shower 控制方法。
      const rawApi = api as unknown as {
        call: (identity: DesktopIdentity, method: string, params: Record<string, unknown>) => Promise<unknown>;
      };
      return rawApi.call(current, method, params);
    },
    [api],
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function onChangeText(v: string) {
    drafts.editText(v);
    if (sendError) setSendError(null);
  }

  function addFile(ref: { name: string; path: string; size: number }) {
    drafts.addFile(ref);
  }

  function removeFile(i: number) {
    drafts.removeFile(i);
  }

  async function pickFile() {
    if (!identity || lockedRef.current) return;
    try {
      const ref = await api.pickFile();
      if (ref && !lockedRef.current) addFile(ref);
    } catch (e) {
      api.reportError(e);
      setSendError('选择文件失败：' + errText(e));
    }
  }

  async function handleSend() {
    if (!identity || sendState !== 'idle' || lockedRef.current) return;
    const msg = drafts.text.trim();
    if (!msg) return;
    const filesNow = drafts.files;
    const composed = filesNow.length
      ? msg + '\n' + filesNow.map((f) => `[文件路径引用，未上传] ${f.path}`).join('\n')
      : msg;
    const requestId = crypto.randomUUID();
    const input: PendingEnqueueInput = {
      kind: 'primary',
      targetDeviceId: identity.targetDeviceId,
      botId: bot.botId,
      requestId,
      text: composed,
    };
    const started = drafts.beginSend(input);
    if (!started) return;
    lockedRef.current = true;
    setSendState('sending');
    setSendError(null);
    setRecOutcome(null);
    await drafts.waitQuiet(started.handle);
    // 只发送冻结副本：await 后不重组身份/业务 ID。
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
          const errMsg = `发送未入队（not-sent）：${errText(e)}。原 requestId ${businessId} 已冻结，无队列记录，可恢复编辑后重试。`;
          drafts.markNotSent(started.handle, errMsg);
          setSendError(errMsg);
        } else {
          const errMsg = `入队结果未确认：${errText(e)}（原 requestId ${businessId}）；保持原 ID 锁，请查询原记录，不会自动补发。`;
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
      setSendError(`已受理（accepted）。结果以 live 或原回执为准。`);
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

  const [live, setLive] = useState<BotLiveState | null>(null);
  const [liveLast, setLiveLast] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveEnded, setLiveEnded] = useState(false);
  const [watchTick, setWatchTick] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [soulStudioOpen, setSoulStudioOpen] = useState(false);

  useEffect(() => {
    // 离线/页面不可见（远端页切回本机）不发 observe：保留最后读取的 live 数据，重连后被动重建。
    if (!identity || !api.transportConnected || !pageActive) return;
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
        const h = api.observe(identity, { kind: 'primary', botId: bot.botId }, (ev) => {
          if (disposed) return;
          if (sessionKey(api.identity) !== localSess) return;
          if ('error' in ev) {
            const err = ev as Extract<DesktopObservationEvent, { error: unknown }>;
            const shape = err.error as { code?: string; message?: string };
            setLiveError(`${shape.code ?? '未知'}${shape.message ? ': ' + shape.message : ''}`);
            setLiveEnded(true);
            return;
          }
          const f = ev.frame;
          if (f.type === 'end') {
            setLiveEnded(true);
            setLiveLast(new Date().toISOString());
            return;
          }
          if ('scopeId' in f) return;
          setLiveLast(new Date().toISOString());
          if (f.type === 'snapshot') {
            setLive(f.state);
          } else {
            const changes = (f as { changes?: Partial<BotLiveState> }).changes;
            if (changes) setLive((prev) => (prev ? { ...prev, ...changes } : prev));
          }
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
  }, [api, sess, bot.botId, watchTick, online, pageActive]);

  async function stopTask() {
    if (!identity || stopping || !api.transportConnected) return;
    setStopping(true);
    try {
      await api.call(identity, 'abort', { botId: bot.botId });
    } catch (e) {
      setLiveError('停止失败：' + errText(e));
      api.reportError(e);
    } finally {
      if (mountedRef.current) setStopping(false);
    }
  }

  const [rawItems, setRawItems] = useState<AnyRawEntry[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const rawCursorRef = useRef<Record<string, unknown> | null>(null);
  const rawSessRef = useRef(sess);
  rawSessRef.current = sess;

  const loadRaw = useCallback(async (reset: boolean) => {
    if (!identity || !api.transportConnected) return;
    const localSess = rawSessRef.current;
    setRawLoading(true);
    try {
      const page = await api.call(identity, 'history', {
        botId: bot.botId,
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
  }, [api, bot.botId, identity]);

  // 只换 Bot 才清旧显示；断开保留最后读取的数据。
  useEffect(() => {
    rawCursorRef.current = null;
    setRawItems([]);
    setRawError(null);
  }, [bot.botId]);

  // 被动读取：离线不自动 call，重连后刷新。
  useEffect(() => {
    if (identity && api.transportConnected) void loadRaw(true);
  }, [loadRaw, identity, online]);

  const disabled = sendState === 'sending' || lockedRef.current || drafts.busy || !!drafts.attempt;

  return (
    <div className="chat-pane-inner">
      <header className="chat-pane-header chat-pane-header-row">
        <div>
          <div className="chat-title">{bot.role}</div>
          <div className="metadata">
            <span>{bot.botId}</span> · <span>cwd: {bot.cwd}</span> · <span>模型: {bot.modelRef ?? '默认'}</span>
          </div>
        </div>
        <div className="chat-header-actions">
          <button
            type="button"
            className={`soul-studio-trigger ${showerOpen ? 'active' : ''}`}
            onClick={() => setShowerOpen((v) => !v)}
          >
            {showerOpen ? '🖥 收起桌面环境' : '🖥 桌面环境'}
          </button>
          <button
            type="button"
            className={`soul-studio-trigger ${soulStudioOpen ? 'active' : ''}`}
            onClick={() => setSoulStudioOpen((v) => !v)}
          >
            {soulStudioOpen ? '✨ 收起灵魂与插件' : '✨ 灵魂与插件 (SOUL & Ext)'}
          </button>
        </div>
      </header>

      <div className="live-status status" aria-live="polite">
        {!online ? <span>离线：显示最后读取的数据，不自动请求。</span>
          : liveError ? <span className="error-text">{liveError}</span>
          : liveEnded ? (
            <span>观察已结束（不断连 Agent）。<button onClick={() => setWatchTick((t) => t + 1)}>重新观察</button></span>
          ) : live ? (
            <span>
              {live.busy ? '● 忙碌中' : live.queuedCount > 0 ? `◐ 队列: ${live.queuedCount}` : '○ 空闲'}
              {' '}·{' '}最后观测 {liveLast ? formatTime(liveLast) : '等待初始帧'}
            </span>
          ) : <span>正在建立观察…</span>}
      </div>

      <BotSettings
        api={api}
        botId={bot.botId}
        open={soulStudioOpen}
        onOpenChange={setSoulStudioOpen}
      />

      {/* 页面不可见时等同断开：停止轮询与输入，避免后台轮询（面板只有 4 个契约 props）。 */}
      {showerOpen ? (
        <ShowerPreview
          call={callShower}
          target={{ botId: bot.botId }}
          connected={api.transportConnected && pageActive}
          onClose={() => setShowerOpen(false)}
        />
      ) : null}

      <div className="live-pane">
        {live ? (
          <>
            {live.generation?.text ? (
              <div className="message assistant">
                <div className="message-text">{live.generation.text}</div>
              </div>
            ) : null}
            {live.tools.length > 0 ? (
              <div className="toolbar-summary">
                {live.tools.map((t) => (
                  <span key={t.callId} className={`tool-chip ${t.status}`}>
                    {t.name} · {t.status}{t.output ? ` · ${truncate(t.output, 60)}` : ''}
                  </span>
                ))}
              </div>
            ) : null}
            {live.history.slice(-6).map((h) => (
              <div key={h.id} className="message history-item">
                <span className="message-role">{h.kind}</span>
                {h.messages.map((m, i) => (
                  <div key={i} className="message-text">{renderLiveMessage(m)}</div>
                ))}
              </div>
            ))}
          </>
        ) : null}
      </div>

      <RawHistoryPane
        items={rawItems}
        loading={rawLoading}
        error={rawError}
        onLoadMore={() => void loadRaw(false)}
        hasMore={!!rawCursorRef.current}
        onRetry={() => void loadRaw(true)}
        offline={!online}
      />

      <div className="toolbar">
        <button disabled={!online || !live || stopping || disabled} onClick={() => void stopTask()}>
          {stopping ? '停止中…' : '停止当前任务'}
        </button>
        <button onClick={() => void loadRaw(true)} disabled={!online || rawLoading || disabled}>刷新历史</button>
      </div>

      <Composer
        text={drafts.text}
        onChangeText={onChangeText}
        files={drafts.files}
        onAddFile={addFile}
        onRemoveFile={removeFile}
        canPick={identity?.kind === 'local'}
        onPick={pickFile}
        draftError={drafts.error}
        draftHint={identity?.kind !== 'local' ? 'Relay 模式不可选本机文件；可将目标 Host 上已存在的路径作为普通文本引用。' : null}
        draftConflict={drafts.conflict}
        sendState={sendState}
        sendError={sendError}
        onSend={handleSend}
        canSend={!!identity && !!drafts.key && drafts.text.trim().length > 0 && !drafts.attempt && !drafts.savePaused}
        disabled={disabled}
        onRetryDraft={drafts.retrySave}
        attempt={drafts.attempt ? {
          ...drafts.attempt,
          businessId: drafts.attempt.input.kind === 'primary' ? drafts.attempt.input.requestId : drafts.attempt.input.messageId,
        } : null}
        recOutcome={recOutcome}
        onReconcile={queryPending}
        onReleaseNotSent={releaseNotSent}
        onRetryClearVerified={retryClearVerified}
        onAdoptNewerDraft={adoptNewerDraft}
      />
    </div>
  );
}

export function BotChats({ api, pageActive = true }: { api: DesktopViewApi; pageActive?: boolean }) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const [bots, setBots] = useState<BotRecord[]>([]);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const targetKeyRef = useRef<string | null>(null);
  const targetKey = identity ? `${identity.profileId}|${identity.targetDeviceId}` : null;

  const loadBots = useCallback(() => {
    if (!identity || !api.transportConnected) return;
    const localSess = sess;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [bs, cat] = await Promise.all([
          api.call(identity, 'listBots', {}),
          api.call(identity, 'getModelCatalog', {}),
        ]);
        if (!cancelled && sessionKey(api.identity) === localSess) {
          setBots(bs);
          setCatalog(cat);
          setBotsError(null);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled && sessionKey(api.identity) === localSess) {
          setBotsError(errText(e));
          api.reportError(e);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api, sess, identity]);

  useEffect(() => {
    // 断开（generation 变化）保留同 profile+target 已加载列表/选择，供离线草稿与入队；
    // 真正换 profile/target 才清旧显示。
    if (targetKey === null) {
      targetKeyRef.current = null;
      setBots([]);
      setCatalog(null);
      setBotsError(null);
      setSelectedBotId(null);
      setLoading(false);
      return;
    }
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      setBots([]);
      setCatalog(null);
      setBotsError(null);
      setSelectedBotId(null);
    }
    // 离线保留同目标最后读取的列表，不自动 call；重连后被动刷新。
    if (!online) {
      setLoading(false);
      return;
    }
    return loadBots();
  }, [loadBots, targetKey, online]);

  const selectedBot = selectedBotId ? bots.find((b) => b.botId === selectedBotId) ?? null : null;

  return (
    <div className="conversation-layout">
      <aside className="entity-list">
        <div className="entity-list-head">
          <h2>Bot私聊</h2>
          <button className="toolbar-btn" onClick={() => setShowCreate((v) => !v)} disabled={!identity}>
            {showCreate ? '取消' : '新建 Bot'}
          </button>
        </div>
        {botsError ? (
          <div className="error-banner" role="alert">
            {botsError}
            <button onClick={() => void loadBots()}>重试</button>
          </div>
        ) : null}
        {!online ? <div className="status">离线：显示最后读取的 Bot 列表，不自动请求。</div> : null}
        {showCreate && identity ? (
          <CreateBotForm
            api={api}
            catalog={catalog}
            onCreated={(bot) => {
              setSelectedBotId(bot.botId);
              setBots((prev) => (prev.some((b) => b.botId === bot.botId) ? prev : [...prev, bot]));
            }}
          />
        ) : null}
        {loading ? <div className="status">加载中…</div>
          : bots.length === 0 && !botsError ? (
            <div className="empty-state">
              暂无 Bot。{identity ? '点击“新建 Bot”创建。' : '请先连接。'}
            </div>
          ) : (
            <ul className="entity-list-items">
              {bots.map((b) => (
                <li key={b.botId}>
                  <button
                    className={`entity-row ${selectedBotId === b.botId ? 'selected' : ''}`}
                    onClick={() => setSelectedBotId(b.botId)}
                  >
                    <span className="entity-title">{b.role}</span>
                    <span className="entity-sub">{b.modelRef ?? '默认模型'} · {b.deviceId}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </aside>
      <section className="chat-pane">
        {identity && selectedBot ? (
          <PrimaryChatPane key={`${selectedBot.botId}_${targetKey}`} api={api} bot={selectedBot} pageActive={pageActive} />
        ) : (
          <div className="empty-state">选择左侧 Bot 查看聊天；如果没有 Bot，请先新建。</div>
        )}
      </section>
    </div>
  );
}
