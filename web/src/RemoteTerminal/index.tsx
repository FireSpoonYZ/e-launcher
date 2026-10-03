import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Monitor, ChevronRight, Plus, Ellipsis, RefreshCw, TerminalSquare, Folder, Check, Link2 } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { createRecovery, recoveryStops } from './recovery';
import { useNavigate } from 'react-router-dom';
import { Header, ErrorNotice, useAction, useText } from '../ui';
import { RemoteTerminal, request, type Host, type Profile, type Session } from './native';
import './terminal.css';
export { TerminalPage } from './TerminalView';

export function TerminalsPage() {
  const t = useText(); const nav = useNavigate(); const action = useAction();
  const [hosts,setHosts]=useState<Host[]>([]); const [hostId,setHostId]=useState(() => { try { return localStorage.getItem('terminal.selectedHost') || ''; } catch { return ''; } });
  const selectedHost = useRef(hostId); selectedHost.current = hostId;
  const [sessions,setSessions]=useState<Session[]>([]); const [profiles,setProfiles]=useState<Profile[]>([]);
  const [descriptor,setDescriptor]=useState(''); const [address,setAddress]=useState(''); const [deviceName,setDeviceName]=useState('');
  const [profileId,setProfileId]=useState(''); const [cwd,setCwd]=useState(''); const [executable,setExecutable]=useState('');
  const [connected,setConnected]=useState(false); const [confirm,setConfirm]=useState<{kind:'host'|'session';id:string}>();
  const [pairing,setPairing]=useState(false); const [creating,setCreating]=useState(false); const [hostMenu,setHostMenu]=useState(false);
  const [recovering,setRecovering]=useState(false);
  const retry=useRef<() => Promise<void>>(async () => {});
  const refreshHosts = async () => {
    const {hosts}=await RemoteTerminal.listHosts(); setHosts(hosts);
    setHostId(current => hosts.some(h => h.id === current) ? current : hosts[0]?.id || '');
  };
  const refresh = async (id: string, current: () => boolean = () => true) => {
    const [sessions,profiles]=await Promise.all([request<Session[]>(id,'terminal.list'),request<Profile[]>(id,'profiles.list')]);
    if (!current() || selectedHost.current !== id) return;
    setSessions(sessions); setProfiles(profiles); setProfileId(current => profiles.some(p => p.id === current) ? current : profiles.find(p => p.available)?.id || profiles[0]?.id || '');
  };
  useEffect(() => { void action.run(refreshHosts); }, []);
  useEffect(() => {
    let active=true; setConnected(false); setSessions([]); setProfiles([]);
    try { localStorage.setItem('terminal.selectedHost',hostId); } catch { /* Selection is optional, pairing remains native. */ }
    if(!hostId) return;
    let listener: Awaited<ReturnType<typeof RemoteTerminal.addListener>> | undefined;
    let appListener: Awaited<ReturnType<typeof CapacitorApp.addListener>> | undefined;
    const recovery=createRecovery(async current => {
      setRecovering(true);
      await RemoteTerminal.connect({hostId}); if(!current()) return;
      await refresh(hostId,current); if(!current()) return;
      setConnected(true); setRecovering(false); action.setError('');
    }, error => {
      setConnected(false); setRecovering(false);
      action.setError(recoveryStops(error) ? t('配对或证书无法验证，请在桌面检查。','Pairing or certificate could not be verified. Check the desktop.') : t('主机暂时不可用，正在重试。','Host unavailable; retrying.'));
    });
    retry.current=() => recovery.retry();
    void (async () => {
      listener=await RemoteTerminal.addListener('terminalEvent', event => {
        if(!active || event.hostId !== hostId) return;
        if(event.event === 'connection' && event.state === 'disconnected' && recoveryStops(event)) { recovery.stop(event); return; }
        if(event.event === 'connection' && event.state === 'disconnected') { setConnected(false); recovery.invalidate(); void recovery.wake(); }
        if(event.event === 'terminal.listChanged') { recovery.invalidate(); void recovery.wake(); }
      });
      if(!active) { await listener.remove(); return; }
      appListener=await CapacitorApp.addListener('appStateChange', state => {
        if(state.isActive) void recovery.resume(); else { recovery.pause(); setConnected(false); }
      });
      if(!active) { await appListener.remove(); return; }
      await recovery.wake();
    })().catch(error => { if(active) action.setError(String(error)); });
    return () => { active=false; recovery.dispose(); void listener?.remove(); void appListener?.remove(); };
  }, [hostId]);
  let addresses: string[]=[];
  try { const value=JSON.parse(descriptor); if(Array.isArray(value.addresses)) addresses=value.addresses.filter((v:unknown):v is string => typeof v === 'string'); } catch { /* Native validates the complete descriptor before pairing. */ }
  const selected = hosts.find(host => host.id === hostId);
  return <main className="rt-hosts"><Header title={t('远程终端','Remote terminals')} onBack={() => nav('/chat')} actions={<button className="icon-button" aria-label={t('配对新主机','Pair a new host')} onClick={() => setPairing(true)}><Plus/></button>}/>
    <ErrorNotice error={action.error}/>
    <section className="rt-host-section" aria-label={t('已配对电脑','Paired computers')}>
      <div className="rt-section-heading"><h2>{t('我的电脑','Computers')}</h2>{hostId && <button className="icon-button" aria-label={t('主机选项','Host options')} onClick={() => setHostMenu(true)}><Ellipsis/></button>}</div>
      <div className="rt-host-list">{hosts.map(host => <button className="rt-host-item" key={host.id} aria-pressed={hostId === host.id} onClick={() => setHostId(host.id)}><Monitor/><span><strong>{host.name}</strong><small>{host.address}:{host.port}</small><span className="rt-host-state"><i className="rt-status-dot" data-state={hostId === host.id ? connected ? 'connected' : recovering ? 'connecting' : 'offline' : 'saved'}/>{hostId !== host.id ? t('已保存 · 点击连接','Saved · tap to connect') : recovering ? t('正在连接…','Connecting…') : connected ? t('已连接','Connected') : t('离线','Offline')}</span></span>{hostId === host.id ? <Check/> : <ChevronRight/>}</button>)}</div>
      {!hosts.length && <div className="rt-empty"><Monitor size={32}/><h3>{t('先连接一台电脑','Connect your first computer')}</h3><p>{t('在 e-desktop 的「终端」中生成配对信息，再粘贴到这里。','Generate pairing info in e-desktop’s Terminal window, then paste it here.')}</p><button className="rt-primary" onClick={() => setPairing(true)}><Link2 size={18}/>{t('连接电脑','Pair a computer')}</button></div>}
    </section>
    <Dialog sheet className="rt-sheet" open={hostMenu} onOpenChange={setHostMenu} title={t('主机选项','Host options')}><div className="rt-menu"><button onClick={() => { setHostMenu(false); setPairing(true); }}>{t('配对新主机','Pair a new host')}</button><button className="rt-danger" onClick={() => { setHostMenu(false); setConfirm({kind:'host',id:hostId}); }}>{t('移除此主机','Remove host')}</button></div></Dialog>
    <Dialog sheet className="rt-sheet" open={pairing} onOpenChange={setPairing} title={t('配对新主机','Pair a new host')}><ErrorNotice error={action.error}/><form onSubmit={e => { e.preventDefault(); void action.run(async () => {
      const result=await RemoteTerminal.pair({descriptor,...(address.trim() ? {address:address.trim()} : {}),...(deviceName.trim() ? {deviceName:deviceName.trim()} : {})});
      setDescriptor(''); setAddress(''); await refreshHosts(); setHostId(result.host.id); setPairing(false);
    }); }}>
      <p>{t('仅通过可信渠道复制描述符；其中的证书指纹用于固定 TLS。配对码五分钟有效。','Copy the descriptor through a trusted channel. Its certificate fingerprint pins TLS. Pairing codes expire after five minutes.')}</p>
      <label>{t('配对信息','Pairing info')}<textarea required value={descriptor} onChange={e => setDescriptor(e.target.value)} autoCorrect="off" autoCapitalize="off"/></label>
      <details className="rt-advanced"><summary>{t('连接选项','Connection options')}</summary><label>{t('地址（可选覆盖）','Address (optional override)')}<input list="rt-addresses" value={address} onChange={e => setAddress(e.target.value)} autoCapitalize="off"/></label><datalist id="rt-addresses">{addresses.map(a => <option key={a} value={a}/>)}</datalist>
      <label>{t('设备名称','Device name')}<input value={deviceName} onChange={e => setDeviceName(e.target.value)} maxLength={100}/></label></details>
      <button className="rt-primary" disabled={action.busy} type="submit">{action.busy ? t('正在配对…','Pairing…') : t('连接电脑','Pair computer')}</button>
    </form></Dialog>
    {hostId && <section className="rt-sessions-section"><div className="rt-section-heading"><div><h2>{t('会话','Sessions')} <span className="rt-count">{sessions.length}</span></h2><p>{connected ? selected?.name : t('连接恢复后刷新会话','Sessions refresh after reconnecting')}</p></div><button className="rt-primary" disabled={!connected} aria-label={t('新建终端','New terminal')} onClick={() => setCreating(true)}><Plus size={18}/>{t('新建','New')}</button><button className="icon-button" disabled={recovering} aria-label={t('重新连接 / 刷新','Reconnect / refresh')} onClick={() => void retry.current()}><RefreshCw size={18} className={recovering ? 'spin' : ''}/></button></div>
      <div className="rt-session-list">{sessions.map(session => <div className="rt-session" key={session.id}><button onClick={() => nav('/terminals/'+encodeURIComponent(hostId)+'/'+encodeURIComponent(session.id))}><TerminalSquare className="rt-session-icon"/><span className="rt-session-copy"><strong>{session.title}</strong><span className="rt-session-path" title={session.cwd}><Folder size={13}/>{session.cwd}</span><small><i className="rt-status-dot" data-state={connected && session.status === 'running' ? 'connected' : 'offline'}/>{!connected ? t('上次状态','Last known') + ' · ' : ''}{session.status === 'running' ? t('运行中','Running') : t('已退出','Exited')}<span className="rt-meta-divider">·</span>{session.profileId}{session.ownerClientId ? t(' · 已有控制者',' · Controlled') : ''}</small></span><ChevronRight className="rt-session-chevron"/></button><button className="icon-button rt-session-menu" aria-label={session.status === 'exited' ? t('移除记录','Remove entry') : t('结束进程','Close process')} disabled={!connected} onClick={() => setConfirm({kind:'session',id:session.id})}><Ellipsis/></button></div>)}</div>
      {!sessions.length && <div className="rt-empty rt-empty-session"><TerminalSquare/><h3>{recovering ? t('正在读取会话','Loading sessions') : connected ? t('从一个终端开始','Start with a terminal') : t('等待电脑连接','Waiting for your computer')}</h3><p>{connected ? t('选择 Shell 和工作目录，继续在电脑上运行。','Choose a shell and working directory. It runs on your computer.') : t('检查电脑上的 e-desktop 是否正在运行。','Check that e-desktop is running on your computer.')}</p></div>}
      <p className="rt-lifetime-note">{t('离开页面不会结束电脑上的 Shell。','Leaving this page keeps your desktop shells running.')}</p>
      <Dialog sheet className="rt-sheet" open={creating} onOpenChange={setCreating} title={t('新建终端','New terminal')}><ErrorNotice error={action.error}/><form onSubmit={e => { e.preventDefault(); void action.run(async () => {
        const session=await request<Session>(hostId,'terminal.create',{profileId,...(cwd.trim()?{cwd:cwd.trim()}:{}),...(executable.trim()?{executable:executable.trim()}:{})});
        nav('/terminals/'+encodeURIComponent(hostId)+'/'+encodeURIComponent(session.id));
      }); }}>
        <label>Shell<select value={profileId} onChange={e => { setProfileId(e.target.value); setExecutable(''); }}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.available?'':t('（不可用）',' (unavailable)')}</option>)}</select></label>
        <p>{profiles.find(p => p.id === profileId)?.reason}</p>
        <label>{t('工作目录（可选）','Working directory (optional)')}<input value={cwd} onChange={e => setCwd(e.target.value)} autoCapitalize="off"/></label>
        {!profiles.find(p => p.id === profileId)?.available && <label>{t('Shell 可执行文件绝对路径','Absolute shell executable path')}<input required value={executable} onChange={e => setExecutable(e.target.value)} autoCapitalize="off"/></label>}
        <button className="rt-primary" disabled={!connected || !profileId || action.busy} type="submit">{action.busy ? t('正在创建…','Creating…') : t('创建终端','Create terminal')}</button>
      </form></Dialog>
    </section>}
    <Dialog sheet className="rt-sheet" open={!!confirm} onOpenChange={open => { if(!open) setConfirm(undefined); }} title={t('确认操作','Confirm action')}>{confirm && <><ErrorNotice error={action.error}/><p>{confirm.kind === 'session' ? t('关闭此会话？运行中的 Shell 将结束；已退出的会话将移除记录。仅离开页面不会关闭。','Close this session? Running shells will stop; exited entries will be removed. Leaving a view does not close it.') : t('移除本机配对？桌面会话继续运行。若要吊销令牌，请在桌面操作。','Remove this saved pairing? Desktop sessions keep running. Revoke the token on the desktop if needed.')}</p>
      <button className="rt-danger" onClick={() => void action.run(async () => { if(confirm.kind === 'session') { await request(hostId,'terminal.close',{sessionId:confirm.id}); await refresh(hostId); } else { await RemoteTerminal.removeHost({hostId:confirm.id}); setHostId(''); await refreshHosts(); } setConfirm(undefined); })}>{t('确认','Confirm')}</button><button onClick={() => setConfirm(undefined)}>{t('取消','Cancel')}</button></>}</Dialog>
  </main>;
}
