import { useEffect, useRef, useState } from 'react';
import { Check, Cpu, X } from 'lucide-react';
import type { CenterBotModelConfig, CenterModelSelection } from '../../host-core/desktop-client.js';
import type { ModelCatalog } from '../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../desktop/web/src/types';
import { openCenterManagement } from './native';
import { ErrorNotice, errorText, useText } from './ui';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

type Props = { api: DesktopPanelApi; identity: DesktopIdentity; botId: string; onClose(): void };

export function BotModelSheet({ api, identity, botId, onClose }: Props) {
  const t = useText();
  const [target] = useState(() => ({ identity, deviceId: identity.targetDeviceId, botId }));
  const alive = useRef(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [config, setConfig] = useState<CenterBotModelConfig>();
  const [draft, setDraft] = useState<CenterModelSelection>({});
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [password, setPassword] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadConfig = async () => {
    const next = await api.broker(target.identity, 'center_bot_model_get', { deviceId: target.deviceId, botId: target.botId });
    if (alive.current) { setConfig(next); setDraft({ ...next.overrides }); }
  };
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const [session, models] = await Promise.all([
          api.broker(target.identity, 'center_owner_session', {}),
          api.call(target.identity, 'getModelCatalog', {}),
        ]);
        if (!alive.current) return;
        setCatalog(models);
        setAuthenticated(session.authenticated);
        if (session.authenticated) await loadConfig();
      } catch (failure) {
        if (alive.current) setError(errorText(failure));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
    return () => { alive.current = false; };
  }, [api, target]);

  const login = async () => {
    setBusy(true); setError('');
    const secret = password;
    setPassword('');
    try {
      await api.broker(target.identity, 'center_owner_login', { password: secret });
      if (!alive.current) return;
      setAuthenticated(true);
      await loadConfig();
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const save = async () => {
    if (!config) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api.broker(target.identity, 'center_bot_model_set', {
        deviceId: target.deviceId, botId: target.botId, expectedRevision: config.revision, value: draft,
      });
      if (alive.current) { setConfig(next); setDraft({ ...next.overrides }); setNotice(t('模型设置已保存', 'Model settings saved')); }
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const update = (key: keyof CenterModelSelection, value: string | null | undefined) => {
    setDraft(previous => {
      const next = { ...previous };
      if (value === undefined) delete next[key]; else next[key] = value;
      return next;
    });
    setNotice('');
  };
  const describe = (value: string | null | undefined) => value === undefined ? t('继承', 'Inherit') : value === null ? t('显式清空', 'Explicitly cleared') : value;
  const q = query.trim().toLowerCase();

  return <div className="grok-sheet-backdrop" role="dialog" aria-modal="true" aria-label={t('Bot 模型设置', 'Bot model settings')} onClick={onClose}>
    <section className="grok-model-sheet" onClick={e => e.stopPropagation()}>
      <header className="grok-model-sheet-header">
        <div className="grok-model-sheet-title-wrap"><h3>{t('Bot 模型设置', 'Bot model settings')}</h3></div>
        <div className="grok-model-sheet-actions">
          <button type="button" className="grok-done-pill-btn" onClick={() => void openCenterManagement().catch(failure => setError(errorText(failure)))}>{t('配置服务商 / 中心管理', 'Providers / Center')}</button>
          <button type="button" className="grok-floating-circle-btn" aria-label={t('关闭', 'Close')} onClick={onClose}><X size={18}/></button>
        </div>
      </header>
      <div className="grok-model-sheet-body">
        {busy && <p role="status">{t('正在处理…', 'Working…')}</p>}
        {!busy && !authenticated && catalog && <form onSubmit={e => { e.preventDefault(); void login(); }}>
          <label className="grok-section-label" htmlFor="center-owner-password">{t('中心管理员密码', 'Center administrator password')}</label>
          <input id="center-owner-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
          <button type="submit" className="grok-done-pill-btn" disabled={!password}>{t('中心管理员登录', 'Center administrator login')}</button>
        </form>}
        {config && <>
          <p>{t('中心全局', 'Global')}: {describe(config.global.modelRef)} · {describe(config.global.thinkingLevel)}</p>
          <p>{t('当前覆盖', 'Override')}: {describe(config.overrides.modelRef)} · {describe(config.overrides.thinkingLevel)}</p>
          <p>{t('当前有效', 'Effective')}: {describe(config.effective.modelRef)} · {describe(config.effective.thinkingLevel)}</p>
          <label className="grok-section-label">{t('模型', 'Model')}</label>
          <section className="grok-card-group">
            <button type="button" className="grok-card-row" disabled={busy} onClick={() => update('modelRef', undefined)}><Cpu size={18}/><span className="grok-row-label">{t('继承全局', 'Inherit global')}</span>{draft.modelRef === undefined && <Check size={18}/>}</button>
            <button type="button" className="grok-card-row" disabled={busy} onClick={() => update('modelRef', null)}><span className="grok-row-label">{t('显式清空', 'Explicitly clear')}</span>{draft.modelRef === null && <Check size={18}/>}</button>
          </section>
          <div className="grok-model-sheet-search"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('搜索模型…', 'Search models…')}/></div>
          <section className="grok-card-group">
            {draft.modelRef && !catalog?.models.some(model => model.modelRef === draft.modelRef) && <p>{t('当前模型不在目录中', 'Current model not in catalog')}: {draft.modelRef}</p>}
            {catalog?.models.filter(model => !q || `${model.name} ${model.modelRef}`.toLowerCase().includes(q)).map(model => <button type="button" className="grok-card-row" key={model.modelRef} disabled={busy} onClick={() => update('modelRef', model.modelRef)}><span className="grok-row-label">{model.name} · {model.modelRef}</span>{draft.modelRef === model.modelRef && <Check size={18}/>}</button>)}
          </section>
          <label className="grok-section-label" htmlFor="bot-thinking-level">{t('思考档位', 'Thinking level')}</label>
          <select id="bot-thinking-level" className="grok-inline-select" disabled={busy} value={draft.thinkingLevel === undefined ? '__inherit' : draft.thinkingLevel === null ? '__null' : draft.thinkingLevel} onChange={e => update('thinkingLevel', e.target.value === '__inherit' ? undefined : e.target.value === '__null' ? null : e.target.value)}>
            <option value="__inherit">{t('继承全局', 'Inherit global')}</option><option value="__null">{t('显式清空', 'Explicitly clear')}</option>
            {draft.thinkingLevel && !levels.includes(draft.thinkingLevel) && <option value={draft.thinkingLevel}>{draft.thinkingLevel}</option>}
            {levels.map(level => <option key={level} value={level}>{level}</option>)}
          </select>
          <button type="button" className="grok-done-pill-btn" disabled={busy} onClick={() => void save()}>{t('保存', 'Save')}</button>
        </>}
        <ErrorNotice error={error}/>{notice && <p role="status">{notice}</p>}
      </div>
    </section>
  </div>;
}
