// Module 17 待发送面板（core-owned，stage1 修正）：pending 列表/分页/筛选、显式发送、
// 只读 reconcile、仅 pending 本地 cancel；冻结创建/成员变更 intents 展示与对账。
// 断开后保留队列 identity/目标，本面板仍可离线 list/get/enqueue/cancel。
import { Component } from 'react';
import type { ReactNode } from 'react';
import type { PendingCursor, PendingRecord, PendingState } from '../../../host-core/index.js';
import type { DesktopUiIntent } from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { toError } from './api';

interface Props {
  api: DesktopPanelApi;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
}

interface State {
  items: PendingRecord[];
  cursor: PendingCursor | null;
  filter: PendingState | null;
  intents: DesktopUiIntent[];
  error: string | null;
  busyId: string | null;
}

const STATE_LABELS: Record<PendingState, string> = {
  pending: 'pending',
  sending: 'sending',
  unconfirmed: 'unconfirmed',
  accepted: 'accepted',
  rejected: 'rejected',
};

const INTENT_METHOD_LABELS: Record<DesktopUiIntent['method'], string> = {
  createBot: '创建 Bot',
  createScope: '创建 scope',
  updateScope: '更新 scope',
};

export class PendingPanel extends Component<Props, State> {
  state: State = {
    items: [],
    cursor: null,
    filter: null,
    intents: [],
    error: null,
    busyId: null,
  };

  private unsub: (() => void) | null = null;
  private mounted = false;
  private identityEpoch = 0;
  private loadEpoch = 0;

  private isCurrent(identity: DesktopIdentity, epoch: number): boolean {
    const current = this.props.identity;
    return this.mounted && this.identityEpoch === epoch && !!current &&
      current.profileId === identity.profileId && current.targetDeviceId === identity.targetDeviceId &&
      current.kind === identity.kind && current.generation === identity.generation;
  }
  /** 同步在途标记：state.busyId 在重渲染前不能防双击。 */
  private inFlight = false;

  componentDidMount(): void {
    this.mounted = true;
    this.unsub = this.props.api.subscribe(() => {
      if (!this.mounted) return;
      const snap = this.props.api.snapshot;
      this.setState({ intents: snap ? snap.state.intents : [] });
    });
    this.setState({ intents: this.props.api.snapshot ? this.props.api.snapshot.state.intents : [] });
    void this.load();
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.identityEpoch += 1;
    this.loadEpoch += 1;
    if (this.unsub) this.unsub();
  }

  componentDidUpdate(prev: Props): void {
    const a = prev.identity;
    const b = this.props.identity;
    if (
      a?.generation !== b?.generation ||
      a?.profileId !== b?.profileId ||
      a?.kind !== b?.kind ||
      a?.targetDeviceId !== b?.targetDeviceId
    ) {
      this.identityEpoch += 1;
      this.loadEpoch += 1;
      this.setState({ items: [], cursor: null, error: null, busyId: null });
      void this.load();
    }
  }

  private async load(): Promise<void> {
    const identity = this.props.identity;
    if (!identity) return;
    const epoch = this.identityEpoch;
    const loadEpoch = ++this.loadEpoch;
    const filter = this.state.filter;
    try {
      const page = await this.props.api.pending(identity, 'pending_list', {
        options: { ...(filter ? { state: filter } : {}), limit: 50, cursor: null },
      });
      // 旧请求结果不得覆盖新目标/新筛选。
      if (!this.isCurrent(identity, epoch) || this.loadEpoch !== loadEpoch || this.state.filter !== filter) {
        return;
      }
      this.setState({
        items: page.items,
        cursor: page.nextCursor,
        error: null,
      });
    } catch (e) {
      if (!this.isCurrent(identity, epoch) || this.loadEpoch !== loadEpoch || this.state.filter !== filter) {
        return;
      }
      this.setState({ error: toError(e).message });
    }
  }

  private async loadMore(): Promise<void> {
    const identity = this.props.identity;
    if (!identity || !this.state.cursor) return;
    const epoch = this.identityEpoch;
    const loadEpoch = ++this.loadEpoch;
    const filter = this.state.filter;
    try {
      // 保留完整 PendingCursor 原样回传，不手工伪造。
      const page = await this.props.api.pending(identity, 'pending_list', {
        options: { ...(filter ? { state: filter } : {}), limit: 50, cursor: this.state.cursor },
      });
      if (!this.isCurrent(identity, epoch) || this.loadEpoch !== loadEpoch || this.state.filter !== filter) {
        return;
      }
      this.setState((s) => ({
        items: [...s.items, ...page.items],
        cursor: page.nextCursor,
      }));
    } catch (e) {
      if (!this.isCurrent(identity, epoch) || this.loadEpoch !== loadEpoch || this.state.filter !== filter) {
        return;
      }
      this.setState({ error: toError(e).message });
    }
  }

  private async run(
    id: string,
    op: 'pending_send' | 'pending_reconcile' | 'pending_cancel',
  ): Promise<void> {
    const identity = this.props.identity;
    if (!identity || this.inFlight) return;
    if ((op === 'pending_send' || op === 'pending_reconcile') && !this.props.transportConnected) {
      this.setState({ error: '客户端未连接：发送/对账需先重新连接；本地取消仍可用' });
      return;
    }
    const epoch = this.identityEpoch;
    this.inFlight = true;
    this.setState({ busyId: id, error: null });
    try {
      const updated = await this.props.api.pending(identity, op, { id });
      if (!this.isCurrent(identity, epoch)) return;
      this.setState((s) => ({
        items: s.items.map((it) => (it.id === id ? updated : it)),
        busyId: null,
      }));
    } catch (e) {
      if (!this.isCurrent(identity, epoch)) return;
      this.setState({ busyId: null, error: toError(e).message });
    } finally {
      this.inFlight = false;
    }
  }

  private async reconcileBotIntent(intent: DesktopUiIntent): Promise<void> {
    const identity = this.props.identity;
    if (!identity || !this.canReconcile(intent) || this.inFlight || !this.props.transportConnected) return;
    const epoch = this.identityEpoch;
    this.inFlight = true;
    this.setState({ busyId: intent.id, error: null });
    try {
      // Bot create 只读 findByRequest，使用原 requestId/原目标；查到才保存结果，null 保持未确认。
      const params = intent.params as { requestId: string };
      const bot = await this.props.api.call(identity, 'findByRequest', { requestId: params.requestId });
      if (!this.isCurrent(identity, epoch)) return;
      if (bot) {
        await this.props.api.updateIntent(intent.id, { outcome: 'responded', result: bot });
      }
      if (!this.isCurrent(identity, epoch)) return;
      this.setState({ busyId: null });
    } catch (e) {
      if (!this.isCurrent(identity, epoch)) return;
      this.setState({ busyId: null, error: toError(e).message });
    } finally {
      this.inFlight = false;
    }
  }

  private canReconcile(intent: DesktopUiIntent): boolean {
    const identity = this.props.identity;
    return (
      !!identity &&
      intent.method === 'createBot' &&
      intent.outcome === 'unconfirmed' &&
      identity.profileId === intent.profileId &&
      identity.targetDeviceId === intent.targetDeviceId
    );
  }

  private renderItem(item: PendingRecord): ReactNode {
    const busy = this.state.busyId === item.id;
    const offline = !this.props.transportConnected;
    const canSend = item.state === 'pending';
    const canReconcileRow =
      item.state === 'unconfirmed' || item.state === 'pending' || item.state === 'rejected';
    const canCancel = item.state === 'pending';
    return (
      <div key={item.id} className="entity-row">
        <div className="entity-main">
          <span className="entity-title">
            {item.kind === 'primary' ? `primary · ${item.botId}` : `room · ${item.scopeId}`}
          </span>
          <span className="status">{STATE_LABELS[item.state]}</span>
          <span className="metadata">{`target ${item.targetDeviceId}`}</span>
          <span className="metadata">
            {'requestId' in item ? item.requestId : `message ${item.messageId}`}
          </span>
          {item.lastError && (
            <span className="metadata error-banner">
              {`${item.lastError.code} · ${item.lastError.outcome}`}
            </span>
          )}
          <pre className="raw-history">{JSON.stringify(item.receipt ?? null, null, 2)}</pre>
        </div>
        <div className="toolbar">
          {canSend && (
            <button
              onClick={() => void this.run(item.id, 'pending_send')}
              disabled={busy || offline}
            >
              发送
            </button>
          )}
          {canReconcileRow && (
            <button
              onClick={() => void this.run(item.id, 'pending_reconcile')}
              disabled={busy || offline}
            >
              对账
            </button>
          )}
          {canCancel && (
            <button onClick={() => void this.run(item.id, 'pending_cancel')} disabled={busy}>
              取消
            </button>
          )}
          {!canSend && !canReconcileRow && (
            <span className="metadata">终态无发送/对账</span>
          )}
        </div>
      </div>
    );
  }

  private renderIntent(intent: DesktopUiIntent): ReactNode {
    const busy = this.state.busyId === intent.id;
    const offline = !this.props.transportConnected;
    const canDelete = intent.outcome === 'responded' || intent.outcome === 'not-sent';
    const canReconcileNow = this.canReconcile(intent);
    return (
      <div key={intent.id} className="entity-row">
        <div className="entity-main">
          <span className="entity-title">{INTENT_METHOD_LABELS[intent.method]}</span>
          <span className="status">{intent.outcome}</span>
          <span className="metadata">
            {`target ${intent.targetDeviceId} · profile ${intent.profileId}`}
          </span>
          <span className="metadata">
            {`requestId ${(intent.params as { requestId?: string }).requestId ?? '—'}`}
          </span>
          {intent.error && (
            <span className="metadata error-banner">
              {`${intent.error.code} · ${intent.error.outcome}`}
            </span>
          )}
          <pre className="raw-history">{JSON.stringify(intent.result ?? null, null, 2)}</pre>
        </div>
        <div className="toolbar">
          {intent.method === 'createBot' && (
            <button
              onClick={() => void this.reconcileBotIntent(intent)}
              disabled={busy || !canReconcileNow || offline}
            >
              对账 findByRequest
            </button>
          )}
          {canDelete && (
            <button onClick={() => void this.props.api.deleteIntent(intent.id)} disabled={busy}>
              删除
            </button>
          )}
          {!canDelete && !canReconcileNow && (
            <span className="metadata">unconfirmed 不可删除或编辑身份</span>
          )}
        </div>
      </div>
    );
  }

  render(): ReactNode {
    const identity = this.props.identity;
    if (!identity) {
      return <div className="empty-state">未配置当前队列，请先连接目标 Host</div>;
    }
    const offline = !this.props.transportConnected;
    return (
      <div className="conversation-layout">
        <div className="entity-list">
          <h3>待发送</h3>
          <label>
            筛选
            <select
              value={this.state.filter ?? ''}
              onChange={(e) =>
                this.setState(
                  { filter: (e.target.value || null) as PendingState | null },
                  () => void this.load(),
                )
              }
            >
              <option value="">全部</option>
              {(Object.keys(STATE_LABELS) as PendingState[]).map((s) => (
                <option key={s} value={s}>
                  {STATE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <h3>冻结创建/成员变更 intents</h3>
          <p className="empty-state">
            Bot create 仅支持只读 findByRequest 对账；scope create/update 无 request lookup，不虚构对账或自动重放。
          </p>
          <p className="empty-state">已确认或 not-sent 可显式删除；unconfirmed 不可删除或编辑身份。</p>
        </div>
        <div className="chat-pane">
          <h3>Pending 队列</h3>
          {offline && (
            <p className="status">
              客户端未连接：队列仍可本地读取/取消；发送与对账已禁用，重连后再操作。
            </p>
          )}
          {this.state.error && (
            <div className="error-banner" role="alert">
              {`操作失败：${this.state.error}`}
              <button onClick={() => void this.load()}>重试</button>
            </div>
          )}
          {this.state.items.length === 0 ? (
            this.state.error ? null : <p className="empty-state">暂无 pending 记录</p>
          ) : (
            this.state.items.map((it) => this.renderItem(it))
          )}
          {this.state.cursor && (
            <button onClick={() => void this.loadMore()} disabled={!!this.state.busyId}>
              加载更多
            </button>
          )}
          <h3>Intents</h3>
          {this.state.intents.length === 0 ? (
            <p className="empty-state">暂无冻结 intents</p>
          ) : (
            this.state.intents.map((it) => this.renderIntent(it))
          )}
        </div>
      </div>
    );
  }
}
