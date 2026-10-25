import { useEffect, useRef, useState } from 'react';
import { BotHost, type BotExtensionSnapshot, type BotExtensions, type BotSoul, type ExtensionCatalog, type HostBot } from './native';
import { ErrorNotice, Row, errorText, record, useAction, useText } from './ui';

// 跨 lane 的 wire DTO 直接用共享类型，不维护第二份形状；这里只做 unknown -> 共享类型的严格校验。
type AccessMode = BotExtensions['hindsight']['mode'];
type HindsightPolicy = BotExtensionSnapshot['effective']['hindsight'];
type CatalogExtension = ExtensionCatalog['extensions'][number];

// Host 的公开上限，本地先挡明显超限；权威校验仍在 Host。
const SOUL_MAX_BYTES = 65536;
const HINDSIGHT_READ_TOOLS = [
  'hindsight_recall',
  'hindsight_reflect',
  'hindsight_get',
  'hindsight_source',
  'hindsight_status',
] as const;
const HINDSIGHT_WRITE_TOOLS = [
  'hindsight_retain',
  'hindsight_correct',
  'hindsight_retry',
] as const;
const SOUL_SNIPPETS: { zh: string; en: string; text: string }[] = [
  {
    zh: '＋ 角色使命',
    en: '+ Mission',
    text: '\n## 核心角色与使命\n你是一个专注、可靠的 AI 工程与知识助手，优先给出可验证的结论与清晰步骤。\n',
  },
  {
    zh: '＋ 沟通风格',
    en: '+ Style',
    text: '\n## 沟通风格\n- 保持 Grok 式的极简与直接，拒绝空洞套话\n- 复杂问题先给结论，再展开关键依据\n',
  },
  {
    zh: '＋ 群聊准则',
    en: '+ Room Rules',
    text: '\n## 群聊与协作准则 (Scope / Room)\n- 仅在被明确提及时或掌握关键上下文时发言，否则保持 silent\n',
  },
];
const modeOf = (value: unknown): AccessMode|undefined => value === 'read-write' || value === 'read-only' ? value : undefined;
const reasonOf = (value: unknown): HindsightPolicy['reason'] => value === 'bot-disabled' || value === 'host-disabled' || value === 'not-configured' ? value : null;
const policyOf = (value: unknown): HindsightPolicy|undefined => {
  const raw = record(value); const mode = modeOf(raw.mode);
  return typeof raw.enabled === 'boolean' && mode ? {enabled: raw.enabled, mode, reason: reasonOf(raw.reason)} : undefined;
};
// BotExtensions 的 Hindsight 策略嵌在 hindsight 下：wire 必须是 {hindsight:{enabled,mode}}。
const extensionsOf = (value: unknown): BotExtensions|undefined => {
  const hindsight = policyOf(record(value).hindsight);
  return hindsight ? {hindsight: {enabled: hindsight.enabled, mode: hindsight.mode}} : undefined;
};
const snapshotOf = (value: unknown): BotExtensionSnapshot|undefined => {
  const raw = record(value);
  const extensions = extensionsOf(raw.extensions);
  const effective = policyOf(record(raw.effective).hindsight);
  // Bot 扩展 revision 初始为 0，只接受非负安全整数。
  if (typeof raw.botId !== 'string' || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !extensions || !effective) return undefined;
  return {botId: raw.botId, revision: raw.revision, extensions, effective: {hindsight: effective}};
};
const soulOf = (value: unknown): BotSoul|undefined => {
  const raw = record(value);
  return typeof raw.botId === 'string' && typeof raw.path === 'string' && typeof raw.revision === 'string' && typeof raw.text === 'string'
    ? {botId: raw.botId, path: raw.path, revision: raw.revision, text: raw.text} : undefined;
};
const catalogOf = (value: unknown): CatalogExtension[] => {
  const source = record(value).extensions;
  const list: unknown[] = Array.isArray(source) ? source : [];
  return list.map((item): CatalogExtension|undefined => {
    const raw = record(item);
    if (typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string') return undefined;
    return {
      id: raw.id, name: raw.name,
      version: typeof raw.version === 'string' ? raw.version : '',
      scope: 'bot',
      enabled: raw.enabled === true,
      available: raw.available === true,
      defaultEnabled: raw.defaultEnabled === true,
      reason: raw.reason === 'host-disabled' || raw.reason === 'not-configured' ? raw.reason : null,
    } as CatalogExtension;
  }).filter((extension): extension is CatalogExtension => !!extension);
};
const sameExtensions = (a: BotExtensions, b: BotExtensions) => a.hindsight.enabled === b.hindsight.enabled && a.hindsight.mode === b.hindsight.mode;
const soulBytes = (text: string): number => { try { return new TextEncoder().encode(text).length; } catch { return Number.POSITIVE_INFINITY; } };

// RUNTIME_BUSY/REQUEST_CONFLICT 给出可读提示；其它错误保留真实错误文本（已含 code）。
const failureText = (error: unknown, t: (zh: string, en: string) => string): string => {
  const code = typeof record(error).code === 'string' ? String(record(error).code) : '';
  if (code === 'RUNTIME_BUSY') return t('RUNTIME_BUSY：该 Bot 还有排队或运行中的任务，现在不能修改；空闲后重试。','RUNTIME_BUSY: this bot still has queued or running work; edit again once it is idle.');
  if (code === 'REQUEST_CONFLICT') return t('REQUEST_CONFLICT：远端已更新，本地修改保留且未被覆盖；请重新读取后合并。','REQUEST_CONFLICT: the remote copy changed; your edits are kept and nothing was overwritten. Reload and merge.');
  return errorText(error);
};

// Host 级扩展目录：只读展示安装/启用/可用/默认状态，连接与全局开关仍在 Host 配置 JSON 中编辑。
export function HostExtensionCatalog({disabled}: {disabled: boolean}) {
  const t = useText(); const action = useAction();
  const [catalog, setCatalog] = useState<CatalogExtension[]>();
  const load = () => {
    void action.run(async () => setCatalog(catalogOf((await BotHost.call({method:'getExtensionCatalog', params:{}})).result)));
  };
  const reasonText = (reason: CatalogExtension['reason']): string => reason === 'host-disabled' ? t('Host 全局已关闭','Disabled for the Host')
    : reason === 'not-configured' ? t('未配置连接','Not configured') : '';
  return <>
    <Row title={t('读取扩展目录','Read extension catalog')} detail={catalog ? t('共 ' + catalog.length + ' 项','extensions: ' + catalog.length) : undefined} onClick={disabled ? undefined : load}/>
    {catalog && catalog.length === 0 && <p className="secondary">{t('Host 没有可管理的扩展。','The Host has no managed extensions.')}</p>}
    {catalog?.map(extension => <Row key={extension.id} title={extension.name} detail={[
      extension.id,
      `v${extension.version}`,
      extension.scope,
      extension.available ? t('可用','available') : t('不可用','unavailable'),
      extension.enabled ? t('已启用','enabled') : t('已停用','disabled'),
      extension.defaultEnabled ? t('新 Bot 默认开启','default on for new bots') : t('新 Bot 默认关闭','default off for new bots'),
      reasonText(extension.reason),
    ].filter(Boolean).join(' · ')}/>)}
    <p className="secondary">{t('连接与全局开关在下方“配置”JSON 里编辑（runtime.extensions），此处不保存。','Connection and global switches stay in the Configuration JSON below (runtime.extensions); nothing is saved here.')}</p>
    <p className="secondary"><code>{'runtime.extensions.hindsight = {enabled, defaultEnabled, config:{baseUrl, apiKeyEnv}}'}</code></p>
    <p className="secondary">{t('旧的 runtime.hindsight 仍按 enabled/defaultEnabled 均为 true 读取。','Legacy runtime.hindsight is still read as enabled and defaultEnabled being true.')}</p>
    <ErrorNotice error={action.error}/>
  </>;
}

// 选中 Bot 的 Hindsight 开关/只读策略与 SOUL.md：显式读取、显式 CAS 保存、无自动保存。
// 结果与草稿都按 botId 归档；有未保存草稿时读取只更新草稿、绝不隐式改基线，避免旧草稿被 rebase 后覆盖别人修改。
export function HostBotSettings({bot, disabled}: {bot: HostBot; disabled: boolean}) {
  const t = useText(); const action = useAction();
  const [snapshots, setSnapshots] = useState<Record<string, BotExtensionSnapshot>>({});
  const [edits, setEdits] = useState<Record<string, BotExtensions>>({});
  const [souls, setSouls] = useState<Record<string, BotSoul>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 响应回来时用当时的草稿判断是否 dirty（迟到的读取也一样）。
  const editsRef = useRef(edits); editsRef.current = edits;
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const attempt = (operation: () => Promise<void>) => {
    void action.run(async () => {
      try { await operation(); } catch (error) { action.setError(failureText(error, t)); }
    });
  };
  const discardExtensions = (botId: string) => setEdits(prev => { const rest = {...prev}; delete rest[botId]; return rest; });
  const discardSoul = (botId: string) => setDrafts(prev => { const rest = {...prev}; delete rest[botId]; return rest; });
  // adopt=true 只由用户显式的“丢弃修改并采用远端”触发：丢弃草稿并采用远端基线。
  const loadExtensions = (botId: string, adopt = false) => attempt(async () => {
    const next = snapshotOf((await BotHost.call({method:'getBotExtensions', params:{botId}})).result);
    if (!next || next.botId !== botId) return; // 归属不符的结果不落到界面
    if (!adopt && editsRef.current[botId] !== undefined) return; // 有未保存修改：不隐式改基线
    setSnapshots(prev => ({...prev, [botId]: next}));
    if (adopt) discardExtensions(botId);
  });
  const loadSoul = (botId: string, adopt = false) => attempt(async () => {
    const next = soulOf((await BotHost.call({method:'getBotSoul', params:{botId}})).result);
    if (!next || next.botId !== botId) return;
    if (!adopt && draftsRef.current[botId] !== undefined) return;
    setSouls(prev => ({...prev, [botId]: next}));
    if (adopt) discardSoul(botId);
  });
  const saveExtensions = (snapshot: BotExtensionSnapshot, next: BotExtensions) => attempt(async () => {
    // wire 载荷保持完整嵌套：{expectedRevision, extensions:{hindsight:{enabled,mode}}}。
    const saved = snapshotOf((await BotHost.call({method:'setBotExtensions', params:{botId: snapshot.botId, input:{expectedRevision: snapshot.revision, extensions: next}}})).result);
    if (!saved || saved.botId !== snapshot.botId) return;
    setSnapshots(prev => ({...prev, [saved.botId]: saved}));
    setEdits(prev => {
      const edit = prev[saved.botId];
      if (!edit || !sameExtensions(edit, saved.extensions)) return prev;
      const rest = {...prev}; delete rest[saved.botId]; return rest;
    });
  });
  const saveSoul = (soul: BotSoul, text: string) => attempt(async () => {
    // 冲突/失败不改草稿，也不重放写请求。
    const saved = soulOf((await BotHost.call({method:'setBotSoul', params:{botId: soul.botId, input:{expectedRevision: soul.revision, text}}})).result);
    if (!saved || saved.botId !== soul.botId) return;
    setSouls(prev => ({...prev, [saved.botId]: saved}));
    setDrafts(prev => {
      if (prev[saved.botId] !== saved.text) return prev;
      const rest = {...prev}; delete rest[saved.botId]; return rest;
    });
  });
  useEffect(() => {
    if (disabled) return; // Host 未运行时不去读，避免无意义的失败提示
    loadExtensions(bot.botId);
    loadSoul(bot.botId);
  }, [bot.botId, disabled]);

  const snapshot = snapshots[bot.botId];
  const soul = souls[bot.botId];
  const draft = drafts[bot.botId];
  const edited = snapshot ? edits[bot.botId] : undefined;
  const current = edited ?? snapshot?.extensions;
  const extensionsDirty = !!snapshot && !!edited && !sameExtensions(edited, snapshot.extensions);
  const soulText = draft ?? soul?.text ?? '';
  const soulDirty = draft !== undefined;
  const currentSoulBytes = soulBytes(soulText);
  const overLimit = soulDirty && currentSoulBytes > SOUL_MAX_BYTES;
  const bytePct = Math.min(100, Math.round((currentSoulBytes / SOUL_MAX_BYTES) * 100));
  const locked = action.busy || disabled;
  const patch = (next: BotExtensions['hindsight']) => {
    if (!snapshot) return;
    setEdits(prev => {
      if (sameExtensions({hindsight: next}, snapshot.extensions)) { const rest = {...prev}; delete rest[bot.botId]; return rest; }
      return {...prev, [bot.botId]: {hindsight: next}};
    });
  };
  const reasonText = (reason: HindsightPolicy['reason']): string => reason === 'bot-disabled' ? t('该 Bot 已关闭','Disabled for this bot')
    : reason === 'host-disabled' ? t('Host 全局已关闭','Disabled for the Host')
      : reason === 'not-configured' ? t('未配置 Hindsight 连接','Hindsight is not configured')
        : t('正常生效','Effective');
  const editSoul = (text: string) => setDrafts(prev => {
    if (soul && text === soul.text) { const rest = {...prev}; delete rest[bot.botId]; return rest; }
    return {...prev, [bot.botId]: text};
  });

  const hostOk = snapshot ? snapshot.effective.hindsight.reason !== 'host-disabled' && snapshot.effective.hindsight.reason !== 'not-configured' : false;
  const readAllowed = Boolean(current?.hindsight.enabled && hostOk);
  const writeAllowed = Boolean(current?.hindsight.enabled && current?.hindsight.mode === 'read-write' && hostOk);

  return <>
    <Row title={t('读取扩展状态','Read extension state')} detail={[
      snapshot ? `${t('修订号','Revision')} ${snapshot.revision}` : t('尚未读取','Not loaded'),
      extensionsDirty ? t('有未保存修改','unsaved changes') : '',
    ].filter(Boolean).join(' · ')} onClick={locked || extensionsDirty ? undefined : () => loadExtensions(bot.botId)}/>
    {snapshot && current && <>
      <Row title={t('Hindsight 启用','Hindsight enabled')}><input type="checkbox" aria-label={t('Hindsight 启用','Hindsight enabled')} disabled={locked} checked={current.hindsight.enabled} onChange={event => patch({...current.hindsight, enabled: event.target.checked})}/></Row>
      <Row title={t('访问模式','Access mode')}><select aria-label={t('访问模式','Access mode')} disabled={locked} value={current.hindsight.mode} onChange={event => patch({...current.hindsight, mode: event.target.value === 'read-only' ? 'read-only' : 'read-write'})}><option value="read-write">{t('读写','Read-write')}</option><option value="read-only">{t('只读','Read-only')}</option></select></Row>
      <Row title={t('实际生效','Effective')} detail={`${snapshot.effective.hindsight.enabled ? t('已启用','enabled') : t('未启用','off')} · ${snapshot.effective.hindsight.mode} · ${reasonText(snapshot.effective.hindsight.reason)}`}/>
      <div className="tool-gating-box" style={{margin: '6px 0'}}>
        <div className="tool-gating-row">
          <span className="tool-gating-label">{t(`读取工具 (${HINDSIGHT_READ_TOOLS.length})`, `Read tools (${HINDSIGHT_READ_TOOLS.length})`)}</span>
          <div className="tool-gating-chips">
            {HINDSIGHT_READ_TOOLS.map(name => (
              <code key={name} className={`gating-chip ${readAllowed ? 'allowed' : 'gated'}`}>{`${readAllowed ? '✓' : '🚫'} ${name}`}</code>
            ))}
          </div>
        </div>
        <div className="tool-gating-row">
          <span className="tool-gating-label">{t(`写入工具 (${HINDSIGHT_WRITE_TOOLS.length})`, `Write tools (${HINDSIGHT_WRITE_TOOLS.length})`)}</span>
          <div className="tool-gating-chips">
            {HINDSIGHT_WRITE_TOOLS.map(name => (
              <code key={name} className={`gating-chip ${writeAllowed ? 'allowed' : 'gated'}`}>{`${writeAllowed ? '✓' : '🚫'} ${name}`}</code>
            ))}
          </div>
        </div>
      </div>
      <p className="secondary">{t('只影响该 Bot：关闭时隐藏全部 Hindsight 工具并跳过自动回忆与自动保存；只读保留回忆/查询，拒绝写入并暂停自动写入。改动在下一个请求前生效。','Applies to this bot only: off hides every Hindsight tool and skips automatic recall/save; read-only keeps recall and queries, denies writes and pauses automatic writes. Changes apply before the next request.')}</p>
      <div className="action-row">
        <button className="button" disabled={locked || !extensionsDirty} onClick={() => saveExtensions(snapshot, current)}>{t('保存（CAS）','Save (CAS)')}</button>
        <button className="button secondary-button" disabled={locked} onClick={() => loadExtensions(bot.botId, true)}>{extensionsDirty ? t('丢弃修改并采用远端','Discard changes and adopt remote') : t('重新读取','Reload')}</button>
      </div>
    </>}
    <Row title={t('SOUL.md','SOUL.md')} detail={[
      soul ? `${soul.path} · ${soul.revision.slice(0, 12)}` : t('尚未读取','Not loaded'),
      soulDirty ? t('有未保存草稿','unsaved draft') : '',
    ].filter(Boolean).join(' · ')} onClick={locked || soulDirty ? undefined : () => loadSoul(bot.botId)}/>
    {soul && <form className="form" onSubmit={event => { event.preventDefault(); if (soulDirty && !overLimit) saveSoul(soul, soulText); }}>
      <div className="soul-byte-progress">
        <div className="soul-byte-bar">
          <div className={`soul-byte-fill ${overLimit ? 'over' : ''}`} style={{width: `${bytePct}%`}}/>
        </div>
        <div className="soul-byte-meta">
          <span>{`SHA-256: ${soul.revision.slice(0, 12)}`}</span>
          <span>{`${currentSoulBytes.toLocaleString()} / ${SOUL_MAX_BYTES.toLocaleString()} B (${bytePct}%)`}</span>
        </div>
      </div>
      <div className="soul-snippet-bar">
        {SOUL_SNIPPETS.map(item => (
          <button
            key={item.zh}
            type="button"
            className="snippet-chip"
            disabled={locked}
            onClick={() => editSoul((soulText ? soulText.trimEnd() + '\n' : '') + item.text.trimStart())}
          >
            {t(item.zh, item.en)}
          </button>
        ))}
        {soulText.length > 0 && (
          <button
            type="button"
            className="snippet-chip danger"
            disabled={locked}
            onClick={() => editSoul('')}
          >
            {t('清空 ("")', 'Clear ("")')}
          </button>
        )}
      </div>
      <label>{t('SOUL.md 内容（UTF-8，允许为空）','SOUL.md content (UTF-8, may be empty)')}<textarea rows={10} spellCheck={false} aria-label={t('SOUL.md 内容','SOUL.md content')} disabled={locked} value={soulText} onChange={event => editSoul(event.target.value)}/></label>
      <p className="secondary">{t('这是该 Bot 自己的 SOUL.md，作为主会话与工作上下文的系统人设；空内容表示有意为空。','This is the bot\'s own SOUL.md and the system persona for its primary and work contexts; empty means intentionally empty.')}</p>
      {soulDirty && <p className="secondary" role="status">{t('草稿未保存；自动读取不会改动它的基线修订号。','Draft not saved; automatic reads do not move its baseline revision.')}</p>}
      {overLimit && <p className="inline-error" role="alert">{t(`超出 64 KiB 上限（${soulBytes(soulText)} 字节）。`, `Over the 64 KiB limit (${soulBytes(soulText)} bytes).`)}</p>}
      <div className="action-row">
        <button className="button" disabled={locked || !soulDirty || overLimit}>{t('保存 SOUL（CAS）','Save SOUL (CAS)')}</button>
        <button type="button" className="button secondary-button" disabled={locked} onClick={() => loadSoul(bot.botId, true)}>{soulDirty ? t('丢弃草稿并采用远端','Discard draft and adopt remote') : t('重新读取','Reload')}</button>
      </div>
    </form>}
    <ErrorNotice error={action.error}/>
  </>;
}
