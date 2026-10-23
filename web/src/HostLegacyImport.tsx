import { useEffect, useRef, useState } from 'react';
import { BotHost, type FrozenInput, type HostBot, type HostPhase, type LegacyDraftAttachment, type LegacyListItem, type LegacyPreview, type LegacyStatus } from './native';
import { ErrorNotice, Row, Section, useAction, useText, errorText } from './ui';

const PAGE_SIZE = 20;
const DRAFT_TEXT_PAGE = 8192;
const DRAFT_ATT_PAGE = 50;
const DRAFT_TEXT_BUDGET = 33554432; // manifest jsonFileBytes bound for draft.txt

type Props = {
  phase: HostPhase;
  workspace?: string | null;
  locked?: boolean;
  activeBotId?: string;
  onOpenBot(bot: HostBot): void;
  onRefreshBots(): void;
  onApplyDraft(botId: string, text: string): boolean;
};

type SendState =
  | { state: 'idle'; status: LegacyStatus | null }
  | { state: 'sending'; status: LegacyStatus | null }
  | { state: 'unconfirmed'; status: LegacyStatus | null }
  | { state: 'settled'; status: LegacyStatus };

const sourceKeyOf = (conversationId: string) => `android-chat:${conversationId}`;
const statusBrief = (status: LegacyStatus, t: (zh: string, en: string) => string): string => {
  if (status.phase === 'completed') return t('已导入','Imported');
  if (status.phase === 'prepared') return t('已预留（等待继续）','Prepared (resume)');
  return t('未导入','Not imported');
};

export function HostLegacyImport({phase, workspace, locked, activeBotId, onOpenBot, onRefreshBots, onApplyDraft}: Props) {
  const t = useText(); const action = useAction();
  const [sources, setSources] = useState<LegacyListItem[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [past, setPast] = useState<Array<string | null>>([]);
  const [expanded, setExpanded] = useState<string>();
  const [targetRole, setTargetRole] = useState('');
  const [targetCwd, setTargetCwd] = useState('');
  const [targetModelRef, setTargetModelRef] = useState('');
  const [preview, setPreview] = useState<LegacyPreview>();
  const [status, setStatus] = useState<LegacyStatus>();
  const [probeError, setProbeError] = useState('');
  const [send, setSend] = useState<SendState>({state: 'idle', status: null});
  const [draftText, setDraftText] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<LegacyDraftAttachment[]>([]);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const alive = useRef(true);
  const genRef = useRef(0);
  const busyRef = useRef(false);
  // Synchronous send-state mirror: handlers read this ref, never stale React state.
  const sendRef = useRef<SendState>({state: 'idle', status: null});
  // Independent draft epoch: source/panel/Bot changes and cleanup invalidate any
  // pending draft read without touching the import/reconcile generation.
  const draftEpochRef = useRef(0);
  const frozenRef = useRef<FrozenInput | null>(null);
  const [frozenShown, setFrozenShown] = useState<FrozenInput>();

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ++genRef.current; ++draftEpochRef.current; };
  }, []);
  useEffect(() => { if (workspace && !targetCwd) setTargetCwd(workspace); }, [workspace]);
  // Bot switch invalidates pending draft reads; late results must not land.
  useEffect(() => { ++draftEpochRef.current; }, [activeBotId]);

  const setSendBoth = (next: SendState) => { sendRef.current = next; setSend(next); };
  // While any send outcome is unresolved (sending/unconfirmed, or settled
  // missing/prepared), the panel is locked to that frozen payload.
  const payloadLocked = () => {
    const s = sendRef.current;
    if (s.state === 'sending' || s.state === 'unconfirmed') return true;
    if (s.state === 'settled') return s.status.phase === 'missing' || s.status.phase === 'prepared';
    return false;
  };
  const canImport = () => {
    const s = sendRef.current;
    return s.state === 'idle' || (s.state === 'settled' && (s.status.phase === 'missing' || s.status.phase === 'prepared'));
  };
  // Shared synchronous operation admission: acquired before calling action.run;
  // if already busy, return a settled promise without touching action.busy so a
  // second concurrent op cannot clear the first op's busy state.
  const runOp = <T,>(op: () => Promise<T>) => {
    if (busyRef.current) return Promise.resolve(undefined as T | undefined);
    busyRef.current = true;
    return action.run(async () => {
      try { return await op(); }
      finally { busyRef.current = false; }
    });
  };
  const setFrozenSafe = (nextFrozen: FrozenInput) => {
    if (payloadLocked()) return;
    frozenRef.current = nextFrozen;
    setFrozenShown(nextFrozen);
  };
  const resetSourceState = () => {
    frozenRef.current = null;
    setFrozenShown(undefined);
    setSendBoth({state: 'idle', status: null});
    setExpanded(undefined);
    setPreview(undefined);
    setStatus(undefined);
    setProbeError('');
    setDraftLoaded(false);
    setDraftText('');
    setDraftAttachments([]);
    ++draftEpochRef.current;
  };
  const settleCompleted = (s: LegacyStatus) => {
    if (s.phase !== 'completed') return;
    const prev = sendRef.current;
    if (prev.state === 'sending' || prev.state === 'unconfirmed') return;
    if (prev.state === 'settled' && prev.status.requestId === s.requestId) return;
    setSendBoth({state: 'settled', status: s});
  };

  // Restore a prepared/completed registry state: show and keep its actually saved
  // definition/input, so a later continue never sends a different preview def.
  useEffect(() => {
    if (!status) return;
    if ((status.phase === 'completed' || status.phase === 'prepared') && status.snapshotId && status.requestId && status.definition && sendRef.current.state === 'idle') {
      setFrozenSafe({sourceKey: status.sourceKey, snapshotId: status.snapshotId, requestId: status.requestId, ...status.definition});
      setTargetRole(status.definition.role);
      setTargetCwd(status.definition.cwd);
      setTargetModelRef(status.definition.modelRef);
      // Lock the restored saved identity so edits cannot float a new definition
      // over the original payload; only explicit retry/resume sends it.
      setSendBoth({state: 'settled', status});
    }
    settleCompleted(status);
  }, [status]);

  // Send/ambiguous states block every navigation/entry/target-edit/preview entry
  // synchronously (not just via React busy) so an import receipt is never dropped.
  const listFirst = () => runOp(async () => {
    if (payloadLocked()) return;
    ++genRef.current;
    const gen = genRef.current;
    const envelope = await BotHost.legacyList({limit: PAGE_SIZE});
    if (!alive.current || genRef.current !== gen) return;
    resetSourceState();
    setSources(envelope.items);
    setCursor(null);
    setNext(envelope.nextCursor);
    setPast([]);
  });
  const listNext = () => runOp(async () => {
    if (payloadLocked() || next == null) return;
    ++genRef.current;
    const gen = genRef.current;
    const envelope = await BotHost.legacyList({cursor: next, limit: PAGE_SIZE});
    if (!alive.current || genRef.current !== gen) return;
    setPast(p => [...p, cursor]);
    setCursor(next);
    setNext(envelope.nextCursor);
    resetSourceState();
    setSources(envelope.items);
  });
  const listPrev = () => runOp(async () => {
    if (payloadLocked() || past.length === 0) return;
    ++genRef.current;
    const gen = genRef.current;
    const prevStart = past[past.length - 1];
    const envelope = await BotHost.legacyList(prevStart == null ? {limit: PAGE_SIZE} : {cursor: prevStart, limit: PAGE_SIZE});
    if (!alive.current || genRef.current !== gen) return;
    setPast(p => p.slice(0, -1));
    setCursor(prevStart);
    setNext(envelope.nextCursor);
    resetSourceState();
    setSources(envelope.items);
  });
  const toggleSource = (item: LegacyListItem) => {
    if (busyRef.current || payloadLocked()) return;
    ++genRef.current;
    const gen = genRef.current;
    const wasOpen = expanded === item.conversationId;
    resetSourceState();
    if (wasOpen) return;
    setExpanded(item.conversationId);
    void runOp(async () => {
      const nextStatus = await BotHost.legacyStatus({sourceKey: sourceKeyOf(item.conversationId)});
      if (alive.current && genRef.current === gen) setStatus(nextStatus);
    }).catch(err => {
      if (alive.current && genRef.current === gen) setProbeError(errorText(err));
    });
  };
  const onTargetChange = (setter: (v: string) => void, value: string) => {
    if (busyRef.current || payloadLocked()) return;
    setter(value);
    setPreview(undefined);
    if (sendRef.current.state === 'idle') {
      // Not yet sent: stale preview/frozen must be re-obtained by a new preview.
      if (frozenRef.current) { frozenRef.current = null; setFrozenShown(undefined); }
    }
  };
  const previewSource = () => runOp(async () => {
    if (payloadLocked() || !expanded || !targetRole.trim() || !targetCwd.trim() || !targetModelRef.trim()) return;
    const gen = ++genRef.current;
    // Send raw user values; only the emptiness check trims (role text preserved).
    const result = await BotHost.legacyPreview({
      conversationId: expanded,
      role: targetRole,
      cwd: targetCwd,
      modelRef: targetModelRef,
    });
    if (!alive.current || genRef.current !== gen) return;
    setPreview(result);
    setProbeError('');
    if (result.existing.phase === 'prepared' || result.existing.phase === 'completed') {
      // Registry already holds a saved request: keep/send exactly that definition.
      if (result.existing.snapshotId && result.existing.requestId && result.existing.definition) {
        setFrozenSafe({sourceKey: result.existing.sourceKey, snapshotId: result.existing.snapshotId, requestId: result.existing.requestId, ...result.existing.definition});
      }
    } else {
      setFrozenSafe({sourceKey: result.sourceKey, snapshotId: result.snapshotId, requestId: result.requestId, role: result.definition.role, cwd: result.definition.cwd, modelRef: result.definition.modelRef});
    }
    setStatus(result.existing);
  });
  const doImport = () => runOp(async () => {
    const payload = frozenRef.current;
    if (!payload || !canImport() || !running || locked) return;
    setSendBoth({state: 'sending', status: null});
    const gen = ++genRef.current;
    try {
      const result = await BotHost.legacyImport({input: payload});
      if (!alive.current || genRef.current !== gen) return;
      setSendBoth({state: 'settled', status: result});
      if (result.phase === 'completed') onRefreshBots();
    } catch (error) {
      if (!alive.current || genRef.current !== gen) return;
      // Outcome unclear: keep frozen; only read-only reconcile below.
      setSendBoth({state: 'unconfirmed', status: null});
      throw error;
    }
  });
  const reconcileStatus = () => runOp(async () => {
    const payload = frozenRef.current;
    if (!payload || sendRef.current.state === 'sending') return;
    const gen = ++genRef.current;
    const result = await BotHost.legacyStatus({sourceKey: payload.sourceKey, requestId: payload.requestId});
    if (!alive.current || genRef.current !== gen) return;
    setSendBoth({state: 'settled', status: result});
    if (result.phase === 'completed') onRefreshBots();
  });
  const discardPreview = () => runOp(async () => {
    const payload = frozenRef.current;
    const s = sendRef.current;
    // Only idle (unsent) or settled-missing may discard; sending/unconfirmed and
    // prepared cannot bypass read-only reconciliation.
    const discardable = (s.state === 'idle' && status?.phase !== 'prepared')
      || (s.state === 'settled' && s.status.phase === 'missing');
    if (!payload || !discardable) return;
    const gen = ++genRef.current;
    try {
      await BotHost.legacyDiscard({sourceKey: payload.sourceKey, snapshotId: payload.snapshotId});
      if (!alive.current || genRef.current !== gen) return;
      // Only a successful discard may drop the frozen payload / reset editing.
      frozenRef.current = null;
      setFrozenShown(undefined);
      setPreview(undefined);
      setStatus(undefined);
      setProbeError('');
      setSendBoth({state: 'idle', status: null});
      ++draftEpochRef.current;
    } catch (error) {
      if (!alive.current || genRef.current !== gen) return;
      throw error; // failure keeps original payload
    }
  });
  const loadDraft = () => runOp(async () => {
    const s = sendRef.current;
    const imp = s.state === 'settled' ? s.status : null;
    const payload = frozenRef.current;
    if (imp?.phase !== 'completed' || !payload) return;
    const gen = ++genRef.current;
    const epoch = ++draftEpochRef.current;
    const fail = (message: string): never => {
      if (alive.current && draftEpochRef.current === epoch) setDraftLoaded(false);
      throw new Error(message);
    };
    let text = '';
    const att: LegacyDraftAttachment[] = [];
    let textOffset = 0;
    let attachmentOffset = 0;
    let textDone = false;
    let attDone = false;
    let hasTotals = false;
    let totalText = 0;
    let totalAtt = 0;
    let pageCount = 0;
    while (!(textDone && attDone)) {
      const page = await BotHost.legacyDraft({sourceKey: payload.sourceKey, requestId: payload.requestId, textOffset, attachmentOffset});
      // Stale view (cleanup / source / panel / bot change): never touch state.
      if (!alive.current || genRef.current !== gen || draftEpochRef.current !== epoch) return;
      if (page.sourceKey !== payload.sourceKey || page.snapshotId !== payload.snapshotId || page.requestId !== payload.requestId
          || (imp.bot?.botId && page.botId !== imp.bot.botId)) {
        fail(t('草稿身份不一致','Draft identity mismatch'));
      }
      if (page.textOffset !== textOffset || page.attachmentOffset !== attachmentOffset) {
        fail(t('草稿偏移不一致','Draft offset mismatch'));
      }
      if (!Number.isSafeInteger(page.totalTextLength) || page.totalTextLength < 0
          || !Number.isSafeInteger(page.totalAttachments) || page.totalAttachments < 0) {
        fail(t('草稿总量无效','Draft totals invalid'));
      }
      if (!hasTotals) {
        totalText = page.totalTextLength;
        totalAtt = page.totalAttachments;
        hasTotals = true;
      } else if (page.totalTextLength !== totalText || page.totalAttachments !== totalAtt) {
        fail(t('草稿总量不一致','Draft totals mismatch'));
      }
      if (totalText > DRAFT_TEXT_BUDGET) fail(t('草稿文本超限','Draft text exceeds budget'));
      if (page.text.length > DRAFT_TEXT_PAGE || page.attachments.length > DRAFT_ATT_PAGE) {
        fail(t('草稿页超限','Draft page exceeds limit'));
      }
      pageCount++;
      text += page.text;
      att.push(...page.attachments);
      const maxPages = Math.max(4, Math.ceil(totalText / DRAFT_TEXT_PAGE) + Math.ceil(totalAtt / DRAFT_ATT_PAGE) + 2);
      if (pageCount > maxPages) fail(t('草稿分页未收敛','Draft paging did not converge'));
      if (page.nextTextOffset == null) {
        // Null means this page already reaches the total: it may carry data.
        if (textOffset + page.text.length !== totalText) {
          fail(t('草稿文本结束页无效','Draft text end page invalid'));
        }
        textDone = true;
        textOffset = totalText;
      } else {
        // Exact advance to this page's end; non-final pages must strictly advance.
        if (!Number.isSafeInteger(page.nextTextOffset) || page.nextTextOffset !== textOffset + page.text.length || page.nextTextOffset <= textOffset || page.nextTextOffset > totalText) {
          fail(t('草稿分页越界','Draft text paging out of range'));
        }
        textOffset = page.nextTextOffset;
      }
      if (page.nextAttachmentOffset == null) {
        // Null means this page already reaches the total: it may carry data.
        if (attachmentOffset + page.attachments.length !== totalAtt) {
          fail(t('草稿附件结束页无效','Draft attachment end page invalid'));
        }
        attDone = true;
        attachmentOffset = totalAtt;
      } else {
        if (!Number.isSafeInteger(page.nextAttachmentOffset) || page.nextAttachmentOffset !== attachmentOffset + page.attachments.length || page.nextAttachmentOffset <= attachmentOffset || page.nextAttachmentOffset > totalAtt) {
          fail(t('草稿分页越界','Draft attachment paging out of range'));
        }
        attachmentOffset = page.nextAttachmentOffset;
      }
    }
    // Complete only when accumulated totals equal the protocol totals.
    if (text.length !== totalText || att.length !== totalAtt) fail(t('草稿累计不完整','Draft accumulation incomplete'));
    if (!alive.current || draftEpochRef.current !== epoch) return;
    setDraftText(text);
    setDraftAttachments(att);
    setDraftLoaded(true);
  });
  const applyDraft = () => {
    if (busyRef.current || payloadLocked()) return;
    const s = sendRef.current;
    const imp = s.state === 'settled' ? s.status : null;
    if (imp?.phase !== 'completed' || !draftLoaded) return;
    const targetBotId = imp.bot?.botId;
    if (!targetBotId || activeBotId !== targetBotId) {
      action.setError(t('请先打开目标 Bot 再应用草稿。','Open the target bot before applying the draft.'));
      return;
    }
    const refs = draftAttachments.map(a => `${a.name} — ${a.path}`).join('\n');
    const combined = [draftText, refs].filter(Boolean).join('\n\n');
    if (!onApplyDraft(targetBotId, combined)) {
      action.setError(t('请先打开目标 Bot 再应用草稿。','Open the target bot before applying the draft.'));
    }
  };

  const running = phase === 'running';
  // Render predicate must match the handler: only idle (non-prepared) or
  // settled-missing may discard; sending/unconfirmed/prepared/completed never.
  const canDiscard = !!frozenShown
    && (sendRef.current.state === 'idle' ? status?.phase !== 'prepared'
      : sendRef.current.state === 'settled' && sendRef.current.status?.phase === 'missing');
  return (
    <Section title={t('旧数据迁移','Legacy import')}>
      <Row title={t('列出旧会话','List legacy conversations')} detail={sources ? `${sources.length} ${t('条','items')}` : undefined} onClick={() => void listFirst()}/>
      <p className="secondary">{t('列表采样已落盘的旧聊天；未落盘的内存数据不保证。','Listed chats are sampled from persisted legacy storage; in-memory data is not guaranteed.')}</p>
      {sources && <div className="action-row">
        <button type="button" className="button secondary-button" disabled={action.busy || payloadLocked() || past.length === 0} onClick={() => void listPrev()}>{t('上一页','Previous')}</button>
        <button type="button" className="button secondary-button" disabled={action.busy || payloadLocked() || next == null} onClick={() => void listNext()}>{t('下一页','Next')}</button>
      </div>}
      {probeError && <p className="inline-error">{probeError}</p>}
      {frozenShown && <Row title={t('冻结导入','Frozen import')} detail={`${frozenShown.sourceKey} · ${frozenShown.requestId} · ${frozenShown.role} · ${frozenShown.cwd} · ${frozenShown.modelRef}`}/>}
      {canDiscard && <div className="action-row">
        <button type="button" className="button secondary-button" disabled={action.busy} onClick={() => void discardPreview()}>{t('丢弃预览/重置','Discard preview / reset')}</button>
      </div>}
      {send.state === 'sending' && <p className="secondary" role="status">{t('导入中…','Importing…')}</p>}
      {send.state === 'unconfirmed' && <>
        <Row title={t('导入未确认','Unconfirmed import')} detail={`${frozenShown?.sourceKey ?? ''} · ${frozenShown?.requestId ?? ''}`}/>
        <div className="action-row">
          <button type="button" className="button secondary-button" disabled={action.busy} onClick={() => void reconcileStatus()}>{t('查询状态','Check status')}</button>
        </div>
      </>}
      {send.state === 'settled' && send.status && <>
        <Row title={t('导入状态','Import status')} detail={statusBrief(send.status, t)}/>
        {send.status.phase === 'completed' && send.status.bot && <div className="action-row">
          <button type="button" className="button" onClick={() => onOpenBot(send.status!.bot!)}>{t('打开已导入 Bot','Open imported bot')}</button>
        </div>}
        {send.status.phase === 'prepared' && <div className="action-row">
          <button type="button" className="button secondary-button" disabled={action.busy} onClick={() => void reconcileStatus()}>{t('查询状态','Check status')}</button>
          <button type="button" className="button secondary-button" disabled={!running || action.busy || locked} onClick={() => void doImport()}>{t('继续导入','Resume import')}</button>
        </div>}
        {send.status.phase === 'missing' && <div className="action-row">
          <button type="button" className="button secondary-button" disabled={action.busy} onClick={() => void reconcileStatus()}>{t('查询状态','Check status')}</button>
          <button type="button" className="button secondary-button" disabled={!running || action.busy || locked} onClick={() => void doImport()}>{t('重试导入','Retry import')}</button>
        </div>}
        {send.status.phase === 'completed' && <div className="action-row">
          <button type="button" className="button secondary-button" disabled={action.busy || draftLoaded} onClick={() => void loadDraft()}>{draftLoaded ? t('草稿已载入','Draft loaded') : t('载入草稿','Load draft')}</button>
          {draftLoaded && <button type="button" className="button secondary-button" disabled={locked || action.busy || !activeBotId || activeBotId !== send.status.bot?.botId} onClick={applyDraft}>{t('应用草稿到目标 Bot','Apply draft to target bot')}</button>}
        </div>}
        {draftLoaded && <>
          <p className="secondary">{t('草稿文本：','Draft text: ')}{draftText.length}{t(' 字符',' chars')}</p>
          {draftAttachments.map(a => <Row key={a.id} title={a.name} detail={`${a.path} · ${a.size} B`}/>)}
        </>}
      </>}
      {sources?.map(item => {
        const open = expanded === item.conversationId;
        const detail = [item.createdAt ? new Date(item.createdAt).toLocaleString() : '', item.draftOnly ? t('仅草稿','Draft only') : '', item.modelSelection?.model ? `${t('源模型','Source model')} ${item.modelSelection.model}` : ''].filter(Boolean).join(' · ');
        return <div key={item.conversationId}>
          <Row title={item.title || item.conversationId} detail={detail || undefined} onClick={() => toggleSource(item)}/>
          {open && <div className="form">
            <label>{t('目标角色','Target role')}<textarea rows={2} aria-label={t('目标角色','Target role')} value={targetRole} disabled={payloadLocked()} onChange={e => onTargetChange(setTargetRole, e.target.value)}/></label>
            <label>{t('目标工作目录','Target working directory')}<input aria-label={t('目标工作目录','Target working directory')} value={targetCwd} placeholder={workspace ?? ''} disabled={payloadLocked()} onChange={e => onTargetChange(setTargetCwd, e.target.value)}/></label>
            <label>{t('目标模型引用（必填）','Target model ref (required)')}<input aria-label={t('目标模型引用','Target model ref')} value={targetModelRef} disabled={payloadLocked()} onChange={e => onTargetChange(setTargetModelRef, e.target.value)}/></label>
            <div className="action-row">
              <button type="button" className="button secondary-button" disabled={action.busy || payloadLocked() || !targetRole.trim() || !targetCwd.trim() || !targetModelRef.trim()} onClick={() => void previewSource()}>{t('预览','Preview')}</button>
              {sendRef.current.state === 'idle' && status && <span className="secondary">{statusBrief(status, t)}</span>}
              {status?.phase === 'completed' && status.bot && <button type="button" className="button" onClick={() => onOpenBot(status.bot!)}>{t('打开已导入 Bot','Open imported bot')}</button>}
            </div>
            {preview && <>
              <Row title={t('统计','Counts')} detail={`${t('节点','Nodes')} ${preview.counts.nodes} · ${t('选中','Selected')} ${preview.counts.selectedNodes} · SDK ${preview.counts.sdkEntries} · ${t('记录','Records')} ${preview.counts.contextRecords} · ${t('附件','Attachments')} ${preview.counts.attachments}`}/>
              {preview.warnings.map(w => <p key={w.code} className="secondary">{w.count != null ? `${w.code} × ${w.count}` : w.code}</p>)}
              <Row title={t('草稿','Draft')} detail={`${t('文本','Text')} ${preview.draft.bytes} B · ${t('附件','Attachments')} ${preview.draft.attachments}`}/>
            </>}
            {frozenShown && <Row title={t('冻结定义','Frozen definition')} detail={`${frozenShown.role} · ${frozenShown.cwd} · ${frozenShown.modelRef}`}/>}
            {frozenShown && sendRef.current.state === 'idle' && <div className="action-row">
              <button type="button" className="button" disabled={!running || action.busy || locked || !canImport()} onClick={() => void doImport()}>{status?.phase === 'prepared' ? t('继续导入','Resume import') : t('导入','Import')}</button>
            </div>}
          </div>}
        </div>;
      })}
      <ErrorNotice error={action.error}/>
    </Section>
  );
}
