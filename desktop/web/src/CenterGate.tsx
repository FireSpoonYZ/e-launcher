import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';

type CenterStatus = { state: 'disconnected' | 'connecting' | 'ready'; centerUrl: string; clientId: string };
type Props = { children: ReactNode; onDisconnected(): void };

const request = <T,>(op: string, params: object = {}) =>
  invoke<T>('desktop_request', { request: { op, params } });

export function CenterGate({ children, onDisconnected }: Props) {
  const [url, setUrl] = useState(() => localStorage.getItem('center-url') ?? '');
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('center-device-id') ?? '');
  const [token, setToken] = useState('');
  const [ca, setCa] = useState('');
  const [status, setStatus] = useState<CenterStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const wasReady = useRef(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const issued = epoch.current;
      try {
        const next = await request<CenterStatus>('center_status');
        if (live && issued === epoch.current) setStatus(next);
      } catch {
        if (live && issued === epoch.current) setStatus(undefined);
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (wasReady.current && status?.state !== 'ready') onDisconnected();
    wasReady.current = status?.state === 'ready';
  }, [status, onDisconnected]);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    epoch.current += 1;
    setBusy(true);
    setError('');
    try {
      const next = await request<CenterStatus>('center_connect', {
        url: url.trim(), deviceId: deviceId.trim(), deviceToken: token.trim(),
        ...(ca.trim() ? { ca: ca.trim() } : {}),
      });
      localStorage.setItem('center-url', url.trim());
      localStorage.setItem('center-device-id', deviceId.trim());
      setStatus(next);
    } catch {
      setStatus(undefined);
      setError('中心连接失败，请检查地址、设备身份、令牌与证书。');
    } finally {
      setToken('');
      setBusy(false);
    }
  };

  if (status?.state === 'ready') return <><button type="button" onClick={() => { epoch.current += 1; void request<CenterStatus>('center_disconnect').then(setStatus); }}>更换中心连接</button>{children}</>;
  return <main className="desktop-shell error-shell">
    <h1>连接中心</h1>
    <p>请先在中心登记客户端设备并输入其设备身份和令牌。</p>
    {status?.clientId && <p>本客户端标识：{status.clientId}</p>}
    <form onSubmit={connect}>
      <label>中心 HTTPS 地址<input required type="url" value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label>设备身份<input required value={deviceId} onChange={e => setDeviceId(e.target.value)} /></label>
      <label>设备令牌<input required type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label>
      <label>CA 证书（可选）<textarea value={ca} onChange={e => setCa(e.target.value)} /></label>
      <button disabled={busy} type="submit">{busy ? '连接中…' : '连接 / 重试'}</button>
    </form>
    <button disabled={!url} onClick={() => void invoke('desktop_open_center', { url: url.trim() }).catch(() => setError('无法打开中心管理页面。'))}>打开中心管理 / 登录</button>
    {error && <p role="alert">{error}</p>}
  </main>;
}

export function openCenterManagement() {
  const url = localStorage.getItem('center-url');
  if (url) void invoke('desktop_open_center', { url });
}
