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
  mobileLocalRequest,
  mobileUiSettings,
  mobileClientRequest,
  mobileReconnect,
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
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [adoptEpoch, setAdoptEpoch] = useState(0);
  const adopting = useRef(false);
  const scheduleAdopt = useRef<() => void>(() => {});
  const unsubscribeRemote = useRef<(() => void) | undefined>(undefined);
  const remoteRef = useRef<MobileRemoteClient | undefined>(undefined);

  const centerDisconnected = useCallback(() => { remoteRef.current?.invalidate(); }, []);

  const getOrCreateRemoteClient = useCallback(() => {
    if (!remoteRef.current) {
      remoteRef.current = createMobileRemoteClient();
      const api = remoteRef.current.api;
      unsubscribeRemote.current = api.subscribe(() => { if (!api.transportConnected && !adopting.current) scheduleAdopt.current(); });
    }
    return remoteRef.current;
  }, []);

  const centerReady = useCallback(async (centerUrl: string) => {
    if (adopting.current) throw Object.assign(new Error('正在恢复设备连接。'), { code: 'RPC_BUSY' });
    adopting.current = true;
    let adopted = false;
    try {
      const client = getOrCreateRemoteClient();
      client.invalidate();
      const status = await mobileClientRequest<DesktopClientStatus>('status', {});
      const connection = status.connection;
      if (status.phase !== 'connected' || connection?.kind !== 'relay') {
        throw Object.assign(new Error('中心已认证，但设备中继正在恢复。'), { code: 'NOT_CONNECTED' });
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
        throw Object.assign(new Error('设备连接已变化，正在恢复。'), { code: 'NOT_CONNECTED' });
      }
      api.setIdentity({ profileId: profile.id, targetDeviceId: '', kind: 'relay' });
      api.setTransportConnected(true);
      adopted = true;
      setNotice('');
    } finally {
      adopting.current = false;
      if (adopted && remoteRef.current && !remoteRef.current.api.transportConnected) scheduleAdopt.current();
    }
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

  useEffect(() => {
    let live = true;
    let recovering = false;
    let failedAgain = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recover = () => {
      if (!live) return;
      if (recovering) { failedAgain = true; return; }
      recovering = true;
      setNotice('正在重连…');
      let delay = 500;
      const attempt = async () => {
        try {
          failedAgain = false;
          const result = await mobileReconnect();
          if (!result.connected || failedAgain) throw new Error('IPC unavailable');
          if (!live) return;
          recovering = false;
          setConnectionEpoch(value => value + 1);
        } catch {
          if (!live) return;
          timer = setTimeout(attempt, delay);
          delay = Math.min(delay * 2, 10000);
        }
      };
      void attempt();
    };
    const stop = onMobileStreamFailure(recover);
    return () => { live = false; stop(); if (timer) clearTimeout(timer); };
  }, []);
  useEffect(() => {
    let live = true;
    let scheduled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (!live || scheduled || adopting.current || !remoteRef.current || remoteRef.current.api.transportConnected) return;
      scheduled = true;
      timer = setTimeout(async () => {
        try {
          const center = await mobileClientRequest<{ state: string }>('center_status', {});
          const broker = await mobileClientRequest<DesktopClientStatus>('status', {});
          if (live && !adopting.current && !remoteRef.current?.api.transportConnected && center.state === 'ready' && broker.phase === 'connected') {
            setAdoptEpoch(value => value + 1);
          }
        } catch { /* IPC reconnect has its own retry loop */ }
        finally { scheduled = false; }
      }, 2000);
    };
    scheduleAdopt.current = check;
    const foreground = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', foreground);
    check();
    return () => { live = false; scheduleAdopt.current = () => {}; document.removeEventListener('visibilitychange', foreground); if (timer) clearTimeout(timer); };
  }, []);
  useEffect(() => () => { unsubscribeRemote.current?.(); remoteRef.current?.dispose(); }, []);

  return (
    <LanguageOverride.Provider value={ui.language}>
      <div className="mobile-shell">
        <div className="mobile-body">
          <CenterGate onDisconnected={centerDisconnected} onReady={centerReady} recoveryEpoch={connectionEpoch + adoptEpoch}><HostPage
            onBack={() => void mobileHide()}
            persistentPending
            connectionEpoch={connectionEpoch}
            active
            getOrCreateRemoteClient={getOrCreateRemoteClient}
            onOpenSystemSettings={() => void mobileLocalRequest('openSystemSettings').catch(error => setNotice(errorText(error)))}
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
