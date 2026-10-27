import { createContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BotHost, openCenterUrl } from './index';
import { mobileClientRequest } from './tauri-host';

type Status = { state: 'disconnected' | 'connecting' | 'ready'; centerUrl: string; clientId?: string };
export const ActiveCenter = createContext('');

export function CenterGate({ children, remoteClient = false, onDisconnected, onReady }: { children: ReactNode; remoteClient?: boolean; onDisconnected?: () => void; onReady?: (centerUrl: string) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('center-client-device-id') ?? '');
  const [token, setToken] = useState('');
  const [hostToken, setHostToken] = useState('');
  const [ca, setCa] = useState('');
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const wasReady = useRef(false);
  const [error, setError] = useState('');
  const [preparedCenter, setPreparedCenter] = useState('');
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    let live = true;
    void BotHost.centerSettings().then(value => {
      if (live) { setUrl(remoteClient ? localStorage.getItem('active-center-url') ?? value.url : value.url); setCa(value.ca); }
    }).catch(() => { if (live) setError('无法读取中心连接设置'); });
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const issued = epoch.current;
      try {
        const next = remoteClient
          ? await mobileClientRequest<Status>('center_status', {})
          : (await BotHost.status()).center;
        if (live && issued === epoch.current) setStatus(next);
      } catch {
        if (live && issued === epoch.current) setStatus(undefined);
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
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

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    epoch.current += 1;
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
        const next = await mobileClientRequest<Status>('center_connect', {
          url: url.trim(), deviceId: deviceId.trim(), deviceToken: token.trim(),
          ...(ca.trim() ? { ca: ca.trim() } : {}),
        });
        localStorage.setItem('center-client-device-id', deviceId.trim());
        localStorage.setItem('active-center-url', url.trim());
        setStatus(next);
      } else {
        await BotHost.start();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '连接失败，请检查中心设置。');
    } finally {
      setToken('');
      setHostToken('');
      setBusy(false);
    }
  };

  if (status?.state === 'ready' && (!onReady || preparedCenter === status.centerUrl)) return <><button type="button" onClick={() => {
    epoch.current += 1;
    if (remoteClient) void mobileClientRequest<Status>('center_disconnect', {}).then(setStatus);
    else void BotHost.stop().then(() => setStatus(undefined));
  }}>更换中心连接</button><ActiveCenter.Provider value={status.centerUrl}>{children}</ActiveCenter.Provider></>;
  return <main className="page">
    <h1>连接中心</h1>
    <p>连接中心后才能使用助手。请先登记设备并获取设备令牌。</p>
    {remoteClient && status?.clientId && <p>本客户端标识：{status.clientId}</p>}
    <form className="form" onSubmit={connect}>
      <label>中心 HTTPS 地址<input required type="url" value={url} onChange={e => setUrl(e.target.value)} /></label>
      {remoteClient && <label>客户端设备身份<input required value={deviceId} onChange={e => setDeviceId(e.target.value)} /></label>}
      <label>{remoteClient ? '客户端设备令牌' : '本机 Host 设备令牌'}<input type="password" autoComplete="off" required={remoteClient} value={token} onChange={e => setToken(e.target.value)} placeholder={remoteClient ? "仅本次连接使用，不保存" : "已保存时可留空"} /></label>
      {remoteClient && <label>本机 Host 设备令牌（可选，仅在配置本机 Host 时填写）<input type="password" autoComplete="off" value={hostToken} onChange={e => setHostToken(e.target.value)} /></label>}
      <label>CA 证书（可选）<textarea value={ca} onChange={e => setCa(e.target.value)} /></label>
      <button className="button" disabled={busy || preparing} type="submit">{busy || preparing ? '连接设备中…' : '连接 / 重试'}</button>
    </form>
    <button className="button secondary-button" disabled={!url} onClick={() => void openCenterUrl(url.trim()).catch(() => setError('无法打开中心管理页面'))}>打开中心管理 / 登录</button>
    <button className="button secondary-button" onClick={() => void BotHost.stop()}>停止本机 Host 以修改连接</button>
    {error && <p role="alert">{error}</p>}
  </main>;
}
