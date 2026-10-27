import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import Login from './pages/Login';
import Providers from './pages/Providers';
import Models from './pages/Models';
import Devices from './pages/Devices';
import Capabilities from './pages/Capabilities';
import Installation from './pages/Installation';
import BotCapabilities from './pages/BotCapabilities';

export default function App() {
  const [state, setState] = useState<'loading' | 'offline' | 'anonymous' | 'ready'>('loading');
  const refresh = useCallback(async () => {
    try { const session = await api.session(); setState(session.authenticated ? 'ready' : 'anonymous'); }
    catch { setState('offline'); }
  }, []);
  useEffect(() => {
    void refresh();
    const offline = () => setState('offline');
    const unauthenticated = () => { setState('anonymous'); void refresh(); };
    window.addEventListener('center-offline', offline);
    window.addEventListener('center-unauthenticated', unauthenticated);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { window.clearInterval(timer); window.removeEventListener('center-offline', offline); window.removeEventListener('center-unauthenticated', unauthenticated); };
  }, [refresh]);
  if (state === 'loading') return <main className="page"><p>正在连接中心…</p></main>;
  if (state === 'offline') return <main className="page"><h1>中心不可用</h1><p role="alert">无法连接中心，业务页面已关闭。</p><button className="button" onClick={() => void refresh()}>重试连接</button></main>;
  return <BrowserRouter>{state === 'anonymous' ? <Routes><Route path="/login" element={<Login />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes> : <div className="shell"><nav aria-label="中心管理"><Link to="/providers">服务商与模型</Link><Link to="/devices">设备与 Bot</Link><Link to="/capabilities">插件、MCP 与 Skill</Link><button className="quiet-button" onClick={() => void api.logout().then(refresh).catch(() => refresh())}>退出登录</button></nav><Routes><Route path="/login" element={<Navigate to="/providers" replace />} /><Route path="/providers" element={<Providers />} /><Route path="/providers/:providerId/models" element={<Models />} /><Route path="/devices" element={<Devices />} /><Route path="/capabilities" element={<Capabilities />} /><Route path="/capabilities/:installationId" element={<Installation />} /><Route path="/devices/:deviceId/bots/:botId/capabilities" element={<BotCapabilities />} /><Route path="*" element={<Navigate to="/providers" replace />} /></Routes></div>}</BrowserRouter>;
}
