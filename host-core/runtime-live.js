// 模块 6：Bot 主私聊 committed live 预览（观察者）。
// 用 Durable Conversation.watch（结构视图）由 runtime-live-projection.js 投影安全状态；
// 只观察，不启动/中止/提交模型工作，外部 AbortSignal 只停止观察。
// SDK 的 watch.start 不投初始值：attach 成功先同步投影 native.value，再立即 start，
// 中间不 await，避免漏掉此间的 commit。
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { getPrimaryConversation } from './runtime-docs.js';
import { BotSessionState } from './bot-session-context.js';
import { emptyLiveState, projectLiveState, diffLiveState } from './runtime-live-projection.js';

const CTX = BACKGROUND_CONTEXT;

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertNonBlank(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw errWithCode(name + " must be a non-empty string", 'INVALID_ARGUMENT');
  }
}

// Turn admission statuses are Host-internal data crossing a wire boundary:
// validate structure strictly and bound every string so a status can never
// blow the per-frame budget or smuggle text/credentials into live frames.
const TURN_ADMISSION_PHASES = new Set(['queued', 'checking', 'synchronizing', 'failed']);
const MAX_TURN_REQUEST_ID_CHARS = 128;
const MAX_TURN_ERROR_CHARS = 256;

function boundText(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Validate/copy a TurnAdmissionStatus for the live wire. requestId and error
 * strings are capped; no other fields pass through. status null clears.
 */
function normalizeTurnAdmission(status) {
  if (status === null) return null;
  if (typeof status !== 'object' || Array.isArray(status)) {
    throw errWithCode('turn admission status must be an object or null', 'INVALID_ARGUMENT');
  }
  if (typeof status.requestId !== 'string' || status.requestId.trim() === '' ||
      !status.requestId.isWellFormed()) {
    throw errWithCode('turn admission requestId must be a non-empty well-formed string', 'INVALID_ARGUMENT');
  }
  if (!TURN_ADMISSION_PHASES.has(status.phase)) {
    throw errWithCode('turn admission phase must be queued, checking, synchronizing or failed', 'INVALID_ARGUMENT');
  }
  const normalized = { requestId: boundText(status.requestId, MAX_TURN_REQUEST_ID_CHARS), phase: status.phase };
  if (status.error !== undefined) {
    const error = status.error;
    if (typeof error !== 'object' || error === null || Array.isArray(error) ||
        typeof error.code !== 'string' || typeof error.message !== 'string' ||
        !error.code.isWellFormed() || !error.message.isWellFormed()) {
      throw errWithCode('turn admission error must be {code, message} strings', 'INVALID_ARGUMENT');
    }
    normalized.error = { code: boundText(error.code, MAX_TURN_ERROR_CHARS), message: boundText(error.message, MAX_TURN_ERROR_CHARS) };
  }
  return normalized;
}

/**
 * Merge the Host-side turn admission into a projected state for a primary
 * watch. queuedCount = pi.inbox items (projected) + Host-queued inputs, which
 * are disjoint sets — an input leaves the Host queue the moment it is
 * submitted to the SDK, so the sum never double counts.
 */
function withTurnAdmission(projected, admission) {
  // turnAdmission 恒写入（null 表示无等待项）：字段缺失时 diff 帧序列化会丢键，
  // 已发布的 admission 无法被清除。
  return {
    ...projected,
    turnAdmission: admission?.status ?? null,
    queuedCount: projected.queuedCount + (admission?.hostQueued ?? 0),
  };
}

// 投影 state 是纯 JSON 安全值：深冻结后对外暴露，防止任一消费者改写破坏后续 diff/帧。
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Bot 主私聊/远端工作上下文 live 观察控制器。
 * - watch()：Bot 主私聊。先登记待绑 watch（per-Bot map），再做只读
 *   getPrimaryConversation(create:false) 查映射：缺会话时返回空快照且保持待绑，绝不创建/
 *   启动模型。Runtime.submit 在会话解析/创建后、输入提交前调用 bind() 附着等待中的 watch。
 * - watchWork()：远端 scope 工作上下文。先登记待绑 watch（per-(bot,scope) map），再经
 *   resolveWorkContext 只读授权：未绑定 scope 发出空快照且保持待绑，绝不创建会话；
 *   syncWorkContext 提交成功后经 onBound→bindWork 附着等待中的 watch（绑定前 conversationId
 *   为 null，绑定后固定为公开 UUID）。work watch 只发 FULL snapshot 帧。
 * 两类 watch 共享同一生命周期/单飞行 attach/串行监听泵（projection 上限/深冻结/合并
 * 最新状态复用），不新增轮询。
 */
export function createRuntimeLive({ host, getHarness, resolveWorkContext }) {
  const pendingByBot = new Map(); // botId -> Set<watch>
  const pendingByWork = new Map(); // "botId\0scopeId" -> Set<watch>
  const watches = new Set(); // 全部未结束 watch，供 close 统一停止
  let closedFlag = false; // close 后拒绝新订阅逃逸
  const inflight = new Set(); // 已受理 lookup/attach/bind 异步工作，close 需要 join
  // botId -> {status, hostQueued}：最近一次的 Host 队列 admission 发布；
  // primary watch 每次投影时并入，绝不进 work watch。
  const admissionByBot = new Map();

  function track(task) {
    inflight.add(task);
    task.then(() => inflight.delete(task), () => inflight.delete(task));
    return task;
  }

  function workKey(botId, scopeId) {
    return botId + '\u0000' + scopeId;
  }

  function createWatch(bot, signal, work) {
    const botId = bot.botId;
    const state = {
      kind: 'pending', // 'pending' | 'attaching' | 'attached' | 'ended'
      native: null,
      attachPromise: null,
      // 未并入 admission 的 pi.inbox 计数基线：admission 重算 queuedCount 时以此为底，
      // 避免把已并入的 hostQueued 再累加一遍。
      inboxQueued: 0,
      current: deepFreeze(work ? emptyLiveState() : withTurnAdmission(emptyLiveState(), admissionByBot.get(botId) ?? null)),
      delivered: null, // null = 尚未投递首个快照
      seq: 0,
      dirty: false,
      pumping: false,
      started: false,
      listener: null,
      endReason: null,
      settleEnd: null,
      closed: null,
      removeAbort: null,
      forceFrame: false, // work 绑定后即使状态未变化也强制发一帧快照
      conversationId: work ? null : bot.primaryConversationId,
      // 该 watch 绑定的 native 会话 id（装载归属 doc 用）；与公开 conversationId 区分。
      nativeId: null,
      // 归属快照与待投影视图：单飞行装载循环只对最新 pendingView 取已提交
      // BotSessionState 快照后投影；首个快照落地前不发布任何帧——
      // 不先把无来源的 peer 正文当作用户消息推给客户端。
      sessionState: null,
      pendingView: null,
      attributionLoad: null,
    };
    state.closed = new Promise((resolve) => { state.settleEnd = resolve; });

    function end(reason, error) {
      if (state.endReason !== null) return;
      state.endReason = reason;
      state.kind = 'ended';
      state.removeAbort?.();
      state.removeAbort = null;
      watches.delete(watch);
      const key = work ? workKey(botId, work.scopeId) : botId;
      const pending = work ? pendingByWork.get(key) : pendingByBot.get(key);
      if (pending) {
        pending.delete(watch);
        if (pending.size === 0) {
          if (work) pendingByWork.delete(key);
          else pendingByBot.delete(key);
        }
      }
      state.settleEnd({ reason, ...(error !== undefined ? { error } : {}) });
    }

    function stopNative() {
      const native = state.native;
      return native ? native.stop() : Promise.resolve();
    }

    function kick() {
      if (state.pumping) return;
      state.pumping = true;
      queueMicrotask(() => void pump());
    }

    // 串行监听泵：只保留最新投影状态与已投递状态；消费者慢时合并（丢弃中间帧），
    // 无每事件无界队列。primary 帧在投递时按 diffLiveState(delivered, current) 整字段替换；
    // work 帧恒为完整快照（绑定/状态变化时都会发）。
    async function pump() {
      try {
        while (state.dirty) {
          state.dirty = false;
          if (state.endReason !== null || !state.started) break;
          let frame;
          if (state.delivered === null || state.forceFrame || (work && state.current !== state.delivered)) {
            frame = {
              type: 'snapshot',
              botId,
              ...(work ? { scopeId: work.scopeId } : {}),
              conversationId: state.conversationId,
              sequence: state.seq,
              state: state.current,
            };
            state.delivered = state.current;
            state.forceFrame = false;
          } else if (state.current !== state.delivered) {
            const changes = deepFreeze(diffLiveState(state.delivered, state.current));
            if (changes === null) { state.delivered = state.current; continue; }
            frame = { type: 'update', botId, conversationId: state.conversationId, sequence: state.seq, changes };
            state.delivered = state.current;
          } else {
            continue;
          }
          try {
            await state.listener(frame);
          } catch (err) {
            end('listener_error', err);
            void stopNative().catch(() => {});
            break;
          }
        }
      } finally {
        state.pumping = false;
      }
    }

    function start(listener) {
      if (typeof listener !== 'function') {
        throw errWithCode('listener must be a function', 'INVALID_ARGUMENT');
      }
      if (state.started) {
        throw errWithCode('start may only be called once', 'INVALID_ARGUMENT');
      }
      state.listener = listener;
      state.started = true;
      if (state.endReason !== null) return;
      state.dirty = true;
      kick();
    }

    // 结束观察并释放底层原生 watch。先落定本端 reason，再 await native.stop()，
    // 避免原生 closed 回调抢先覆盖 reason；不等待用户 listener。
    async function shutdown(reason) {
      if (state.endReason !== null) return state.closed;
      const native = state.native;
      end(reason);
      if (native) await native.stop();
      return state.closed;
    }

    function stop() {
      return shutdown('stopped');
    }

    // 原生 watcher 回调：只保存最新 view 并保证有且仅有一个归属装载在飞；
    // 同步返回，不调用 Session API/commit。attach 的 native.value/start 之间不 await。
    function onView(view) {
      if (state.endReason !== null) return;
      state.pendingView = view;
      if (state.attributionLoad === null) {
        const task = processAttribution();
        state.attributionLoad = task;
        track(task);
      }
    }

    // 单飞行归属装载：对最新 pendingView 先取已提交的 BotSessionState 快照再投影，
    // 保证生成/peer 条目的归属索引覆盖被投影的 view。快照期间到达的新 view 只保留
    // 最新一份，loop 再取一次快照覆盖它（新快照可归属旧帧，反向不行）。
    // 快照失败停在原地——下一次 view 重新进入装载；不在 finally 里立即重试。
    async function processAttribution() {
      try {
        while (state.endReason === null) {
          const view = state.pendingView;
          if (view === null || state.nativeId === null) return;
          let doc;
          try {
            doc = await getHarness().snapshot(BotSessionState, state.nativeId, CTX);
          } catch {
            return; // 等下一次 view 重试；Session 失败由 native.closed 收尾
          }
          if (state.endReason !== null) return;
          state.sessionState = doc ?? null;
          if (state.pendingView === view) {
            state.pendingView = null;
            publishView(view);
          }
          // pendingView 在 await 期间被替换：回到循环为最新 view 重取快照。
        }
      } finally {
        state.attributionLoad = null;
      }
    }

    // 用已装载的归属快照投影并投递一帧（diff 与原串行泵一致）。
    function publishView(view) {
      let next;
      try {
        next = projectLiveState(view, state.sessionState);
        state.inboxQueued = next.queuedCount;
        if (!work) next = withTurnAdmission(next, admissionByBot.get(botId) ?? null);
      } catch (err) {
        end('listener_error', err);
        void stopNative().catch(() => {});
        return;
      }
      const previous = state.current;
      state.current = deepFreeze(next);
      if (diffLiveState(previous, next) !== null) {
        state.seq++;
        if (state.started) {
          state.dirty = true;
          kick();
        }
      }
    }

    async function doAttach(conversation, binding) {
      if (state.endReason !== null || state.kind === 'attached') return;
      state.kind = 'attaching';
      if (signal?.aborted) { end('cancelled'); return; }
      let native;
      try {
        native = await conversation.watch(signal ? withAbortSignal(signal, CTX) : CTX);
      } catch (err) {
        if (signal?.aborted) end('cancelled');
        else end('session_failed', err);
        return;
      }
      if (state.endReason !== null) {
        // attach 完成前已 stop/关闭：释放这次刚获取的 watch。
        await native.stop();
        return;
      }
      state.native = native;
      state.kind = 'attached';
      const key = work ? workKey(botId, work.scopeId) : botId;
      const pending = work ? pendingByWork.get(key) : pendingByBot.get(key);
      if (pending) {
        pending.delete(watch);
        if (pending.size === 0) {
          if (work) pendingByWork.delete(key);
          else pendingByBot.delete(key);
        }
      }
      if (work) {
        // 绑定成功后固定公开 UUID，并强制发一帧快照（状态未变也通知客户端绑定结果）。
        state.conversationId = binding.conversationId;
        state.seq++;
        state.forceFrame = true;
      }
      // SDK start 不投初始值：登记归属装载（异步）后立即 start，中间不 await，不漏 commit。
      state.nativeId = conversation.id;
      onView(native.value);
      if (work && state.forceFrame) {
        state.dirty = true;
        kick();
      }
      try {
        // Durable 保证视图 watch 只发 value 调用：直接解构，onView 同步执行。
        native.start(({ value }) => { onView(value); });
      } catch (err) {
        await stopNative().catch(() => {});
        end('listener_error', err);
        return;
      }
      native.closed.then((nativeEnd) => {
        if (state.endReason !== null) return;
        // 新 WatchEnd.kind 映射回宿主既有 reason 词汇：control-live 的 END_REASONS 不变，
        // failed→session_failed、aborted→cancelled；stopped/ended/listener_error 原名透传。
        const kind = nativeEnd.kind;
        end(kind === 'failed' ? 'session_failed' : kind === 'aborted' ? 'cancelled' : kind, nativeEnd.error);
      }, () => {});
    }

    // 单飞行附着：并发 watch/bind 复用同一 attach promise，绝不创建重复底层 watch。
    // 入队供 close join：晚到 native handle 在 doAttach 内 stop 后才算完成。
    function attach(conversation, binding) {
      if (state.endReason !== null || state.kind === 'attached') return Promise.resolve();
      if (!state.attachPromise) {
        state.attachPromise = track(doAttach(conversation, binding).finally(() => { state.attachPromise = null; }));
      }
      return state.attachPromise;
    }

    // Host 侧 admission 发布到达：重投影当前态并入最新 admission。即使未绑
    // 原生会话（pending watch），已连接前端也能收到下一帧变化。
    function applyAdmission(targetBotId) {
      if (work || targetBotId !== botId || state.endReason !== null) return;
      const previous = state.current;
      // 以 inboxQueued 为底重算：previous.queuedCount 已含上一次并入的 hostQueued。
      const next = deepFreeze(
        withTurnAdmission({ ...previous, queuedCount: state.inboxQueued }, admissionByBot.get(botId) ?? null),
      );
      if (diffLiveState(previous, next) !== null) {
        state.current = next;
        state.seq++;
        if (state.started) {
          state.dirty = true;
          kick();
        }
      }
    }

    const watch = {
      _applyAdmission: applyAdmission,
      get value() {
        return {
          type: 'snapshot',
          botId,
          ...(work ? { scopeId: work.scopeId } : {}),
          conversationId: state.conversationId,
          sequence: state.seq,
          state: state.current,
        };
      },
      get closed() { return state.closed; },
      get ended() { return state.endReason !== null; },
      start,
      stop,
      shutdown,
      attach,
    };

    if (signal) {
      const onAbort = () => { void stopNative().catch(() => {}); end('cancelled'); };
      if (signal.aborted) {
        end('cancelled');
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        state.removeAbort = () => signal.removeEventListener('abort', onAbort);
      }
    }

    return watch;
  }

  async function bind(botId, conversation) {
    const pending = pendingByBot.get(botId);
    if (!pending || pending.size === 0) return;
    for (const w of [...pending]) {
      await w.attach(conversation);
    }
  }

  // 提交成功后（事务外）附着等待中的 work watch；观察失败只停止受影响 watch，不影响导入。
  // 整段列入 inflight：close 结束时已 join conversation lookup 与 attach。
  function bindWork(botId, scopeId, binding) {
    return track((async () => {
      const pending = pendingByWork.get(workKey(botId, scopeId));
      if (!pending || pending.size === 0) return;
      let conversation;
      try {
        conversation = await getHarness().conversation(binding.nativeId, CTX);
      } catch (err) {
        for (const w of [...pending]) {
          await w.shutdown('session_failed');
        }
        return;
      }
      for (const w of [...pending]) {
        await w.attach(conversation, binding);
      }
    })());
  }

  function watch(botId, options = {}) {
    return track((async () => {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode('bot not found: ' + botId, 'BOT_NOT_FOUND');
      const signal = options?.signal ?? undefined;
      const w = createWatch(bot, signal, null);
      if (w.ended) return w;
      if (closedFlag) {
        await w.shutdown('session_closed');
        return w;
      }
      watches.add(w);
      let pending = pendingByBot.get(botId);
      if (!pending) {
        pending = new Set();
        pendingByBot.set(botId, pending);
      }
      pending.add(w);
      let conversation;
      try {
        conversation = await getPrimaryConversation(getHarness(), bot, {}, CTX);
      } catch (err) {
        // 查映射失败：不留 watch，停止并清 pending 后再抛。
        await w.stop();
        throw err;
      }
      if (conversation) await bind(botId, conversation);
      return w;
    })());
  }

  function watchWork(botId, scopeId, options = {}) {
    return track((async () => {
      assertNonBlank(botId, 'botId');
      assertNonBlank(scopeId, 'scopeId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode('bot not found: ' + botId, 'BOT_NOT_FOUND');
      const signal = options?.signal ?? undefined;
      const w = createWatch(bot, signal, { scopeId });
      if (w.ended) return w;
      if (closedFlag) {
        await w.shutdown('session_closed');
        return w;
      }
      watches.add(w);
      const key = workKey(botId, scopeId);
      let pending = pendingByWork.get(key);
      if (!pending) {
        pending = new Set();
        pendingByWork.set(key, pending);
      }
      pending.add(w);
      try {
        // 先登记 pending 再异步授权，避免并发 sync 成功绑定后漏附。
        const authorized = await resolveWorkContext(botId, scopeId);
        if (authorized?.binding) {
          await bindWork(botId, scopeId, authorized.binding);
        }
      } catch (err) {
        // 授权失败：不留 watch，停止并清 pending 后再抛；若同时正在 close，回已结束 watch。
        if (closedFlag) {
          await w.shutdown('session_closed');
          return w;
        }
        await w.stop();
        throw err;
      }
      return w;
    })());
  }

  /**
   * Publish the next waiting primary-turn admission for a Bot. status null clears
   * it. hostQueued counts ONLY Host-side queued primary inputs not yet submitted
   * to the SDK; projection adds pi.inbox items itself, so they never double count.
   * The status applies to primary watches only — work watches never carry it.
   */
  function setTurnAdmission(botId, status, hostQueued = 0) {
    assertNonBlank(botId, 'botId');
    if (!Number.isSafeInteger(hostQueued) || hostQueued < 0) {
      throw errWithCode('hostQueued must be a safe nonnegative integer', 'INVALID_ARGUMENT');
    }
    const normalized = normalizeTurnAdmission(status);
    if (normalized === null && hostQueued === 0) {
      admissionByBot.delete(botId);
    } else {
      admissionByBot.set(botId, { status: normalized, hostQueued });
    }
    for (const w of watches) {
      w._applyAdmission(botId);
    }
  }

  async function close() {
    if (closedFlag) return;
    closedFlag = true;
    // seal 后不新附着：先反复排空全部已接受 watch（含封口前已放行的并发新增），
    // 再 join 已受理 lookup/attach/bind 异步工作；晚到的 native handle 由 doAttach
    // 在 endReason 已落定时自行 stop，close 等其完成后才返回。不等外部 listener。
    while (watches.size > 0) {
      const batch = [...watches];
      await Promise.allSettled(batch.map((w) => w.shutdown('session_closed')));
    }
    await Promise.allSettled([...inflight]);
    pendingByBot.clear();
    pendingByWork.clear();
  }

  return { watch, watchWork, bind, bindWork, setTurnAdmission, close };
}
