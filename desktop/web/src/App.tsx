// Module 17 desktop 应用装配（core-owned，stage1 修正）：连接管理、设备目录、
// 导航与面板渲染。token/CA 仅输入态存在，连接尝试结束后立即清空。
import { Component } from 'react';
import type { ReactNode } from 'react';
import { DesktopRemoteError, toError } from './api';
import type {
  DesktopClientStatus,
  DesktopConnectionInput,
  DesktopUiProfile,
} from '../../../host-core/desktop-client.js';
import type { DevicesDirectoryItem } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { PendingPanel } from './PendingPanel';
import { SettingsPanel } from './SettingsPanel';
import { BotChats } from './BotChats';
import { Scopes } from './Scopes';
import { CenterGate, openCenterManagement } from './CenterGate';
import { targetApi } from './targetApi';
import type { DesktopViewApi } from './types';

interface ProfileFormState {
  title: string;
  kind: 'local' | 'relay';
  url: string;
  expectedDeviceId: string;
  deviceId: string;
}

interface AppState {
  busy: boolean;
  profiles: DesktopUiProfile[];
  profilesError: string | null;
  selectedProfileId: string | null;
  status: DesktopClientStatus | null;
  /** 不可变快照：与 api 可变 getter 分离，供子面板按 props 旧值检测变化。 */
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  view: 'chat' | 'scopes' | 'pending' | 'settings';
  token: string;
  ca: string;
  form: ProfileFormState;
  globalError: string | null;
  bannerError: string | null;
  sidebarCollapsed: boolean;
  selectedDeviceId: string;
}

interface AppProps {
  api: DesktopPanelApi;
  /** false = 页面不可见（手机切回本机页）：停止面板观察/只读轮询，不断连、不释放会话。 */
  pageActive?: boolean;
}

function runId(): string {
  return `p-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 实际连接状态统一口径：transport 已断开/身份已作废时，缓存的 connected 不得再当在线。
 * connecting 仍是当前正在连接，failed 指上次连接失败；纯展示，不新增 broker 调用、不自动重连。 */
function phaseText(status: DesktopClientStatus | null, transportConnected: boolean): string {
  if (!status) return '未连接';
  if (status.phase === 'connecting') return '连接中';
  if (status.phase === 'failed') return '连接失败';
  return status.phase === 'connected' && transportConnected ? '已连接' : '未连接';
}

interface DevicesSectionState {
  items: DevicesDirectoryItem[];
  nextCursor: { afterDeviceId: string } | null;
  error: string | null;
  busy: boolean;
  /** 成功读取过目录的时间；仅用于展示，失败/加载中不得冒充为空目录。 */
  loadedAt: string | null;
  loaded: boolean;
}

interface DevicesSectionProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  lastObservedAt: string | null;
  selectedDeviceId: string;
  onSelect: (deviceId: string) => void;
}

/** 设备目录（core-owned）：local/relay 均调用真实 broker devices；失败/加载中明确展示。 */
class DevicesSection extends Component<DevicesSectionProps, DevicesSectionState> {
  state: DevicesSectionState = {
    items: [],
    nextCursor: null,
    error: null,
    busy: false,
    loadedAt: null,
    loaded: false,
  };

  private mounted = false;

  componentDidMount(): void {
    this.mounted = true;
    void this.load();
  }

  componentWillUnmount(): void {
    this.mounted = false;
  }

  componentDidUpdate(prev: DevicesSectionProps): void {
    const a = prev.identity;
    const b = this.props.identity;
    if (a?.profileId !== b?.profileId || a?.kind !== b?.kind) {
      this.setState({ items: [], nextCursor: null, error: null, busy: false, loadedAt: null, loaded: false });
      void this.load();
    } else if (!prev.transportConnected && this.props.transportConnected) {
      void this.load();
    } else if (prev.transportConnected && !this.props.transportConnected) {
      this.setState({ busy: false });
    }
  }

  /** 目录只属于一个连接（profile+kind+transport）；generation 变化不影响已读分页。 */
  private sameConnection(profileId: string, kind: 'local' | 'relay', generation: number): boolean {
    const identity = this.props.identity;
    return (
      !!identity &&
      this.props.transportConnected &&
      identity.profileId === profileId &&
      identity.kind === kind &&
      identity.generation === generation
    );
  }

  private async load(): Promise<void> {
    const identity = this.props.identity;
    if (!identity || !this.props.transportConnected) return;
    const { profileId, kind, generation } = identity;
    this.setState({ busy: true, error: null });
    try {
      const page = await this.props.api.broker(identity, 'devices', { limit: 20, cursor: null });
      if (!this.mounted || !this.sameConnection(profileId, kind, generation)) return;
      this.setState({
        items: page.items,
        nextCursor: page.nextCursor,
        busy: false,
        loaded: true,
        loadedAt: new Date().toISOString(),
      });
    } catch (e) {
      if (!this.mounted || !this.sameConnection(profileId, kind, generation)) return;
      // 同一连接内换目标产生的迟到身份错误不作目录失败展示。
      const err = toError(e);
      this.setState({ error: err.code === 'IDENTITY_CHANGED' ? null : err.message, busy: false });
    }
  }

  private async loadMore(): Promise<void> {
    const identity = this.props.identity;
    if (!identity || !this.props.transportConnected || !this.state.nextCursor) return;
    const { profileId, kind, generation } = identity;
    this.setState({ busy: true });
    try {
      const page = await this.props.api.broker(identity, 'devices', {
        limit: 20,
        cursor: this.state.nextCursor,
      });
      if (!this.mounted || !this.sameConnection(profileId, kind, generation)) return;
      this.setState((s) => ({
        items: [...s.items, ...page.items],
        nextCursor: page.nextCursor,
        busy: false,
        loadedAt: new Date().toISOString(),
      }));
    } catch (e) {
      if (!this.mounted || !this.sameConnection(profileId, kind, generation)) return;
      const err = toError(e);
      this.setState({ error: err.code === 'IDENTITY_CHANGED' ? null : err.message, busy: false });
    }
  }

  private async rename(item: DevicesDirectoryItem): Promise<void> {
    const identity = this.props.identity;
    if (!identity || identity.kind !== 'relay' || !this.props.transportConnected || this.state.busy) return;
    const name = window.prompt('中央设备名称', item.displayName || item.deviceId);
    if (name === null) return;
    if (!name.trim() || name.trim().length > 120) {
      this.setState({ error: '设备名称须为 1–120 字符。' });
      return;
    }
    this.setState({ busy: true, error: null });
    try {
      await this.props.api.broker(identity, 'rename_device', { deviceId: item.deviceId, displayName: name.trim() });
      if (!this.mounted || !this.sameConnection(identity.profileId, identity.kind, identity.generation)) return;
      await this.load();
    } catch (e) {
      if (!this.mounted || !this.sameConnection(identity.profileId, identity.kind, identity.generation)) return;
      this.setState({ busy: false, error: `改名失败或结果未确认：${toError(e).message}；请刷新目录核对。` });
    }
  }

  render(): ReactNode {
    const identity = this.props.identity;
    if (!identity) return null;
    const isRelay = identity.kind === 'relay';
    const { error, busy, loaded, items, nextCursor } = this.state;
    return (
      <section className="devices-section">
        <h3>{isRelay ? '设备目录' : '本地 Host'}</h3>
        <button onClick={() => void this.load()} disabled={busy || !this.props.transportConnected}>
          刷新
        </button>
        {error ? (
          <div className="error-banner" role="alert">
            {`设备查询失败：${error}`}
            <button onClick={() => this.setState({ error: null })}>关闭</button>
          </div>
        ) : !loaded ? (
          <p className="status">{busy ? '正在加载目录…' : '目录尚未读取（transport 未连接）'}</p>
        ) : items.length === 0 ? (
          <p className="empty-state">目录为空（已成功读取）</p>
        ) : (
          <ul className="device-list">
            {items.map((item) => (
              <li
                key={item.deviceId}
                className={item.deviceId === this.props.selectedDeviceId ? 'selected' : undefined}
              >
                <button
                  className="profile-row"
                  onClick={() => this.props.onSelect(item.deviceId)}
                >
                  <span className="profile-title">{item.displayName || item.deviceId}</span>
                  <span className="metadata">{item.deviceId}</span>
                  <span className="status">{item.online ? '在线' : '离线'}</span>
                  {isRelay && (
                    <span className="metadata">
                      {`control ${item.controlProtocol} · scope ${item.scopeProtocol}`}
                    </span>
                  )}
                  {!isRelay && (
                    <span className="metadata">
                      {`最后观测 ${this.props.lastObservedAt ?? this.state.loadedAt ?? '—'}`}
                    </span>
                  )}
                </button>
                {isRelay && <button type="button" disabled={busy || !this.props.transportConnected} onClick={() => void this.rename(item)}>重命名</button>}
              </li>
            ))}
          </ul>
        )}
        {isRelay && nextCursor && (
          <button onClick={() => void this.loadMore()} disabled={busy}>
            加载更多
          </button>
        )}
        {!this.props.transportConnected && loaded && <p className="status">离线：显示上次读取的设备目录。</p>}
        <p className="metadata">选择设备用于群聊与待发送；Bot 聊天按各自设备路由。</p>
      </section>
    );
  }
}

export class App extends Component<AppProps, AppState> {
  private unsub: (() => void) | null = null;
  private unsubErrors: (() => void) | null = null;
  /** 同步在途标记：state.busy 在重渲染前不能防双击。 */
  private actionInFlight = false;
  private scopedKey = '';
  private scopedApi: DesktopViewApi | null = null;

  constructor(props: AppProps) {
    super(props);
    this.state = {
      busy: true,
      profiles: [],
      profilesError: null,
      selectedProfileId: null,
      status: null,
      identity: null,
      transportConnected: false,
      view: 'chat',
      token: '',
      ca: '',
      form: { title: '', kind: 'local', url: '', expectedDeviceId: '', deviceId: '' },
      globalError: null,
      bannerError: null,
      sidebarCollapsed: false,
      selectedDeviceId: '',
    };
  }

  componentDidMount(): void {
    this.unsub = this.props.api.subscribe(() => {
      this.setState({
        profiles: this.props.api.snapshot ? this.props.api.snapshot.state.profiles : [],
        identity: this.props.api.identity,
        transportConnected: this.props.api.transportConnected,
      });
    });
    this.unsubErrors = this.props.api.subscribeErrors((message) => {
      this.setState({ bannerError: message });
    });
    void this.refreshProfiles();
  }

  componentWillUnmount(): void {
    if (this.unsub) this.unsub();
    if (this.unsubErrors) this.unsubErrors();
  }

  private async refreshProfiles(): Promise<void> {
    try {
      await this.props.api.init();
      const snap = this.props.api.snapshot;
      this.setState({
        busy: false,
        profiles: snap ? snap.state.profiles : [],
        profilesError: null,
      });
    } catch (e) {
      this.setState({ busy: false, profilesError: `无法读取配置：${toError(e).message}` });
    }
  }

  private selectProfile(profile: DesktopUiProfile): void {
    this.setState({ selectedProfileId: profile.id, globalError: null });
  }

  private async connect(): Promise<void> {
    const profile = this.state.profiles.find((p) => p.id === this.state.selectedProfileId);
    const token = this.state.token;
    const previousIdentity = this.state.identity;
    const previousDeviceId = this.state.selectedDeviceId;
    if (this.actionInFlight || !profile || !token) return;
    let input: DesktopConnectionInput;
    if (profile.kind === 'local') {
      input = { kind: 'local', url: profile.url, token };
      if (profile.expectedDeviceId) input.expectedDeviceId = profile.expectedDeviceId;
    } else {
      input = { kind: 'relay', url: profile.url, deviceId: profile.deviceId, token };
      if (this.state.ca.trim()) input.ca = this.state.ca.trim();
    }
    this.actionInFlight = true;
    // 连接开始即封住旧身份并标记 transport 断开；迟到旧结果不能覆盖新选择。
    this.props.api.setTransportConnected(false);
    this.props.api.setIdentity(null);
    this.setState({ busy: true, globalError: null });
    try {
      const status = await this.props.api.broker(
        { profileId: profile.id, targetDeviceId: '', generation: 0, kind: profile.kind },
        'connect',
        { connection: input },
      );
      let targetDeviceId = '';
      if (status.connection && status.connection.kind === 'local') {
        targetDeviceId = status.connection.deviceId ?? '';
      }
      this.props.api.setIdentity({
        profileId: profile.id,
        targetDeviceId,
        kind: profile.kind,
      });
      // transport 连接以 status.phase === 'connected' 为准；不代表目标 Host 在线。
      this.props.api.setTransportConnected(status.phase === 'connected');
      this.setState({ busy: false, status, bannerError: null, selectedDeviceId: targetDeviceId || (previousIdentity?.profileId === profile.id ? previousDeviceId : '') });
    } catch (e) {
      this.setState({ busy: false, globalError: `连接失败：${toError(e).message}` });
    } finally {
      // 无论成败都清输入，不保存 token/CA 副本。
      this.actionInFlight = false;
      this.setState({ token: '', ca: '' });
    }
  }

  private async disconnect(): Promise<void> {
    const identity = this.state.identity;
    if (this.actionInFlight || !identity) return;
    this.actionInFlight = true;
    // 断开开始即封住旧身份（generation 增）并标记 transport 断开；保留队列 identity/目标。
    this.props.api.setTransportConnected(false);
    this.props.api.setIdentity({
      profileId: identity.profileId,
      targetDeviceId: identity.targetDeviceId,
      kind: identity.kind,
    });
    this.setState({ busy: true });
    try {
      const status = await this.props.api.broker(this.props.api.identity ?? identity, 'disconnect', {});
      this.setState({ busy: false, status });
    } catch (e) {
      this.props.api.reportError(e);
      this.setState({ busy: false });
    } finally {
      this.actionInFlight = false;
    }
  }

  private async saveProfile(e: { preventDefault(): void }): Promise<void> {
    e.preventDefault();
    const { form, profiles } = this.state;
    if (this.actionInFlight) return;
    if (profiles.length >= 16) {
      this.setState({ globalError: 'profile 已达上限 16' });
      return;
    }
    let next: DesktopUiProfile;
    if (form.kind === 'local') {
      next = { id: runId(), title: form.title.trim() || form.url, kind: 'local', url: form.url.trim() };
      if (form.expectedDeviceId.trim()) next.expectedDeviceId = form.expectedDeviceId.trim();
    } else {
      next = {
        id: runId(),
        title: form.title.trim() || form.url,
        kind: 'relay',
        url: form.url.trim(),
        deviceId: form.deviceId.trim(),
      };
    }
    this.actionInFlight = true;
    try {
      await this.props.api.init();
      await this.props.api.queueWrite((s) => ({
        ...s,
        profiles: [...s.profiles, next],
      }));
      this.setState({ form: { title: '', kind: 'local', url: '', expectedDeviceId: '', deviceId: '' } });
    } catch (e) {
      this.setState({ globalError: `保存 profile 失败：${toError(e).message}` });
    } finally {
      this.actionInFlight = false;
    }
  }

  render(): ReactNode {
    const api = this.props.api;
    const identity = this.state.identity;
    const transportConnected = this.state.transportConnected;
    const status = this.state.status;
    const connection = status?.connection ?? null;
    const phaseLabel = phaseText(status, transportConnected);
    return (
      <div className={`desktop-shell${this.state.sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <aside className="app-sidebar">
          <header className="workspace-header">
            <div className="brand-title-row">
              <h1>e-助手</h1>
              <span className="brand-badge">Grok × Hermes</span>
            </div>
          </header>
          {this.state.busy ? (
            <p className="status">加载中…</p>
          ) : this.state.profilesError ? (
            <div className="error-banner" role="alert">
              {this.state.profilesError}
              <button onClick={() => void this.refreshProfiles()}>重试</button>
            </div>
          ) : (
            this.renderProfiles()
          )}
          {this.renderSettingsSide()}
          <DevicesSection
            api={api}
            identity={identity}
            transportConnected={transportConnected}
            lastObservedAt={status?.lastObservedAt ?? null}
            selectedDeviceId={this.state.selectedDeviceId}
            onSelect={(deviceId) => this.setState({ selectedDeviceId: deviceId })}
          />
        </aside>
        <main className="app-workspace">
          <div className="connection-strip">
            <button
              type="button"
              className="sidebar-toggle-btn"
              onClick={() => this.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))}
              title={this.state.sidebarCollapsed ? '展开连接与设备边栏' : '收起连接与设备边栏（专注对话）'}
            >
              {this.state.sidebarCollapsed ? '🔌 展开连接栏 ▸' : '🔌 收起连接栏 ◂'}
            </button>
            <span className={`conn-dot ${transportConnected ? 'online' : 'offline'}`} />
            <span>{phaseLabel}</span>
            {identity && <span className="status">{this.state.selectedDeviceId || '群聊/待发送未选设备'}</span>}
            {connection && (
              <span className="metadata">{`${connection.kind} · ${connection.url}`}</span>
            )}
            <span className="metadata">
              {transportConnected ? 'transport 已连接' : 'transport 未连接'}
            </span>
          </div>
          <nav className="app-nav">
            <button type="button" onClick={openCenterManagement}>中心管理</button>
            {(
              [
                { key: 'chat', label: '聊天' },
                { key: 'scopes', label: '群聊与Bot私聊' },
                { key: 'pending', label: '待发送' },

              ] as const
            ).map((item) => (
              <button
                key={item.key}
                className={this.state.view === item.key ? 'active' : undefined}
                onClick={() => this.setState({ view: item.key })}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {this.state.globalError && (
            <div className="error-banner" role="alert">
              {this.state.globalError}
              <button onClick={() => this.setState({ globalError: null })}>关闭</button>
            </div>
          )}
          {this.state.bannerError && (
            <div className="error-banner" role="alert">
              {this.state.bannerError}
              <button onClick={() => this.setState({ bannerError: null })}>关闭</button>
            </div>
          )}
          <div className="workspace-body">{this.renderWorkspace()}</div>
        </main>
      </div>
    );
  }

  private renderProfiles(): ReactNode {
    const { profiles, selectedProfileId } = this.state;
    return (
      <section className="profiles-section">
        <h3>连接配置</h3>
        {profiles.length === 0 ? (
          <p className="empty-state">尚无保存的配置</p>
        ) : (
          <ul className="profile-list">
            {profiles.map((p) => (
              <li key={p.id} className={selectedProfileId === p.id ? 'selected' : undefined}>
                <button className="profile-row" onClick={() => this.selectProfile(p)}>
                  <span className="profile-title">{p.title}</span>
                  <span className="metadata">{`${p.kind} · ${p.url}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="form-grid" onSubmit={(e) => void this.saveProfile(e)}>
          <label>
            名称
            <input
              value={this.state.form.title}
              onChange={(e) => this.setState({ form: { ...this.state.form, title: e.target.value } })}
            />
          </label>
          <label>
            类型
            <select
              value={this.state.form.kind}
              onChange={(e) =>
                this.setState({
                  form: { ...this.state.form, kind: e.target.value as 'local' | 'relay' },
                })
              }
            >
              <option value="local">local</option>
              <option value="relay">relay</option>
            </select>
          </label>
          <label>
            URL
            <input
              value={this.state.form.url}
              onChange={(e) => this.setState({ form: { ...this.state.form, url: e.target.value } })}
            />
          </label>
          {this.state.form.kind === 'local' && (
            <label>
              期望设备ID（可选）
              <input
                value={this.state.form.expectedDeviceId}
                onChange={(e) =>
                  this.setState({ form: { ...this.state.form, expectedDeviceId: e.target.value } })
                }
              />
            </label>
          )}
          {this.state.form.kind === 'relay' && (
            <label>
              设备ID
              <input
                value={this.state.form.deviceId}
                onChange={(e) =>
                  this.setState({ form: { ...this.state.form, deviceId: e.target.value } })
                }
              />
            </label>
          )}
          <button type="submit" disabled={this.state.busy}>保存</button>
        </form>
      </section>
    );
  }

  private renderSettingsSide(): ReactNode {
    const profile = this.state.profiles.find((p) => p.id === this.state.selectedProfileId);
    if (!profile) {
      return (
        <div className="settings-side">
          <p className="empty-state">请选择或保存一个连接配置</p>
        </div>
      );
    }
    const identity = this.state.identity;
    const transportConnected = this.state.transportConnected;
    return (
      <div className="settings-side">
        <label>
          连接 token（仅本次会话，不保存）
          <input
            type="password"
            value={this.state.token}
            onChange={(e) => this.setState({ token: e.target.value })}
          />
        </label>
        {profile.kind === 'relay' && (
          <label>
            CA（可选，会话有效）
            <textarea
              value={this.state.ca}
              onChange={(e) => this.setState({ ca: e.target.value })}
            />
          </label>
        )}
        {identity && transportConnected ? (
          <button onClick={() => void this.disconnect()} disabled={this.state.busy}>
            断开
          </button>
        ) : (
          <button
            onClick={() => void this.connect()}
            disabled={this.state.busy || !this.state.token}
          >
            {identity ? '重新连接' : '连接'}
          </button>
        )}
        {this.state.status && (
          <p className="status">
            {`阶段：${phaseText(this.state.status, transportConnected)}`}
            {this.state.status.phase === 'connected' && !transportConnected
              ? `（最后观测 ${this.state.status.phase}）`
              : ''}
            {` · 代次：${this.state.status.generation}`}
          </p>
        )}
      </div>
    );
  }

  private renderWorkspace(): ReactNode {
    const view = this.state.view;
    const api = this.props.api;
    const identity = this.state.identity;
    const transportConnected = this.state.transportConnected;
    const pageActive = this.props.pageActive !== false;
    const snapshot = api.snapshot;
    if (view === 'settings') {
      return <SettingsPanel />;
    }
    if (!identity || !snapshot) return <div className="empty-state">请先连接 Host 或中继。</div>;
    if (view === 'chat') return <BotChats api={api} pageActive={pageActive} />;
    const deviceId = this.state.selectedDeviceId;
    if (!deviceId) return <div className="empty-state">请从设备目录选择群聊或待发送所属设备。</div>;
    const key = `${identity.profileId}|${identity.kind}|${identity.generation}|${deviceId}`;
    if (this.scopedKey !== key) {
      this.scopedKey = key;
      this.scopedApi = targetApi(api, deviceId);
    }
    if (view === 'pending') {
      return <PendingPanel key={key} api={api} identity={this.scopedApi!.identity} transportConnected={transportConnected} />;
    }
    return <Scopes key={key} api={this.scopedApi!} pageActive={pageActive} />;
  }

}

/** 应用装配 ErrorBoundary：加载失败显示明确错误，提供只读重试。 */
export class DesktopApp extends Component<{ api: DesktopPanelApi; pageActive?: boolean }, { failed: string | null }> {
  state = { failed: null as string | null };

  private centerDisconnected = () => {
    this.props.api.setTransportConnected(false);
    this.props.api.setIdentity(null);
  };

  static getDerivedStateFromError(error: unknown): { failed: string } {
    return { failed: error instanceof DesktopRemoteError ? error.message : String(error) };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="desktop-shell error-shell">
          <div className="error-banner" role="alert">{this.state.failed}</div>
          <button onClick={() => this.setState({ failed: null })}>重试</button>
        </div>
      );
    }
    return <CenterGate onDisconnected={this.centerDisconnected}><App api={this.props.api} pageActive={this.props.pageActive} /></CenterGate>;
  }
}
