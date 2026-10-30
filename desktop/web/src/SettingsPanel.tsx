// Lane 3：连接与节点设置弹窗内容（仅展示 + 回调，状态由 App 持有）。
// Radix Dialog 由 App 提供 Portal/Overlay/Content；本组件渲染标题、页签与两块内容。
// token/CA 仅为输入态，随连接尝试结束由 App 清空；不写 localStorage / 日志。
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, Pencil, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { DesktopClientStatus, DesktopUiProfile } from '../../../host-core/desktop-client.js';
import type { DevicesDirectoryItem } from '../../../host-core/index.js';
import type { DesktopIdentity } from './types';
import { openCenterManagement } from './CenterGate';

interface ProfileFormState {
  title: string;
  kind: 'local' | 'relay';
  url: string;
  expectedDeviceId: string;
  deviceId: string;
}

interface DevicesSectionState {
  items: DevicesDirectoryItem[];
  nextCursor: { afterDeviceId: string } | null;
  error: string | null;
  busy: boolean;
  loadedAt: string | null;
  loaded: boolean;
}

interface CenterStatusLite {
  state: 'disconnected' | 'connecting' | 'ready';
  centerUrl: string;
  clientId: string;
}

export interface SettingsPanelProps {
  profiles: DesktopUiProfile[];
  profilesError: string | null;
  profilesBusy: boolean;
  selectedProfile: DesktopUiProfile | null;
  onSelectProfile: (profile: DesktopUiProfile) => void;
  form: ProfileFormState;
  onFormChange: (patch: Partial<ProfileFormState>) => void;
  onSaveProfile: (e: FormEvent) => void;
  token: string;
  ca: string;
  onTokenChange: (v: string) => void;
  onCaChange: (v: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  status: DesktopClientStatus | null;
  phaseLabel: string;
  centerStatus: CenterStatusLite | undefined;
  /** 保留 Promise；gate reject 由 App 转 globalError（不吞）。 */
  onDisconnectCenter: () => Promise<void>;
  devices: DevicesSectionState;
  devicesIsRelay: boolean;
  lastObservedAt: string | null;
  selectedDeviceId: string;
  onSelectDevice: (deviceId: string) => void;
  onRefreshDevices: () => void;
  onLoadMoreDevices: () => void;
  onRenameDevice: (item: DevicesDirectoryItem, displayName: string) => void;
  onDeviceError: (message: string) => void;
}

/** 设备目录行：行内改名替代 window.prompt；保存前置 1–120 字符校验与 App 保持一致。 */
function DeviceRow(props: {
  item: DevicesDirectoryItem;
  isRelay: boolean;
  selected: boolean;
  busy: boolean;
  lastObservedAt: string | null;
  onSelect: (deviceId: string) => void;
  onRename: (item: DevicesDirectoryItem, displayName: string) => void;
  onError: (message: string) => void;
}) {
  const { item, isRelay, selected, busy, lastObservedAt } = props;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const startEdit = () => {
    setValue(item.displayName || item.deviceId);
    setEditing(true);
  };

  const commit = () => {
    const name = value.trim();
    if (!name || name.length > 120) {
      props.onError('设备名称须为 1–120 字符。');
      return;
    }
    if (name !== (item.displayName || item.deviceId)) {
      props.onRename(item, name);
    }
    setEditing(false);
  };

  return (
    <li className={selected ? 'selected' : undefined}>
      {editing ? (
        <span className="rename-inline">
          <input
            autoFocus
            value={value}
            maxLength={120}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label="设备名称"
          />
          <button type="button" className="icon-button" onClick={commit} disabled={busy} aria-label="保存名称">
            <Check size={14} aria-hidden />
          </button>
          <button type="button" className="icon-button" onClick={() => setEditing(false)} aria-label="取消">
            <X size={14} aria-hidden />
          </button>
        </span>
      ) : (
        <>
          <button type="button" className="device-row" onClick={() => props.onSelect(item.deviceId)}>
            <span className="profile-title">{item.displayName || item.deviceId}</span>
            <span className="metadata">{item.deviceId}</span>
            <span className={'status ' + (item.online ? 'ok' : 'muted')}>{item.online ? '在线' : '离线'}</span>
            {isRelay ? (
              <span className="metadata">{'control ' + item.controlProtocol + ' · scope ' + item.scopeProtocol}</span>
            ) : (
              <span className="metadata">{'最后观测 ' + (lastObservedAt ?? '—')}</span>
            )}
          </button>
          {isRelay && (
            <button
              type="button"
              className="icon-button"
              onClick={startEdit}
              disabled={busy}
              aria-label="重命名设备"
            >
              <Pencil size={14} aria-hidden />
            </button>
          )}
        </>
      )}
    </li>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [tab, setTab] = useState<'general' | 'profiles'>('general');
  const [copied, setCopied] = useState(false);
  const {
    identity,
    transportConnected,
    status,
    phaseLabel,
    centerStatus,
    selectedProfile,
    devices,
    devicesIsRelay,
  } = props;

  const copyClientId = () => {
    if (!centerStatus?.clientId) return;
    void navigator.clipboard.writeText(centerStatus.clientId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <>
      <div className="dialog-head">
        <Dialog.Title className="dialog-title">连接与节点</Dialog.Title>
        <Dialog.Close asChild>
          <button type="button" className="icon-button" aria-label="关闭">
            <X size={16} aria-hidden />
          </button>
        </Dialog.Close>
      </div>
      <Dialog.Description className="dialog-desc">
        中心连接、设备目录与高级连接档案；凭据仅输入态，连接尝试结束即清空。
      </Dialog.Description>
      <div className="dialog-tabs pill-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'general'} className={tab === 'general' ? 'active' : undefined} onClick={() => setTab('general')}>
          常规
        </button>
        <button type="button" role="tab" aria-selected={tab === 'profiles'} className={tab === 'profiles' ? 'active' : undefined} onClick={() => setTab('profiles')}>
          高级档案
        </button>
      </div>
      <div className="dialog-body">
        {tab === 'general' ? (
          <>
            <div className="settings-section">
              <div className="section-head"><h4>中心连接</h4></div>
              <div className="card-row">
                <span className={'conn-dot ' + (centerStatus?.state === 'ready' ? 'online' : 'offline')} />
                <span className="profile-title">
                  {centerStatus?.state === 'ready' ? '中心已连接' : '中心未连接'}
                </span>
                {centerStatus?.centerUrl && <span className="metadata">{centerStatus.centerUrl}</span>}
              </div>
              {centerStatus?.clientId && (
                <div className="card-row">
                  <span className="client-pill">
                    {'客户端 '}
                    {centerStatus.clientId}
                    <button type="button" className="icon-button" onClick={copyClientId} aria-label="复制客户端标识">
                      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    </button>
                  </span>
                </div>
              )}
              <div className="dialog-actions">
                <button type="button" className="secondary-button" onClick={openCenterManagement}>
                  打开中心管理
                </button>
                {centerStatus?.state === 'ready' && (
                  <button type="button" className="secondary-button" onClick={props.onDisconnectCenter}>
                    更换中心连接
                  </button>
                )}
              </div>
            </div>

            <div className="settings-section">
              <div className="section-head">
                <h4>{devicesIsRelay ? '设备目录' : '本地 Host'}</h4>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={props.onRefreshDevices}
                  disabled={devices.busy || !transportConnected}
                >
                  刷新
                </button>
              </div>
              {devices.error ? (
                <div className="error-banner" role="alert">
                  {'设备查询失败：' + devices.error}
                  <button onClick={props.onRefreshDevices} disabled={devices.busy}>重试</button>
                </div>
              ) : !devices.loaded ? (
                <p className="status">{devices.busy ? '正在加载目录…' : '目录尚未读取（transport 未连接）'}</p>
              ) : devices.items.length === 0 ? (
                <p className="empty-state">目录为空（已成功读取）</p>
              ) : (
                <ul className="device-list">
                  {devices.items.map((item) => (
                    <DeviceRow
                      key={item.deviceId}
                      item={item}
                      isRelay={devicesIsRelay}
                      selected={item.deviceId === props.selectedDeviceId}
                      busy={devices.busy || !transportConnected}
                      lastObservedAt={props.lastObservedAt ?? devices.loadedAt}
                      onSelect={props.onSelectDevice}
                      onRename={props.onRenameDevice}
                      onError={props.onDeviceError}
                    />
                  ))}
                </ul>
              )}
              {devicesIsRelay && devices.nextCursor && (
                <button type="button" className="secondary-button" onClick={props.onLoadMoreDevices} disabled={devices.busy}>
                  加载更多
                </button>
              )}
              {!transportConnected && devices.loaded && (
                <p className="status">离线：显示上次读取的设备目录。</p>
              )}
              <p className="metadata">选择设备用于群聊与待发送；Bot 聊天按各自设备路由。</p>
            </div>
          </>
        ) : (
          <>
            <div className="settings-section">
              <div className="section-head"><h4>连接档案（最多 16 个）</h4></div>
              {props.profilesError ? (
                <div className="error-banner" role="alert">{props.profilesError}</div>
              ) : props.profiles.length === 0 ? (
                <p className="empty-state">尚无保存的配置</p>
              ) : (
                <ul className="profile-list">
                  {props.profiles.map((p) => (
                    <li key={p.id} className={selectedProfile?.id === p.id ? 'selected' : undefined}>
                      <button type="button" className="profile-row" onClick={() => props.onSelectProfile(p)}>
                        <span className="profile-title">{p.title}</span>
                        <span className="metadata">{p.kind + ' · ' + p.url}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form className="form-grid" onSubmit={props.onSaveProfile}>
                <label>
                  名称
                  <input value={props.form.title} onChange={(e) => props.onFormChange({ title: e.target.value })} />
                </label>
                <label>
                  类型
                  <select
                    value={props.form.kind}
                    onChange={(e) => props.onFormChange({ kind: e.target.value as 'local' | 'relay' })}
                  >
                    <option value="local">local</option>
                    <option value="relay">relay</option>
                  </select>
                </label>
                <label className="form-grid-full">
                  URL
                  <input value={props.form.url} onChange={(e) => props.onFormChange({ url: e.target.value })} />
                </label>
                {props.form.kind === 'local' && (
                  <label className="form-grid-full">
                    期望设备ID（可选）
                    <input value={props.form.expectedDeviceId} onChange={(e) => props.onFormChange({ expectedDeviceId: e.target.value })} />
                  </label>
                )}
                {props.form.kind === 'relay' && (
                  <label className="form-grid-full">
                    设备ID
                    <input value={props.form.deviceId} onChange={(e) => props.onFormChange({ deviceId: e.target.value })} />
                  </label>
                )}
                <div className="form-grid-full">
                  <button type="submit" className="primary-button" disabled={props.profilesBusy}>
                    保存档案
                  </button>
                </div>
              </form>
            </div>

            <div className="settings-section">
              <div className="section-head"><h4>连接凭据</h4></div>
              {!selectedProfile ? (
                <p className="empty-state">请选择或保存一个连接配置</p>
              ) : (
                <div className="settings-connect">
                  <label>
                    连接 token（留空使用已保存中心令牌）
                    <input type="password" autoComplete="off" value={props.token} onChange={(e) => props.onTokenChange(e.target.value)} />
                  </label>
                  {selectedProfile.kind === 'relay' && (
                    <label>
                      CA（可选，会话有效）
                      <textarea value={props.ca} onChange={(e) => props.onCaChange(e.target.value)} />
                    </label>
                  )}
                  {identity && transportConnected ? (
                    <button type="button" className="primary-button" onClick={props.onDisconnect} disabled={props.profilesBusy}>
                      断开
                    </button>
                  ) : (
                    <button type="button" className="primary-button" onClick={props.onConnect} disabled={props.profilesBusy}>
                      {identity ? '重新连接' : '连接'}
                    </button>
                  )}
                  {status && (
                    <p className="status">
                      {'阶段：' + phaseLabel}
                      {status.phase === 'connected' && !transportConnected
                        ? '（最后观测 ' + status.phase + '）'
                        : ''}
                      {' · 代次：' + status.generation}
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
