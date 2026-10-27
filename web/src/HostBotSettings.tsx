import { useEffect, useRef, useState } from 'react';
import { BotHost, openCenterManagement, type BotSoul, type HostBot } from './native';
import { ErrorNotice, Row, errorText, record, useAction, useText } from './ui';

// Host 的公开上限，本地先挡明显超限；权威校验仍在 Host。
const SOUL_MAX_BYTES = 65536;
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
const soulOf = (value: unknown): BotSoul|undefined => {
  const raw = record(value);
  return typeof raw.botId === 'string' && typeof raw.path === 'string' && typeof raw.revision === 'string' && typeof raw.text === 'string'
    ? {botId: raw.botId, path: raw.path, revision: raw.revision, text: raw.text} : undefined;
};
const soulBytes = (text: string): number => { try { return new TextEncoder().encode(text).length; } catch { return Number.POSITIVE_INFINITY; } };

// RUNTIME_BUSY/REQUEST_CONFLICT 给出可读提示；其它错误保留真实错误文本（已含 code）。
const failureText = (error: unknown, t: (zh: string, en: string) => string): string => {
  const code = typeof record(error).code === 'string' ? String(record(error).code) : '';
  if (code === 'RUNTIME_BUSY') return t('RUNTIME_BUSY：该 Bot 还有排队或运行中的任务，现在不能修改；空闲后重试。','RUNTIME_BUSY: this bot still has queued or running work; edit again once it is idle.');
  if (code === 'REQUEST_CONFLICT') return t('REQUEST_CONFLICT：远端已更新，本地修改保留且未被覆盖；请重新读取后合并。','REQUEST_CONFLICT: the remote copy changed; your edits are kept and nothing was overwritten. Reload and merge.');
  return errorText(error);
};

export function HostExtensionCatalog({disabled}: {disabled: boolean}) {
  const t = useText();
  return <Row title={t('在中心管理插件','Manage plugins in center')} onClick={disabled ? undefined : () => { void openCenterManagement(); }}/>
}

// 选中 Bot 的 SOUL.md：显式读取、显式 CAS 保存、无自动保存。
// 结果与草稿都按 botId 归档；有未保存草稿时读取只更新草稿、绝不隐式改基线，避免旧草稿被 rebase 后覆盖别人修改。
export function HostBotSettings({bot, disabled}: {bot: HostBot; disabled: boolean}) {
  const t = useText(); const action = useAction();
  const [souls, setSouls] = useState<Record<string, BotSoul>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 响应回来时用当时的草稿判断是否 dirty（迟到的读取也一样）。
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const attempt = (operation: () => Promise<void>) => {
    void action.run(async () => {
      try { await operation(); } catch (error) { action.setError(failureText(error, t)); }
    });
  };
  const discardSoul = (botId: string) => setDrafts(prev => { const rest = {...prev}; delete rest[botId]; return rest; });
  // adopt=true 只由用户显式的“丢弃修改并采用远端”触发：丢弃草稿并采用远端基线。
  const loadSoul = (botId: string, adopt = false) => attempt(async () => {
    const next = soulOf((await BotHost.call({method:'getBotSoul', params:{botId}})).result);
    if (!next || next.botId !== botId) return;
    if (!adopt && draftsRef.current[botId] !== undefined) return;
    setSouls(prev => ({...prev, [botId]: next}));
    if (adopt) discardSoul(botId);
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
    loadSoul(bot.botId);
  }, [bot.botId, disabled]);

  const soul = souls[bot.botId];
  const draft = drafts[bot.botId];
  const soulText = draft ?? soul?.text ?? '';
  const soulDirty = draft !== undefined;
  const currentSoulBytes = soulBytes(soulText);
  const overLimit = soulDirty && currentSoulBytes > SOUL_MAX_BYTES;
  const bytePct = Math.min(100, Math.round((currentSoulBytes / SOUL_MAX_BYTES) * 100));
  const locked = action.busy || disabled;
  const editSoul = (text: string) => setDrafts(prev => {
    if (soul && text === soul.text) { const rest = {...prev}; delete rest[bot.botId]; return rest; }
    return {...prev, [bot.botId]: text};
  });

  return <>
    <Row title={t('在中心管理插件','Manage plugins in center')} onClick={() => { void openCenterManagement(); }}/>
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
