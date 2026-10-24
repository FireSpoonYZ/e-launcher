// Module 17 core API：Tauri 桥接 + DesktopViewApi 实现（core-owned，stage1 修正）。
// 仅服务依赖 @tauri-apps/api（Tauri 2，固定 2.12.4）；host-core 只用于类型。
import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  LiveTarget,
  RemoteControlMethodMap,
  RemoteControlOutcome,
} from '../../../host-core/index.js';
import type {
  DesktopDraftEntry,
  DesktopDraftFileRef,
  DesktopIntentMethod,
  DesktopObservationEvent,
  DesktopOperationMap,
  DesktopUiIntent,
  DesktopUiSnapshot,
  DesktopUiState,
} from '../../../host-core/desktop-client.js';
import type {
  BrokerOpParams,
  BrokerOpResult,
  DesktopIdentity,
  DesktopPanelApi,
  IntentPatch,
  ObservationHandle,
  PendingOperation,
  PublicBrokerOperation,
} from './types';

export class DesktopRemoteError extends Error {
  readonly code: string;
  readonly outcome: RemoteControlOutcome;
  constructor(shape: { code: string; message: string; outcome: RemoteControlOutcome }) {
    super(`${shape.code}: ${shape.message}`);
    this.name = 'DesktopRemoteError';
    this.code = shape.code;
    this.outcome = shape.outcome;
  }
}

export function toError(e: unknown): DesktopRemoteError {
  if (e instanceof DesktopRemoteError) return e;
  if (typeof e === 'object' && e !== null) {
    const s = e as { code?: unknown; message?: unknown; outcome?: unknown };
    if (typeof s.code === 'string') {
      const outcome: RemoteControlOutcome =
        s.outcome === 'not-sent' || s.outcome === 'unconfirmed' || s.outcome === 'responded'
          ? s.outcome
          : 'unconfirmed';
      return new DesktopRemoteError({
        code: s.code,
        message: typeof s.message === 'string' ? s.message : '',
        outcome,
      });
    }
  }
  return new DesktopRemoteError({
    code: 'INTERNAL',
    message: e instanceof Error ? e.message : String(e),
    outcome: 'unconfirmed',
  });
}

/** 需要 transport 连接的远程 broker op（本地/仅会话 op 除外；pending_send/reconcile 在 pending() 内单独校验）。 */
const REMOTE_BROKER_OPS = new Set<string>([
  'devices',
  'call',
  'settings_get',
  'settings_set',
  'service_status',
]);

function isEmptyDraft(draft: DesktopDraftEntry): boolean {
  return draft.text === '' && draft.files.length === 0;
}

/** 按 text、files 的 name/path/size 与元素顺序比较；不依赖 JSON 键顺序。 */
function sameDraftContent(a: DesktopDraftEntry, b: DesktopDraftEntry): boolean {
  if (a.text !== b.text || a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i += 1) {
    const x = a.files[i];
    const y = b.files[i];
    if (x.name !== y.name || x.path !== y.path || x.size !== y.size) return false;
  }
  return true;
}

type WireEvent = DesktopObservationEvent & { deliveryId?: string };

interface ObserveInvokeArgs {
  observationId: string;
  targetDeviceId: string;
  target: LiveTarget;
  onEvent: Channel<WireEvent>;
}

/**
 * 可注入的最小原生传输：默认是桌面 Tauri 的 4 个命令；手机远端页注入自己的 client* helper。
 * observe 的 deliveryId 由实现侧回执（桌面走 observe_ack，手机走原生 ACK 路径）。
 */
export interface DesktopTransport {
  request<K extends PublicBrokerOperation>(op: K, params: BrokerOpParams<K>): Promise<BrokerOpResult<K>>;
  pickFile(): Promise<DesktopDraftFileRef | null>;
  observe(
    observationId: string,
    targetDeviceId: string,
    target: LiveTarget,
    onEvent: (event: WireEvent) => void,
  ): Promise<void>;
  unobserve(observationId: string): Promise<void>;
}

/** 默认桌面传输：Tauri 命令 → M17 broker sidecar；失败只规范化，不重试、不重放。 */
const tauriTransport: DesktopTransport = {
  async request<K extends PublicBrokerOperation>(
    op: K,
    params: BrokerOpParams<K>,
  ): Promise<BrokerOpResult<K>> {
    try {
      return (await invoke('desktop_request', { request: { op, params } })) as BrokerOpResult<K>;
    } catch (e) {
      throw toError(e);
    }
  },
  async pickFile(): Promise<DesktopDraftFileRef | null> {
    try {
      return (await invoke('desktop_pick_file')) as DesktopDraftFileRef | null;
    } catch (e) {
      throw toError(e);
    }
  },
  async observe(observationId, targetDeviceId, target, onEvent): Promise<void> {
    const channel = new Channel<WireEvent>();
    channel.onmessage = onEvent;
    try {
      // 直接用字面量：interface 无 index signature，先赋给变量再传 invoke 会 TS2345。
      await invoke(
        'desktop_observe',
        { observationId, targetDeviceId, target, onEvent: channel } satisfies ObserveInvokeArgs,
      );
    } catch (e) {
      throw toError(e);
    }
  },
  async unobserve(observationId): Promise<void> {
    try {
      await invoke('desktop_unobserve', { observationId });
    } catch (e) {
      throw toError(e);
    }
  },
};

/** 公共 broker 请求（observe/unobserve 除外；observe_ack 留在原生本地）。 */
export function request<K extends PublicBrokerOperation>(
  op: K,
  params: BrokerOpParams<K>,
): Promise<BrokerOpResult<K>> {
  return tauriTransport.request(op, params);
}

export function pickFile(): Promise<DesktopDraftFileRef | null> {
  return tauriTransport.pickFile();
}

export class DesktopViewApiImpl implements DesktopPanelApi {
  /** 传输按实例注入：默认桌面 Tauri；手机远端页注入自己的 client* 实现。 */
  private readonly transport: DesktopTransport;
  private identityValue: DesktopIdentity | null = null;
  private snapshotValue: DesktopUiSnapshot | null = null;
  private generation = 0;
  private transportConnectedValue = false;
  private uiChain: Promise<unknown> = Promise.resolve();
  private loadPromise: Promise<DesktopUiSnapshot> | null = null;
  private listeners = new Set<() => void>();
  private errorListeners = new Set<(message: string) => void>();

  constructor(transport: DesktopTransport = tauriTransport) {
    this.transport = transport;
  }

  get identity(): DesktopIdentity | null {
    return this.identityValue;
  }

  get snapshot(): DesktopUiSnapshot | null {
    return this.snapshotValue;
  }

  get transportConnected(): boolean {
    return this.transportConnectedValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeErrors(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private notifyError(message: string): void {
    for (const listener of this.errorListeners) listener(message);
  }

  /** 全局错误可见状态；不记录凭据/正文/原始异常。 */
  reportError(error: unknown): void {
    this.notifyError(toError(error).message);
  }

  /** transport 连接状态变更（仅由 core 内部调用），并 notify 订阅者。 */
  setTransportConnected(connected: boolean): void {
    if (this.transportConnectedValue === connected) return;
    this.transportConnectedValue = connected;
    this.emit();
  }

  /** generation 单调递增并通知订阅者；profile/连接/目标设备变化即调用本方法。 */
  setIdentity(
    base: { profileId: string; targetDeviceId: string; kind: 'local' | 'relay' } | null,
  ): DesktopIdentity | null {
    this.generation += 1;
    if (base === null) {
      this.identityValue = null;
      this.emit();
      return null;
    }
    const identity: DesktopIdentity = { ...base, generation: this.generation };
    this.identityValue = identity;
    this.emit();
    return identity;
  }

  async init(): Promise<DesktopUiSnapshot> {
    return this.ensureLoaded();
  }

  private ensureLoaded(): Promise<DesktopUiSnapshot> {
    if (!this.loadPromise) {
      this.loadPromise = this.transport.request('ui_get', {}).then(
        (snap) => {
          this.snapshotValue = snap;
          this.emit();
          return snap;
        },
        (e) => {
          this.loadPromise = null;
          throw toError(e);
        },
      );
    }
    return this.loadPromise;
  }

  private lockedSnapshot(): DesktopUiSnapshot {
    if (!this.snapshotValue) {
      throw new DesktopRemoteError({
        code: 'UI_NOT_LOADED',
        message: '界面状态尚未加载',
        outcome: 'not-sent',
      });
    }
    return this.snapshotValue;
  }

  private assertCurrent(identity: DesktopIdentity): void {
    const cur = this.identityValue;
    if (
      !cur ||
      cur.profileId !== identity.profileId ||
      cur.targetDeviceId !== identity.targetDeviceId ||
      cur.generation !== identity.generation
    ) {
      throw new DesktopRemoteError({
        code: 'IDENTITY_CHANGED',
        message: '连接或目标已切换，操作未派发',
        outcome: 'not-sent',
      });
    }
  }

  private assertTransport(): void {
    if (!this.transportConnectedValue) {
      throw new DesktopRemoteError({
        code: 'NOT_CONNECTED',
        message: '客户端 transport 未连接，远程操作不可用',
        outcome: 'not-sent',
      });
    }
  }

  /** 供 core 面板（App 保存 profile 等）复用同一串行 ui_set 链；不在共享 DesktopViewApi 内。 */
  queueWrite(mutate: (state: DesktopUiState) => DesktopUiState): Promise<DesktopUiSnapshot> {
    return this.writeUi(mutate);
  }

  /** ui_set 更新串行在同一 Promise 链；基于最新快照计算纯更新，保留其他草稿/intents。 */
  private writeUi(mutate: (state: DesktopUiState) => DesktopUiState): Promise<DesktopUiSnapshot> {
    const run = this.uiChain.then(async () => {
      const snap = this.lockedSnapshot();
      // 不做“内容与缓存相同即成功”的短路：每个持久化写入都必须取得 ui_set 的 CAS 回执。
      const next = mutate(JSON.parse(JSON.stringify(snap.state)) as DesktopUiState);
      try {
        const updated = await this.transport.request('ui_set', { expectedRevision: snap.revision, state: next });
        this.snapshotValue = updated;
        this.emit();
        return updated;
      } catch (e) {
        // CAS 冲突/不确定：只读 ui_get 对账并报错，不自动重试写入。
        let reconcileError: string | null = null;
        try {
          this.snapshotValue = await this.transport.request('ui_get', {});
          this.emit();
        } catch (reconcileErr) {
          reconcileError = toError(reconcileErr).message;
        }
        const err = toError(e);
        if (reconcileError) {
          throw new DesktopRemoteError({
            code: err.code,
            message: `${err.message}（对账读取失败：${reconcileError}）`,
            outcome: err.outcome,
          });
        }
        throw err;
      }
    });
    this.uiChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureWriteReady(): Promise<void> {
    if (!this.snapshotValue) await this.ensureLoaded();
  }

  async call<M extends keyof RemoteControlMethodMap>(
    identity: DesktopIdentity,
    method: M,
    params: RemoteControlMethodMap[M]['params'],
  ): Promise<RemoteControlMethodMap[M]['result']> {
    this.assertCurrent(identity);
    this.assertTransport();
    // Tauri 协议边界单点断言：request('call') 结果是宽 union，这里收窄到具体 M 的 result。
    const result = await this.transport.request('call', {
      targetDeviceId: identity.targetDeviceId,
      method,
      params,
    } as BrokerOpParams<'call'>);
    return result as RemoteControlMethodMap[M]['result'];
  }

  async pending<K extends PendingOperation>(
    identity: DesktopIdentity,
    op: K,
    params: DesktopOperationMap[K]['params'],
  ): Promise<DesktopOperationMap[K]['result']> {
    this.assertCurrent(identity);
    // 仅远程发送/对账需要 transport；读/入队/本地取消离线可用。
    if (op === 'pending_send' || op === 'pending_reconcile') {
      this.assertTransport();
    }
    return this.transport.request(op, params);
  }

  async broker<K extends PublicBrokerOperation>(
    identity: DesktopIdentity,
    op: K,
    params: BrokerOpParams<K>,
  ): Promise<BrokerOpResult<K>> {
    // connect/ui_set 是会话建立/本地状态操作，无既存连接可核对；其余 op 一律核对。
    if (op !== 'connect' && op !== 'ui_set') {
      this.assertCurrent(identity);
    }
    if (REMOTE_BROKER_OPS.has(op)) {
      this.assertTransport();
    }
    return this.transport.request(op, params);
  }

  async mutateIntent<M extends DesktopIntentMethod>(
    identity: DesktopIdentity,
    method: M,
    params: RemoteControlMethodMap[M]['params'],
  ): Promise<RemoteControlMethodMap[M]['result']> {
    this.assertCurrent(identity);
    this.assertTransport();
    // 冻结复制 params（含调用方 requestId）；后续派发使用冻结副本。
    const frozenParams = JSON.parse(JSON.stringify(params)) as RemoteControlMethodMap[M]['params'];
    const intent: DesktopUiIntent = {
      id: crypto.randomUUID(),
      profileId: identity.profileId,
      targetDeviceId: identity.targetDeviceId,
      method,
      params: frozenParams,
      outcome: 'unconfirmed',
    };
    // 先持久化 unconfirmed（冻结身份与方法参数）；本地写失败绝不派发远程 mutation。
    await this.ensureWriteReady();
    try {
      await this.writeUi((s) => ({ ...s, intents: [...s.intents, intent] }));
    } catch (e) {
      throw toError(e);
    }
    let result: RemoteControlMethodMap[M]['result'];
    try {
      // 持久化后走重新校验 identity 的 call（防止旧 profile 路由到新连接）。
      result = await this.call(identity, method, frozenParams);
    } catch (e) {
      const err = toError(e);
      try {
        await this.updateIntent(intent.id, {
          outcome: err.outcome,
          error: { code: err.code, message: err.message, outcome: err.outcome },
        });
      } catch (saveErr) {
        this.reportError(
          new DesktopRemoteError({
            code: 'INTENT_RECEIPT_SAVE_FAILED',
            message: `远程失败回执保存失败：${toError(saveErr).message}`,
            outcome: err.outcome,
          }),
        );
      }
      throw err;
    }
    try {
      await this.updateIntent(intent.id, { outcome: 'responded', result });
    } catch (saveErr) {
      const msg = `远程已受理但回执保存失败：${toError(saveErr).message}`;
      this.reportError(msg);
      throw new DesktopRemoteError({
        code: 'INTENT_RECEIPT_SAVE_FAILED',
        message: msg,
        outcome: 'unconfirmed',
      });
    }
    return result;
  }

  /** 严格回写 intent；失败向上抛，不吞错冒充保存成功。 */
  async updateIntent(id: string, patch: IntentPatch): Promise<void> {
    await this.ensureWriteReady();
    await this.writeUi((s) => ({
      ...s,
      intents: s.intents.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    }));
  }

  async deleteIntent(id: string): Promise<void> {
    await this.ensureWriteReady();
    await this.writeUi((s) => {
      const intent = s.intents.find((it) => it.id === id);
      if (intent && intent.outcome !== 'not-sent' && intent.outcome !== 'responded') {
        throw new DesktopRemoteError({
          code: 'INTENT_NOT_DELETABLE',
          message: 'unconfirmed intent 不可删除或编辑身份',
          outcome: 'unconfirmed',
        });
      }
      return { ...s, intents: s.intents.filter((it) => it.id !== id) };
    });
  }

  async saveDraft(key: string, draft: DesktopDraftEntry): Promise<void> {
    await this.ensureWriteReady();
    await this.writeUi((s) => ({ ...s, drafts: { ...s.drafts, [key]: draft } }));
  }

  async clearDraft(key: string, expected: readonly DesktopDraftEntry[]): Promise<void> {
    await this.ensureWriteReady();
    // 比较与写入在同一 ui_set 串行闭包内，基于最新持久快照；不匹配绝不写空草稿。
    await this.writeUi((s) => {
      const current = s.drafts[key];
      if (current && !isEmptyDraft(current) && !expected.some((e) => sameDraftContent(e, current))) {
        throw new DesktopRemoteError({
          code: 'DRAFT_CONFLICT',
          message: '持久草稿已被其他写入更新，未清空',
          outcome: 'not-sent',
        });
      }
      // 即使结果与缓存内容相同也照常写：必须有持久化 CAS 回执。
      return { ...s, drafts: { ...s.drafts, [key]: { text: '', files: [] } } };
    });
  }

  async draftKey(
    identity: DesktopIdentity,
    target: { kind: 'primary' | 'room'; id: string },
  ): Promise<string> {
    const data = `${identity.profileId}\u0000${identity.targetDeviceId}\u0000${target.kind}\u0000${target.id}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async pickFile(): Promise<DesktopDraftFileRef | null> {
    return this.transport.pickFile();
  }

  observe(
    identity: DesktopIdentity,
    target: LiveTarget,
    onEvent: (event: DesktopObservationEvent) => void,
  ): ObservationHandle {
    this.assertCurrent(identity);
    this.assertTransport();
    if (identity.targetDeviceId === '') {
      throw new DesktopRemoteError({
        code: 'IDENTITY_CHANGED',
        message: '目标设备未知，无法观察',
        outcome: 'not-sent',
      });
    }
    const observationId = crypto.randomUUID();
    let closed = false;
    let resolveReady!: () => void;
    let rejectReady!: (e: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // 内部标记 handled，避免未被组件捕获时泄漏 unhandled rejection；组件仍可自行 catch。
    ready.catch(() => {});

    const ack = (ev: WireEvent): void => {
      if (typeof ev.deliveryId === 'string') {
        void this.transport.request('observe_ack', { observationId, deliveryId: ev.deliveryId }).catch((e) => {
          // ACK 失败收束观察并显示错误；绝不重放 ACK 或自动重订阅。
          if (!closed) {
            closed = true;
            this.reportError(
              new DesktopRemoteError({
                code: 'OBSERVE_ACK_FAILED',
                message: `观察确认失败，观察已关闭：${toError(e).message}`,
                outcome: 'unconfirmed',
              }),
            );
            void ready
              .then(() => this.transport.unobserve(observationId), () => undefined)
              .catch(() => {});
          }
        });
      }
    };

    const onWire = (ev: WireEvent): void => {
      const isErrorFrame = ev.type === 'event' && 'error' in ev;
      // 已关闭：忽略事件但仍确认迟到 deliveryId。
      if (closed) {
        ack(ev);
        return;
      }
      // 同步调用视图回调（try/finally 语义：成功/失败都确认 deliveryId）。
      try {
        onEvent(ev);
      } catch (e) {
        this.reportError(e);
      }
      ack(ev);
      if (isErrorFrame) {
        closed = true;
        void ready
          .then(() => this.transport.unobserve(observationId), () => undefined)
          .catch(() => {});
      }
    };

    void this.transport
      .observe(observationId, identity.targetDeviceId, target, onWire)
      .then(
        () => {
          if (closed) {
            void this.transport.unobserve(observationId).catch(() => {});
          }
          resolveReady();
        },
        (e) => {
          const err = toError(e);
          if (!closed) {
            closed = true;
            this.reportError(err);
          }
          rejectReady(err);
        },
      );

    // close 当下即 closed=true；admission settled 后再幂等 unobserve；ready 失败静默释放。
    const close = (): Promise<void> => {
      closed = true;
      return ready
        .then(
          () => this.transport.unobserve(observationId),
          () => undefined,
        )
        .then(() => undefined)
        .catch(() => {});
    };

    return { ready, close };
  }
}

export function createDesktopClient(transport?: DesktopTransport): DesktopViewApiImpl {
  return new DesktopViewApiImpl(transport);
}
