import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, ExternalLink } from 'lucide-react';
import { GrokBotAvatar, JARVIS_AVATAR_PRESET } from '../../../web/src/GrokBotAvatar';
import { ErrorNotice, errorText, useText } from '../../../web/src/ui';
import './CenterGate.css';

type SavedConnection = { url: string; deviceId: string; ca: string };
export type CenterStatus = {
  state: 'disconnected' | 'connecting' | 'ready';
  centerUrl: string;
  clientId: string;
  savedConnection?: SavedConnection;
};
type Props = { children: ReactNode; onDisconnected(): void };

const request = <T,>(op: string, params: object = {}) =>
  invoke<T>('desktop_request', { request: { op, params } });

type CenterConnection = { status: CenterStatus | undefined; disconnectCenter: () => Promise<void> };
const CenterConnectionContext = createContext<CenterConnection>({ status: undefined, disconnectCenter: () => Promise.resolve() });

export function useCenterConnection(): CenterConnection {
  return useContext(CenterConnectionContext);
}

export type DesktopTheme = 'light' | 'dark' | 'system';

const readDesktopTheme = (): DesktopTheme => {
  const value = localStorage.getItem('desktop-theme');
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
};

const applyDesktopTheme = (theme: DesktopTheme) => {
  document.documentElement.dataset.theme = theme;
};

export function useDesktopTheme(): { theme: DesktopTheme; setTheme: (theme: DesktopTheme) => void } {
  const [theme, setThemeState] = useState<DesktopTheme>(readDesktopTheme);
  const setTheme = (next: DesktopTheme) => {
    localStorage.setItem('desktop-theme', next);
    applyDesktopTheme(next);
    setThemeState(next);
  };
  return { theme, setTheme };
}

export function CenterGate({ children, onDisconnected }: Props) {
  const t = useText();
  // 主题应用放在真实桌面入口挂载处：本模块会被 BotSettings -> openCenterManagement 间接导入，
  // 而 BotSettings 可被手机端引用，模块加载即写 data-theme 会污染移动端。
  useLayoutEffect(() => {
    applyDesktopTheme(readDesktopTheme());
  }, []);
  const [url, setUrl] = useState(() => localStorage.getItem('center-url') ?? '');
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('center-device-id') ?? '');
  const [token, setToken] = useState('');
  const [ca, setCa] = useState('');
  const [status, setStatus] = useState<CenterStatus>();
  const [saved, setSaved] = useState<SavedConnection>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const epoch = useRef(0);
  const autoAttempted = useRef(false);
  const wasReady = useRef(false);

  useEffect(() => {
    if (!url || !deviceId) {
      void request<{ state?: { profiles?: Array<{ kind?: string; url?: string; deviceId?: string; expectedDeviceId?: string }> } }>('ui_get')
        .then((snap) => {
          const profiles = snap?.state?.profiles ?? [];
          const relayProf = profiles.find((p) => p.kind === 'relay' && p.url && p.deviceId);
          const localProf = profiles.find((p) => p.kind === 'local' && p.expectedDeviceId);
          if (!url && relayProf?.url) {
            try {
              const u = new URL(relayProf.url);
              const centerOrigin = `${u.protocol === 'ws:' ? 'http:' : 'https:'}//${u.host}`;
              setUrl((prev) => prev || centerOrigin);
            } catch { /* ignore */ }
          }
          const fallbackDevId = relayProf?.deviceId || localProf?.expectedDeviceId || '';
          if (!deviceId && fallbackDevId) setDeviceId((prev) => prev || fallbackDevId);
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const issued = epoch.current;
      try {
        const next = await request<CenterStatus>('center_status');
        if (live && issued === epoch.current) {
          setStatus(next);
          setSaved(next.savedConnection);
          if (next.savedConnection && !autoAttempted.current) {
            const conn = next.savedConnection;
            setUrl((prev) => prev || conn.url);
            setDeviceId((prev) => prev || conn.deviceId);
            setCa((prev) => prev || conn.ca);
            if (next.state !== 'ready') {
              autoAttempted.current = true;
              const attempt = ++epoch.current;
              setBusy(true);
              try {
                const connected = await request<CenterStatus>('center_connect', {
                  url: conn.url,
                  deviceId: conn.deviceId,
                  deviceToken: '',
                  ...(conn.ca ? { ca: conn.ca } : {}),
                });
                if (live && attempt === epoch.current) {
                  localStorage.setItem('center-url', conn.url);
                  localStorage.setItem('center-device-id', conn.deviceId);
                  setStatus(connected);
                  setSaved(connected.savedConnection);
                }
              } catch (e) {
                if (live && attempt === epoch.current) {
                  setError(t('自动连接中心失败，请核对已保存凭据或重新输入令牌。', 'Auto-connect to the center failed. Check the saved credentials or re-enter the token.') + ' ' + errorText(e));
                }
              } finally {
                if (live && attempt === epoch.current) setBusy(false);
              }
            }
          }
        }
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

  const matchesSaved = Boolean(
    saved &&
    saved.url === url.trim() &&
    saved.deviceId === deviceId.trim() &&
    saved.ca === ca.trim(),
  );

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
      setSaved(next.savedConnection);
    } catch (e) {
      setStatus(undefined);
      setError(t('中心连接失败，请检查地址、设备身份、令牌与证书。', 'Failed to connect to the center. Check the address, device identity, token and certificate.') + ' ' + errorText(e));
    } finally {
      setToken('');
      setBusy(false);
    }
  };

  const disconnectCenter = async () => {
    epoch.current += 1;
    const next = await request<CenterStatus>('center_disconnect');
    setStatus(next);
    setSaved(next.savedConnection);
  };

  if (status?.state === 'ready') {
    return (
      <CenterConnectionContext.Provider value={{ status, disconnectCenter }}>
        {children}
      </CenterConnectionContext.Provider>
    );
  }

  const copyClientId = () => {
    if (!status?.clientId) return;
    void navigator.clipboard?.writeText(status.clientId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const connecting = busy || status?.state === 'connecting';

  return (
    <main className="desktop-shell gate-shell">
      <section className="gate-card">
        <div className="gate-hero">
          <GrokBotAvatar preset={JARVIS_AVATAR_PRESET} busy={connecting} size={72} />
          <h1>{t('连接 e-助手中心', 'Connect to e-Assistant Center')}</h1>
          <p className="gate-subtitle">{t('统一管理多端智能体、模型、插件与记忆', 'Manage agents, models, plugins and memory across devices')}</p>
        </div>
        {status?.clientId && (
          <div className="gate-client-id">
            <span className="gate-client-label">{t('本客户端标识', 'Client ID')}</span>
            <code>{status.clientId}</code>
            <button type="button" className="icon-button" onClick={copyClientId} title={t('复制', 'Copy')}>
              <Copy size={14} />
            </button>
            {copied && <span className="gate-copied">{t('已复制', 'Copied')}</span>}
          </div>
        )}
        <form className="gate-form" onSubmit={connect}>
          <label className="gate-field">
            <span>{t('中心 HTTPS 地址', 'Center HTTPS URL')}</span>
            <input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://center.example.com" />
          </label>
          <label className="gate-field">
            <span>{t('设备身份', 'Device identity')}</span>
            <input required value={deviceId} onChange={e => setDeviceId(e.target.value)} />
          </label>
          <label className="gate-field">
            <span>
              {t('设备令牌', 'Device token')}
              {matchesSaved && <em className="gate-saved-badge">{t('已保存，留空即可重连', 'Saved — leave blank to reconnect')}</em>}
            </span>
            <input
              required={!matchesSaved}
              type="password"
              autoComplete="off"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder={matchesSaved ? t('已保存凭据，留空使用已存令牌', 'Saved credentials — leave blank to reuse') : ''}
            />
          </label>
          <details className="gate-advanced">
            <summary>{t('高级 TLS / 自签 CA 证书（可选）', 'Advanced TLS / self-signed CA certificate (optional)')}</summary>
            <textarea value={ca} onChange={e => setCa(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" rows={4} />
          </details>
          <button disabled={busy} type="submit" className="primary-button gate-submit">
            {connecting ? t('连接中…', 'Connecting…') : t('连接中心', 'Connect')}
          </button>
        </form>
        <button
          type="button"
          className="secondary-button gate-manage"
          disabled={!url}
          onClick={() => void invoke('desktop_open_center', { url: url.trim() }).catch((e) => setError(t('无法打开中心管理页面。', 'Could not open the center management page.') + ' ' + errorText(e)))}
        >
          <ExternalLink size={14} />
          {t('在浏览器打开中心管理', 'Open center management in browser')}
        </button>
        <ErrorNotice error={error} onDismiss={() => setError('')} />
      </section>
    </main>
  );
}

export function openCenterManagement() {
  const url = localStorage.getItem('center-url');
  if (url) void invoke('desktop_open_center', { url });
}
