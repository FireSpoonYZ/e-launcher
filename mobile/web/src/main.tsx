// Android Tauri 主界面入口：统一承载极简 Bot Hub（置顶主 Bot + 本机/远程统一 Bot 列表 + 左右隐藏侧边栏）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { HostPage } from '../../../web/src/Host';
import { ErrorNotice, LanguageOverride, errorText } from '../../../web/src/ui';
import {
  mobileHide,
  mobileOpenLegacy,
  mobileUiSettings,
  onMobileStreamFailure,
  type MobileUiSettings,
} from '../../../web/src/native/tauri-host';
import { createMobileRemoteClient, type MobileRemoteClient } from './remote-client';
import '../../../web/src/styles.css';
import './mobile.css';

const applyUi = (ui: MobileUiSettings) => {
  document.documentElement.dataset.theme = ui.appearance;
  document.documentElement.lang = ui.language === 'system' ? navigator.language : ui.language;
};

function MobileShell() {
  const [ui, setUi] = useState<MobileUiSettings>({ language: 'system', appearance: 'system' });
  const [notice, setNotice] = useState('');
  const [connectionEpoch] = useState(0);
  const remoteRef = useRef<MobileRemoteClient | undefined>(undefined);

  const getOrCreateRemoteClient = useCallback(() => {
    if (!remoteRef.current) {
      remoteRef.current = createMobileRemoteClient();
    }
    return remoteRef.current;
  }, []);

  useEffect(() => {
    let live = true;
    mobileUiSettings().then(
      next => {
        if (!live) return;
        applyUi(next);
        setUi(next);
      },
      error => {
        if (live) setNotice(errorText(error));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => onMobileStreamFailure(error => setNotice(error.message)), []);
  useEffect(() => () => { remoteRef.current?.dispose(); }, []);

  return (
    <LanguageOverride.Provider value={ui.language}>
      <div className="mobile-shell">
        <div className="mobile-body">
          <HostPage
            onBack={() => void mobileHide()}
            persistentPending
            connectionEpoch={connectionEpoch}
            active
            getOrCreateRemoteClient={getOrCreateRemoteClient}
            onOpenSystemSettings={() => void mobileOpenLegacy('settings')}
          />
        </div>
        <ErrorNotice error={notice} />
      </div>
    </LanguageOverride.Provider>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}
createRoot(container).render(
  <HashRouter>
    <MobileShell />
  </HashRouter>,
);
