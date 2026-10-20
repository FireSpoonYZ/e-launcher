// 模块 6：Bot 主私聊 committed live 预览（观察者）。
// 用 Durable Conversation.watch（结构视图）由 runtime-live-projection.js 投影安全状态；
// 只观察，不启动/中止/提交模型工作，外部 AbortSignal 只停止观察。
// SDK 的 watch.start 不投初始值：attach 成功先同步投影 native.value，再立即 start，
// 中间不 await，避免漏掉此间的 commit。
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { getPrimaryConversation } from './runtime-docs.js';
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

// 投影 state 是纯 JSON 安全值：深冻结后对外暴露，防止任一消费者改写破坏后续 diff/帧。
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Bot 主私聊 live 观察控制器。watch() 先登记待绑 watch（per-Bot map），再做只读
 * getPrimaryConversation(create:false) 查映射：缺会话时返回空快照且保持待绑，绝不创建/
 * 启动模型。Runtime.submit 在会话解析/创建后、输入提交前调用 bind() 附着等待中的 watch。
 */
export function createRuntimeLive({ host, getHarness }) {
  const pendingByBot = new Map(); // botId -> Set<watch>
  const watches = new Set(); // 全部未结束 watch，供 close 统一停止
  let closedFlag = false; // close 后拒绝新订阅逃逸

  function createWatch(bot, signal) {
    const botId = bot.botId;
    const conversationId = bot.primaryConversationId;
    const state = {
      kind: 'pending', // 'pending' | 'attaching' | 'attached' | 'ended'
      native: null,
      attachPromise: null,
      current: deepFreeze(emptyLiveState()),
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
    };
    state.closed = new Promise((resolve) => { state.settleEnd = resolve; });

    function end(reason, error) {
      if (state.endReason !== null) return;
      state.endReason = reason;
      state.kind = 'ended';
      state.removeAbort?.();
      state.removeAbort = null;
      watches.delete(watch);
      const pending = pendingByBot.get(botId);
      if (pending) {
        pending.delete(watch);
        if (pending.size === 0) pendingByBot.delete(botId);
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
    // 无每事件无界队列。update 帧在投递时按 diffLiveState(delivered, current) 整字段替换。
    async function pump() {
      try {
        while (state.dirty) {
          state.dirty = false;
          if (state.endReason !== null || !state.started) break;
          let frame;
          if (state.delivered === null) {
            frame = { type: 'snapshot', botId, conversationId, sequence: state.seq, state: state.current };
            state.delivered = state.current;
          } else if (state.current !== state.delivered) {
            const changes = deepFreeze(diffLiveState(state.delivered, state.current));
            if (changes === null) { state.delivered = state.current; continue; }
            frame = { type: 'update', botId, conversationId, sequence: state.seq, changes };
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

    // 原生 watcher 回调：同步投影+入队，立即返回，不调用 Session API/commit。
    function onView(view) {
      if (state.endReason !== null) return;
      let next;
      try {
        next = projectLiveState(view);
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

    async function doAttach(conversation) {
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
      const pending = pendingByBot.get(botId);
      if (pending) {
        pending.delete(watch);
        if (pending.size === 0) pendingByBot.delete(botId);
      }
      // SDK start 不投初始值：先同步投影 native.value 再立即 start，中间不 await，不漏 commit。
      onView(native.value);
      try {
        native.start((view) => { onView(view); });
      } catch (err) {
        await stopNative().catch(() => {});
        end('listener_error', err);
        return;
      }
      native.closed.then((nativeEnd) => {
        if (state.endReason !== null) return;
        end(nativeEnd.reason, nativeEnd.error);
      }, () => {});
    }

    // 单飞行附着：并发 watch/bind 复用同一 attach promise，绝不创建重复底层 watch。
    function attach(conversation) {
      if (state.endReason !== null || state.kind === 'attached') return Promise.resolve();
      if (!state.attachPromise) {
        state.attachPromise = doAttach(conversation).finally(() => { state.attachPromise = null; });
      }
      return state.attachPromise;
    }

    const watch = {
      get value() {
        return { type: 'snapshot', botId, conversationId, sequence: state.seq, state: state.current };
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

  async function watch(botId, options = {}) {
    assertNonBlank(botId, 'botId');
    const bot = host.getBot(botId);
    if (!bot) throw errWithCode('bot not found: ' + botId, 'BOT_NOT_FOUND');
    const signal = options?.signal ?? undefined;
    const w = createWatch(bot, signal);
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
  }

  async function close() {
    if (closedFlag) return;
    closedFlag = true;
    // 已接受订阅以 session_closed 结束（harness 即将关闭）；pending 一并释放。
    await Promise.allSettled([...watches].map((w) => w.shutdown('session_closed')));
    pendingByBot.clear();
    watches.clear();
  }

  return { watch, bind, close };
}
