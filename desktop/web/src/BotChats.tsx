import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopIdentity, DesktopPanelApi, DesktopViewApi } from './types';
import type { DesktopObservationEvent } from './types';
import type {
  BotLiveState,
  BotRecord,
  BotDirectoryEntry,
  DevicesDirectoryItem,
  LiveMessage,
  PendingCursor,
  PendingEnqueueInput,
  PendingListPage,
  PendingRecord,
} from '../../../host-core/index.js';
import { useDrafts } from './drafts';
import type { DraftSnapshot } from './drafts';
import {
  readToolPresentation,
  ToolPresentationCard,
  type QuestionnaireSubmitPayload,
} from '../../../web/src/ToolPresentation';
import { BotSettings } from './BotSettings';
import { ShowerPreview } from './ShowerPreview';
import { targetApi } from './targetApi';
import { readHistoryPage } from './history';

type AnyRawEntry = { id: unknown; kind: string; model?: unknown; data?: unknown };

const ARCHIVE_RETENTION_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DIRECTORY_POLL_INTERVAL_MS = 2000;

interface CachedBotDirectory {
  bots: BotDirectoryEntry[];
  devices: DevicesDirectoryItem[];
  updatedAt: string;
}

function directoryCacheKey(profileKey: string): string {
  return `desktop-bot-dir-v5:${profileKey}`;
}

function readDirectoryCache(profileKey: string): CachedBotDirectory | null {
  if (!profileKey || typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(directoryCacheKey(profileKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedBotDirectory>;
    if (!Array.isArray(parsed.bots) || !Array.isArray(parsed.devices)) return null;
    return {
      bots: parsed.bots,
      devices: parsed.devices,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

function writeDirectoryCache(
  profileKey: string,
  bots: BotDirectoryEntry[],
  devices: DevicesDirectoryItem[],
): void {
  if (!profileKey || typeof window === 'undefined' || !window.localStorage) return;
  try {
    const payload: CachedBotDirectory = {
      bots,
      devices,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(directoryCacheKey(profileKey), JSON.stringify(payload));
  } catch {
    // 忽略 localStorage 配额或权限限制
  }
}

function remainingArchiveDays(archivedAt: string | null | undefined): number {
  if (!archivedAt) return ARCHIVE_RETENTION_DAYS;
  const archivedMs = Date.parse(archivedAt);
  if (Number.isNaN(archivedMs)) return ARCHIVE_RETENTION_DAYS;
  const expireMs = archivedMs + ARCHIVE_RETENTION_DAYS * MS_PER_DAY;
  return Math.max(0, Math.ceil((expireMs - Date.now()) / MS_PER_DAY));
}

function botSortTimestamp(b: Pick<BotRecord, 'lastActivityAt' | 'createdAt'>): number {
  return Date.parse(b.lastActivityAt || b.createdAt || '') || 0;
}

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

/**
 * 按 contract §7 的 TurnAdmissionStatus 本地形状读取：字段缺失即视为无该信息。
 * protocol lane 尚未在共享 d.ts 声明；这里读的是 PendingRecord.receipt（已入库的 Record）。
 */
interface TurnAdmissionView {
  requestId: string;
  phase: 'queued' | 'checking' | 'synchronizing' | 'failed';
  error: { code: string; message: string } | null;
}

const TURN_ADMISSION_PHASES = new Set(['queued', 'checking', 'synchronizing', 'failed']);

const TURN_ADMISSION_LABELS: Record<TurnAdmissionView['phase'], string> = {
  queued: '排队等待准入',
  checking: '正在核对 Center 版本集',
  synchronizing: '正在同步插件版本',
  failed: '准入失败',
};

/** Host-queued 回执：status queued 且 submissionId null，本地持久化后等待准入与原生提交。 */
interface HostQueuedReceipt {
  status: 'queued';
  submissionId: null;
  admission: TurnAdmissionView | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 宽容读取 admission：形状非法/字段缺失返回 null（状态不渲染），不读取文本/凭据。 */
function readTurnAdmission(value: unknown): TurnAdmissionView | null {
  if (!isRecord(value)) return null;
  if (typeof value.requestId !== 'string') return null;
  if (typeof value.phase !== 'string' || !TURN_ADMISSION_PHASES.has(value.phase)) return null;
  let error: TurnAdmissionView['error'] = null;
  if (isRecord(value.error)) {
    error = {
      code: typeof value.error.code === 'string' ? value.error.code : 'UNKNOWN',
      message: typeof value.error.message === 'string' ? value.error.message : '',
    };
  }
  return { requestId: value.requestId, phase: value.phase as TurnAdmissionView['phase'], error };
}

/** 从 PendingRecord.receipt 读取 queued/null-submission 与可选 admission；二者皆缺返回 null。 */
function readHostQueuedReceipt(record: PendingRecord | null): HostQueuedReceipt | null {
  if (!record || !isRecord(record.receipt)) return null;
  const r = record.receipt;
  const admission = readTurnAdmission(r.admission);
  if (r.status === 'queued' && r.submissionId === null) return { status: 'queued', submissionId: null, admission };
  return admission ? { status: 'queued', submissionId: null, admission } : null;
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

function CreateBotForm({
  api,
  devices,
  bots,
  initialDeviceId = '',
  onCreated,
}: {
  api: DesktopPanelApi;
  devices: DevicesDirectoryItem[];
  bots: BotDirectoryEntry[];
  initialDeviceId?: string;
  onCreated: (deviceId: string, bot: BotRecord) => void;
}) {
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [cwd, setCwd] = useState('');
  const [makePrimary, setMakePrimary] = useState(true);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (initialDeviceId) {
      setDeviceId(initialDeviceId);
      const hasPrimary = bots.some(
        (b) => b.deviceId === initialDeviceId && b.isPrimary && !b.archivedAt,
      );
      setMakePrimary(!hasPrimary);
    }
  }, [initialDeviceId, bots]);

  const targetHasPrimary = useMemo(
    () =>
      Boolean(
        deviceId &&
          bots.some((b) => b.deviceId === deviceId && b.isPrimary && !b.archivedAt),
      ),
    [deviceId, bots],
  );
  const forcePrimary = Boolean(deviceId && !targetHasPrimary);
  const effectiveMakePrimary = forcePrimary ? true : makePrimary;

  function handleSelectDevice(nextDeviceId: string) {
    setDeviceId(nextDeviceId);
    const hasPrimary = Boolean(
      nextDeviceId &&
        bots.some((b) => b.deviceId === nextDeviceId && b.isPrimary && !b.archivedAt),
    );
    setMakePrimary(!hasPrimary);
  }

  async function submit() {
    if (sendingRef.current || busy || locked) return;
    if (!deviceId || !devices.some((d) => d.deviceId === deviceId && d.online)) {
      setError('请选择在线目标设备；目标失效时不会改用本机。');
      return;
    }
    if (!role.trim()) {
      setError('Bot 名称必填');
      return;
    }
    sendingRef.current = true;
    setBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    try {
      const identity = api.identityForTarget(deviceId);
      const bot = await api.mutateIntent(identity, 'createBot', {
        requestId,
        role: role.trim(),
        description: description.trim(),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        modelRef: null,
        ...(effectiveMakePrimary ? { makePrimary: true } : {}),
      });
      if (!mountedRef.current) return;
      setRole('');
      setDescription('');
      setCwd('');
      onCreated(deviceId, effectiveMakePrimary ? { ...bot, isPrimary: true } : bot);
    } catch (e) {
      if (!mountedRef.current) return;
      if (
        !isNotSent(e) &&
        !(e && typeof e === 'object' && (e as { outcome?: string }).outcome === 'responded')
      ) {
        setLocked(true);
      }
      setError(
        `${errText(e)}（原 requestId: ${requestId}；未确认结果请在待发送面板选择原设备对账，不会自动重发）`,
      );
      api.reportError(e);
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <form
      className="form-grid"
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        目标设备
        <select
          value={deviceId}
          onChange={(e) => handleSelectDevice(e.target.value)}
          disabled={busy || locked}
        >
          <option value="">请选择设备</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId} disabled={!d.online}>
              {d.displayName || d.deviceId} · {d.deviceId} {d.online ? '在线' : '离线'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Bot 名称
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={busy || locked}
        />
      </label>
      <label className="field">
        职责
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          disabled={busy || locked}
        />
      </label>
      <label className="field">
        cwd（可选；留空使用目标默认工作区）
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          disabled={busy || locked}
        />
      </label>
      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={effectiveMakePrimary}
          disabled={busy || locked || forcePrimary}
          onChange={(e) => setMakePrimary(e.target.checked)}
        />
        <span>设为主 Bot (makePrimary)</span>
      </label>
      {forcePrimary ? (
        <p className="hint">该设备当前尚无未归档的主 Bot，已强制勾选并锁定设为主 Bot。</p>
      ) : null}
      <p>模型由中心管理，新 Bot 使用中心默认配置。</p>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" disabled={busy || locked || !api.transportConnected}>
          {busy ? '创建中…' : effectiveMakePrimary ? '创建主 Bot' : '创建 Bot'}
        </button>
      </div>
    </form>
  );
}

function Composer({ text, onChangeText, files, onAddFile, onRemoveFile, canPick, onPick, draftError, draftHint, draftConflict, sendState, sendError, onSend, canSend, disabled, onRetryDraft, attempt, recOutcome, onReconcile, onReleaseNotSent, onRetryClearVerified, onAdoptNewerDraft, turnAdmission, onRetryTurnAdmission }: {
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
  /** 最新可见的 Host 准入状态（来自原 pending 记录 receipt.admission）；null 表示无等待项。 */
  turnAdmission: TurnAdmissionView | null;
  /** Host 准入失败后的显式重试：沿用冻结的同一 requestId/文本重新入队，不自动重发。 */
  onRetryTurnAdmission: () => void;
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
      {turnAdmission ? (
        <div className={'status' + (turnAdmission.phase === 'failed' ? ' error' : ' busy')} role="status" aria-live="polite">
          {TURN_ADMISSION_LABELS[turnAdmission.phase]}
          {turnAdmission.error
            ? '（' + turnAdmission.error.code + (turnAdmission.error.message ? '：' + truncate(turnAdmission.error.message, 120) : '') + '）'
            : null}
          {' · 同一 requestId 等待中心准入'}
          {turnAdmission.phase === 'failed' && onRetryTurnAdmission ? (
            <button type="button" onClick={() => onRetryTurnAdmission()}>重试准入</button>
          ) : null}
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

function BotProfile({ api, bot, onSaved }: { api: DesktopViewApi; bot: BotRecord; onSaved: (bot: BotRecord) => void }) {
  const [name, setName] = useState(bot.role);
  const [description, setDescription] = useState(bot.description ?? '');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const isArchived = Boolean(bot.archivedAt);
  useEffect(() => {
    if (!dirty.current && !locked) { setName(bot.role); setDescription(bot.description ?? ''); }
  }, [bot.role, bot.description, locked]);

  async function save() {
    const identity = api.identity;
    if (!identity || !api.transportConnected || inFlight.current || locked || isArchived) return;
    if (!name.trim()) { setError('Bot 名称必填'); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.call(identity, 'updateBotProfile', { botId: bot.botId, name: name.trim(), description: description.trim() });
      if (sessionKey(api.identity) !== sessionKey(identity)) return;
      dirty.current = false;
      setName(updated.role);
      setDescription(updated.description ?? '');
      onSaved(updated);
    } catch (e) {
      if (sessionKey(api.identity) !== sessionKey(identity)) return;
      if (!isNotSent(e) && !(e && typeof e === 'object' && (e as { outcome?: string }).outcome === 'responded')) setLocked(true);
      setError(`资料保存失败：${errText(e)}。结果未确认时请读取并采用远端资料核对，不会自动重发。`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function adoptRemote() {
    const identity = api.identity;
    if (!identity || !api.transportConnected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const items = await api.call(identity, 'listBots', {});
      if (sessionKey(api.identity) !== sessionKey(identity)) return;
      const fresh = items.find((item) => item.botId === bot.botId);
      if (!fresh) { setError('远端没有此 Bot；保留草稿与锁定。'); return; }
      dirty.current = false;
      setName(fresh.role);
      setDescription(fresh.description ?? '');
      setLocked(false);
      setError(null);
      onSaved(fresh);
    } catch (e) {
      if (sessionKey(api.identity) === sessionKey(identity)) setError(`读取远端资料失败：${errText(e)}；保留草稿与锁定。`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <details className="raw-history">
    <summary>Bot 名称与职责</summary>
    <div className="form-grid raw-history-content">
      <label>名称<input value={name} maxLength={120} disabled={busy || locked || isArchived} onChange={(e) => { dirty.current = true; setName(e.target.value); }} /></label>
      <label>职责<textarea value={description} maxLength={2000} disabled={busy || locked || isArchived} onChange={(e) => { dirty.current = true; setDescription(e.target.value); }} /></label>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {locked ? <button type="button" disabled={busy || !api.transportConnected} onClick={() => void adoptRemote()}>读取并采用远端资料（丢弃草稿）</button> : null}
      <button onClick={() => void save()} disabled={busy || locked || isArchived || !api.transportConnected}>保存资料</button>
    </div>
  </details>;
}

function PrimaryChatPane({
  api,
  bot,
  onProfileSaved,
  onBotUpdated,
  onBotDeleted,
  onLiveActivity,
  pageActive = true,
}: {
  api: DesktopPanelApi;
  bot: BotRecord;
  onProfileSaved: (bot: BotRecord) => void;
  onBotUpdated: (patch: Partial<BotRecord> & { botId: string }) => void;
  onBotDeleted: (botId: string) => void;
  onLiveActivity?: () => void;
  pageActive?: boolean;
}) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const isArchived = Boolean(bot.archivedAt);
  const isPrimary = Boolean(bot.isPrimary);
  const draftTarget = useMemo(() => ({ kind: 'primary' as const, id: bot.botId }), [bot.botId]);
  const drafts = useDrafts({ api, identity, target: draftTarget });

  const [sendState, setSendState] = useState<'idle' | 'sending'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [recOutcome, setRecOutcome] = useState<{ action: string; found: boolean; recordId: string | null; recordState: string | null } | null>(null);
  const lockedRef = useRef(false);
  const [showerOpen, setShowerOpen] = useState(false);
  /** 本聊天最新的 Host 准入状态（Host-queued 回执中的 admission）；null 表示无等待项。 */
  const [turnAdmission, setTurnAdmission] = useState<TurnAdmissionView | null>(null);

  const [manageAction, setManageAction] = useState<'setPrimary' | 'archive' | 'unarchive' | 'delete' | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const manageInFlightRef = useRef(false);
  const manageBusy = manageAction !== null;

  const onLiveActivityRef = useRef(onLiveActivity);
  onLiveActivityRef.current = onLiveActivity;

  /** 问卷提交复用现有 callCapabilityAction；deviceId/botId 取自当前身份与 Bot。 */
  const submitQuestionnaire = useCallback(
    (installationId: string, input: QuestionnaireSubmitPayload): Promise<unknown> => {
      const current = api.identity;
      if (!current || !api.transportConnected) {
        return Promise.reject(new Error('NOT_CONNECTED: 没有活动连接身份'));
      }
      return api.call(current, 'callCapabilityAction', {
        installationId,
        action: 'answerQuestionnaire',
        request: {
          requestId: crypto.randomUUID(),
          deviceId: current.targetDeviceId,
          botId: bot.botId,
          input,
        },
      });
    },
    [api, bot.botId],
  );

  useEffect(() => {
    setManageError(null);
    setConfirmDelete(false);
  }, [bot.botId]);

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

  async function handleSetPrimary() {
    if (!identity || !online || manageInFlightRef.current || isPrimary || isArchived) return;
    manageInFlightRef.current = true;
    setManageAction('setPrimary');
    setManageError(null);
    try {
      const updated = await api.call(identity, 'setPrimaryBot', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      onBotUpdated({
        ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
        botId: bot.botId,
        isPrimary: true,
      });
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`设为主 Bot 失败：${errText(e)}`);
        api.reportError(e);
      }
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  async function handleArchive() {
    if (!identity || !online || manageInFlightRef.current || isPrimary || isArchived) return;
    manageInFlightRef.current = true;
    setManageAction('archive');
    setManageError(null);
    try {
      const updated = await api.call(identity, 'archiveBot', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      const archivedAt =
        updated &&
        typeof updated === 'object' &&
        'archivedAt' in updated &&
        typeof (updated as { archivedAt?: unknown }).archivedAt === 'string'
          ? (updated as { archivedAt: string }).archivedAt
          : new Date().toISOString();
      onBotUpdated({
        ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
        botId: bot.botId,
        archivedAt,
        isPrimary: false,
      });
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`归档失败：${errText(e)}`);
        api.reportError(e);
      }
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  async function handleUnarchive() {
    if (!identity || !online || manageInFlightRef.current || !isArchived) return;
    manageInFlightRef.current = true;
    setManageAction('unarchive');
    setManageError(null);
    try {
      const updated = await api.call(identity, 'unarchiveBot', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      onBotUpdated({
        ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
        botId: bot.botId,
        archivedAt: null,
      });
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`恢复失败：${errText(e)}`);
        api.reportError(e);
      }
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  async function handleDelete() {
    if (!identity || !online || manageInFlightRef.current || isPrimary) return;
    manageInFlightRef.current = true;
    setManageAction('delete');
    setManageError(null);
    try {
      await api.call(identity, 'deleteBot', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      setConfirmDelete(false);
      onBotDeleted(bot.botId);
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`删除失败：${errText(e)}`);
        api.reportError(e);
      }
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

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
    if (!identity || lockedRef.current || isArchived) return;
    try {
      const ref = await api.pickFile();
      if (ref && !lockedRef.current) addFile(ref);
    } catch (e) {
      api.reportError(e);
      setSendError('选择文件失败：' + errText(e));
    }
  }

  async function handleSend() {
    if (!identity || sendState !== 'idle' || lockedRef.current || isArchived) return;
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
    const hostQueued = readHostQueuedReceipt(rec);
    // Host-queued：本地已持久化并等待中心准入，submissionId 为 null 属正常，不视为缺失。
    setTurnAdmission(hostQueued ? hostQueued.admission : null);
    if (rec.state === 'accepted') {
      drafts.finishSend(handle);
      // 受理只说明已受理；完成与否以 live/原回执为准，界面不断言。
      setSendError(hostQueued
        ? '已受理（accepted）：提交已入 Host 队列等待准入（submissionId 未定）。结果以 live 或原回执为准。'
        : '已受理（accepted）。结果以 live 或原回执为准。');
      onLiveActivityRef.current?.();
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
      setSendError(hostQueued
        ? `消息已入 Host 队列等待准入（${originalPendingId}）${hostQueued.admission ? '：' + TURN_ADMISSION_LABELS[hostQueued.admission.phase] : ''}；结果以 live 或原回执为准。`
        : `消息状态：${rec.state}（${originalPendingId}）。`);
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

  /** 找到本 Bot 最近一条 Host-queued 记录（本地分页，只读；返回 null 表示无等待项）。 */
  async function findHostAdmissionRecord(): Promise<PendingRecord | null> {
    const current = api.identity;
    if (!current) return null;
    let cursor: PendingCursor | null = null;
    for (let pageNo = 0; pageNo < 20; pageNo += 1) {
      const page: PendingListPage = await api.pending(current, 'pending_list', { options: { limit: 50, cursor } });
      const hit = page.items.find(
        (item: PendingRecord) => item.kind === 'primary' && item.botId === bot.botId && readHostQueuedReceipt(item) !== null,
      );
      if (hit) return hit;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return null;
  }

  /** 显式刷新 Host 准入状态；找不到等待记录即清空显示。 */
  async function refreshTurnAdmission() {
    const rec = await findHostAdmissionRecord();
    if (!mountedRef.current) return;
    setTurnAdmission(rec ? readHostQueuedReceipt(rec)?.admission ?? null : null);
  }

  /**
   * Host 准入失败后的显式重试：用持久化记录里冻结的原 requestId/原文本直接调远端 submit。
   * 不能走 pending_send：已 accepted 的本地 outbox 记录会被 store 短路，永远达不到 Host。
   * Host 端按 requestId+摘要幂等受理同一队列条目，绝不产生第二条消息；返回回执直接刷新准入状态。
   */
  async function retryTurnAdmission() {
    const current = api.identity;
    if (!current || !api.transportConnected || sendState !== 'idle' || lockedRef.current || isArchived) return;
    const rec = await findHostAdmissionRecord();
    const admission = rec ? readHostQueuedReceipt(rec)?.admission ?? null : null;
    if (!rec || rec.kind !== 'primary' || !admission || admission.phase !== 'failed') {
      if (mountedRef.current) setTurnAdmission(admission);
      return;
    }
    lockedRef.current = true;
    setSendState('sending');
    setSendError(null);
    try {
      const receipt = await api.call(current, 'submit', {
        botId: rec.botId, requestId: rec.requestId, text: rec.text,
      });
      if (!mountedRef.current) return;
      const nextAdmission = readTurnAdmission((receipt as { admission?: unknown }).admission);
      setTurnAdmission(nextAdmission);
      setSendError(nextAdmission && nextAdmission.phase !== 'failed'
        ? '已重新受理：' + TURN_ADMISSION_LABELS[nextAdmission.phase]
        : '已重新提交准入，等待 Host 受理状态更新。');
      // 本地 outbox 记录 receipt 仍带旧 admission：显式对账刷新一次（只读，不改远端状态）。
      try { await api.pending(current, 'pending_reconcile', { id: rec.id }); } catch { /* 对账失败不掩盖重试结果 */ }
    } catch (e) {
      api.reportError(e);
      setSendError('准入重试未确认：' + errText(e) + '。原 requestId 与记录保留，可再次显式重试，不会自动补发。');
    } finally {
      lockedRef.current = false;
      setSendState('idle');
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
            onLiveActivityRef.current?.();
            return;
          }
          if ('scopeId' in f) return;
          setLiveLast(new Date().toISOString());
          if (f.type === 'snapshot') {
            setLive(f.state);
            // 快照帧可能带整字段 turnAdmission；缺省/形状非法一律清空显示。
            setTurnAdmission(readTurnAdmission((f.state as { turnAdmission?: unknown }).turnAdmission));
            onLiveActivityRef.current?.();
          } else {
            const changes = (f as { changes?: Partial<BotLiveState> }).changes;
            if (changes && 'turnAdmission' in changes) {
              setTurnAdmission(readTurnAdmission((changes as { turnAdmission?: unknown }).turnAdmission));
            }
            if (changes) {
              setLive((prev) => (prev ? { ...prev, ...changes } : prev));
              if ('history' in changes || 'busy' in changes || 'generation' in changes) {
                onLiveActivityRef.current?.();
              }
            }
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
      const page = await readHistoryPage(async (cursor, limit, chunked) => {
        if (rawSessRef.current !== localSess) return null;
        return api.call(identity, 'history', { botId: bot.botId, limit, cursor, ...(chunked ? { chunked: true } : {}) });
      }, reset ? null : rawCursorRef.current, 30);
      if (rawSessRef.current !== localSess || !page) return;
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

  // 重连/切换后被动刷新 Host 准入状态；离线保留最后显示，不自动请求。
  useEffect(() => {
    if (identity && api.transportConnected) void refreshTurnAdmission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, identity, online, bot.botId]);

  const disabled =
    isArchived || sendState === 'sending' || lockedRef.current || drafts.busy || !!drafts.attempt;

  return (
    <div className="chat-pane-inner">
      <header className="chat-pane-header chat-pane-header-row">
        <div>
          <div className="chat-title-row">
            <span className="chat-title">{bot.role}</span>
            {isPrimary && !isArchived ? (
              <span className="primary-star-pill" title="当前设备主 Bot">★ 主 Bot</span>
            ) : null}
            {isArchived ? (
              <span className="archived-pill">已归档</span>
            ) : null}
          </div>
          <div className="metadata">
            <span>{bot.botId}</span> · <span>cwd: {bot.cwd}</span> · <span>模型: {bot.modelRef ?? '默认'}</span>
          </div>
          {isPrimary && !isArchived ? (
            <div className="primary-guard-hint">
              主 Bot 不可归档，请先切换主 Bot · 主 Bot 不可删除，请先切换主 Bot
            </div>
          ) : null}
        </div>
        <div className="chat-header-actions">
          {!isPrimary && !isArchived ? (
            <button
              type="button"
              className="toolbar-btn"
              disabled={!online || manageBusy}
              onClick={() => void handleSetPrimary()}
              title={!online ? '设备离线，不可切换主 Bot' : '将此 Bot 设为所属设备的主 Bot'}
            >
              {manageAction === 'setPrimary' ? '设置中…' : '★ 设为主 Bot'}
            </button>
          ) : null}
          {!isArchived ? (
            <button
              type="button"
              className="toolbar-btn"
              disabled={!online || manageBusy || isPrimary}
              title={
                isPrimary
                  ? '主 Bot 不可归档，请先切换主 Bot'
                  : !online
                    ? '设备离线，不可归档'
                    : '归档此 Bot（14 天后自动删除）'
              }
              onClick={() => void handleArchive()}
            >
              {manageAction === 'archive' ? '归档中…' : '归档'}
            </button>
          ) : (
            <button
              type="button"
              className="toolbar-btn"
              disabled={!online || manageBusy}
              title={!online ? '设备离线，不可恢复' : '恢复此 Bot'}
              onClick={() => void handleUnarchive()}
            >
              {manageAction === 'unarchive' ? '恢复中…' : '恢复'}
            </button>
          )}
          <button
            type="button"
            className="toolbar-btn danger-outline-btn"
            disabled={!online || manageBusy || isPrimary}
            title={
              isPrimary
                ? '主 Bot 不可删除，请先切换主 Bot'
                : !online
                  ? '设备离线，不可删除'
                  : '删除此 Bot'
            }
            onClick={() => setConfirmDelete(true)}
          >
            {manageAction === 'delete' ? '删除中…' : '删除'}
          </button>
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

      {confirmDelete && !isPrimary ? (
        <div className="confirm-delete-banner" role="alert">
          <span>确定要永久删除 Bot「{bot.role}」（{bot.botId}）吗？此操作不可撤销。</span>
          <div className="confirm-delete-actions">
            <button
              type="button"
              className="toolbar-btn danger-btn"
              disabled={!online || manageBusy}
              onClick={() => void handleDelete()}
            >
              {manageAction === 'delete' ? '删除中…' : '确认删除'}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              disabled={manageBusy}
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {manageError ? (
        <div className="error-banner" role="alert">
          {manageError}
          <button type="button" onClick={() => setManageError(null)}>关闭</button>
        </div>
      ) : null}

      {isArchived ? (
        <div className="archived-readonly-banner" role="status">
          <span>
            此 Bot 已归档（只读模式，不可发送消息）· 剩余 {remainingArchiveDays(bot.archivedAt)} 天后自动删除
            {bot.archivedAt ? `（归档于 ${formatTime(bot.archivedAt)}）` : ''}
          </span>
          <button
            type="button"
            className="toolbar-btn"
            disabled={!online || manageBusy}
            onClick={() => void handleUnarchive()}
          >
            {manageAction === 'unarchive' ? '恢复中…' : '恢复 Bot'}
          </button>
        </div>
      ) : null}

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

      <BotProfile key={bot.botId} api={api} bot={bot} onSaved={onProfileSaved} />
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
                {live.tools.map((t) => {
                  const presentation = readToolPresentation(
                    (t as { presentation?: unknown }).presentation,
                  );
                  return (
                    <span key={t.callId} className="tool-chip-wrap">
                      <span className={`tool-chip ${t.status}`}>
                        {t.name} · {t.status}{t.output ? ` · ${truncate(t.output, 60)}` : ''}
                      </span>
                      {presentation ? (
                        <ToolPresentationCard
                          key={`${bot.deviceId}:${bot.botId}:${presentation.kind === 'questionnaire' ? presentation.requestId : t.callId}`}
                          presentation={presentation}
                          active={t.status !== 'done' && live.busy === true && !isArchived}
                          onSubmit={
                            presentation.kind === 'questionnaire'
                              ? input => submitQuestionnaire(presentation.installationId, input)
                              : undefined
                          }
                        />
                      ) : null}
                    </span>
                  );
                })}
              </div>
            ) : null}
            {live.history.slice(-6).map((h) => (
              <div key={h.id} className="message history-item">
                <span className="message-role">{h.kind}</span>
                {h.messages.map((m, i) => {
                  const presentation = m.presentation ? readToolPresentation(m.presentation) : null;
                  return (
                    <div key={i} className="message-text">
                      {renderLiveMessage(m)}
                      {presentation ? (
                        <ToolPresentationCard
                          presentation={presentation}
                          active={false}
                        />
                      ) : null}
                    </div>
                  );
                })}
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
        canPick={!isArchived && identity?.kind === 'local'}
        onPick={pickFile}
        draftError={drafts.error}
        draftHint={
          isArchived
            ? '此 Bot 已归档，当前为只读模式，恢复后可继续发送消息。'
            : identity?.kind !== 'local'
              ? 'Relay 模式不可选本机文件；可将目标 Host 上已存在的路径作为普通文本引用。'
              : null
        }
        draftConflict={drafts.conflict}
        sendState={sendState}
        sendError={sendError}
        onSend={handleSend}
        canSend={
          !isArchived &&
          !!identity &&
          !!drafts.key &&
          drafts.text.trim().length > 0 &&
          !drafts.attempt &&
          !drafts.savePaused
        }
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
        turnAdmission={turnAdmission}
        onRetryTurnAdmission={() => void retryTurnAdmission()}
      />
    </div>
  );
}

export function BotChats({ api, pageActive = true }: { api: DesktopPanelApi; pageActive?: boolean }) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const profileKey = identity ? `${identity.profileId}|${identity.kind}` : '';
  const profileRef = useRef(profileKey);
  const initialCache = useMemo(() => readDirectoryCache(profileKey), [profileKey]);

  const [bots, setBots] = useState<BotDirectoryEntry[]>(() => initialCache?.bots ?? []);
  const [devices, setDevices] = useState<DevicesDirectoryItem[]>(() => initialCache?.devices ?? []);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<boolean>(() => Boolean(initialCache));
  const [selected, setSelected] = useState<{ deviceId: string; botId: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createTargetDeviceId, setCreateTargetDeviceId] = useState('');
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refreshQueued = useRef(false);
  const inFlight = useRef(false);
  const seq = useRef(0);
  const sessionRef = useRef(sess);
  sessionRef.current = sess;
  const lastLiveRefreshRef = useRef(0);

  const loadBots = useCallback(async () => {
    if (!identity || !api.transportConnected || !pageActive || !visible || inFlight.current) return;
    const localSess = sess;
    const localProfileKey = profileKey;
    const n = ++seq.current;
    inFlight.current = true;
    setLoading(true);
    try {
      const directory = await api.broker(identity, 'bot_directory', {});
      if (seq.current !== n || sessionRef.current !== localSess) return;
      const unavailable = new Set(directory.devices.filter((d) => !d.online).map((d) => d.deviceId));
      for (const error of directory.errors) unavailable.add(error.deviceId);
      setBots((old) => {
        const merged = [
          ...directory.bots,
          ...old
            .filter(
              (b) =>
                (unavailable.has(b.deviceId) ||
                  !directory.devices.some((d) => d.deviceId === b.deviceId)) &&
                !directory.bots.some(
                  (next) => next.deviceId === b.deviceId && next.botId === b.botId,
                ),
            )
            .map((b) => ({ ...b, online: false })),
        ];
        writeDirectoryCache(localProfileKey, merged, directory.devices);
        return merged;
      });
      setDevices(directory.devices);
      setLoaded(true);
      setBotsError(
        directory.errors.length
          ? directory.errors
              .map((e) => `${e.deviceId}: ${e.code}${e.message ? ' ' + e.message : ''}`)
              .join('；')
          : null,
      );
    } catch (e) {
      if (seq.current === n && sessionRef.current === localSess) {
        setBotsError(`目录读取失败：${errText(e)}`);
      }
    } finally {
      inFlight.current = false;
      if (seq.current === n && sessionRef.current === localSess) setLoading(false);
      if (refreshQueued.current) {
        refreshQueued.current = false;
        setRefreshVersion((v) => v + 1);
      }
    }
  }, [api, sess, profileKey, online, pageActive, visible]);

  const triggerLoadBots = useCallback(() => {
    if (inFlight.current) {
      refreshQueued.current = true;
    } else {
      void loadBots();
    }
  }, [loadBots]);

  const handleLiveActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastLiveRefreshRef.current < 400) {
      refreshQueued.current = true;
      return;
    }
    lastLiveRefreshRef.current = now;
    triggerLoadBots();
  }, [triggerLoadBots]);

  useEffect(() => {
    if (loaded && profileKey) {
      writeDirectoryCache(profileKey, bots, devices);
    }
  }, [loaded, profileKey, bots, devices]);

  useEffect(() => {
    const onVisibility = () => {
      const nextVisible = !document.hidden;
      setVisible(nextVisible);
      if (nextVisible) triggerLoadBots();
    };
    const onFocus = () => {
      const nextVisible = !document.hidden;
      setVisible(nextVisible);
      if (nextVisible) triggerLoadBots();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [triggerLoadBots]);

  useEffect(() => {
    if (profileRef.current !== profileKey) {
      profileRef.current = profileKey;
      const cached = readDirectoryCache(profileKey);
      setBots(cached?.bots ?? []);
      setDevices(cached?.devices ?? []);
      setSelected(null);
      setLoaded(Boolean(cached));
      setBotsError(null);
    }
    seq.current += 1;
    setLoading(false);
    if (online && pageActive && visible) void loadBots();
    const timer =
      online && pageActive && visible
        ? window.setInterval(() => void loadBots(), DIRECTORY_POLL_INTERVAL_MS)
        : null;
    return () => {
      seq.current += 1;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [loadBots, profileKey, online, pageActive, visible, refreshVersion]);

  const missingPrimaryDevices = useMemo(
    () =>
      devices.filter(
        (d) =>
          d.online &&
          !bots.some((b) => b.deviceId === d.deviceId && b.isPrimary && !b.archivedAt),
      ),
    [devices, bots],
  );

  const { primaryBots, regularBots, archivedBots } = useMemo(() => {
    const sortByRecent = (a: BotDirectoryEntry, b: BotDirectoryEntry) =>
      botSortTimestamp(b) - botSortTimestamp(a);
    const primary = bots
      .filter((b) => !b.archivedAt && b.isPrimary)
      .slice()
      .sort(sortByRecent);
    const regular = bots
      .filter((b) => !b.archivedAt && !b.isPrimary)
      .slice()
      .sort(sortByRecent);
    const archived = bots
      .filter((b) => Boolean(b.archivedAt))
      .slice()
      .sort(sortByRecent);
    return { primaryBots: primary, regularBots: regular, archivedBots: archived };
  }, [bots]);

  const selectedBot = selected
    ? bots.find((b) => b.deviceId === selected.deviceId && b.botId === selected.botId) ?? null
    : null;
  const scopedApi = useMemo(
    () =>
      identity && selectedBot
        ? targetApi(api, selectedBot.deviceId, selectedBot.online)
        : null,
    [api, sess, selectedBot?.deviceId, selectedBot?.online],
  );

  function renderBotRow(b: BotDirectoryEntry, isArchivedSection = false) {
    const isSelected = selected?.deviceId === b.deviceId && selected.botId === b.botId;
    const isBotOnline = Boolean(b.online && online);
    const platformLabel = b.platform || 'host';
    const activityIso = b.lastActivityAt || b.createdAt;
    const isPrimaryActive = Boolean(b.isPrimary && !b.archivedAt);
    return (
      <li key={`${b.deviceId}:${b.botId}`}>
        <button
          type="button"
          className={`entity-row bot-entity-row ${isSelected ? 'selected' : ''} ${!isBotOnline ? 'offline' : ''} ${isPrimaryActive ? 'is-primary' : ''} ${b.archivedAt ? 'is-archived' : ''}`}
          onClick={() => setSelected({ deviceId: b.deviceId, botId: b.botId })}
        >
          <span className={`bot-avatar ${isPrimaryActive ? 'primary' : ''}`}>
            <span className="bot-avatar-initial">
              {(b.role || 'B').slice(0, 1).toUpperCase()}
            </span>
            {isPrimaryActive ? (
              <>
                <span className="bot-badge-platform" title={`平台: ${platformLabel}`}>
                  {platformLabel}
                </span>
                <span className="bot-badge-star" title="主 Bot" aria-label="主 Bot">
                  ★
                </span>
              </>
            ) : null}
          </span>
          <span className="entity-main">
            <span className="entity-title-row">
              <span className="entity-title">
                {isPrimaryActive ? `★ ${b.role}` : b.role}
              </span>
              {activityIso ? (
                <span className="entity-time" title={formatTime(activityIso)}>
                  {formatTime(activityIso)}
                </span>
              ) : null}
            </span>
            <span className="entity-sub">
              {devices.find((d) => d.deviceId === b.deviceId)?.displayName || b.deviceName || b.deviceId} · {b.deviceId} · {isBotOnline ? '在线' : '离线或不可读取'}
            </span>
            {b.lastPreview ? (
              <span className="entity-sub entity-preview">{truncate(b.lastPreview, 80)}</span>
            ) : b.description ? (
              <span className="entity-sub">{b.description}</span>
            ) : null}
            {isArchivedSection && b.archivedAt ? (
              <span className="entity-sub archive-countdown">
                已归档 · 剩余 {remainingArchiveDays(b.archivedAt)} 天自动删除
              </span>
            ) : null}
          </span>
        </button>
      </li>
    );
  }

  return (
    <div className="conversation-layout">
      <aside className="entity-list">
        <div className="entity-list-head">
          <h2>Bot私聊</h2>
          <button
            className="toolbar-btn"
            onClick={() => triggerLoadBots()}
            disabled={!online || loading}
          >
            刷新
          </button>
          <button
            className="toolbar-btn"
            onClick={() => {
              setShowCreate((v) => !v);
              if (!showCreate && missingPrimaryDevices.length > 0) {
                setCreateTargetDeviceId(missingPrimaryDevices[0].deviceId);
              }
            }}
            disabled={!identity}
          >
            {showCreate ? '取消' : '新建 Bot'}
          </button>
        </div>

        {missingPrimaryDevices.length > 0 ? (
          <div className="primary-onboarding-banner" role="region" aria-label="创建主 Bot 引导">
            <div className="primary-onboarding-title">⚠️ 在线设备缺少主 Bot</div>
            <div className="primary-onboarding-desc">
              以下在线设备尚未拥有未归档的主 Bot：
              {missingPrimaryDevices
                .map((d) => `${d.displayName || d.deviceId} (${d.deviceId})`)
                .join('、')}
            </div>
            <div className="primary-onboarding-actions">
              {missingPrimaryDevices.map((d) => (
                <button
                  key={d.deviceId}
                  type="button"
                  className="toolbar-btn primary-cta-btn"
                  onClick={() => {
                    setCreateTargetDeviceId(d.deviceId);
                    setShowCreate(true);
                  }}
                >
                  创建主 Bot（{d.displayName || d.deviceId}）
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {botsError ? (
          <div className="error-banner" role="alert">
            {botsError}
            <button onClick={() => triggerLoadBots()}>重试</button>
          </div>
        ) : null}
        {!online ? <div className="status">离线：显示最后读取的 Bot 列表。</div> : null}

        {showCreate && identity ? (
          <CreateBotForm
            api={api}
            devices={devices}
            bots={bots}
            initialDeviceId={createTargetDeviceId}
            onCreated={(deviceId, bot) => {
              setSelected({ deviceId, botId: bot.botId });
              const dev = devices.find((d) => d.deviceId === deviceId);
              setBots((old) => {
                const cleared = bot.isPrimary
                  ? old.map((b) => (b.deviceId === deviceId ? { ...b, isPrimary: false } : b))
                  : old;
                return [
                  ...cleared.filter((b) => b.deviceId !== deviceId || b.botId !== bot.botId),
                  {
                    ...bot,
                    deviceName: dev?.displayName || deviceId,
                    platform: dev?.platform,
                    online: true,
                  },
                ];
              });
              triggerLoadBots();
            }}
          />
        ) : null}

        {loading && !loaded ? (
          <div className="status">加载中…</div>
        ) : !loaded ? (
          <div className="status">目录尚未读取。</div>
        ) : bots.length === 0 && !botsError ? (
          <div className="empty-state">暂无 Bot，点击“新建 Bot”创建。</div>
        ) : (
          <div className="bot-sections-container">
            {primaryBots.length > 0 ? (
              <div className="bot-list-section primary-section">
                <div className="bot-section-header">★ 置顶主 Bot ({primaryBots.length})</div>
                <ul className="entity-list-items">
                  {primaryBots.map((b) => renderBotRow(b, false))}
                </ul>
              </div>
            ) : null}

            {regularBots.length > 0 ? (
              <div className="bot-list-section regular-section">
                <div className="bot-section-header">普通 Bot ({regularBots.length})</div>
                <ul className="entity-list-items">
                  {regularBots.map((b) => renderBotRow(b, false))}
                </ul>
              </div>
            ) : null}

            {archivedBots.length > 0 ? (
              <details className="bot-archived-details">
                <summary>已归档 ({archivedBots.length}) · 14 天倒计时</summary>
                <ul className="entity-list-items">
                  {archivedBots.map((b) => renderBotRow(b, true))}
                </ul>
              </details>
            ) : null}
          </div>
        )}
      </aside>

      <section className="chat-pane">
        {scopedApi && selectedBot ? (
          <PrimaryChatPane
            key={`${sess}:${selectedBot.deviceId}:${selectedBot.botId}`}
            api={scopedApi}
            bot={selectedBot}
            onProfileSaved={(updated) => {
              setBots((old) =>
                old.map((b) =>
                  b.deviceId === updated.deviceId && b.botId === updated.botId
                    ? { ...b, ...updated }
                    : b,
                ),
              );
              triggerLoadBots();
            }}
            onBotUpdated={(patch) => {
              const targetDeviceId = selectedBot.deviceId;
              setBots((old) =>
                old.map((b) => {
                  if (b.deviceId !== targetDeviceId) return b;
                  if (b.botId === patch.botId) return { ...b, ...patch };
                  if (patch.isPrimary) return { ...b, isPrimary: false };
                  return b;
                }),
              );
              triggerLoadBots();
            }}
            onBotDeleted={(deletedBotId) => {
              const targetDeviceId = selectedBot.deviceId;
              setSelected(null);
              setBots((old) =>
                old.filter(
                  (b) => !(b.deviceId === targetDeviceId && b.botId === deletedBotId),
                ),
              );
              triggerLoadBots();
            }}
            onLiveActivity={handleLiveActivity}
            pageActive={pageActive}
          />
        ) : (
          <div className="empty-state">选择左侧 Bot 查看聊天。</div>
        )}
      </section>
    </div>
  );
}
