import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Harness, createRegistry, defineExtension, section, hook, GenerationTask } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { buildCompressSystemPrompt } from 'acp-kernel';
import { createCodingTools } from '@earendil-works/pi-durable/tools';
import { createHostExecutionEnv } from './host-environment.js';
import { openHost } from './host.js';
import { acquireRuntimeOwner } from './runtime-owner.js';
import { parseExecutionOptions, parseModelRef } from './runtime-models.js';
import { createGrepTool } from './grep-tool.js';
import { createFindTool } from './find-tool.js';
import { createLsTool } from './ls-tool.js';
import { getPrimaryConversation, RequestKeys, upgradeLegacyContextConversations } from './runtime-docs.js';
import { formatPrimarySubmission, normalizeHistoryOptions, readPrimaryHistory } from './runtime-history.js';
import { createContextManager } from './context-manager.js';
import { createContextTools } from './context-tools.js';
import { BC_KERNEL_VERSION } from './context-state.js';
import { createRuntimeLive } from './runtime-live.js';
import { createWorkContextRuntime } from './runtime-work-contexts.js';
import { createWorkDecisionRuntime } from './runtime-work-decisions.js';
import { createCommunicationTools } from './communication-tools.js';

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
  // 执行选项先于任何写数据校验：bashPath/toolPaths 类型错误在打开 host 前拒绝。
  const execution = parseExecutionOptions(options);
  const host = openHost({ dataRoot: options?.dataRoot });
  const models = options?.models ?? createModels();
  const defaultModel = options?.defaultModel ?? null;
  let releaseOwner = null;
  let storage = null;
  let harness = null;
  let workContexts = null;

  // 每 conversationId+cwd 一个执行环境；绝不 process.chdir 或默认 process.cwd，缺 cwd 明确报错。
  const envCache = new Map();
  const envFor = (target) => {
    const cwd = target.cwd;
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw errWithCode(`conversation ${target.conversationId} has no cwd; configure the bot cwd before sending`, 'INVALID_ARGUMENT');
    }
    const key = target.conversationId + '\u0000' + cwd;
    let env = envCache.get(key);
    if (!env) {
      env = createHostExecutionEnv({ cwd, bashPath: execution.bashPath });
      envCache.set(key, env);
    }
    return env;
  };
  const cleanupEnvs = async () => {
    const envs = [...envCache.values()];
    envCache.clear();
    const results = await Promise.allSettled(envs.map((env) => env.cleanup(CTX)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result) => result.reason), `env cleanup failed for ${failures.length} environment(s)`);
    }
  };

  // 内嵌 Billion Context：每 Host 一个 registry/管理器，hook 仅随生成调度运行。
  const manager = createContextManager({ getHarness: () => harness, models });
  const decisions = createWorkDecisionRuntime({
    host,
    getHarness: () => harness,
    getWorkContexts: () => workContexts,
    models,
    defaultModel,
    context: CTX,
  });
  const registry = createRegistry();
  registry.install(createCodingTools());
  registry.install(defineExtension({
    name: 'host.tools',
    tools: [
      createGrepTool({ dataRoot: host.dataRoot, toolPaths: execution.toolPaths }),
      createFindTool({ dataRoot: host.dataRoot, toolPaths: execution.toolPaths }),
      createLsTool(),
    ],
    sections: [section('host-execution', (input) => {
      const shell = process.platform === 'win32' ? 'Git Bash' : 'bash';
      const cwd = input.env?.cwd ?? input.agent.cwd;
      return `Tools execute on this host (device ${host.deviceId}) through ${shell}; they are not sandboxed. Default working directory: ${JSON.stringify(cwd ?? null)}.`;
    })],
  }));
  registry.install(defineExtension({
    name: 'host.communication',
    tools: createCommunicationTools({
      host,
      getHarness: () => harness,
      getMessageLog: () => workContexts.getMessageLog(),
      publishWork: decisions.publishWork,
    }),
  }));
  registry.install(defineExtension({
    name: 'host.billion-context',
    tools: createContextTools(manager),
    sections: [section('billion-context', () => buildCompressSystemPrompt())],
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        try {
          await decisions.beforeRequest(request, api, context);
          const result = await manager.prepare(request, api, context);
          await decisions.checkBudget(request, api, context);
          return result;
        } catch (err) {
          if (!context.abortSignal?.aborted) {
            // SDK 会吞普通 hook 异常；用本次 invocation context 取消当前任务，避免 join 自身。
            try {
              await harness.abortTask(api.taskId, context);
            } catch (abortErr) {
              if (!context.abortSignal?.aborted) throw abortErr;
            }
          }
          throw err;
        }
      },
    })],
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
      env: envFor,
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
    try { await cleanupEnvs(); } catch { /* open 失败清理不掩盖原错误 */ }
    try { releaseOwner?.(); } catch { /* release 失败不掩盖原错误 */ }
    host.close();
    throw err;
  }
  const live = createRuntimeLive({ host, getHarness: () => harness });
  workContexts = createWorkContextRuntime({ host, harness, manager, context: CTX });
  return createRuntime({ host, harness, models, defaultModel, releaseOwner, manager, cleanupEnvs, live, workContexts, decisions });
}

function createRuntime({ host, harness, models, defaultModel, releaseOwner, manager, cleanupEnvs, live, workContexts, decisions }) {
  let closePromise = null;
  const close = () => {
    closePromise ??= (async () => {
      // 依次执行并收集每步错误：任何一步失败仍继续清理，最后显式抛出。
      const errors = [];
      try { await decisions.close(); } catch (err) { errors.push(err); }
      // 排空已接纳导入，但共享消息账本须保留到原生工具退出。
      try { await workContexts.quiesce(); } catch (err) { errors.push(err); }
      try { await live.close(); } catch (err) { errors.push(err); }
      try { await harness.close(CTX); } catch (err) { errors.push(err); }
      try { await workContexts.close(); } catch (err) { errors.push(err); }
      try { await cleanupEnvs(); } catch (err) { errors.push(err); }
      try { host.close(); } catch (err) { errors.push(err); }
      try { releaseOwner(); } catch (err) { errors.push(err); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'runtime close failed');
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

      // 会话解析/创建后、输入提交前，绑定等待中的 live watch（不等待外部 listener）。
      await live.bind(botId, conversation);

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

    getWorkContext: workContexts.getWorkContext,
    syncWorkContext: workContexts.syncWorkContext,
    workHistory: workContexts.workHistory,
    workContextStatus: workContexts.workContextStatus,
    getWorkActivity: decisions.getWorkActivity,
    stopWork: decisions.stopWork,
    resumeWork: decisions.resumeWork,

    resume() {
      harness.resume();
      decisions.resume();
    },

    watch(botId, options) {
      return live.watch(botId, options);
    },

    close,
  };
}
