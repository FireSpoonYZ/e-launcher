import { defineDoc, configure } from '@earendil-works/pi-durable';
import { parseModelRef } from './runtime-models.js';
import { ContextState, BC_KERNEL_VERSION } from './context-state.js';

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Bot.primaryConversationId（公开 UUID）到 Durable 数字会话 ID 的映射。
// 与会话创建在同一 commit 中原子持久化；每 Host（每 durable.sqlite）一份。
export const PrimaryIndex = defineDoc({
  kind: 'host.primary-index',
  version: 1,
  scope: 'session',
  initial: () => ({ byPrimary: {} }),
});

// 本模块请求正文去重索引：key 为 'r:'+requestId，保存正文 SHA-256 摘要。
export const RequestKeys = defineDoc({
  kind: 'host.request-keys',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ digests: {} }),
});

/**
 * 在调用方事务内创建 ownerless 主会话并写 PrimaryIndex 映射。只适合在 commit 回调内调用；
 * 返回 Durable 数字会话 ID；已映射或并发重入时幂等返回既有 ID。
 * 缺模型显式抛 MODEL_REQUIRED（parseModelRef 对空值抛 INVALID_ARGUMENT），提交回滚，不产生半成品会话。
 */
export async function createPrimaryInTransaction(tx, bot, options = {}) {
  const primaryId = bot.primaryConversationId;
  const draft = await tx.doc(PrimaryIndex);
  const existing = draft.byPrimary[primaryId];
  if (existing !== undefined) return existing;

  const modelRef = bot.modelRef ?? options.defaultModel;
  if (!modelRef) {
    throw errWithCode('model is required', 'MODEL_REQUIRED');
  }
  const model = parseModelRef(modelRef);
  const record = await tx.createConversation({ ownership: { kind: 'ownerless' } });
  await configure(tx, record.id, {
    model,
    instructions: bot.role,
    cwd: bot.cwd,
    tools: null,
  });
  draft.byPrimary[primaryId] = record.id;
  return record.id;
}

/**
 * 解析 Bot 在本 Host Durable 库中的主私聊会话。
 * - 已映射：返回现有会话句柄。
 * - 未映射且 create=false：返回 null，不创建、不调度。
 * - 未映射且 create=true：在同一 commit 内重新查重、创建 ownerless 会话、
 *   用 parseModelRef 解析模型并配置代理，再把 UUID->数字ID 映射一并提交。
 */
export async function getPrimaryConversation(harness, bot, options, context) {
  const create = options?.create === true;
  const primaryId = bot.primaryConversationId;

  // 先快照查映射：已映射无需任何提交。
  const index = await harness.snapshot(PrimaryIndex, context);
  const mapped = index?.byPrimary[primaryId];
  if (mapped !== undefined) {
    return harness.conversation(mapped, context);
  }
  if (!create) return null;

  // commit 回调里只允许通过 tx 读写；会话句柄在提交完成后解析。
  const conversationId = await harness.commit(async (tx) => createPrimaryInTransaction(tx, bot, options), context);
  return harness.conversation(conversationId, context);
}

/**
 * 主动模式升级：旧版创建的会话受 tools:[] 限制，未启用 Billion Context。
 * 对已映射且尚无 ContextState 的会话清除该限制（tools:null 继承 registry 默认工具）。
 * 调用方只应在显式传入 models 的 active openRuntime 中执行；被动查询不做改造。
 */
export async function upgradeLegacyContextConversations(harness, context) {
  const index = await harness.snapshot(PrimaryIndex, context);
  if (!index) return;
  for (const conversationId of Object.values(index.byPrimary ?? {})) {
    const doc = await harness.snapshot(ContextState, conversationId, context);
    if (doc) {
      if (doc.kernelVersion !== BC_KERNEL_VERSION) {
        const err = new Error('kernel version mismatch: expected ' + BC_KERNEL_VERSION + ', found ' + doc.kernelVersion);
        err.code = 'UNSUPPORTED_SCHEMA';
        throw err;
      }
      continue;
    }
    await harness.commit(async (tx) => {
      await configure(tx, conversationId, { tools: null });
    }, context);
  }
}
