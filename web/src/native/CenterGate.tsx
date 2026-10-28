import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BotHost, openCenterUrl } from './index';
import { mobileClientRequest } from './tauri-host';

export type SavedConnection = { url: string; deviceId: string; ca: string };
export type CenterStatus = { state: 'disconnected' | 'connecting' | 'ready'; centerUrl: string; clientId?: string; savedConnection?: SavedConnection; savedConnectionError?: string };
export const ActiveCenter = createContext('');

export interface CenterConnectionContextValue {
  remoteClient: boolean;
  url: string;
  setUrl: (v: string) => void;
  deviceId: string;
  setDeviceId: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  hostToken: string;
  setHostToken: (v: string) => void;
  ca: string;
  setCa: (v: string) => void;
  status?: CenterStatus;
  saved?: SavedConnection;
  initialized: boolean;
  busy: boolean;
  preparing: boolean;
  connecting: boolean;
  ready: boolean;
  matchesSaved: boolean;
  error: string;
  setError: (v: string) => void;
  connect: (event?: FormEvent) => Promise<void>;
  disconnect: () => void;
  openManagement: () => void;
  stopLocalHost: () => void;
}

const defaultCenterContext: CenterConnectionContextValue = {
  remoteClient: false,
  url: '',
  setUrl: () => {},
  deviceId: '',
  setDeviceId: () => {},
  token: '',
  setToken: () => {},
  hostToken: '',
  setHostToken: () => {},
  ca: '',
  setCa: () => {},
  initialized: true,
  busy: false,
  preparing: false,
  connecting: false,
  ready: false,
  matchesSaved: false,
  error: '',
  setError: () => {},
  connect: async () => {},
  disconnect: () => {},
  openManagement: () => {},
  stopLocalHost: () => {},
};

export const CenterConnectionContext = createContext<CenterConnectionContextValue>(defaultCenterContext);
export const useCenterConnection = () => useContext(CenterConnectionContext);

export function CenterGate({ children, remoteClient = false, onDisconnected, onReady }: { children: ReactNode; remoteClient?: boolean; onDisconnected?: () => void; onReady?: (centerUrl: string) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('center-client-device-id') ?? '');
  const [token, setToken] = useState('');
  const [hostToken, setHostToken] = useState('');
  const [ca, setCa] = useState('');
  const [status, setStatus] = useState<CenterStatus>();
  const [saved, setSaved] = useState<SavedConnection>();
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const autoAttempted = useRef(false);
  const autoConnection = useRef<Promise<CenterStatus> | null>(null);
  const wasReady = useRef(false);
  const [error, setError] = useState('');
  const [preparedCenter, setPreparedCenter] = useState('');
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    if (!remoteClient) {
      setInitialized(true);
      void BotHost.centerSettings().then(value => {
        if (live) { setUrl(value.url); setCa(value.ca); }
      }).catch(() => { if (live) setError('无法读取中心连接设置'); });
      const pollHost = async () => {
        const issued = epoch.current;
        try {
          const next = (await BotHost.status()).center;
          if (live && issued === epoch.current) setStatus(next);
        } catch {
          if (live && issued === epoch.current) setStatus(undefined);
        }
        if (live) timer = setTimeout(pollHost, 1000);
      };
      void pollHost();
      return () => { live = false; epoch.current += 1; clearTimeout(timer); };
    }
    const updateStatus = (next: CenterStatus) => {
      setStatus(next);
      setSaved(next.savedConnection);
      if (next.savedConnectionError) setError(next.savedConnectionError);
    };
    const readStatus = () => mobileClientRequest<CenterStatus>('center_status', {});
    const poll = async () => {
      const issued = epoch.current;
      try {
        const next = await readStatus();
        if (live && issued === epoch.current) updateStatus(next);
      } catch {
        if (live && issued === epoch.current) setStatus(undefined);
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    const initialize = async () => {
      const issued = epoch.current;
      try {
        const value = await BotHost.centerSettings();
        if (!live || issued !== epoch.current) return;
        setUrl(localStorage.getItem('active-center-url') ?? value.url);
        setCa(value.ca);
      } catch {
        if (live && issued === epoch.current) setError('无法读取中心连接设置');
      }
      if (!live || issued !== epoch.current) return;
      try {
        const next = await readStatus();
        if (!live || issued !== epoch.current) return;
        updateStatus(next);
        if (next.savedConnection) {
          const connection = next.savedConnection;
          setUrl(connection.url);
          setDeviceId(connection.deviceId);
          setCa(connection.ca);
          if (next.state !== 'ready' && !autoAttempted.current) {
            autoAttempted.current = true;
            autoConnection.current = mobileClientRequest<CenterStatus>('center_connect', {
              url: connection.url, deviceId: connection.deviceId, deviceToken: '',
              ...(connection.ca ? { ca: connection.ca } : {}),
            });
          }
          if (autoConnection.current && next.state !== 'ready') {
            const attempt = ++epoch.current;
            setBusy(true);
            try {
              const connected = await autoConnection.current;
              if (live && attempt === epoch.current) updateStatus(connected);
            } catch (failure) {
              if (live && attempt === epoch.current) setError(failure instanceof Error ? failure.message : '自动连接失败，请重试。');
            } finally {
              if (live && attempt === epoch.current) setBusy(false);
            }
          }
        }
      } catch {
        if (live && issued === epoch.current) setError('无法读取中心连接状态');
      }
      if (live) {
        setBusy(false);
        setInitialized(true);
        timer = setTimeout(poll, 1000);
      }
    };
    void initialize();
    return () => { live = false; epoch.current += 1; clearTimeout(timer); };
  }, [remoteClient]);

  useEffect(() => {
    if (wasReady.current && status?.state !== 'ready') onDisconnected?.();
    wasReady.current = status?.state === 'ready';
  }, [status, onDisconnected]);

  useEffect(() => {
    let live = true;
    setPreparedCenter('');
    if (status?.state !== 'ready' || !onReady) { setPreparing(false); return; }
    setPreparing(true);
    onReady(status.centerUrl).then(() => {
      if (live) { setPreparedCenter(status.centerUrl); setError(''); }
    }, failure => {
      if (live) setError(failure instanceof Error ? failure.message : '设备连接初始化失败，请重试');
    }).finally(() => { if (live) setPreparing(false); });
    return () => { live = false; };
  }, [status?.state, status?.centerUrl, onReady]);

  const connect = async (event?: FormEvent) => {
    event?.preventDefault();
    const issued = ++epoch.current;
    setBusy(true);
    setError('');
    setPreparedCenter('');
    setStatus(undefined);
    onDisconnected?.();
    try {
      if (!remoteClient || hostToken.trim()) {
        const snapshot = await BotHost.snapshot();
        if (snapshot.phase === 'running' || snapshot.phase === 'starting') {
          throw new Error('Host 正在运行；如需修改连接，请先停止 Host。');
        }
        await BotHost.saveCenterSettings({ input: {
          url: url.trim(), deviceToken: remoteClient ? hostToken.trim() : token.trim(), ca: ca.trim(),
        } });
      }
      if (remoteClient) {
        const next = await mobileClientRequest<CenterStatus>('center_connect', {
          url: url.trim(), deviceId: deviceId.trim(), deviceToken: token.trim(),
          ...(ca.trim() ? { ca: ca.trim() } : {}),
        });
        if (issued !== epoch.current) return;
        localStorage.setItem('center-client-device-id', deviceId.trim());
        localStorage.setItem('active-center-url', url.trim());
        setSaved(next.savedConnection);
        setStatus(next);
      } else {
        await BotHost.start();
      }
    } catch (failure) {
      if (issued === epoch.current) setError(failure instanceof Error ? failure.message : '连接失败，请检查中心设置。');
    } finally {
      if (issued === epoch.current) {
        setToken('');
        setHostToken('');
        setBusy(false);
      }
    }
  };

  const matchesSaved = Boolean(saved && saved.url === url.trim() && saved.deviceId === deviceId.trim() && saved.ca === ca.trim());
  const disconnect = () => {
    const issued = ++epoch.current;
    setBusy(true);
    setError('');
    const request = remoteClient ? mobileClientRequest<CenterStatus>('center_disconnect', {}) : BotHost.stop().then(() => undefined);
    void request.then(next => {
      if (issued !== epoch.current) return;
      setSaved(undefined);
      setStatus(next);
    }).catch(failure => {
      if (issued === epoch.current) setError(failure instanceof Error ? failure.message : '断开连接失败，请重试。');
    }).finally(() => { if (issued === epoch.current) setBusy(false); });
  };

  const openManagement = () => {
    if (!url.trim()) return;
    void openCenterUrl(url.trim()).catch(() => setError('无法打开中心管理页面'));
  };

  const stopLocalHost = () => {
    void BotHost.stop().catch(failure => {
      setError(failure instanceof Error ? failure.message : '停止本机 Host 失败');
    });
  };

  const ready = Boolean(status?.state === 'ready' && (!onReady || preparedCenter === status.centerUrl));
  const connecting = Boolean(!initialized || busy || preparing || status?.state === 'connecting');
  const activeCenterUrl = ready && status ? status.centerUrl : '';

  const contextValue: CenterConnectionContextValue = {
    remoteClient,
    url,
    setUrl,
    deviceId,
    setDeviceId,
    token,
    setToken,
    hostToken,
    setHostToken,
    ca,
    setCa,
    status,
    saved,
    initialized,
    busy,
    preparing,
    connecting,
    ready,
    matchesSaved,
    error,
    setError,
    connect,
    disconnect,
    openManagement,
    stopLocalHost,
  };

  return (
    <CenterConnectionContext.Provider value={contextValue}>
      <ActiveCenter.Provider value={activeCenterUrl}>
        {children}
      </ActiveCenter.Provider>
    </CenterConnectionContext.Provider>
  );
}
