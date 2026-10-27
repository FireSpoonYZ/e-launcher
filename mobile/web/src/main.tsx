// Android Tauri 主界面入口：统一承载极简 Bot Hub（置顶主 Bot + 本机/远程统一 Bot 列表 + 左右隐藏侧边栏）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopClientStatus } from '../../../host-core/desktop-client';
import { HashRouter } from 'react-router-dom';
import { HostPage } from '../../../web/src/Host';
import { CenterGate } from '../../../web/src/native/CenterGate';
import { ErrorNotice, LanguageOverride, errorText } from '../../../web/src/ui';
import {
  mobileHide,
  mobileOpenLegacy,
  mobileUiSettings,
  mobileClientRequest,
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

  const centerDisconnected = useCallback(() => { remoteRef.current?.invalidate(); }, []);

  const getOrCreateRemoteClient = useCallback(() => {
    if (!remoteRef.current) {
      remoteRef.current = createMobileRemoteClient();
    }
    return remoteRef.current;
  }, []);

  const centerReady = useCallback(async (centerUrl: string) => {
    const client = getOrCreateRemoteClient();
    client.invalidate();
    const status = await mobileClientRequest<DesktopClientStatus>('status', {});
    const connection = status.connection;
    if (status.phase !== 'connected' || connection?.kind !== 'relay') {
      throw new Error('中心已认证，但设备中继未连接，请重新连接中心。');
    }
    const api = client.api;
    let snapshot = await api.init();
    let profile = snapshot.state.profiles.find(p => p.kind === 'relay' &&
      p.url === connection.url && p.deviceId === connection.deviceId);
    if (!profile) {
      const next = { id: crypto.randomUUID(), title: new URL(centerUrl).host,
        kind: 'relay' as const, url: connection.url, deviceId: connection.deviceId };
      snapshot = await api.queueWrite(state => ({ ...state, profiles: [...state.profiles, next] }));
      profile = snapshot.state.profiles.find(p => p.id === next.id)!;
    }
    const latest = await mobileClientRequest<DesktopClientStatus>('status', {});
    if (latest.generation !== status.generation || latest.phase !== 'connected') {
      throw new Error('设备连接已变化，请重新连接中心。');
    }
    api.setIdentity({ profileId: profile.id, targetDeviceId: '', kind: 'relay' });
    api.setTransportConnected(true);
  }, [getOrCreateRemoteClient]);

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
          <CenterGate remoteClient onDisconnected={centerDisconnected} onReady={centerReady}><HostPage
            onBack={() => void mobileHide()}
            persistentPending
            connectionEpoch={connectionEpoch}
            active
            getOrCreateRemoteClient={getOrCreateRemoteClient}
            onOpenSystemSettings={() => void mobileOpenLegacy('settings')}
          /></CenterGate>
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
