import { useEffect, useRef, useState } from 'react';
import { List, TerminalSquare } from 'lucide-react';
import { useText } from '../ui';
import { RemoteTerminal, request, type Session } from './native';
import { createSessionListLoader } from './session-navigation';

export function SessionTabs({hostId, session, sessionId, connected, navigate}: {hostId:string; session?:Session; sessionId:string; connected:boolean; navigate(path:string):void}) {
  const t = useText();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [failed, setFailed] = useState(false);
  const activeTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let listener: Awaited<ReturnType<typeof RemoteTerminal.addListener>> | undefined;
    const loader = createSessionListLoader(() => request<Session[]>(hostId,'terminal.list'), value => {setSessions(value); setFailed(false);}, () => setFailed(true));
    void (async () => {
      listener = await RemoteTerminal.addListener('terminalEvent', event => {
        if (event.hostId === hostId && event.event === 'terminal.listChanged') void loader.refresh();
      });
      if (disposed) {await listener.remove(); return;}
      await loader.refresh();
    })().catch(() => {if (!disposed) setFailed(true);});
    return () => {disposed = true; loader.dispose(); void listener?.remove();};
  }, [hostId, connected]);
  useEffect(() => {activeTab.current?.scrollIntoView({block:'nearest',inline:'nearest'});}, [sessionId,sessions]);
  const tabs = sessions.some(item => item.id === sessionId) ? sessions : session ? [session,...sessions] : sessions;
  return <nav className="rt-tabbar" aria-label={t('终端会话','Terminal sessions')}>
    <div className="rt-tabs">{tabs.map(item => <button key={item.id} ref={item.id === sessionId ? activeTab : undefined} className="rt-tab" aria-current={item.id === sessionId ? 'page' : undefined} title={item.title} onClick={() => {if (item.id !== sessionId) navigate('/terminals/'+encodeURIComponent(hostId)+'/'+encodeURIComponent(item.id));}}><TerminalSquare size={14}/><span>{item.title}</span></button>)}{!tabs.length && <span className="rt-tab-placeholder">{t('终端','Terminal')}</span>}</div>
    <button className="icon-button rt-tab-list" aria-label={failed ? t('会话列表未更新，返回列表重试','Session list unavailable; return to retry') : t('所有会话','All sessions')} onClick={() => navigate('/terminals')}><List size={20}/></button>
  </nav>;
}
