import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as durable from '@earendil-works/pi-durable';
import * as chord from '@earendil-works/chord';
import { Harness, createRegistry, defineExtension, section, hook, GenerationTask } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { InlineCodemodeSandbox } from '@earendil-works/pi-codemode/portable';
import { createCodingTools } from '@earendil-works/pi-durable/tools';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { createAndroidTools } from './android-tools.js';
import { createHostExecutionEnv } from './host-environment.js';
import { openHost } from './host.js';
import { acquireRuntimeOwner } from './runtime-owner.js';
import { parseExecutionOptions, parseModelRef, normalizeThinkingLevel, normalizeCodemodeFlag, describeModelCatalog, discoverProviderModels, applyCenterModels } from './runtime-models.js';
import { createGrepTool } from './grep-tool.js';
import { createFindTool } from './find-tool.js';
import { createLsTool } from './ls-tool.js';
import { getPrimaryConversation, RequestKeys, PrimaryIndex, applyAgentProfile } from './runtime-docs.js';
import { formatPrimarySubmission, normalizeHistoryOptions, readPrimaryHistory } from './runtime-history.js';
import { RequestContext, countMessageTokens, countRequestTokens } from './request-context.js';
import { resolveBotIdentity } from './bot-identity.js';
import { createPluginManager } from './plugins/manager.js';
import { createRuntimeLive } from './runtime-live.js';
import { readScopeHistory, readScopeMessage, readScopeMessageDelivery } from './runtime-scope-queries.js';
import { createWorkContextRuntime } from './runtime-work-contexts.js';
import { WorkIndex, WorkContextState, workInstructions } from './work-context-docs.js';
import { WorkDecisionState } from './work-decision-state.js';
import { createWorkDecisionRuntime } from './runtime-work-decisions.js';
import { normalizeUserMessage } from './scope-protocol.js';
import { createCommunicationTools } from './communication-tools.js';
import { createCollaborationService } from './collaboration-service.js';
import { renderCollaborationPrompt } from './collaboration-prompt.js';
import { createShowerManager } from './shower-manager.js';
import { createShowerTools } from './shower-tools.js';
import { createRuntimeShower } from './runtime-shower.js';
import { createScheduleManager } from './host-schedules.js';
import { createScheduleTools } from './schedule-tools.js';

const CTX = BACKGROUND_CONTEXT;
const BOTS_SYNC_THROTTLE_MS = 1000;
const ARCHIVE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ARCHIVE_PURGE_INTERVAL_MS = 6 * 3600 * 1000;

let quickJsWasmPromise = null;
function loadHostQuickJsWasm() {
  if (!quickJsWasmPromise) {
    quickJsWasmPromise = (async () => {
      const runtimeDir = dirname(fileURLToPath(import.meta.url));
      const candidates = [
        join(runtimeDir, 'quickjs.wasm'),
        join(runtimeDir, 'node_modules', 'quickjs-wasi', 'quickjs.wasm'),
      ];
      let lastErr = null;
      for (const candidate of candidates) {
        try {
          const bytes = await readFile(candidate);
          return await globalThis.WebAssembly.compile(bytes);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr ?? new Error('quickjs.wasm not found');
    })().catch((err) => {
      quickJsWasmPromise = null;
      throw err;
    });
  }
  return quickJsWasmPromise;
}

function createHostCodemodeSandbox() {
  return new InlineCodemodeSandbox({
    wasm: {
      then(onFulfilled, onRejected) {
        return loadHostQuickJsWasm().then(onFulfilled, onRejected);
      },
    },
  });
}

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

// 生命周期回执的线格式：错误码与短消息，绝不含配置或凭证。
function toRuntimeError(err) {
  const code = typeof err?.code === 'string' && err.code ? err.code : 'RUNTIME_APPLY_FAILED';
  const message = typeof err?.message === 'string' && err.message
    ? err.message.slice(0, 200) : 'runtime configuration could not be applied';
  return { code, message };
}

/**
 * 每 Bot FIFO 准入：同一 Bot 的发送、设置与工作操作串行，不同 Bot 互不阻塞。
 * 关闭时立即拒绝新准入，并排空已接纳操作（调用方仍各自收到自己的失败）。
 * 配置应用用 tryExclusive：同一条 lane 串行，但从不等待已有任务（忙即返回 false），
 * 因此不会与 send/设置或生命周期队列互相等死锁；准入暂停（启动/断线）时仍可应用配置。
 */
function createBotAdmission() {
  const lanes = new Map();
  const accepted = new Set();
  let closed = false;
  let suspended = false;

  function track(botId, start) {
    const task = Promise.resolve().then(start);
    lanes.set(botId, task);
    accepted.add(task);
    const release = () => {
      accepted.delete(task);
      if (lanes.get(botId) === task) lanes.delete(botId);
    };
    task.then(release, release);
    return task;
  }

  function admit(botId, operation) {
    if (typeof botId !== 'string' || botId === '') {
      return Promise.reject(errWithCode('botId must be a non-empty string', 'INVALID_ARGUMENT'));
    }
    if (closed || suspended) return Promise.reject(errWithCode('host is not connected', 'NOT_CONNECTED'));
    const start = () => {
      if (closed || suspended) throw errWithCode('host is not connected', 'NOT_CONNECTED');
      return operation();
    };
    const previous = lanes.get(botId);
    if (!previous) return track(botId, start);
    const task = previous.then(start, start);
    lanes.set(botId, task);
    accepted.add(task);
    const release = () => {
      accepted.delete(task);
      if (lanes.get(botId) === task) lanes.delete(botId);
    };
    task.then(release, release);
    return task;
  }

  /** 占用同一 lane 但不等已有任务：该 Bot 当前有排队/在操作时返回 false（调用方报 waiting-idle）。 */
  function tryExclusive(botId, operation) {
    if (typeof botId !== 'string' || botId === '') {
      return Promise.reject(errWithCode('botId must be a non-empty string', 'INVALID_ARGUMENT'));
    }
    if (closed || lanes.has(botId)) return Promise.resolve(false);
    return track(botId, () => {
      if (closed) throw errWithCode('host is not connected', 'NOT_CONNECTED');
      return operation();
    }).then(() => true);
  }

  async function close() {
    closed = true;
    while (accepted.size > 0) await Promise.allSettled([...accepted]);
  }

  return { admit, tryExclusive, close, suspend() { suspended = true; }, resume() { suspended = false; },
    async drain() { while (accepted.size) await Promise.allSettled([...accepted]); } };
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
  const centerRuntime = options?.centerRuntime;
  if (!centerRuntime?.snapshot || !centerRuntime.installer || typeof centerRuntime.getClient !== 'function') {
    throw errWithCode('center runtime is required', 'CENTER_OFFLINE');
  }
  const host = openHost({ dataRoot: options?.dataRoot });
  const models = options?.models ?? createModels();
  const defaultModel = null;
  let releaseOwner = null;
  let storage = null;
  let harness = null;
  let workContexts = null;
  let online = false;
  let botModels = {};
  let getBotEntryWatermark;
  let runtime;
  const collaboration = createCollaborationService({
    host,
    ...options?.collaboration,
    createLocalBot: (input) => runtime.createBot(input),
    scheduleLocalTask: (botId, input) => runtime.scheduleTask(botId, input),
    getLocalRuntime: () => runtime,
    getCenterClient: () => centerRuntime.getClient(),
  });

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

  // 每 Bot 准入队列归本 Runtime：send/设置/工作操作共用，关闭时先拒新准入再排空。
  const bots = createBotAdmission();
  bots.suspend();
  const decisions = createWorkDecisionRuntime({
    host,
    getHarness: () => harness,
    getWorkContexts: () => workContexts,
    models,
    defaultModel,
    context: CTX,
    // 工作决策的 stop/resume/advance 在同一 Bot 队列内执行；scope lane 在前，Bot lane 在后。
    admitBot: bots.admit,
    getProfile: (botId, workMeta) => botProfile(host, plugins, botModels, coreExtensions, finalBudgetExtension, botId, workMeta),
  });

  // 统一图形环境：管理器按注入的可信原生桥接（Android）或当前平台（Windows/Linux）选后端；
  // 构造不启动原生/进程资源，首次 ensure 才申请，随 Runtime 关闭释放。
  const shower = createShowerManager({ dataRoot: host.dataRoot, nativeBridge });
  const schedules = createScheduleManager({
    host,
    getRuntime: () => runtime,
    isOnline: () => online,
    nativeBridge,
  });
  const registry = createRegistry();
  registry.install(createCodingTools());
  registry.install(createToolSearchExtension());
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
      collaboration,
    }),
    sections: [section('host-collaboration', async (input, context) => renderCollaborationPrompt({
      device: await collaboration.getCurrentDevice(),
      botId: (await resolveBotIdentity(host, input.read, input.conversationId, context)).botId,
      cwd: input.env?.cwd ?? input.agent.cwd,
    }))],
  }));
  registry.install(defineExtension({
    name: 'host.schedule',
    tools: createScheduleTools({
      host,
      getHarness: () => harness,
      schedules,
      collaboration,
    }),
  }));
  // 原生桥接工具仅显式注入时注册：主会话与 work 身份共享同一 registry，二者均可见。
  if (nativeBridge) {
    registry.install(defineExtension({
      name: 'host.android-tools',
      tools: createAndroidTools({ host, getHarness: () => harness, nativeBridge }),
    }));
  }
  // 统一图形环境工具只在确有后端选择的平台注册（Android 原生桥接 / Windows / Linux）：
  // 其他平台保留六个 Runtime 方法（调用显式返回 SHOWER_UNAVAILABLE），不注册不可用工具。
  if (nativeBridge || process.platform === 'win32' || process.platform === 'linux') {
    registry.install(defineExtension({
      name: 'host.shower',
      tools: createShowerTools({ host, getHarness: () => harness, manager: shower }),
    }));
  }
  let plugins;
  const services = {
    host, models, getHarness: () => harness, context: CTX, getWorkContexts: () => workContexts,
    getWorkActivity: decisions.getWorkActivity,
    resolveConversationBot: async (id) => {
      const identity = await resolveBotIdentity(host, harness, id, CTX);
      const primary = await harness.snapshot(PrimaryIndex, CTX);
      const work = await harness.snapshot(WorkIndex, CTX);
      const owners = host.listBots().filter((bot) => bot.deviceId === host.deviceId && primary?.byPrimary?.[bot.primaryConversationId] === id)
        .map((bot) => ({ botId: bot.botId, scopeId: null }));
      for (const [key, binding] of Object.entries(work?.byKey ?? {})) {
        const pair = parseBindingKey(key);
        if (binding.nativeId === id && pair) owners.push({ botId: pair[0], scopeId: pair[1] });
      }
      if (owners.length !== 1 || owners[0].botId !== identity.botId || owners[0].scopeId !== identity.scopeId) {
        throw errWithCode('conversation has ambiguous ownership', 'BOT_CONTEXT_REQUIRED');
      }
      return identity.botId;
    },
    assertCapabilityAllowed: (botId, id) => plugins.assertCapabilityAllowed(botId, id),
    getExecutionEnv: async (botId) => envFor({ conversationId: 'plugin:' + botId, cwd: host.getBot(botId).cwd }),
    getBotEntryWatermark: (botId) => getBotEntryWatermark(botId),
    documents: { PrimaryIndex, RequestKeys, WorkIndex, WorkContextState, WorkDecisionState, RequestContext, ContextState: RequestContext },
    sdk: {
      ...durable,
      defineDoc: (definition) => durable.defineDoc({ checkpointWhen: () => false, ...definition }),
      defineDocFamily: (definition) => durable.defineDocFamily({ checkpointWhen: () => false, ...definition }),
      chord,
    }, countMessageTokens,
    centerClient: {
      listCapabilityTools: (...args) => {
        const client = centerRuntime.getClient();
        if (!client) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        return client.listCapabilityTools(...args);
      },
      callCapabilityTool: (...args) => {
        const client = centerRuntime.getClient();
        if (!client) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        return client.callCapabilityTool(...args);
      },
    },
  };
  plugins = createPluginManager({ host, registry, installer: centerRuntime.installer, services, isOnline: () => online });
  registry.install(defineExtension({
    name: 'host.request-context',
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        try {
          if (!online) throw errWithCode('center is offline', 'CENTER_OFFLINE');
          const botId = await services.resolveConversationBot(api.conversationId);
          const modelRef = botModels[botId]?.modelRef;
          if (!modelRef) throw errWithCode('center model is required', 'MODEL_REQUIRED');
          const expected = parseModelRef(modelRef);
          const task = await harness.getTask(api.taskId, context);
          const actual = task?.state?.checkpoint?.model;
          if (!actual || actual.provider !== expected.provider || actual.modelId !== expected.modelId) throw errWithCode('center model changed', 'INVALID_STATE');
          await decisions.beforeRequest(request, api, context);
          const requestView = await plugins.prepareContext(request, api, context);
          const checkpoint = task.state.checkpoint;
          const model = models.getModel(actual.provider, actual.modelId);
          if (!model || checkpoint.cutoff === undefined) throw errWithCode('request checkpoint is unavailable', 'INVALID_STATE');
          await harness.commit(async (tx) => {
            const doc = await tx.doc(RequestContext, api.conversationId);
            doc.prepared = {
              taskId: String(api.taskId), cutoff: checkpoint.cutoff,
              contextWindow: model.contextWindow, tokenCount: countRequestTokens(requestView),
              messages: requestView.messages,
            };
          }, context);
          if (!online) throw errWithCode('center is offline', 'CENTER_OFFLINE');
          return await plugins.beforeRequest(requestView, api, context);
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
  // Selected after each Bot's plugin hooks, so this check sees their complete request.
  const finalBudgetExtension = defineExtension({ name: 'cap-final-budget', hooks: [hook(GenerationTask, {
    async beforeRequest(request, api, context) {
      try {
        if (!online) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        const prepared = (await harness.snapshot(RequestContext, api.conversationId, context))?.prepared;
        if (!prepared || prepared.taskId !== String(api.taskId)) throw errWithCode('context is not prepared', 'INVALID_STATE');
        const added = Math.max(0, countRequestTokens(request) - countRequestTokens({ messages: prepared.messages }));
        if (prepared.tokenCount + added >= prepared.contextWindow) throw errWithCode('context limit reached', 'CONTEXT_LIMIT');
        await decisions.checkBudget(request, api, context);
      } catch (err) {
        if (!context.abortSignal?.aborted) await harness.abortTask(api.taskId, context);
        throw err;
      }
    },
  })] });
  const codemodeExtension = createCodemodeExtension({ sandbox: createHostCodemodeSandbox() });
  registry.install(codemodeExtension);
  registry.install(finalBudgetExtension);
  const coreExtensions = registry.snapshot().installed().filter((extension) => extension !== finalBudgetExtension && extension !== codemodeExtension);
  try {
    releaseOwner = acquireRuntimeOwner(host.dataRoot);
    storage = await openNodeSqliteStorage(join(host.dataRoot, 'durable.sqlite'));
    harness = await Harness.open(storage, {
      models,
      registry,
      settings: { compaction: { enabled: false }, extensions: coreExtensions },
      env: envFor,
    }, CTX);
  } catch (err) {
    if (harness) {
      try { await harness.close(CTX); } catch { /* close 失败不掩盖原错误 */ }
    } else if (storage) {
      try { await storage.close(CTX); } catch { /* close 失败不掩盖原错误 */ }
    }
    try { await plugins.close(); } catch { /* close 失败不掩盖原错误 */ }
    try { await schedules.close(); } catch { /* close 失败不掩盖原错误 */ }
    try { await shower.close(); } catch { /* close 失败不掩盖原错误 */ }
    try { await collaboration.close(); } catch { /* close 失败不掩盖原错误 */ }
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
    context: CTX,
    getProfile: (botId, workMeta) => botProfile(host, plugins, botModels, coreExtensions, codemodeExtension, finalBudgetExtension, botId, workMeta),
    // sync 提交成功后附着等待中的 work watch（事务外，观察失败不影响导入）。
    onBound: (botId, scopeId, binding) => live.bindWork(botId, scopeId, binding),
  });
  runtime = createRuntime({
    host,
    harness,
    models,
    defaultModel,
    releaseOwner,
    cleanupEnvs,
    live,
    workContexts,
    decisions,
    plugins,
    coreExtensions,
    codemodeExtension,
    finalBudgetExtension,
    centerRuntime,
    setOnline: (value) => { online = value; },
    setBotModels: (value) => { botModels = value; },
    getBotModels: () => botModels,
    setWatermarkReader: (fn) => { getBotEntryWatermark = fn; },
    botAdmissions: bots,
    onBotsChanged: options?.onBotsChanged,
    onBotsSync: options?.onBotsSync,
    collaboration,
    shower,
    schedules,
  });
  try {
    // 启动时初始化已有 Bot 的 SOUL 和会话人格；中心策略稍后应用。
    await runtime.initializeBots();
    schedules.start();
  } catch (err) {
    try { await runtime.close(); } catch { /* close 失败不掩盖启动错误 */ }
    throw err;
  }
  return runtime;
}

/** 构建该 Bot 的 SOUL、中心模型和明确的 core + 插件扩展视图。 */
function botProfile(host, plugins, botModels, coreExtensions, codemodeExtension, finalBudgetExtension, botId, workMeta) {
  const selection = botModels[botId] ?? {};
  const modelRef = selection.modelRef ?? null;
  let model;
  if (typeof modelRef === 'string' && modelRef.trim() !== '') {
    try { model = parseModelRef(modelRef.trim()); } catch { /* ignore invalid ref during profile snapshot */ }
  }
  const soul = host.getBotSoul(botId).text;
  const instructions = workMeta ? workInstructions(soul, workMeta) : (soul === '' ? null : soul);
  const pluginExtensions = plugins.extensionsFor(botId);
  const codemodeOnly = Boolean(selection.codemodeOnly);
  const codemodeEnabled = Boolean(selection.codemode) || codemodeOnly;
  const selectedExtensions = [
    ...coreExtensions,
    ...(codemodeEnabled && codemodeExtension ? [codemodeExtension] : []),
    ...pluginExtensions,
    finalBudgetExtension,
  ];
  // thinkingLevel 总是给出：(null 表示 SDK 默认) 才能让 reload 后重应用人格时回写变更。
  return {
    instructions,
    selectedExtensions,
    pluginTools: pluginExtensions.flatMap((extension) => extension.tools ?? []),
    thinkingLevel: selection.thinkingLevel ?? null,
    codemode: codemodeEnabled,
    codemodeOnly,
    ...(model ? { model } : {}),
  };
}

function parseBindingKey(key) {
  try {
    const pair = JSON.parse(key);
    return Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string') ? pair : null;
  } catch {
    return null;
  }
}

function createRuntime({ host, harness, models, defaultModel, releaseOwner, cleanupEnvs, live, workContexts, decisions, plugins, coreExtensions, codemodeExtension, finalBudgetExtension, centerRuntime, setOnline, setBotModels, getBotModels, setWatermarkReader, botAdmissions, collaboration, onBotsChanged, onBotsSync, shower, schedules }) {
  let closePromise = null;
  let closing = false;
  let centerOnline = false;
  let appliedRevision = null;
  let highestRevision = -1;
  let centerConfigured = false;
  let registryKey = null;
  // 每 Bot 已应用的执行内容摘要与版本：只用于判断“无需重建”，不参与授权。
  const botFingerprints = new Map();
  const botAppliedRevision = new Map();
  let lifecycle = Promise.resolve();
  let epoch = 0;
  const serial = (operation) => {
    const next = lifecycle.then(operation);
    lifecycle = next.catch(() => {});
    return next;
  };
  // 同一 Bot 的发送/设置/显式同步串行；内侧复用 raw 实现，避免自持同一 lane。
  const admitBot = botAdmissions.admit;
  // 本运行时已初始化过人格/工具的 Bot；新 Bot 经 initializeBot 增量加入。
  const initializedBots = new Set();

  // >= 1000ms 尾沿节流（trailing throttle）同步 Bot 元数据。
  const syncBotsCallback = onBotsSync ?? onBotsChanged ?? null;
  let botsSyncTimer = null;
  let botsSyncPending = false;
  let botsSyncRunning = false;
  let lastBotsSyncAt = 0;

  function runBotsSync() {
    if (closing || !syncBotsCallback) return;
    if (botsSyncRunning) {
      botsSyncPending = true;
      return;
    }
    botsSyncRunning = true;
    lastBotsSyncAt = Date.now();
    Promise.resolve()
      .then(() => syncBotsCallback())
      .catch(() => {})
      .finally(() => {
        botsSyncRunning = false;
        if (botsSyncPending && !closing) {
          botsSyncPending = false;
          scheduleBotsSync();
        }
      });
  }

  function scheduleBotsSync() {
    if (closing || !syncBotsCallback) return;
    if (botsSyncTimer !== null) return;
    const elapsed = Date.now() - lastBotsSyncAt;
    const delay = Math.max(BOTS_SYNC_THROTTLE_MS, BOTS_SYNC_THROTTLE_MS - elapsed);
    botsSyncTimer = setTimeout(() => {
      botsSyncTimer = null;
      runBotsSync();
    }, delay);
    botsSyncTimer.unref?.();
  }

  // 跟踪在飞的主会话提交：完成时记录 lastActivityAt 与 lastPreview。
  const trackedSubmissions = new Map(); // submissionId -> { botId, nativeId }
  const completedSubmissions = new Set(); // submissionId
  let submissionCheckPromise = null;
  let checkSubmissionsAgain = false;

  function recordCompletedSubmission(botId, formatted) {
    if (!formatted || formatted.status !== 'done') return;
    const submissionId = formatted.submissionId;
    if (submissionId !== undefined && submissionId !== null) {
      trackedSubmissions.delete(submissionId);
      if (completedSubmissions.has(submissionId)) return;
      completedSubmissions.add(submissionId);
    }
    try {
      host.recordBotActivity(botId, {
        lastActivityAt: new Date().toISOString(),
        lastPreview: formatted.answerText || '',
      });
      scheduleBotsSync();
    } catch {
      /* ignore activity update error if bot was deleted or store closed */
    }
  }

  function checkTrackedSubmissions() {
    if (closing || trackedSubmissions.size === 0) return;
    if (submissionCheckPromise) {
      checkSubmissionsAgain = true;
      return;
    }
    submissionCheckPromise = (async () => {
      try {
        do {
          checkSubmissionsAgain = false;
          if (closing || trackedSubmissions.size === 0) break;
          for (const [submissionId, info] of [...trackedSubmissions.entries()]) {
            if (closing) break;
            try {
              const sub = await harness.submission(submissionId, CTX);
              if (!sub) {
                trackedSubmissions.delete(submissionId);
                continue;
              }
              const statusRecord = await sub.status(CTX);
              if (statusRecord.status === 'done') {
                const bot = host.getBot(info.botId);
                if (bot) {
                  const formatted = await formatPrimarySubmission(harness, bot, statusRecord, CTX);
                  recordCompletedSubmission(info.botId, formatted);
                } else {
                  trackedSubmissions.delete(submissionId);
                }
              } else if (statusRecord.status === 'unanswered') {
                trackedSubmissions.delete(submissionId);
              }
            } catch {
              /* ignore transient/closing errors */
            }
          }
        } while (checkSubmissionsAgain && !closing);
      } finally {
        submissionCheckPromise = null;
      }
    })();
  }

  let unsubscribeCommits = null;
  try {
    unsubscribeCommits = harness.subscribeCommits((publication) => {
      if (closing || trackedSubmissions.size === 0) return;
      if (publication && Array.isArray(publication.changes) && publication.changes.some((c) => c?.type === 'submission')) {
        queueMicrotask(() => checkTrackedSubmissions());
      }
    });
  } catch {
    /* ignore if harness does not support subscribeCommits */
  }

  // 14 天归档自动删除定时器（每 6 小时检查一次）。
  let archivePurgeTimer = setInterval(() => {
    void purgeExpiredArchivedBots();
  }, ARCHIVE_PURGE_INTERVAL_MS);
  archivePurgeTimer.unref?.();

  const close = () => {
    closing = true;
    ++epoch;
    centerOnline = false;
    setOnline(false);
    if (botsSyncTimer !== null) {
      clearTimeout(botsSyncTimer);
      botsSyncTimer = null;
    }
    if (archivePurgeTimer !== null) {
      clearInterval(archivePurgeTimer);
      archivePurgeTimer = null;
    }
    if (unsubscribeCommits) {
      try { unsubscribeCommits(); } catch { /* ignore */ }
      unsubscribeCommits = null;
    }
    botAdmissions.suspend();
    plugins.suspend();
    plugins.abortActions();
    closePromise ??= (async () => {
      await lifecycle;
      // 同步封闭 Bot 新准入并开始排空：必须在本次 async 体的首个 await 之前调用，
      // 否则等待 decisions.close() 期间新设置/发送操作仍能入队。
      const botClose = botAdmissions.close();
      // 依次执行并收集每步错误：任何一步失败仍继续清理，最后显式抛出。
      const errors = [];
      try { await decisions.close(); } catch (err) { errors.push(err); }
      // 已接纳 Bot 操作在 harness/store 释放前排空。
      try { await botClose; } catch (err) { errors.push(err); }
      if (submissionCheckPromise) {
        try { await submissionCheckPromise; } catch { /* ignore */ }
      }
      // 再关闭定时任务与 Shower：丢弃排队操作并释放本 Host 拥有的资源，不把在飞结果留到关库之后。
      try { await schedules.close(); } catch (err) { errors.push(err); }
      try { await shower.close(); } catch (err) { errors.push(err); }
      // 排空已接纳导入，但共享消息账本须保留到原生工具退出。
      try { await workContexts.quiesce(); } catch (err) { errors.push(err); }
      try { await live.close(); } catch (err) { errors.push(err); }
      try { await collaboration.close(); } catch (err) { errors.push(err); }
      // Seal Durable before stopping plugin resources.
      const nativeClose = harness.close(CTX);
      const pluginQuiesce = plugins.quiesce();
      for (const result of await Promise.allSettled([nativeClose, pluginQuiesce])) {
        if (result.status === 'rejected') errors.push(result.reason);
      }
      try { await plugins.close(); } catch (err) { errors.push(err); }
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

  const profileFor = (botId, workMeta) => botProfile(host, plugins, getBotModels(), coreExtensions, codemodeExtension, finalBudgetExtension, botId, workMeta);

  // 统一图形环境的 Runtime 门面：Actor 只来自可信主会话或工作绑定，绝不采信调用方会话。
  const showerRuntime = createRuntimeShower({
    host,
    getHarness: () => harness,
    resolveWorkContext: (botId, scopeId) => workContexts.resolveWorkContext(botId, scopeId),
    takeoverWork: decisions.takeoverShower,
    manager: shower,
    context: CTX,
  });

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
    host.ensureBotSoul(botId);
    if (!initializedBots.has(botId)) {
      await refreshBotProfiles(bot);
      initializedBots.add(botId);
    }
  }

  async function createRuntimeBot(input) {
    if (closing) throw errWithCode('host is closing', 'NOT_CONNECTED');
    if (input?.modelRef != null) throw errWithCode('bot models are managed by the center', 'INVALID_ARGUMENT');
    const bot = host.createBot(input);
    await initializeBot(bot.botId);
    if (onBotsChanged) await onBotsChanged();
    else if (onBotsSync) await onBotsSync();
    else scheduleBotsSync();
    return bot;
  }

  /** 编辑准入：Bot 的任一已映射会话有 queued/placed 提交、活动任务（含手动压缩）或挂起工作决策则忙。 */
  async function assertBotIdle(bot) {
    const nativeIds = await botConversations(bot);
    if (nativeIds.length === 0) return;
    const inspection = await harness.inspect(CTX);
    const known = new Set(nativeIds);
    if (inspection.submissions.some((submission) => known.has(submission.conversationId)) ||
        inspection.tasks.some((task) => known.has(task.record.conversationId))) {
      throw errWithCode('bot has active or queued work', 'RUNTIME_BUSY');
    }
    for (const nativeId of nativeIds) {
      const state = await harness.snapshot(WorkDecisionState, nativeId, CTX);
      if (state?.pending) throw errWithCode('bot has an active work decision', 'RUNTIME_BUSY');
    }
  }

  /** 主会话的编辑前置：无会话返回 null；有活动任务/排队提交则忙（含手动压缩任务）。 */
  async function idlePrimaryConversation(bot) {
    const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
    if (!conversation) return null;
    const inspection = await harness.inspect(CTX);
    if (inspection.submissions.some((submission) => submission.conversationId === conversation.id) ||
        inspection.tasks.some((task) => task.record.conversationId === conversation.id)) {
      throw errWithCode('bot has active or queued work', 'RUNTIME_BUSY');
    }
    return conversation;
  }

  /**
   * 配置应用前的安全边界：该 Bot 不受其他 Bot 影响。
   * 任何未结束任务（含 blocked，不把未知状态当空闲）、排队提交、挂起决策、能力执行都算忙；
   * 检查失败也按忙处理，交给后续刷新重试。失效任务的显式清理在 reapStaleTasks。
   */
  async function botIsIdle(bot) {
    try {
      if (plugins.hasActiveExecutions(bot.botId)) return false;
      const nativeIds = await botConversations(bot);
      if (nativeIds.length === 0) return true;
      const known = new Set(nativeIds);
      const inspection = await harness.inspect(CTX);
      if (inspection.tasks.some((task) => known.has(task.record.conversationId))) return false;
      if (inspection.submissions.some((submission) => known.has(submission.conversationId))) return false;
      for (const nativeId of nativeIds) {
        const state = await harness.snapshot(WorkDecisionState, nativeId, CTX);
        if (state?.pending) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 只结束本 Bot 会话内明确属于本次被撤销能力的任务（按 durable 任务类型匹配）。
   * 不认识的 blocked 任务一律不动：保持忙、由状态对外可见，绝不静默清理别人的遗留任务。
   */
  async function reapStaleTasks(bot, staleKinds) {
    if (!staleKinds || staleKinds.size === 0) return;
    const nativeIds = await botConversations(bot);
    if (nativeIds.length === 0) return;
    const known = new Set(nativeIds);
    const inspection = await harness.inspect(CTX);
    const stale = inspection.tasks.filter((task) => known.has(task.record.conversationId) &&
      staleKinds.has(task.record.kind));
    for (const task of stale) {
      try { await harness.abortTask(task.record.id, CTX); }
      catch { /* 已被其他路径结束 */ }
    }
  }

  /** Bot 执行内容摘要：模型选择 + 启用的能力（含配置与凭证值），不含展示名称与 revision。 */
  function botExecutionFingerprint(selection, capabilities, credentials) {
    const entries = (capabilities ?? []).filter((capability) => capability.enabled).map((capability) => [
      capability.installationId, capability.kind, capability.target, capability.targetVersion,
      capability.effectiveConfig ?? null,
      (capability.target === 'host' ? capability.credentialRefs ?? [] : []).map((ref) => [ref, credentials?.[ref] ?? null]),
    ]);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return createHash('sha256').update(JSON.stringify([selection ?? null, entries])).digest('hex');
  }

  /**
   * 模型注册表指纹：只含影响注册/执行的字段（启用、api、baseUrl、引用的凭证值、模型参数）。
   * revision 与展示名称变化不重建 provider，所以单纯改名不会动运行中的模型对象。
   */
  function centerRegistryKey(snapshot) {
    const providers = (snapshot.providers ?? []).map((provider) => ({
      id: provider.id, enabled: provider.enabled, api: provider.api, baseUrl: provider.baseUrl,
      credential: provider.credentialRef == null ? null
        : [provider.credentialRef, snapshot.credentials?.[provider.credentialRef] ?? null],
      models: (snapshot.models?.[provider.id] ?? []).filter((model) => model.enabled).map((model) => ({
        id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: model.input,
        reasoning: model.reasoning, cost: model.cost, compat: model.compat ?? null,
        thinkingLevelMap: model.thinkingLevelMap ?? null, inputLimits: model.inputLimits ?? null,
      })),
    }));
    providers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return createHash('sha256').update(JSON.stringify(providers)).digest('hex');
  }

  async function purgeOneExpiredBot(botId) {
    const bot = host.getBot(botId);
    if (!bot || bot.isPrimary || !bot.archivedAt) return false;
    await assertBotIdle(bot);
    await schedules.deleteBot(bot);
    host.deleteBot({ botId });
    initializedBots.delete(botId);
    return true;
  }

  async function purgeExpiredArchivedBots() {
    if (closing) return;
    const cutoffIso = new Date(Date.now() - ARCHIVE_RETENTION_MS).toISOString();
    const expired = host.listExpiredArchivedBots(cutoffIso);
    if (expired.length === 0) return;
    let deletedAny = false;
    for (const bot of expired) {
      if (closing) break;
      try {
        const runPurge = () => purgeOneExpiredBot(bot.botId);
        const didDelete = centerOnline ? await admitBot(bot.botId, runPurge) : await runPurge();
        if (didDelete) deletedAny = true;
      } catch {
        /* 忙或出错忽略 */
      }
    }
    if (deletedAny) {
      if (onBotsSync) {
        try { await onBotsSync(); } catch { /* ignore */ }
      } else {
        scheduleBotsSync();
      }
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

  setWatermarkReader(async (botId) => botMaxEntryId(await requireBot(botId)));

  async function abortConversations() {
    if ((await harness.inspect(CTX)).scheduling === 'paused') return;
    const ids = new Set();
    for (const bot of host.listBots()) for (const id of await botConversations(bot)) ids.add(id);
    for (const id of ids) {
      const conversation = await harness.conversation(id, CTX);
      if (conversation) await conversation.abort(CTX, { background: true });
    }
  }

  function setCenterOnline(value) {
    if (!value) {
      // 仅真实断线走这里：关闭准入、中止执行、卸载能力。
      ++epoch;
      centerOnline = false;
      appliedRevision = null;
      botFingerprints.clear();
      botAppliedRevision.clear();
      setOnline(false);
      botAdmissions.suspend();
      plugins.suspend();
      plugins.abortActions();
      return serial(async () => { await abortConversations(); await botAdmissions.drain(); await plugins.quiesce(); });
    }
    const generation = epoch;
    return serial(async () => {
      if (closing || !centerConfigured || !centerRuntime.getClient() || generation !== epoch) throw errWithCode('center is offline', 'CENTER_OFFLINE');
      setOnline(true);
      try {
        // 单个能力激活失败只撤销该能力，其他 Bot 与基础聊天保持在线。
        const activation = await plugins.activate();
        // 激活失败的能力已被 manager 释放：同步清掉这些 Bot 的已应用指纹，
        // 否则下一轮核对会因指纹相等而跳过重试并伪报 applied。
        for (const item of activation?.capabilityErrors ?? []) {
          botFingerprints.delete(item.botId);
          botAppliedRevision.delete(item.botId);
        }
        if (generation !== epoch || !centerRuntime.getClient()) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        plugins.resumeAdmissions();
        centerOnline = true;
        botAdmissions.resume();
        schedules.notifyOnline();
        return activation;
      } catch (err) {
        centerOnline = false;
        setOnline(false);
        botAdmissions.suspend();
        plugins.suspend();
        plugins.abortActions();
        await plugins.quiesce().catch(() => {});
        throw err;
      }
    });
  }

  /**
   * 新快照校验后的即时撤销入口（内部，只由 HostService 生命周期调用，不对外暴露）：
   * 先**同步**删授权（先于任何 await / 部署 / 忙闲检查），再在生命周期队列里按 Bot 安全顺序
   * 通知 onPolicyChanged 并只结束属于被撤销能力的任务。应用阶段再次撤销幂等。
   */
  function revokeCenterCapabilities(snapshot) {
    const pending = [];
    if (!closing) {
      try {
        const valid = snapshot?.protocol === 1 && snapshot.deviceId === host.deviceId &&
          Number.isSafeInteger(snapshot.revision) && snapshot.revision >= highestRevision;
        if (valid) {
          const credentials = snapshot.credentials ?? {};
          const desired = new Map((snapshot.bots ?? []).map((bot) => [bot.botId, bot]));
          for (const record of host.listBots()) {
            const capabilities = desired.get(record.botId)?.capabilities ?? [];
            const stale = plugins.staleGrants(record.botId, capabilities, credentials);
            if (!stale.length) continue;
            // 先把任务类型名取下来，再做删除；之后的实例释放不会让这里丢信息。
            const kinds = plugins.capabilityTaskNames(stale);
            const dropped = plugins.dropGrants(record.botId, stale);
            if (!dropped.length) continue;
            pending.push({ botId: record.botId, ids: dropped, capabilities, kinds });
          }
        }
      } catch { /* 关闭中读不到 Bot 列表时，应用阶段仍会重做撤销 */ }
    }
    return serial(async () => {
      for (const item of pending) {
        try {
          await plugins.notifyGrants(item.botId, item.ids, item.capabilities);
          const record = host.getBot(item.botId);
          if (record) await reapStaleTasks(record, item.kinds);
        } catch { /* 撤销已完成；后续通知/清理失败不阻止其他 Bot */ }
      }
    });
  }

  /**
   * 单个 Bot 的配置应用（已在它的 admission lane 内，与 send/设置严格串行）：
   * 先收紧发生变化能力的授权（幂等），再只结束该能力的失效任务，最后在空闲边界切换模型/能力/profile。
   */
  async function applyBotConfiguration(record, selection, capabilities, deployment, credentials) {
    const botId = record.botId;
    try {
      // 1. 授权先收紧（幂等；新快照到达时 HostService 已先做过一次）。
      const stale = plugins.staleGrants(botId, capabilities, credentials);
      if (stale.length) await plugins.revoke(botId, stale, capabilities);
      // 2. 只结束受影响会话内明确属于被撤销能力的任务；其他未结束任务一律不碰。
      await reapStaleTasks(record, plugins.capabilityTaskNames(stale));
    } catch (err) {
      return { status: 'failed', error: toRuntimeError(err), capabilityErrors: [] };
    }
    // 3. 仍有未结束任务/提交/挂起决策 => 在当前版本继续服务，本次报 waiting-idle。
    if (!(await botIsIdle(record))) return { status: 'waiting-idle', error: null, capabilityErrors: [] };
    try {
      if (selection?.modelRef != null) {
        const ref = parseModelRef(selection.modelRef);
        if (!models.getModel(ref.provider, ref.modelId)) throw errWithCode('center selected model is unavailable', 'MODEL_NOT_FOUND');
      }
      normalizeThinkingLevel(selection?.thinkingLevel);
      normalizeCodemodeFlag(selection?.codemode, 'codemode');
      normalizeCodemodeFlag(selection?.codemodeOnly, 'codemodeOnly');
      const nextModels = { ...getBotModels() };
      if (selection && (selection.modelRef != null || selection.thinkingLevel != null || selection.codemode != null || selection.codemodeOnly != null)) nextModels[botId] = selection;
      else delete nextModels[botId];
      setBotModels(nextModels);
      const applied = await plugins.applyBot(record, capabilities, { deviceId: host.deviceId, credentials });
      await refreshBotProfiles(record);
      if (applied.capabilityErrors.length === 0) return { status: 'applied', error: null, capabilityErrors: [] };
      // 只有“目标版本未装且部署仍在进行中”才算等待；无计划或部署已失败一律报 failed，不得永久 waiting-idle。
      const pendingDeployment = applied.capabilityErrors.every((item) => item.error.code === 'CAPABILITY_NOT_INSTALLED' &&
        deployment.planned.has(item.installationId) && !deployment.failed.has(item.installationId));
      if (pendingDeployment) return { status: 'waiting-idle', error: null, capabilityErrors: applied.capabilityErrors };
      const deploymentFailed = applied.capabilityErrors.some((item) => deployment.failed.has(item.installationId));
      return {
        status: 'failed',
        error: deploymentFailed
          ? { code: 'DEPLOYMENT_FAILED', message: 'capability deployment failed' }
          : { code: 'CAPABILITY_APPLY_FAILED', message: 'one or more capabilities could not be applied' },
        capabilityErrors: applied.capabilityErrors,
      };
    } catch (err) {
      return { status: 'failed', error: toRuntimeError(err), capabilityErrors: [] };
    }
  }

  /**
   * 应用中心快照：不再全局断线。执行内容未变的 Bot 只确认版本；变化的 Bot
   * 在各自 admission lane 的空闲边界应用（模型/思考档位按请求边界、能力按 Bot），
   * 失败隔离到 Bot/能力并回报；failed 优先于 waiting-idle，两者同时存在时每 Bot 状态准确。
   */
  function applyCenterSnapshot(snapshot, options = {}) {
    const deployment = {
      planned: new Set(options?.deployment?.planned ?? []),
      failed: new Set(options?.deployment?.failed ?? []),
    };
    return serial(async () => {
      if (closing) throw errWithCode('host is closing', 'NOT_CONNECTED');
      if (snapshot?.protocol !== 1 || snapshot.deviceId !== host.deviceId ||
          !Number.isSafeInteger(snapshot.revision) || snapshot.revision < highestRevision) {
        throw errWithCode('invalid or stale center snapshot', 'INVALID_ARGUMENT');
      }
      highestRevision = snapshot.revision;
      // 模型注册表只在执行字段变化时重建；Bot 选择不在此处发布。
      const nextRegistryKey = centerRegistryKey(snapshot);
      if (nextRegistryKey !== registryKey) {
        applyCenterModels(snapshot, models);
        registryKey = nextRegistryKey;
      }
      centerConfigured = true;
      const credentials = snapshot.credentials ?? {};
      const desired = new Map((snapshot.bots ?? []).map((bot) => [bot.botId, bot]));
      const bots = [];
      const capabilityErrors = [];
      let waiting = false;
      for (const record of host.listBots()) {
        const botId = record.botId;
        const target = desired.get(botId) ?? null;
        const selection = target?.model ?? null;
        const capabilities = target?.capabilities ?? [];
        const receipt = { botId, desiredRevision: snapshot.revision,
          appliedRevision: botAppliedRevision.get(botId) ?? null, status: 'pending', error: null };
        const fingerprint = botExecutionFingerprint(selection, capabilities, credentials);
        if (plugins.isActive() && botFingerprints.get(botId) === fingerprint) {
          botAppliedRevision.set(botId, snapshot.revision);
          bots.push({ ...receipt, appliedRevision: snapshot.revision, status: 'applied' });
          continue;
        }
        let outcome = null;
        let ran = false;
        try {
          ran = await botAdmissions.tryExclusive(botId, async () => {
            outcome = await applyBotConfiguration(record, selection, capabilities, deployment, credentials);
          });
        } catch (err) {
          if (closing) throw errWithCode('host is closing', 'NOT_CONNECTED');
          outcome = { status: 'waiting-idle', error: null, capabilityErrors: [], cause: err };
          ran = true;
        }
        if (!ran) {
          waiting = true;
          bots.push({ ...receipt, status: 'waiting-idle' });
          continue;
        }
        capabilityErrors.push(...outcome.capabilityErrors);
        if (outcome.status === 'applied') {
          botFingerprints.set(botId, fingerprint);
          botAppliedRevision.set(botId, snapshot.revision);
          bots.push({ ...receipt, appliedRevision: snapshot.revision, status: 'applied' });
        } else if (outcome.status === 'waiting-idle') {
          waiting = true;
          bots.push({ ...receipt, status: 'waiting-idle' });
        } else {
          botAppliedRevision.delete(botId);
          bots.push({ ...receipt, appliedRevision: null, status: 'failed', error: outcome.error });
        }
      }
      // 本机已删除的 Bot：主循环不覆盖，这里只清记录并释放其能力绑定。
      for (const botId of [...botFingerprints.keys()]) {
        if (desired.has(botId) || host.getBot(botId)) continue;
        botFingerprints.delete(botId);
        botAppliedRevision.delete(botId);
        try {
          await plugins.revoke(botId, plugins.staleGrants(botId, [], credentials), []);
          await plugins.applyBot({ botId }, [], { deviceId: host.deviceId, credentials: {} });
        } catch { /* 已无能力可撤销时忽略 */ }
      }
      const failed = bots.some((bot) => bot.status === 'failed');
      const status = failed ? 'failed' : waiting ? 'waiting-idle' : 'applied';
      appliedRevision = status === 'applied' ? snapshot.revision : null;
      return {
        deviceId: host.deviceId, revision: snapshot.revision, appliedRevision, status,
        error: failed ? { code: 'RUNTIME_APPLY_FAILED', message: 'runtime configuration was only partially applied' } : null,
        bots, capabilityErrors,
      };
    });
  }

  function withCapabilityActivation(installationId, publish) {
    return serial(async () => {
      const generation = epoch;
      if (!centerRuntime.getClient()) return false;
      const initial = await harness.inspect(CTX);
      if (generation !== epoch || !centerRuntime.getClient() || initial.tasks.length || initial.submissions.length || plugins.hasActiveExecutions()) return false;
      const wasOnline = centerOnline;
      centerOnline = false;
      botAdmissions.suspend();
      plugins.suspend();
      await botAdmissions.drain();
      const inspection = await harness.inspect(CTX);
      if (generation !== epoch || !centerRuntime.getClient() || inspection.tasks.length || inspection.submissions.length || plugins.hasActiveExecutions()) {
        if (wasOnline && generation === epoch && centerRuntime.getClient()) { plugins.resumeAdmissions(); centerOnline = true; botAdmissions.resume(); }
        return false;
      }
      setOnline(false);
      await plugins.quiesce();
      appliedRevision = null;
      botFingerprints.clear();
      botAppliedRevision.clear();
      await publish();
      return true;
    });
  }

  const runtime = {
    applyCenterSnapshot, setCenterOnline, withCapabilityActivation, revokeCenterCapabilities,
    callCapabilityAction: (id, action, request) => plugins.action(id, action, request),
    getCurrentDevice: collaboration.getCurrentDevice,
    createBot: createRuntimeBot,
    getBot: (botId) => requireBot(botId),
    updateBotProfile: (input) => admitBot(input?.botId, async () => {
      const updated = host.updateBotProfile(input);
      if (onBotsSync) await onBotsSync();
      else if (onBotsChanged) await onBotsChanged();
      else scheduleBotsSync();
      return updated;
    }),
    initializeBot,

    async initializeBots() {
      await purgeExpiredArchivedBots();
      for (const bot of host.listBots()) await initializeBot(bot.botId);
    },

    setPrimaryBot: (botId) => admitBot(botId, async () => {
      const updated = host.setPrimaryBot({ botId });
      if (onBotsSync) await onBotsSync();
      else scheduleBotsSync();
      return updated;
    }),

    archiveBot: (botId) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.isPrimary) throw errWithCode('primary bot cannot be archived', 'PRIMARY_BOT_PROTECTED');
      await assertBotIdle(bot);
      await schedules.pauseBot(bot);
      const updated = host.archiveBot({ botId });
      if (onBotsSync) await onBotsSync();
      else scheduleBotsSync();
      return updated;
    }),

    unarchiveBot: (botId) => admitBot(botId, async () => {
      await requireBot(botId);
      const updated = host.unarchiveBot({ botId });
      if (onBotsSync) await onBotsSync();
      else scheduleBotsSync();
      return updated;
    }),

    deleteBot: (botId) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.isPrimary) throw errWithCode('primary bot cannot be deleted', 'PRIMARY_BOT_PROTECTED');
      await assertBotIdle(bot);
      await schedules.deleteBot(bot);
      const res = host.deleteBot({ botId });
      initializedBots.delete(botId);
      if (onBotsSync) await onBotsSync();
      else scheduleBotsSync();
      return res;
    }),

    async scheduleTask(botId, input) {
      const bot = await requireBot(botId);
      if (
        bot.archivedAt !== null &&
        bot.archivedAt !== undefined &&
        (input?.action === 'create' ||
          input?.action === 'update' ||
          (input?.action === 'setEnabled' && input?.enabled === true))
      ) {
        throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
      }
      return schedules.execute(bot, input, { taskId: 1 });
    },

    getExtensionCatalog() { throw errWithCode('capabilities are managed by the center', 'INVALID_STATE'); },
    getBotExtensions() { throw errWithCode('capabilities are managed by the center', 'INVALID_STATE'); },
    setBotExtensions() { throw errWithCode('capabilities are managed by the center', 'INVALID_STATE'); },

    async getBotSoul(botId) {
      await requireBot(botId);
      return host.getBotSoul(botId);
    },

    setBotSoul: (botId, input) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      await assertBotIdle(bot);
      const soul = host.setBotSoul(botId, input);
      await refreshBotProfiles(bot);
      return soul;
    }),

    setBotModel() { throw errWithCode('models are managed by the center', 'INVALID_STATE'); },

    // 发送占位到原生接纳/回执为止（不等模型完成）；并发设置保存因此能看到已排队提交。
    submit: (botId, input) => admitBot(botId, async () => {
      assertNonBlank(botId, 'botId');
      const requestId = input?.requestId;
      const text = input?.text;
      assertNonBlank(requestId, 'requestId');
      assertNonBlank(text, 'text');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
        throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
      }
      // 遗留 Bot 在首次运行使用前完成 SOUL 回填。
      await initializeBot(botId);
      const profile = profileFor(botId, null);
      if (!getBotModels()[botId]?.modelRef) throw errWithCode('center model is required', 'MODEL_REQUIRED');

      let conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) {
        const modelRef = getBotModels()[botId]?.modelRef;
        if (!modelRef) throw errWithCode('model is required', 'MODEL_REQUIRED');
        const ref = parseModelRef(modelRef);
        if (!models.getModel(ref.provider, ref.modelId)) {
          throw errWithCode(`model not found: ${modelRef}`, 'MODEL_NOT_FOUND');
        }
        conversation = await getPrimaryConversation(harness, { ...bot, modelRef }, {
          create: true,
          defaultModel: modelRef,
          thinkingLevel: profile.thinkingLevel,
          instructions: profile.instructions,
          removeTools: profile.removeTools,
          codemodeOnly: profile.codemodeOnly,
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
        if (record.status === 'queued' || record.status === 'placed') {
          trackedSubmissions.set(record.id, { botId, nativeId: conversation.id });
        }
        const formatted = await formatPrimarySubmission(harness, bot, record, CTX);
        if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
        return formatted;
      }

      // 发新输入前验证会话实际（已持久化）模型仍在当前 models 中。
      const agent = await conversation.agent(CTX);
      const modelRef = agent.model;
      if (!modelRef) throw errWithCode('model is required', 'MODEL_REQUIRED');
      if (!models.getModel(modelRef.provider, modelRef.modelId)) {
        throw errWithCode(`model not found: ${modelRef.provider}/${modelRef.modelId}`, 'MODEL_NOT_FOUND');
      }

      const submission = await conversation.submit({ type: 'input', content: text, requestId }, CTX);
      const statusRecord = await submission.status(CTX);
      trackedSubmissions.set(statusRecord.id, { botId, nativeId: conversation.id });
      const formatted = await formatPrimarySubmission(harness, bot, statusRecord, CTX);
      if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
      return formatted;
    }),

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
        const formatted = await formatPrimarySubmission(harness, bot, record, CTX);
        if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
        return formatted;
      }
      const submission = await harness.submission(record.id, CTX);
      if (!submission) throw errWithCode('submission not found', 'SUBMISSION_NOT_FOUND');
      trackedSubmissions.set(record.id, { botId, nativeId: conversation.id });
      const finalRecord = await submission.wait(CTX);
      const formatted = await formatPrimarySubmission(harness, bot, finalRecord, CTX);
      if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
      return formatted;
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
      const formatted = await formatPrimarySubmission(harness, bot, record, CTX);
      if (formatted.status === 'done') recordCompletedSubmission(botId, formatted);
      return formatted;
    },

    async history(botId, options = {}) {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      const historyOptions = normalizeHistoryOptions(options);
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) {
        return { botId, conversationId: bot.primaryConversationId, items: [], nextCursor: null };
      }
      const page = await readPrimaryHistory(conversation, historyOptions, CTX, { afterReset: true });
      return { botId, conversationId: bot.primaryConversationId, ...page };
    },

    // /clear：SDK 用 pi.reset 开新上下文（不换 conversationId、保留原始回执条目以维持 requestId 幂等），
    // 返回 reset 条目 id 作为所有客户端的可见历史起点。
    clearHistory: (botId) => admitBot(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
        throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
      }
      const conversation = await idlePrimaryConversation(bot);
      const conversationId = bot.primaryConversationId;
      if (!conversation) return { botId, conversationId, clearedThroughEntryId: 0 };
      await conversation.reset(undefined, CTX);
      // 空闲且无并发主会话操作时，reset 就是新的 head 标记；不猜其他条目 id。
      const head = (await conversation.context(CTX)).head;
      if (head?.kind !== durable.ResetEntry.kind) {
        throw errWithCode('reset entry is not the active context head', 'INVALID_STATE');
      }
      return { botId, conversationId, clearedThroughEntryId: head.id };
    }),

    // /compact：准入内只创建手动压缩任务（再来 clear/compact 会被活动任务检查拒绝），
    // 等待任务终态与摘要落地在准入外，不长期占用该 Bot 的 FIFO。
    async compact(botId) {
      assertNonBlank(botId, 'botId');
      const started = await admitBot(botId, async () => {
        const bot = await requireBot(botId);
        if (bot.archivedAt !== null && bot.archivedAt !== undefined) {
          throw errWithCode('bot is archived and read-only', 'BOT_ARCHIVED');
        }
        const conversation = await idlePrimaryConversation(bot);
        const conversationId = bot.primaryConversationId;
        if (!conversation) return { conversationId, taskId: null };
        return { conversationId, taskId: await conversation.compact(undefined, CTX) };
      });
      if (started.taskId === null) return { botId, conversationId: started.conversationId, compacted: false };
      const settled = await harness.waitForTask(started.taskId, CTX);
      const outcome = settled.state.outcome;
      if (outcome.status !== 'completed') {
        const reason = outcome.status === 'failed' || outcome.status === 'faulted'
          ? outcome.error.message
          : outcome.reason ?? outcome.status;
        throw errWithCode(`compaction ${outcome.status}: ${reason}`, 'COMPACTION_FAILED');
      }
      if (outcome.result?.entryId !== undefined) {
        return { botId, conversationId: started.conversationId, compacted: true };
      }
      const submissionId = outcome.result?.submissionId;
      if (submissionId === undefined) return { botId, conversationId: started.conversationId, compacted: false };
      // 会话空闲时 SDK 在任务的同一个 terminal commit 内已把摘要 write 置为 done；未落地就不算成功。
      const submission = await harness.submission(submissionId, CTX);
      if (!submission) throw errWithCode('compaction summary submission is missing', 'COMPACTION_FAILED');
      let record = await submission.status(CTX);
      if (record.status === 'queued' || record.status === 'placed') record = await submission.wait(CTX);
      if (record.status !== 'done') {
        throw errWithCode(`compaction summary is ${record.status}${record.status === 'unanswered' ? `: ${record.reason}` : ''} rather than placed`, 'COMPACTION_FAILED');
      }
      return { botId, conversationId: started.conversationId, compacted: true };
    },

    async abort(botId) {
      assertNonBlank(botId, 'botId');
      const bot = host.getBot(botId);
      if (!bot) throw errWithCode(`bot not found: ${botId}`, 'BOT_NOT_FOUND');
      const conversation = await getPrimaryConversation(harness, bot, {}, CTX);
      if (!conversation) return;
      await conversation.abort(CTX);
    },

    reloadModels() { throw errWithCode('models are managed by the center', 'INVALID_STATE'); },

    async discoverProviderModels(input) {
      return discoverProviderModels(input);
    },

    async getModelCatalog() {
      return describeModelCatalog(models, defaultModel);
    },

    async contextStatus(botId) {
      await requireBot(botId);
      return plugins.actionByName(botId, 'contextStatus', {});
    },

    memoryStatus: (botId, input) => plugins.actionByName(botId, 'memoryStatus', input),
    recallMemory: (botId, input) => plugins.actionByName(botId, 'recallMemory', input),
    reflectMemory: (botId, input) => plugins.actionByName(botId, 'reflectMemory', input),
    retainMemory: (botId, input) => plugins.actionByName(botId, 'retainMemory', input),
    getMemory: (botId, input) => plugins.actionByName(botId, 'getMemory', input),
    getMemorySource: (botId, input) => plugins.actionByName(botId, 'getMemorySource', input),
    correctMemory: (botId, input) => plugins.actionByName(botId, 'correctMemory', input),
    retryMemory: (botId, input) => plugins.actionByName(botId, 'retryMemory', input),

    getWorkContext: workContexts.getWorkContext,
    // 显式同步与发送/设置同队列：决策内部走 raw workContexts.syncWorkContext（已在 Bot 准入内），不会递归取 lane。
    syncWorkContext: (botId, scopeId, options) => admitBot(botId, () => workContexts.syncWorkContext(botId, scopeId, options)),
    workHistory: workContexts.workHistory,
    async workContextStatus(botId, scopeId) {
      await workContexts.resolveWorkContext(botId, scopeId);
      return plugins.actionByName(botId, 'contextStatus', { scopeId });
    },
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

    // 统一图形环境（Android/Windows/Linux 同签名）：status/frame 只读，takeover 复用 conversation.abort。
    getShowerStatus: showerRuntime.getShowerStatus,
    createShowerSession: showerRuntime.createShowerSession,
    getShowerFrame: showerRuntime.getShowerFrame,
    sendShowerInput: showerRuntime.sendShowerInput,
    takeoverShower: showerRuntime.takeoverShower,
    releaseShowerSession: showerRuntime.releaseShowerSession,

    resume() {
      harness.resume();
      decisions.resume();
    },

    watch(botId, options) {
      return live.watch(botId, options);
    },

    watchWork(botId, scopeId, options) {
      return live.watchWork(botId, scopeId, options);
    },

    close,
  };
  const lifecycleMethods = new Set(['initializeBots', 'applyCenterSnapshot', 'setCenterOnline', 'withCapabilityActivation', 'revokeCenterCapabilities', 'close']);
  return new Proxy(runtime, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function' || lifecycleMethods.has(key)) return value;
      return (...args) => {
        if (!centerOnline) throw errWithCode('center is offline', 'CENTER_OFFLINE');
        return value(...args);
      };
    },
  });
}
