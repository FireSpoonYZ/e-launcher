import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Harness, createRegistry, defineExtension, section, hook, GenerationTask } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { buildCompressSystemPrompt } from 'acp-kernel';
import { openHost } from './host.js';
import { acquireRuntimeOwner } from './runtime-owner.js';
import { parseModelRef } from './runtime-models.js';
import { getPrimaryConversation, RequestKeys, upgradeLegacyContextConversations } from './runtime-docs.js';
import { formatPrimarySubmission, normalizeHistoryOptions, readPrimaryHistory } from './runtime-history.js';
import { createContextManager } from './context-manager.js';
import { createContextTools } from './context-tools.js';
import { BC_KERNEL_VERSION } from './context-state.js';

const CTX = BACKGROUND_CONTEXT;

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertNonBlank(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw errWithCode(`${name} must be a non-empty string`, 'INVALID_ARGUMENT');
  }
}

/**
 * Open the Pi Durable primary private-chat runtime for one host.
 * Ownership of dataRoot is exclusive for the runtime's lifetime; close() releases it.
 */
export async function openRuntime(options) {
  const host = openHost({ dataRoot: options?.dataRoot });
  const models = options?.models ?? createModels();
  const defaultModel = options?.defaultModel ?? null;
  let releaseOwner = null;
  let storage = null;
  let harness = null;
  // 内嵌 Billion Context：每 Host 一个 registry/管理器，hook 仅随生成调度运行。
  const manager = createContextManager({ getHarness: () => harness, models });
  const registry = createRegistry();
  registry.install(defineExtension({
    name: 'host.billion-context',
    tools: createContextTools(manager),
    sections: [section('billion-context', () => buildCompressSystemPrompt())],
    hooks: [hook(GenerationTask, { beforeRequest: manager.prepare })],
  }));
  // 显式传入 models 才是主动模式：把旧 tools:[] 会话升级为继承 registry 默认工具。
  const upgradeLegacy = options?.models !== undefined;
  try {
    releaseOwner = acquireRuntimeOwner(host.dataRoot);
    storage = await openNodeSqliteStorage(join(host.dataRoot, 'durable.sqlite'));
    harness = await Harness.open(storage, {
      models,
      registry,
      settings: { compaction: { enabled: false } },
    }, CTX);
    if (upgradeLegacy) {
      await upgradeLegacyContextConversations(harness, CTX);
    }
  } catch (err) {
    if (harness) {
      try { await harness.close(CTX); } catch { /* close 失败不掩盖原错误 */ }
    } else if (storage) {
      try { await storage.close(CTX); } catch { /* close 失败不掩盖原错误 */ }
    }
    try { releaseOwner?.(); } catch { /* release 失败不掩盖原错误 */ }
    host.close();
    throw err;
  }
  return createRuntime({ host, harness, models, defaultModel, releaseOwner, manager });
}

function createRuntime({ host, harness, models, defaultModel, releaseOwner, manager }) {
  let closePromise = null;
  const close = () => {
    closePromise ??= (async () => {
      try {
        await harness.close(CTX);
      } finally {
        host.close();
        releaseOwner();
      }
    })();
    return closePromise;
  };

  return {
    async submit(botId, input) {
      assertNonBlank(botId, 'botId');
      const requestId = input?.requestId;
      const text = input?.text;
      assertNonBlank(requestId, 'requestId');
      assertNonBlank(text, 'text');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');

      let conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) {
        const modelRef = bot.modelRef ?? defaultModel;
        if (!modelRef) throw errWithCode('model is required', 'MODEL_REQUIRED');
        const ref = parseModelRef(modelRef);
        if (!models.getModel(ref.provider, ref.modelId)) {
          throw errWithCode(`model not found: ${modelRef}`, 'MODEL_NOT_FOUND');
        }
        conversation = await getPrimaryConversation(harness, bot, { create: true, defaultModel }, CTX);
      }

      // 持久化正文摘要用于去重：同 requestId 不同正文冲突，相同/首次保存。
      const digest = createHash('sha256').update(text).digest('hex');
      const key = 'r:' + requestId;
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(RequestKeys, conversation.id);
        const existing = doc.digests[key];
        if (existing !== undefined && existing !== digest) {
          throw errWithCode(`requestId already used with different text: ${requestId}`, 'REQUEST_CONFLICT');
        }
        doc.digests[key] = digest;
      }, CTX);

      // 已有提交：比较摘要后直接返回原回执，不再次调用模型。
      const record = await harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), CTX);
      if (record !== undefined) {
        return formatPrimarySubmission(harness, bot, record, CTX);
      }

      // 发新输入前验证会话实际（已持久化）模型仍在当前 models 中。
      const agent = await conversation.agent(CTX);
      const modelRef = agent.model;
      if (!modelRef) throw errWithCode('model is required', 'MODEL_REQUIRED');
      if (!models.getModel(modelRef.provider, modelRef.modelId)) {
        throw errWithCode(`model not found: ${modelRef.provider}/${modelRef.modelId}`, 'MODEL_NOT_FOUND');
      }

      const submission = await conversation.submit({ type: 'input', content: text, requestId }, CTX);
      return formatPrimarySubmission(harness, bot, await submission.status(CTX), CTX);
    },

    async wait(botId, requestId) {
      assertNonBlank(botId, 'botId');
      assertNonBlank(requestId, 'requestId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) throw errWithCode('submission not found', 'SUBMISSION_NOT_FOUND');
      const record = await harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), CTX);
      if (!record) throw errWithCode('submission not found', 'SUBMISSION_NOT_FOUND');
      // 已完结回执直接返回，不调用 Submission.wait（其上开头无条件 resume，会意外调度其他待处理任务）。
      if (record.status === 'done' || record.status === 'unanswered') {
        return formatPrimarySubmission(harness, bot, record, CTX);
      }
      const submission = await harness.submission(record.id, CTX);
      if (!submission) throw errWithCode('submission not found', 'SUBMISSION_NOT_FOUND');
      return formatPrimarySubmission(harness, bot, await submission.wait(CTX), CTX);
    },

    async getSubmission(botId, requestId) {
      assertNonBlank(botId, 'botId');
      assertNonBlank(requestId, 'requestId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) return null;
      const record = await harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), CTX);
      if (!record) return null;
      return formatPrimarySubmission(harness, bot, record, CTX);
    },

    async history(botId, options = {}) {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      const { limit, cursor } = normalizeHistoryOptions(options);
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) {
        return { botId, conversationId: bot.primaryConversationId, items: [], nextCursor: null };
      }
      const page = await readPrimaryHistory(conversation, { limit, cursor }, CTX);
      return { botId, conversationId: bot.primaryConversationId, ...page };
    },

    async abort(botId) {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) return;
      await conversation.abort(CTX);
    },

    async contextStatus(botId) {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      const status = conversation
        ? await manager.inspect(conversation.id, CTX)
        : { kernelVersion: BC_KERNEL_VERSION, status: null, blocks: [], messageRefs: { byRaw: {}, byRef: {} }, prepared: null };
      return { botId, conversationId: bot.primaryConversationId, ...status };
    },

    resume() {
      harness.resume();
    },

    close,
  };
}
