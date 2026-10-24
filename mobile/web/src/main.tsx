// M18 mobile（Tauri 辅助进程）入口：HashRouter 承载既有 HostPage；不调用任何 Capacitor 插件。
// 界面偏好只有 language/appearance，来自原生 uiSettings，不含 Pi 配置或凭据。
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { HostPage } from '../../../web/src/Host';
import { ErrorNotice, LanguageOverride, errorText, useAction, useText } from '../../../web/src/ui';
import { mobileHide, mobileOpenLegacy, mobileReconnect, mobileUiSettings, onMobileStreamFailure, type MobileUiSettings } from '../../../web/src/native/tauri-host';
import '../../../web/src/styles.css';
import './mobile.css';

type LegacyTarget = 'chat' | 'settings' | 'host';

const applyUi = (ui: MobileUiSettings) => {
  document.documentElement.dataset.theme = ui.appearance;
  document.documentElement.lang = ui.language === 'system' ? navigator.language : ui.language;
};

function Toolbar({busy, hide, legacy, reconnect}: {busy: boolean; hide(): void; legacy(target: LegacyTarget): void; reconnect(): void}) {
  const t = useText();
  return <div className="mobile-toolbar">
    <button className="button secondary-button" onClick={hide}>{t('隐藏','Hide')}</button>
    <button className="button secondary-button" onClick={() => legacy('chat')}>{t('旧会话','Legacy chat')}</button>
    <button className="button secondary-button" onClick={() => legacy('settings')}>{t('设置','Settings')}</button>
    <button className="button secondary-button" onClick={() => legacy('host')}>{t('旧 Host 待确认','Legacy Host')}</button>
    <button className="button secondary-button" disabled={busy} onClick={reconnect}>{t('重连','Reconnect')}</button>
  </div>;
}

function MobileShell() {
  const [ui, setUi] = useState<MobileUiSettings>({language: 'system', appearance: 'system'});
  const [notice, setNotice] = useState('');
  // 只在显式重连成功后前进：HostPage 据此恢复只读能力，不重挂载、不丢草稿/设置。
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const action = useAction();
  const hide = () => action.run(() => mobileHide());
  const legacy = (target: LegacyTarget) => action.run(() => mobileOpenLegacy(target));
  // 显式重连后只重读界面偏好：不重发观察/请求，也不恢复旧 UI 状态。
  const reconnect = () => action.run(async () => {
    await mobileReconnect();
    setConnectionEpoch(value => value + 1);
    const next = await mobileUiSettings();
    applyUi(next); setUi(next); setNotice('');
  });
  useEffect(() => {
    let live = true;
    mobileUiSettings().then(next => {
      if (!live) return;
      applyUi(next); setUi(next);
    }, error => { if (live) setNotice(errorText(error)); });
    return () => { live = false; };
  }, []);
  // 事件流失败只显示错误：不自动重连、不重发观察，用户用工具栏“重连”显式恢复。
  useEffect(() => onMobileStreamFailure(error => setNotice(error.message)), []);
  return <LanguageOverride.Provider value={ui.language}>
    <div className="mobile-shell">
      <Toolbar busy={action.busy} hide={() => void hide()} legacy={target => void legacy(target)} reconnect={() => void reconnect()}/>
      <div className="mobile-body"><HostPage onBack={() => void hide()} persistentPending connectionEpoch={connectionEpoch}/></div>
      <ErrorNotice error={action.error || notice}/>
    </div>
  </LanguageOverride.Provider>;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}
createRoot(container).render(<HashRouter><MobileShell/></HashRouter>);
