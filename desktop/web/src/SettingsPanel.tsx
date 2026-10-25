// Module 17 Host设置面板（core-owned，stage5 修正）：仅 local 连接可见；
// getSettings/serviceStatus、JSON 编辑 HostSettings、expectedRevision CAS 保存、
// activeRevision/restartRequired；CAS 冲突/未知结果持续锁保存，只有显式只读对账
// + 显式采用远端基线后才能再次 mutation。
import { Component } from 'react';
import type { ReactNode } from 'react';
import type { ExtensionCatalog, HostSettings, LocalSettingsSnapshot } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { toError } from './api';

/** 扩展不可用原因（catalog.reason）的可读文本。 */
function extensionReason(reason: 'host-disabled' | 'not-configured'): string {
  return reason === 'host-disabled' ? 'Host 全局关闭' : 'Host 未配置 Hindsight';
}

interface Props {
  api: DesktopPanelApi;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
}

interface State {
  settings: LocalSettingsSnapshot | null;
  servicePhase: string | null;
  loadError: string | null;
  editText: string | null;
  editError: string | null;
  busy: boolean;
  reconciling: boolean;
  /** 保存结果未知（无回执/读回失败）：持续锁保存，直到显式只读对账与显式选基线。 */
  unknownOutcome: boolean;
  conflict: { server: LocalSettingsSnapshot } | null;
  /** 扩展目录（Host 级）：与设置读取分开，老 Host 不支持时不影响设置编辑。 */
  catalog: ExtensionCatalog | null;
  catalogError: string | null;
}

export class SettingsPanel extends Component<Props, State> {
  state: State = {
    settings: null,
    servicePhase: null,
    loadError: null,
    editText: null,
    editError: null,
    busy: false,
    reconciling: false,
    unknownOutcome: false,
    conflict: null,
    catalog: null,
    catalogError: null,
  };

  private mounted = false;
  /** 同步在途标记：state.busy 在重渲染前不能防双击保存（否则二次写入会用旧 revision）。 */
  private saving = false;

  componentDidMount(): void {
    this.mounted = true;
    void this.load();
  }

  componentWillUnmount(): void {
    this.mounted = false;
  }

  componentDidUpdate(prev: Props): void {
    // 只按 props 旧值比较；连接/profile/目标变化才丢弃旧数据，断开（同一目标新代次）保留并标离线。
    // 两侧都为空（null→null）不算变化，否则 setState 会再次进入本方法并无限循环。
    const a = prev.identity;
    const b = this.props.identity;
    const connectionChanged =
      a?.profileId !== b?.profileId ||
      a?.kind !== b?.kind ||
      a?.targetDeviceId !== b?.targetDeviceId;
    if (connectionChanged) {
      this.setState({
        settings: null,
        servicePhase: null,
        loadError: null,
        editText: null,
        editError: null,
        busy: false,
        reconciling: false,
        unknownOutcome: false,
        conflict: null,
        catalog: null,
        catalogError: null,
      });
      void this.load();
      return;
    }
    // 重连后做一次被动刷新；断线时保留上次读取的数据（保存已因 transport 禁用）。
    if (!prev.transportConnected && this.props.transportConnected) void this.load();
  }

  private async load(): Promise<void> {
    const identity = this.props.identity;
    if (!identity || identity.kind !== 'local' || !this.props.transportConnected) return;
    const gen = identity.generation;
    void this.loadCatalog();
    this.setState({ busy: true, loadError: null });
    try {
      const [settings, service] = await Promise.all([
        this.props.api.broker(identity, 'settings_get', { targetDeviceId: identity.targetDeviceId }),
        this.props.api.broker(identity, 'service_status', { targetDeviceId: identity.targetDeviceId }),
      ]);
      if (!this.mounted || this.props.identity?.generation !== gen) return;
      this.setState({ settings, servicePhase: service.phase, busy: false });
    } catch (e) {
      if (!this.mounted || this.props.identity?.generation !== gen) return;
      this.setState({ loadError: toError(e).message, busy: false });
    }
  }

  /** 只读扩展目录：失败只标记目录错误，设置编辑保持可用；不自动重试。 */
  private async loadCatalog(): Promise<void> {
    const identity = this.props.identity;
    if (!identity || identity.kind !== 'local' || !this.props.transportConnected) return;
    const gen = identity.generation;
    try {
      const catalog = await this.props.api.call(identity, 'getExtensionCatalog', {});
      if (!this.mounted || this.props.identity?.generation !== gen) return;
      this.setState({ catalog, catalogError: null });
    } catch (e) {
      if (!this.mounted || this.props.identity?.generation !== gen) return;
      this.setState({ catalogError: toError(e).message });
    }
  }

  private async save(): Promise<void> {
    const identity = this.props.identity;
    const { settings, editText, busy, reconciling, unknownOutcome, conflict } = this.state;
    if (
      this.saving ||
      !identity ||
      !settings ||
      busy ||
      reconciling ||
      unknownOutcome ||
      conflict ||
      editText === null
    ) {
      return;
    }
    if (!this.props.transportConnected) {
      this.setState({ editError: '客户端未连接，无法保存' });
      return;
    }
    let next: HostSettings;
    try {
      next = JSON.parse(editText) as HostSettings;
    } catch {
      this.setState({ editError: 'JSON 解析失败，保留编辑文本' });
      return;
    }
    const gen = identity.generation;
    this.saving = true;
    this.setState({ busy: true, editError: null });
    try {
      const updated = await this.props.api.broker(identity, 'settings_set', {
        targetDeviceId: identity.targetDeviceId,
        input: { expectedRevision: settings.revision, settings: next },
      });
      if (!this.mounted || this.props.identity?.generation !== gen) return;
      this.setState({ settings: updated, editText: null, busy: false, unknownOutcome: false });
    } catch (e) {
      if (!this.mounted || this.props.identity?.generation !== gen) return;
      const err = toError(e);
      if (err.outcome === 'not-sent') {
        // 确定的未下发（输入/CAS/连接校验失败）：远端未更新，允许修正输入后重试。
        this.setState({
          busy: false,
          editError: `保存被拒绝（未下发）：${err.message}。远端未更新，可修正后重试。`,
        });
        return;
      }
      // 结果未知：只读对账，未完成读回前持续锁保存。
      this.setState({ reconciling: true, busy: false, unknownOutcome: true });
      await this.readBack(`保存结果未知（${err.message}）。`);
    } finally {
      this.saving = false;
    }
  }

  /**
   * 只读对账：读回成功只提供新的基线候选，不自动重放保存；
   * 读回失败保持输入/原基线与锁。
   */
  private async readBack(reason: string): Promise<void> {
    const identity = this.props.identity;
    if (!identity || identity.kind !== 'local') return;
    const gen = identity.generation;
    this.setState({ reconciling: true });
    try {
      const fresh = await this.props.api.broker(identity, 'settings_get', {
        targetDeviceId: identity.targetDeviceId,
      });
      if (!this.mounted || this.props.identity?.generation !== gen) return;
      this.setState({
        conflict: { server: fresh },
        reconciling: false,
        unknownOutcome: true,
        editError: `${reason}远端当前 revision ${fresh.revision}；请显式选择基线后再保存，不会自动重放。`,
      });
    } catch (readErr) {
      if (!this.mounted || this.props.identity?.generation !== gen) return;
      this.setState({
        reconciling: false,
        unknownOutcome: true,
        editError: `${reason}远端对账读取失败：${toError(readErr).message}。保留编辑文本与原基线，保存保持锁定。`,
      });
    }
  }

  private reconcile(): void {
    void this.readBack('只读对账：');
  }

  /** 显式采用远端基线：同时采用完整 server snapshot（revision/restartRequired/settings）。 */
  private adoptServerBaseline(): void {
    const conflict = this.state.conflict;
    if (!conflict) return;
    this.setState({
      settings: conflict.server,
      editText: JSON.stringify(conflict.server.settings, null, 2),
      conflict: null,
      unknownOutcome: false,
      editError: null,
    });
  }

  render(): ReactNode {
    const identity = this.props.identity;
    if (!identity) {
      return <div className="empty-state">未连接</div>;
    }
    if (identity.kind !== 'local') {
      return (
        <div className="empty-state">
          Relay 连接下无法修改 Host 设置；请在目标 Host 本机配置。
        </div>
      );
    }
    if (this.state.loadError) {
      return (
        <div className="error-banner" role="alert">
          {`读取失败：${this.state.loadError}`}
          <button onClick={() => void this.load()}>重试</button>
        </div>
      );
    }
    if (!this.state.settings) {
      return (
        <p className="status">
          {this.props.transportConnected ? '加载中…' : '客户端未连接：请先连接目标 Host'}
        </p>
      );
    }
    const s = this.state.settings;
    const editText = this.state.editText ?? JSON.stringify(s.settings, null, 2);
    const saveDisabled =
      this.state.busy ||
      this.state.reconciling ||
      this.state.unknownOutcome ||
      !!this.state.conflict ||
      !this.props.transportConnected;
    return (
      <div className="conversation-layout">
        <div className="chat-pane">
          <h3>{`Host 设置 · ${s.deviceId}`}</h3>
          <div className="metadata">
            {`revision ${s.revision} · activeRevision ${s.activeRevision}`}
          </div>
          <div className="status">{s.restartRequired ? '重启后生效' : '已生效'}</div>
          {!this.props.transportConnected && (
            <div className="status">客户端未连接：显示上次读取的设置，保存已禁用。</div>
          )}
          {this.state.servicePhase && (
            <div className="status">{`服务阶段：${this.state.servicePhase}`}</div>
          )}
          {s.settings.relay && (
            <div className="metadata">
              {`relay ${s.settings.relay.url}（tokenEnv: ${s.settings.relay.tokenEnv}）`}
            </div>
          )}
          <details open>
            <summary>扩展目录</summary>
            {this.state.catalogError ? (
              <div className="error-banner" role="alert">
                {`扩展目录读取失败：${this.state.catalogError}`}
                <button onClick={() => void this.loadCatalog()}>重试</button>
              </div>
            ) : !this.state.catalog ? (
              <p className="status">扩展目录尚未读取</p>
            ) : (
              <ul className="data-list">
                {this.state.catalog.extensions.map((ext) => (
                  <li key={ext.id}>
                    {`${ext.name}（${ext.id} · v${ext.version} · ${ext.scope}）`}
                    <div className="metadata">
                      {`${ext.enabled ? '已启用' : '未启用'} · ${ext.available ? '可用' : '不可用'} · 默认${ext.defaultEnabled ? '开启' : '关闭'}${ext.reason ? ` · ${extensionReason(ext.reason)}` : ''}`}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">
              {'连接/全局开关与凭据引用在下方 JSON 编辑器的 runtime.extensions 中配置（例如 '
                + 'runtime.extensions.hindsight = {"enabled":true,"defaultEnabled":true,"config":{...}}）；'
                + 'defaultEnabled 只在 Bot 首次初始化时复制，已有 Bot 保持自己的设置。'
                + '每个 Bot 的开关/只读策略与 SOUL 在“聊天”页选中 Bot 后的 Bot 设置里编辑。'}
            </p>
          </details>
          <details>
            <summary>模型环境变量</summary>
            <ul className="data-list">
              {s.settings.runtime.providers.map((p) => (
                <li key={p.id}>
                  {`${p.id} · baseUrl ${p.baseUrl} · apiKeyEnv ${p.apiKeyEnv ?? '(无)'}`}
                </li>
              ))}
            </ul>
          </details>
          {this.state.editError && (
            <div className="error-banner" role="alert">
              {this.state.editError}
              <button onClick={() => this.setState({ editError: null })}>关闭</button>
            </div>
          )}
          {this.state.unknownOutcome && (
            <div className="status">
              保存结果未确认：保存保持锁定；可只读对账后显式选择基线。
              <button onClick={() => this.reconcile()} disabled={this.state.reconciling}>
                只读对账
              </button>
            </div>
          )}
          {this.state.conflict && (
            <div className="error-banner" role="alert">
              <div className="metadata">
                {`远端 revision ${this.state.conflict.server.revision} · 重启需 ${this.state.conflict.server.restartRequired ? '是' : '否'}`}
              </div>
              <button onClick={() => this.adoptServerBaseline()}>以远端为基准编辑</button>
            </div>
          )}
          <textarea
            className="raw-history"
            value={editText}
            onChange={(e) => this.setState({ editText: e.target.value, editError: null })}
          />
          <div className="toolbar">
            <button onClick={() => void this.save()} disabled={saveDisabled}>
              保存（CAS）
            </button>
          </div>
        </div>
      </div>
    );
  }
}
