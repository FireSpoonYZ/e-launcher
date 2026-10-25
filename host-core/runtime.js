import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Harness, createRegistry, defineExtension, section, hook, GenerationTask } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { buildCompressSystemPrompt } from 'acp-kernel';
import { createCodingTools } from '@earendil-works/pi-durable/tools';
import { createAndroidTools } from './android-tools.js';
import { createHostExecutionEnv } from './host-environment.js';
import { openHost } from './host.js';
import { acquireRuntimeOwner } from './runtime-owner.js';
import { parseExecutionOptions, parseModelRef, describeModelCatalog } from './runtime-models.js';
import { createGrepTool } from './grep-tool.js';
import { createFindTool } from './find-tool.js';
import { createLsTool } from './ls-tool.js';
import { getPrimaryConversation, RequestKeys, PrimaryIndex, upgradeLegacyContextConversations, applyAgentProfile } from './runtime-docs.js';
import { formatPrimarySubmission, normalizeHistoryOptions, readPrimaryHistory } from './runtime-history.js';
import { createContextManager } from './context-manager.js';
import { createContextTools } from './context-tools.js';
import { BC_KERNEL_VERSION } from './context-state.js';
import { createRuntimeLive } from './runtime-live.js';
import { readScopeHistory, readScopeMessage, readScopeMessageDelivery } from './runtime-scope-queries.js';
import { createWorkContextRuntime } from './runtime-work-contexts.js';
import { WorkIndex, WorkContextState, workInstructions } from './work-context-docs.js';
import { WorkDecisionState } from './work-decision-state.js';
import { createWorkDecisionRuntime } from './runtime-work-decisions.js';
import { normalizeUserMessage } from './scope-protocol.js';
import { createCommunicationTools } from './communication-tools.js';
import {
  previewLegacyImport as corePreviewLegacyImport,
  getLegacyImportStatus as coreGetLegacyImportStatus,
  importLegacySnapshot as coreImportLegacySnapshot,
  readLegacyDraft as coreReadLegacyDraft,
} from './legacy-import.js';
import { parseHindsightOptions } from './hindsight-client.js';
import { createRuntimeHindsight } from './runtime-hindsight.js';
import { createHindsightTools } from './hindsight-tools.js';
import { createHostExtensionManager, normalizeBotExtensions } from './extension-manager.js';

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
  // 可信原生桥接仅进程注入时接受：非函数直接拒绝，且绝不来自配置/HTTP/relay。
  const nativeBridge = options?.nativeBridge;
  if (nativeBridge !== undefined && typeof nativeBridge !== 'function') {
    throw errWithCode('nativeBridge must be a function', 'INVALID_ARGUMENT');
  }
  // 遗留 hindsight 选项在打开 host/任何写入前先归一化校验（类型/环境变量错误在写数据前拒绝）。
  parseHindsightOptions(options?.hindsight);
  const host = openHost({ dataRoot: options?.dataRoot });
  // 扩展管理归 Host extension manager（配置/目录/默认值/生命周期）；歧义输入由它拒绝。
  const extensions = createHostExtensionManager({
    host,
    extensions: options?.extensions,
    hindsight: options?.hindsight,
  });
  // manager 给出有效 hindsight 配置；未启用/未配置时为 null，控制器仍创建为禁用态。
  const hindsightOptions = parseHindsightOptions(extensions.hindsightConfig);
  const models = options?.models ?? createModels();
  const defaultModel = options?.defaultModel ?? null;
  let releaseOwner = null;
  let storage = null;
  let harness = null;
  let workContexts = null;
  let memory = null;

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
    getProfile: (botId, workMeta) => botProfile(host, extensions, hindsightTools, botId, workMeta),
  });
  // 始终创建禁用兼容控制器（config:null 不产生网络/存储/listener）；工具经 manager 注册。
  memory = createRuntimeHindsight({
    host,
    getHarness: () => harness,
    getWorkContexts: () => workContexts,
    getWorkActivity: decisions.getWorkActivity,
    getBotPolicy: (botId) => extensions.getPolicy(botId),
    config: hindsightOptions,
    context: CTX,
  });
  // 原生 Hindsight 扩展即使关闭也注册：定义按名字持久，可见性/可调用性由每 Bot 策略过滤。
  const hindsightTools = createHindsightTools(memory);
  extensions.registerRuntime('hindsight', {
    extension: defineExtension({ name: 'host.hindsight', tools: hindsightTools }),
    quiesce: () => memory.quiesce(),
    close: () => memory.close(),
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
      // Android 系统 sh 在描述中显式；Windows Git Bash 与 Linux bash 保持不变。
      const shell = process.platform === 'android'
        ? '/system/bin/sh'
        : process.platform === 'win32' ? 'Git Bash' : 'bash';
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
  // 原生桥接工具仅显式注入时注册：主会话与 work 身份共享同一 registry，二者均可见。
  if (nativeBridge) {
    registry.install(defineExtension({
      name: 'host.android-tools',
      tools: createAndroidTools({ host, getHarness: () => harness, nativeBridge }),
    }));
  }
  // 已注册扩展按原位置装入 registry：保持 core 扩展顺序与 BC-before-memory 链不变。
  extensions.install(registry);
  registry.install(defineExtension({
    name: 'host.billion-context',
    tools: createContextTools(manager),
    sections: [section('billion-context', () => buildCompressSystemPrompt())],
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        try {
          await decisions.beforeRequest(request, api, context);
          const prepared = await manager.prepare(request, api, context);
          // BC 消息作为实际首参：合并 request 与 prepared，不发明第 4 参。
          const requestView = { ...request, ...prepared };
          const memoryResult = await memory.beforeRequest(requestView, api, context);
          const result = memoryResult ?? prepared;
          await decisions.checkBudget(requestView, api, context);
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
    if (memory) {
      try { await extensions.quiesce(); } catch { /* quiesce 失败不掩盖原错误 */ }
      try { await extensions.close(); } catch { /* close 失败不掩盖原错误 */ }
    }
    try { await cleanupEnvs(); } catch { /* open 失败清理不掩盖原错误 */ }
    try { releaseOwner?.(); } catch { /* release 失败不掩盖原错误 */ }
    host.close();
    throw err;
  }
  const live = createRuntimeLive({
    host,
    getHarness: () => harness,
    // work watch 授权复用共享 MessageLog 的只读 resolveWorkContext（含 former-member 定向历史）。
    resolveWorkContext: (botId, scopeId) => workContexts.resolveWorkContext(botId, scopeId),
  });
  workContexts = createWorkContextRuntime({
    host,
    harness,
    manager,
    context: CTX,
    getProfile: (botId, workMeta) => botProfile(host, extensions, hindsightTools, botId, workMeta),
    // sync 提交成功后附着等待中的 work watch（事务外，观察失败不影响导入）。
    onBound: (botId, scopeId, binding) => live.bindWork(botId, scopeId, binding),
  });
  const runtime = createRuntime({
    host,
    harness,
    models,
    defaultModel,
    releaseOwner,
    manager,
    cleanupEnvs,
    live,
    workContexts,
    decisions,
    memory,
    extensions,
    hindsightTools,
  });
  try {
    // 启动时初始化既有 Bot（扩展默认值 + SOUL + 已绑定会话的人格/工具）。
    await runtime.initializeBots();
  } catch (err) {
    try { await runtime.close(); } catch { /* close 失败不掩盖启动错误 */ }
    throw err;
  }
  return runtime;
}

/** 每 Bot 人格/工具视图：实际 SOUL 文本 + manager 管理的工具移除项。 */
function botProfile(host, extensions, hindsightTools, botId, workMeta) {
  const soul = host.getBotSoul(botId).text;
  const byName = new Map(hindsightTools.map((tool) => [tool.name, tool]));
  const removeTools = extensions.disabledToolNames(botId).map((name) => byName.get(name)).filter(Boolean);
  const instructions = workMeta ? workInstructions(soul, workMeta) : (soul === '' ? null : soul);
  return { instructions, removeTools };
}

function parseBindingKey(key) {
  try {
    const pair = JSON.parse(key);
    return Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string') ? pair : null;
  } catch {
    return null;
  }
}

function createRuntime({ host, harness, models, defaultModel, releaseOwner, manager, cleanupEnvs, live, workContexts, decisions, memory, extensions, hindsightTools }) {
  let closePromise = null;
  let closing = false;
  // 本运行时已初始化过人格/工具的 Bot；新 Bot 经 initializeBot 增量加入。
  const initializedBots = new Set();
  // 已接纳的异步迁移操作（preview/status/import/draft）：closing 关准入，
  // close 在 harness/host 关闭前排空，避免半完成的导入或读取悬空。
  const legacyOps = new Set();
  const runLegacyOp = (operation) => {
    if (closing) return Promise.reject(errWithCode('host is closing', 'NOT_CONNECTED'));
    const op = Promise.resolve().then(operation);
    legacyOps.add(op);
    op.then(() => legacyOps.delete(op), () => legacyOps.delete(op));
    return op;
  };
  const drainLegacyOps = async () => {
    while (legacyOps.size > 0) {
      await Promise.allSettled([...legacyOps]);
    }
  };
  const close = () => {
    closing = true;
    closePromise ??= (async () => {
      // 依次执行并收集每步错误：任何一步失败仍继续清理，最后显式抛出。
      const errors = [];
      try { await decisions.close(); } catch (err) { errors.push(err); }
      // 排空已接纳迁移操作：必须在 harness/host 关闭前等待完成。
      try { await drainLegacyOps(); } catch (err) { errors.push(err); }
      // 排空已接纳导入，但共享消息账本须保留到原生工具退出。
      try { await workContexts.quiesce(); } catch (err) { errors.push(err); }
      try { await live.close(); } catch (err) { errors.push(err); }
      // Seal Durable first so memory cancellation cannot turn shutdown into a persistent task abort.
      const nativeClose = harness.close(CTX);
      const memoryQuiesce = extensions.quiesce();
      for (const result of await Promise.allSettled([nativeClose, memoryQuiesce])) {
        if (result.status === 'rejected') errors.push(result.reason);
      }
      try { await extensions.close(); } catch (err) { errors.push(err); }
      try { await workContexts.close(); } catch (err) { errors.push(err); }
      try { await cleanupEnvs(); } catch (err) { errors.push(err); }
      try { host.close(); } catch (err) { errors.push(err); }
      try { releaseOwner(); } catch (err) { errors.push(err); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'runtime close failed');
    })();
    return closePromise;
  };

  // 账本元数据/读取与用户发布仅经共享 MessageLog，不触碰模型、原生任务或 harness。
  const runMessageOperation = (operation) => {
    if (closing) return Promise.reject(new Error('work context runtime is closed'));
    return workContexts.runMessageOperation(operation);
  };

  const profileFor = (botId, workMeta) => botProfile(host, extensions, hindsightTools, botId, workMeta);

  /** Bot 已映射的原生会话（primary + work）：只读快照，不创建会话。 */
  async function botConversations(bot) {
    const nativeIds = [];
    const primaryIndex = await harness.snapshot(PrimaryIndex, CTX);
    const primary = primaryIndex?.byPrimary?.[bot.primaryConversationId];
    if (primary !== undefined) nativeIds.push(primary);
    const workIndex = await harness.snapshot(WorkIndex, CTX);
    for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
      const pair = parseBindingKey(key);
      if (pair !== null && pair[0] === bot.botId) nativeIds.push(binding.nativeId);
    }
    return nativeIds;
  }

  /** 按已绑定会话重新应用人格/工具；无变化不提交。 */
  async function refreshBotProfiles(bot) {
    const primary = await getPrimaryConversation(harness, bot, {}, CTX);
    if (primary) await applyAgentProfile(harness, primary.id, profileFor(bot.botId, null), CTX);
    const workIndex = await harness.snapshot(WorkIndex, CTX);
    for (const [key, binding] of Object.entries(workIndex?.byKey ?? {})) {
      const pair = parseBindingKey(key);
      if (pair === null || pair[0] !== bot.botId) continue;
      const meta = await harness.snapshot(WorkContextState, binding.nativeId, CTX);
      if (!meta?.scopeId || !meta.kind) continue;
      const profile = profileFor(bot.botId, { botId: bot.botId, scopeId: meta.scopeId, kind: meta.kind });
      await applyAgentProfile(harness, binding.nativeId, profile, CTX);
    }
  }

  /** 幂等初始化：扩展默认值 + SOUL 一次，再刷新已存在会话的人格/工具。 */
  async function initializeBot(botId) {
    assertNonBlank(botId, 'botId');
    if (closing) throw errWithCode('host is closing', 'NOT_CONNECTED');
    const bot = host.getBot(botId);
    if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
    await extensions.ensureBot(botId);
    if (!initializedBots.has(botId)) {
      await refreshBotProfiles(bot);
      initializedBots.add(botId);
    }
    return extensions.getBotExtensions(botId);
  }

  /** 编辑准入：Bot 的任一已映射会话有 queued/placed 提交或挂起工作决策则忙。 */
  async function assertBotIdle(bot) {
    const nativeIds = await botConversations(bot);
    if (nativeIds.length === 0) return;
    const inspection = await harness.inspect(CTX);
    const known = new Set(nativeIds);
    if (inspection.submissions.some((submission) => known.has(submission.conversationId))) {
      throw errWithCode('bot has active or queued work', 'RUNTIME_BUSY');
    }
    for (const nativeId of nativeIds) {
      const state = await harness.snapshot(WorkDecisionState, nativeId, CTX);
      if (state?.pending) throw errWithCode('bot has an active work decision', 'RUNTIME_BUSY');
    }
  }

  /** Bot 全部上下文当前最大 native entry id（无会话为 0）。 */
  async function botMaxEntryId(bot) {
    let max = 0;
    for (const nativeId of await botConversations(bot)) {
      const conversation = await harness.conversation(nativeId, CTX);
      if (!conversation) continue;
      const page = await conversation.entries({ order: 'descending' }, 1, undefined, CTX);
      const id = page?.items?.[0]?.id;
      if (Number.isSafeInteger(id) && id > max) max = id;
    }
    return max;
  }

  async function requireBot(botId) {
    assertNonBlank(botId, 'botId');
    const bot = host.getBot(botId);
    if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
    return bot;
  }

  // Hindsight 8 方法直接转发（read 方法直传，retain/correct 显式双参包装，内部 actor 不暴露）。
  return {
    initializeBot,

    async initializeBots() {
      for (const bot of host.listBots()) await initializeBot(bot.botId);
    },

    async getExtensionCatalog() {
      return extensions.listExtensions();
    },

    async getBotExtensions(botId) {
      await requireBot(botId);
      // 遗留 Bot 在首次读取前初始化（默认值 + SOUL），读取不创建会话。
      await extensions.ensureBot(botId);
      return extensions.getBotExtensions(botId);
    },

    async setBotExtensions(botId, input) {
      const bot = await requireBot(botId);
      const requested = normalizeBotExtensions(input?.extensions);
      await assertBotIdle(bot);
      await extensions.ensureBot(botId);
      const previous = extensions.getBotExtensions(botId).extensions.hindsight;
      const writeMode = requested.hindsight.enabled && requested.hindsight.mode === 'read-write';
      const wasWrite = previous.enabled && previous.mode === 'read-write';
      // 从关闭/只读转入读写才冻结下限：关闭期间的交换不回填。
      const options = writeMode && !wasWrite ? { retentionFloor: await botMaxEntryId(bot) } : undefined;
      const snapshot = await extensions.setBotExtensions(botId, input, options);
      // 空闲编辑不重置/分叉会话，下一次请求即生效。
      await refreshBotProfiles(bot);
      return snapshot;
    },

    async getBotSoul(botId) {
      await requireBot(botId);
      return host.getBotSoul(botId);
    },

    async setBotSoul(botId, input) {
      const bot = await requireBot(botId);
      await assertBotIdle(bot);
      const soul = host.setBotSoul(botId, input);
      await refreshBotProfiles(bot);
      return soul;
    },

    async submit(botId, input) {
      assertNonBlank(botId, 'botId');
      const requestId = input?.requestId;
      const text = input?.text;
      assertNonBlank(requestId, 'requestId');
      assertNonBlank(text, 'text');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      // 遗留 Bot 在首次运行使用前完成幂等初始化（扩展默认值 + SOUL 回填）。
      await initializeBot(botId);
      const profile = profileFor(botId, null);

      let conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) {
        const modelRef = bot.modelRef ?? defaultModel;
        if (!modelRef) throw errWithCode('model is required', 'MODEL_REQUIRED');
        const ref = parseModelRef(modelRef);
        if (!models.getModel(ref.provider, ref.modelId)) {
          throw errWithCode(`model not found: ${modelRef}`, 'MODEL_NOT_FOUND');
        }
        conversation = await getPrimaryConversation(harness, bot, {
          create: true,
          defaultModel,
          instructions: profile.instructions,
          removeTools: profile.removeTools,
        }, CTX);
      }
      // 新提交前刷新人格/工具（含空闲编辑后的下一次请求）；无变化不提交。
      await applyAgentProfile(harness, conversation.id, profile, CTX);

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

    async getModelCatalog() {
      return describeModelCatalog(models, defaultModel);
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

    memoryStatus: (botId, input) => memory.memoryStatus(botId, input),
    recallMemory: (botId, input) => memory.recallMemory(botId, input),
    reflectMemory: (botId, input) => memory.reflectMemory(botId, input),
    retainMemory: (botId, input) => memory.retainMemory(botId, input),
    getMemory: (botId, input) => memory.getMemory(botId, input),
    getMemorySource: (botId, input) => memory.getMemorySource(botId, input),
    correctMemory: (botId, input) => memory.correctMemory(botId, input),
    retryMemory: (botId, input) => memory.retryMemory(botId, input),

    getWorkContext: workContexts.getWorkContext,
    syncWorkContext: workContexts.syncWorkContext,
    workHistory: workContexts.workHistory,
    workContextStatus: workContexts.workContextStatus,
    getWorkActivity: decisions.getWorkActivity,
    stopWork: decisions.stopWork,
    resumeWork: decisions.resumeWork,

    createScope: (input) => runMessageOperation((log) => log.createScope(input)),
    updateScope: (scopeId, input) => runMessageOperation((log) => log.updateScope(scopeId, input)),
    getScopeState: (scopeId) => runMessageOperation((log) => log.getScopeState(scopeId)),
    listScopeStates: (options) => runMessageOperation((log) => log.listScopeStates(options)),
    publishUserMessage: (scopeId, input) => runMessageOperation((log) => log.publish(normalizeUserMessage(scopeId, input))),
    listScopeReplicas: (scopeId, options) => runMessageOperation((log) => log.listScopeReplicas(scopeId, options)),
    scopeHistory: (scopeId, options) => runMessageOperation((log) => readScopeHistory(log, scopeId, options)),
    getScopeMessage: (scopeId, messageId) => runMessageOperation((log) => readScopeMessage(log, scopeId, messageId)),
    getScopeMessageDelivery: (scopeId, messageId) => runMessageOperation((log) => readScopeMessageDelivery(log, scopeId, messageId)),

    // Legacy migration methods: reads never create primary or model tasks;
    // import runs the passive core importer on the shared harness. All are
    // admitted async ops drained before harness/host close.
    previewLegacyImport: (input) => runLegacyOp(() => corePreviewLegacyImport(host, input)),
    getLegacyImportStatus: (input) => runLegacyOp(() => coreGetLegacyImportStatus(host, input)),
    importLegacySnapshot: (input) => runLegacyOp(() => coreImportLegacySnapshot(host, harness, input, CTX)),
    readLegacyDraft: (input) => runLegacyOp(() => coreReadLegacyDraft(host, input)),

    resume() {
      harness.resume();
      decisions.resume();
      memory.resume();
    },

    watch(botId, options) {
      return live.watch(botId, options);
    },

    watchWork(botId, scopeId, options) {
      return live.watchWork(botId, scopeId, options);
    },

    close,
  };
}
