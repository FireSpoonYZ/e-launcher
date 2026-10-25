// Bot 设置（desktop/远程页，lane H）：每 Bot 独立的 Hindsight 扩展开关/只读策略与 SOUL.md 编辑。
// 显式读取 + CAS 保存：冲突/结果未确认只锁保存，只有显式“采用远端设置（丢弃本地修改）”才换基线；
// 未保存草稿连同其原始基线（含 revision）按 profile+target+bot 保留，自动读取绝不替换 dirty 部分的基线，
// 因此旧草稿不会拿到未看过的远端 revision 去覆盖远端；不自动重放、不跨 Host 串数据。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotExtensions, BotExtensionSnapshot, BotSoul } from '../../../host-core/index.js';
import { toError } from './api';
import type { DesktopIdentity, DesktopViewApi } from './types';

/** 与 Host 的公开上限一致（UTF-8 字节）。 */
const SOUL_MAX_BYTES = 64 * 1024;

/** 一个 Bot 的本地编辑状态：草稿与其原始基线成对保存，切走/重挂载后 CAS 仍指向同一远端版本。 */
interface Cached {
  snapshot: BotExtensionSnapshot | null;
  soul: BotSoul | null;
  extDraft: BotExtensions | null;
  soulDraft: string | null;
  /** 上次保存冲突/结果未确认：锁定保存，直到用户显式采用远端。 */
  lock: boolean;
}

/** 按 profile+target+bot 保留（不含 generation，重连后仍可继续编辑）。 */
const draftCache = new Map<string, Cached>();

function cacheKey(identity: DesktopIdentity, botId: string): string {
  return `${identity.profileId}\u0000${identity.targetDeviceId}\u0000${botId}`;
}

function sameExtensions(a: BotExtensions, b: BotExtensions): boolean {
  return a.hindsight.enabled === b.hindsight.enabled && a.hindsight.mode === b.hindsight.mode;
}

function soulBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function reasonText(reason: BotExtensionSnapshot['effective']['hindsight']['reason']): string {
  if (reason === 'bot-disabled') return '本 Bot 已关闭';
  if (reason === 'host-disabled') return 'Host 全局关闭';
  if (reason === 'not-configured') return 'Host 未配置 Hindsight';
  return '生效';
}

export function BotSettings({ api, botId }: { api: DesktopViewApi; botId: string }) {
  const identity = api.identity;
  const online = api.transportConnected;
  const key = identity ? cacheKey(identity, botId) : '';
  const cached = key ? draftCache.get(key) : undefined;

  const [snapshot, setSnapshot] = useState<BotExtensionSnapshot | null>(cached?.snapshot ?? null);
  const [soul, setSoul] = useState<BotSoul | null>(cached?.soul ?? null);
  const [extDraft, setExtDraft] = useState<BotExtensions | null>(cached?.extDraft ?? null);
  const [soulDraft, setSoulDraft] = useState<string | null>(cached?.soulDraft ?? null);
  const [locked, setLocked] = useState(!!cached?.lock);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<'extensions' | 'soul' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mountedRef = useRef(true);
  /** 读取代次：同一选择内只应用最后一次读取。 */
  const seqRef = useRef(0);
  /** 写入代次：保存成功后作废发起更早的读取响应，避免把旧 revision 当基线。 */
  const writeSeqRef = useRef(0);
  /** 最近一次渲染的本地状态；响应应用时按“当前”状态判断该部分是否已被编辑。 */
  const liveRef = useRef<Cached>({ snapshot: null, soul: null, extDraft: null, soulDraft: null, lock: false });
  liveRef.current = { snapshot, soul, extDraft, soulDraft, lock: locked };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /** 选择是否已变（profile/target/bot）或已卸载：迟到结果一律丢弃。 */
  const stale = useCallback((sel: string): boolean => {
    if (!mountedRef.current) return true;
    const cur = api.identity;
    return !cur || cacheKey(cur, botId) !== sel;
  }, [api, botId]);

  /** 每次状态变更都把草稿与基线成对写回缓存，保证重挂载后 CAS 仍用原 revision。 */
  const remember = useCallback((patch: Partial<Cached>): void => {
    if (!key) return;
    draftCache.set(key, { ...liveRef.current, ...patch });
  }, [key]);

  function updateExt(next: BotExtensions | null): void {
    setExtDraft(next);
    setNotice(null);
    remember({ extDraft: next });
  }

  function updateSoul(next: string | null): void {
    setSoulDraft(next);
    setNotice(null);
    remember({ soulDraft: next });
  }

  const load = useCallback(async (adoptRemote: boolean): Promise<void> => {
    const id = api.identity;
    if (!id || !api.transportConnected) return;
    const sel = cacheKey(id, botId);
    const seq = ++seqRef.current;
    const writesAtStart = writeSeqRef.current;
    setLoading(true);
    try {
      const [snap, doc] = await Promise.all([
        api.call(id, 'getBotExtensions', { botId }),
        api.call(id, 'getBotSoul', { botId }),
      ]);
      if (stale(sel) || seq !== seqRef.current || writesAtStart !== writeSeqRef.current) return;
      if (adoptRemote) {
        // 唯一允许更新基线并丢弃本地草稿的入口（显式动作）。
        const adopted: Cached = { snapshot: snap, soul: doc, extDraft: null, soulDraft: null, lock: false };
        setSnapshot(snap);
        setSoul(doc);
        setExtDraft(null);
        setSoulDraft(null);
        setLocked(false);
        setError(null);
        setNotice('已采用远端当前设置与 SOUL（本地未保存修改已丢弃）。');
        liveRef.current = adopted;
        draftCache.set(sel, adopted);
        return;
      }
      // 普通读取：已编辑部分保持原基线（请求发起后用户才开始编辑也按当前状态判断）。
      const live = liveRef.current;
      const extPinned = live.extDraft !== null;
      const soulPinned = live.soulDraft !== null;
      const nextSnapshot = extPinned && live.snapshot ? live.snapshot : snap;
      const nextSoul = soulPinned && live.soul ? live.soul : doc;
      setSnapshot(nextSnapshot);
      setSoul(nextSoul);
      if (!live.lock) setError(null);
      if (
        (extPinned && live.snapshot && live.snapshot.revision !== snap.revision) ||
        (soulPinned && live.soul && live.soul.revision !== doc.revision)
      ) {
        setNotice('远端已更新：本地未保存草稿保持原基线，保存会得到冲突提示；需要远端内容请用“采用远端设置（丢弃本地修改）”。');
      }
      remember({ snapshot: nextSnapshot, soul: nextSoul });
    } catch (e) {
      if (stale(sel) || seq !== seqRef.current) return;
      setError(`读取 Bot 设置失败：${toError(e).message}`);
      api.reportError(e);
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false);
    }
  }, [api, botId, key, stale, remember]);

  // 首次/换 Bot：草稿与基线一起从缓存恢复后显式读取；不自动写回任何内容。
  useEffect(() => {
    const saved = key ? draftCache.get(key) : undefined;
    setSnapshot(saved?.snapshot ?? null);
    setSoul(saved?.soul ?? null);
    setExtDraft(saved?.extDraft ?? null);
    setSoulDraft(saved?.soulDraft ?? null);
    setLocked(!!saved?.lock);
    setError(null);
    setNotice(null);
    setSaving(null);
    if (key) void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 重连后被动刷新一次（同一选择；dirty 部分的基线仍保持不动）。
  const prevOnline = useRef(online);
  useEffect(() => {
    if (!prevOnline.current && online && key) void load(false);
    prevOnline.current = online;
  }, [online, key, load]);

  const baseExtensions = snapshot ? snapshot.extensions : null;
  const extValue = extDraft ?? baseExtensions;
  const extDirty = !!extDraft && !!baseExtensions && !sameExtensions(extDraft, baseExtensions);
  const soulValue = soulDraft ?? soul?.text ?? '';
  const soulDirty = soulDraft !== null && !!soul && soulDraft !== soul.text;
  const busy = saving !== null;
  const saveBusy = busy || !online;
  const canSaveExt = !saveBusy && !!snapshot && extDirty && !locked;
  const canSaveSoul = !saveBusy && !!soul && soulDirty && !locked;
  const dirty = extDirty || soulDirty;
  const effective = snapshot ? snapshot.effective.hindsight : null;

  /** 统一收尾：确定的拒绝保留草稿可重试；冲突/未确认锁保存，只有显式采用远端才能继续。 */
  function reportSaveFailure(e: unknown, sel: string, what: string): void {
    if (stale(sel)) return;
    const err = toError(e);
    api.reportError(e);
    if (err.code === 'RUNTIME_BUSY') {
      setError('Bot 正忙（RUNTIME_BUSY）：有进行中或排队的任务，本次未保存。草稿已保留，任务结束后可重试。');
      return;
    }
    if (err.code === 'REQUEST_CONFLICT' || err.outcome === 'unconfirmed') {
      setLocked(true);
      remember({ lock: true });
      setError(err.code === 'REQUEST_CONFLICT'
        ? `${what}保存冲突（REQUEST_CONFLICT）：远端内容已变化，本次写入未生效。草稿与基线已保留；普通“重新读取”不会给未保存草稿换 revision，请用“采用远端设置（丢弃本地修改）”核对后再保存，不会自动重放。`
        : `${what}保存结果未确认（${err.message || err.code}）：草稿已保留，保存保持锁定；请用“采用远端设置（丢弃本地修改）”核对远端，不会自动重放。`);
      return;
    }
    // 其他确定性拒绝（未下发）：不锁保存，可修正后重试。
    setError(`${what}保存被拒绝（${err.code}）：${err.message}。草稿已保留，可修正后重试。`);
  }

  async function saveExtensions(): Promise<void> {
    const id = api.identity;
    if (!id || !snapshot || !extValue || busy || locked || !online) return;
    if (!extDirty) {
      updateExt(null);
      return;
    }
    const sel = cacheKey(id, botId);
    setSaving('extensions');
    setError(null);
    setNotice(null);
    try {
      const updated = await api.call(id, 'setBotExtensions', {
        botId,
        input: { expectedRevision: snapshot.revision, extensions: extValue },
      });
      if (stale(sel)) return;
      writeSeqRef.current += 1;
      liveRef.current = { ...liveRef.current, snapshot: updated, extDraft: null };
      setSnapshot(updated);
      setExtDraft(null);
      remember({ snapshot: updated, extDraft: null });
      setNotice('扩展设置已保存：下一请求生效，进行中的任务与历史不变。');
    } catch (e) {
      reportSaveFailure(e, sel, '扩展设置');
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  }

  async function saveSoul(): Promise<void> {
    const id = api.identity;
    if (!id || !soul || !soulDirty || busy || locked || !online) return;
    const text = soulDraft ?? '';
    const bytes = soulBytes(text);
    if (bytes > SOUL_MAX_BYTES) {
      setError(`SOUL 超过 64 KiB（当前 ${bytes} 字节），未保存。`);
      return;
    }
    const sel = cacheKey(id, botId);
    setSaving('soul');
    setError(null);
    setNotice(null);
    try {
      const updated = await api.call(id, 'setBotSoul', {
        botId,
        input: { expectedRevision: soul.revision, text },
      });
      if (stale(sel)) return;
      writeSeqRef.current += 1;
      liveRef.current = { ...liveRef.current, soul: updated, soulDraft: null };
      setSoul(updated);
      setSoulDraft(null);
      remember({ soul: updated, soulDraft: null });
      setNotice('SOUL 已保存：下一请求生效，不重置会话与历史。');
    } catch (e) {
      reportSaveFailure(e, sel, 'SOUL ');
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  }

  return (
    <details className="raw-history">
      <summary>
        <h4>{`Bot 设置（扩展 · SOUL）${dirty ? ' · 已修改' : ''}`}</h4>
      </summary>
      <div className="raw-history-content">
        {!online ? <div className="status">离线：显示最后读取的设置，保存已禁用。</div> : null}
        {loading && !snapshot ? <div className="status">加载中…</div> : null}
        {error ? (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => setError(null)}>关闭</button>
          </div>
        ) : null}
        {notice ? <div className="status">{notice}</div> : null}
        {locked ? (
          <div className="status">
            保存保持锁定：请用“采用远端设置（丢弃本地修改）”核对远端；普通“重新读取”不会给未保存草稿换 revision。
          </div>
        ) : null}

        <div className="form-grid">
          <div className="field">
            <label>Hindsight 扩展</label>
            {snapshot && extValue ? (
              <>
                <div className="metadata">
                  {`revision ${snapshot.revision}${extDirty ? '（本地草稿基线）' : ''} · 远端生效：${effective && effective.enabled ? effective.mode : '关闭'}（${effective ? reasonText(effective.reason) : '—'}）`}
                </div>
                <label className="field checkbox-field">
                  <input
                    type="checkbox"
                    checked={extValue.hindsight.enabled}
                    disabled={saveBusy}
                    onChange={(e) => {
                      updateExt({ ...extValue, hindsight: { ...extValue.hindsight, enabled: e.target.checked } });
                    }}
                  />
                  为该 Bot 启用 Hindsight
                </label>
                <div className="kind-row">
                  <label>
                    <input
                      type="radio"
                      name={`hindsight-mode-${botId}`}
                      checked={extValue.hindsight.mode === 'read-write'}
                      disabled={saveBusy || !extValue.hindsight.enabled}
                      onChange={() => {
                        updateExt({ ...extValue, hindsight: { ...extValue.hindsight, mode: 'read-write' } });
                      }}
                    />
                    读写（read-write）
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`hindsight-mode-${botId}`}
                      checked={extValue.hindsight.mode === 'read-only'}
                      disabled={saveBusy || !extValue.hindsight.enabled}
                      onChange={() => {
                        updateExt({ ...extValue, hindsight: { ...extValue.hindsight, mode: 'read-only' } });
                      }}
                    />
                    只读（read-only）
                  </label>
                </div>
                <p className="hint">
                  只读允许状态/回忆/反思/读取，拒绝写入并暂停自动写入；关闭会隐藏该 Bot 的全部 Hindsight 工具并跳过自动回忆/记录。
                  不影响其他 Bot；关闭或只读期间完成的对话不会在重新开启后补写。
                </p>
                <div className="form-actions">
                  <button onClick={() => void saveExtensions()} disabled={!canSaveExt}>
                    {saving === 'extensions' ? '保存中…' : '保存扩展设置（CAS）'}
                  </button>
                  <button onClick={() => updateExt(null)} disabled={!extDirty || busy}>
                    放弃扩展修改
                  </button>
                </div>
              </>
            ) : (
              <div className="metadata">{loading ? '读取中…' : '尚未读取'}</div>
            )}
          </div>

          <div className="field">
            <label>SOUL.md</label>
            {soul ? (
              <>
                <div className="metadata">
                  {`${soul.path} · revision ${soul.revision.slice(0, 12)}…${soulDirty ? '（本地草稿基线）' : ''} · ${soulBytes(soulValue)} / ${SOUL_MAX_BYTES} 字节`}
                </div>
                <textarea
                  className="raw-history"
                  value={soulValue}
                  rows={10}
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) => updateSoul(e.target.value)}
                />
                <p className="hint">
                  该 Bot 独立的系统人设（主/工作上下文都用它）；保存后在下一个请求生效，不重置会话与历史。允许为空。
                </p>
                <div className="form-actions">
                  <button onClick={() => void saveSoul()} disabled={!canSaveSoul}>
                    {saving === 'soul' ? '保存中…' : '保存 SOUL（CAS）'}
                  </button>
                  <button onClick={() => updateSoul(null)} disabled={!soulDirty || busy}>
                    放弃 SOUL 修改
                  </button>
                </div>
              </>
            ) : (
              <div className="metadata">{loading ? '读取中…' : '尚未读取'}</div>
            )}
          </div>
        </div>

        <div className="toolbar">
          <button onClick={() => void load(false)} disabled={!online || loading || busy}>
            {loading ? '读取中…' : '重新读取'}
          </button>
          <button
            onClick={() => void load(true)}
            disabled={!online || loading || busy || (!dirty && !locked)}
          >
            采用远端设置（丢弃本地修改）
          </button>
        </div>
      </div>
    </details>
  );
}
