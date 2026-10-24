// M18 mobile（Tauri 辅助进程）入口：HashRouter 承载既有 HostPage；M20 新增“其他设备”远端页。
// 界面偏好只有 language/appearance，来自原生 uiSettings，不含 Pi 配置或凭据。
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
// 先于 styles.css 引入桌面样式：共用变量与元素重置仍以本机样式为准，桌面只有布局类生效；
// 本机页容器的排版基线在 mobile.css 里恢复（app.css 的元素规则是全局的）。
import '../../../desktop/web/src/app.css';
import { HostPage } from '../../../web/src/Host';
import { DesktopApp } from '../../../desktop/web/src/App';
import { ErrorNotice, LanguageOverride, errorText, useAction, useText } from '../../../web/src/ui';
import {
  mobileHide, mobileOpenLegacy, mobileReconnect, mobileUiSettings, onMobileStreamFailure,
  type MobileUiSettings,
} from '../../../web/src/native/tauri-host';
import { createMobileRemoteClient, type MobileRemoteClient } from './remote-client';
import '../../../web/src/styles.css';
import './mobile.css';

type LegacyTarget = 'chat' | 'settings' | 'host';
// host = 本机 Host 页；remote = 其他设备（desktop 面板复用同一 broker 语义）。
type View = 'host' | 'remote';

const applyUi = (ui: MobileUiSettings) => {
  document.documentElement.dataset.theme = ui.appearance;
  document.documentElement.lang = ui.language === 'system' ? navigator.language : ui.language;
};

function Toolbar({busy, view, hide, legacy, reconnect, openRemote, backToHost}: {
  busy: boolean; view: View; hide(): void; legacy(target: LegacyTarget): void;
  reconnect(): void; openRemote(): void; backToHost(): void;
}) {
  const t = useText();
  return <div className="mobile-toolbar">
    <button className="button secondary-button" onClick={hide}>{t('隐藏','Hide')}</button>
    <button className="button secondary-button" onClick={() => legacy('chat')}>{t('旧会话','Legacy chat')}</button>
    <button className="button secondary-button" onClick={() => legacy('settings')}>{t('设置','Settings')}</button>
    <button className="button secondary-button" onClick={() => legacy('host')}>{t('旧 Host 待确认','Legacy Host')}</button>
    <button className="button secondary-button" disabled={busy} onClick={reconnect}>{t('重连','Reconnect')}</button>
    <button className="button secondary-button" disabled={view === 'host'} onClick={backToHost}>{t('本机 Host','Local host')}</button>
    <button className="button secondary-button" disabled={view === 'remote'} onClick={openRemote}>{t('其他设备','Other device')}</button>
  </div>;
}

// 手机远端页容器：把“连接与设备”（配置/设备目录侧栏）折叠成一个按钮，聊天区拿到整屏高度。
// 只在显式连接且已选目标后自动收起；同一目标的重渲染不打断用户主动展开的面板。
function RemoteWorkspace({remote, active}: {remote: MobileRemoteClient; active: boolean}) {
  const t = useText();
  // 首次打开无目标：展开，用户才能选配置与设备。
  const [open, setOpen] = useState(true);
  // 上次自动收起时的目标：仅目标变化/首次有效目标才收，不做“每次通知都收”；
  // 无目标（断开/身份作废）时清空，重连后同一目标再次选回也算首次有效目标。
  const autoCollapsedFor = useRef<string | null>(null);
  useEffect(() => {
    const api = remote.api;
    const sync = () => {
      const identity = api.identity;
      const target = identity && api.transportConnected ? identity.targetDeviceId : '';
      // 无目标（未连接/relay 待选设备）或断开、身份作废：恢复展开，便于重连与选设备；
      // 同时清掉记录，断开/重连后再选回同一目标仍会自动收起。
      if (!target) {
        autoCollapsedFor.current = null;
        setOpen(true);
        return;
      }
      if (autoCollapsedFor.current === target) return;
      autoCollapsedFor.current = target;
      setOpen(false);
    };
    sync();
    return api.subscribe(sync);
  }, [remote]);
  // DesktopApp 不导出侧栏 id：只在手机容器内补一个，供按钮 aria-controls 指向（不改桌面结构）。
  useEffect(() => {
    const sidebar = document.querySelector('.remote-client .app-sidebar');
    if (sidebar && !sidebar.id) sidebar.id = 'remote-connection-panel';
  }, [remote, open]);
  return <div className="remote-client" hidden={!active} data-connection-panel={open ? 'open' : 'closed'}>
    <div className="remote-panel-bar">
      <button
        type="button"
        className="button secondary-button remote-panel-toggle"
        aria-expanded={open}
        aria-controls="remote-connection-panel"
        onClick={() => setOpen(value => !value)}
      >
        {open ? t('收起连接与设备', 'Hide connection & devices') : t('连接与设备', 'Connection & devices')}
      </button>
    </div>
    <DesktopApp api={remote.api} pageActive={active}/>
  </div>;
}

function MobileShell() {
  const [ui, setUi] = useState<MobileUiSettings>({language: 'system', appearance: 'system'});
  const [notice, setNotice] = useState('');
  // 只在显式重连成功后前进：HostPage 据此恢复只读能力，不重挂载、不丢草稿/设置。
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [view, setView] = useState<View>('host');
  // 远端 client 只在用户显式打开“其他设备”时创建；之后保持挂载（仅隐藏）以保留草稿与已选目标。
  const [remote, setRemote] = useState<MobileRemoteClient>();
  const remoteRef = useRef<MobileRemoteClient | undefined>(undefined);
  remoteRef.current = remote;
  const action = useAction();
  const hide = () => action.run(() => mobileHide());
  const legacy = (target: LegacyTarget) => action.run(() => mobileOpenLegacy(target));
  // 显式重连后只重读界面偏好：不重发观察/请求，也不恢复旧 UI 状态。
  // 点击即同步作废旧远端身份与观察（原生随后拆除旧会话）：失败也保持离线，不自动 connect/重放。
  const reconnect = () => {
    remoteRef.current?.invalidate();
    return action.run(async () => {
      await mobileReconnect();
      setConnectionEpoch(value => value + 1);
      const next = await mobileUiSettings();
      applyUi(next); setUi(next); setNotice('');
    });
  };
  const openRemote = () => {
    if (!remote) setRemote(createMobileRemoteClient());
    setView('remote');
  };
  // 切回本机：两个页面都保持挂载，可见性通过 active/pageActive 传给页面——
  // 不可见的一侧立即取消观察、停只读轮询，不停止任何 Host、不断开 client、不关 child。
  const backToHost = () => setView('host');
  useEffect(() => {
    let live = true;
    mobileUiSettings().then(next => {
      if (!live) return;
      applyUi(next); setUi(next);
    }, error => { if (live) setNotice(errorText(error)); });
    return () => { live = false; };
  }, []);
  // 事件流失败只显示错误：不自动重连、不重发观察，用户用工具栏“重连”显式恢复。
  useEffect(() => onMobileStreamFailure(error => setNotice(error.message)), []);
  // UI 自身回收时只移除本页的事件订阅；client child 由原生会话在 UI 关闭时清理。
  useEffect(() => () => { remoteRef.current?.dispose(); }, []);
  return <LanguageOverride.Provider value={ui.language}>
    <div className="mobile-shell">
      <Toolbar
        busy={action.busy}
        view={view}
        hide={() => void hide()}
        legacy={target => void legacy(target)}
        reconnect={() => void reconnect()}
        openRemote={openRemote}
        backToHost={backToHost}
      />
      {/* 两侧都保持挂载（仅隐藏）以保留草稿/选择；不可见一侧由 active 停止观察与轮询。 */}
      <div className="mobile-body" hidden={view !== 'host'}>
        <HostPage
          onBack={() => void hide()}
          persistentPending
          connectionEpoch={connectionEpoch}
          active={view === 'host'}
        />
      </div>
      {remote && <RemoteWorkspace remote={remote} active={view === 'remote'}/>}
      <ErrorNotice error={action.error || notice}/>
    </div>
  </LanguageOverride.Provider>;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}
createRoot(container).render(<HashRouter><MobileShell/></HashRouter>);
