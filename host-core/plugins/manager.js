import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Ajv from 'ajv';
import { defineExtension } from '@earendil-works/pi-durable';
import { loadNativePlugin } from './index.js';
import { createMcpDriver } from '../capabilities/mcp.js';
import { createSkillDriver } from '../capabilities/skill.js';

const error = (code, message) => Object.assign(new Error(message), { code });
const nameFor = (...parts) => 'cap-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const botKey = (botId, installationId) => botId + '\u0000' + installationId;
// 能力错误的线格式只允许短错误码与短消息，绝不回显配置或凭证。
const describe = (err) => ({
  code: typeof err?.code === 'string' && err.code ? err.code : 'CAPABILITY_APPLY_FAILED',
  message: typeof err?.message === 'string' && err.message ? err.message.slice(0, 200) : 'capability could not be applied',
});

export function createPluginManager({ host, registry, installer, services, isOnline }) {
  const ajv = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, strict: false });
  ajv.addFormat('credential-ref', true);
  let instances = new Map(); // installationId -> { plugin, manifest, version, bots, taskExtension }
  let active = false;
  let accepting = false;
  const activeOperations = new Map(); // 在飞操作 -> 所属 Bot（未知为 null）
  let policy = new Map(); // botId -> Map(installationId -> EffectiveCapability)
  const activeActions = new Set();
  const fingerprints = new Map(); // botId\0installationId -> 已应用的执行内容摘要
  // 本轮 applyBot 的准备上下文：仅用于放行能力自身在 prepare 期间的中心只读调用。
  let round = null;

  function assertCapabilityAllowed(botId, installationId) {
    if (!isOnline()) throw error('CENTER_OFFLINE', 'center is offline');
    if (!policy.get(botId)?.get(installationId)?.enabled) {
      throw error('EXTENSION_DISABLED', 'capability is disabled for this Bot');
    }
  }

  async function runAccepted(operation, botId = null) {
    if (!accepting) throw error('RUNTIME_BUSY', 'capability execution is not accepting new work');
    const running = Promise.resolve().then(operation);
    activeOperations.set(running, botId);
    try { return await running; } finally { activeOperations.delete(running); }
  }

  async function checkOwner(botId, installationId, conversationId) {
    assertCapabilityAllowed(botId, installationId);
    if (await services.resolveConversationBot(conversationId) !== botId) {
      throw error('BOT_CONTEXT_REQUIRED', 'conversation is not owned by this Bot');
    }
    assertCapabilityAllowed(botId, installationId);
  }

  function guardContributions(bot, installationId, botId) {
    const source = bot.durableContributions ?? {};
    if (source.tasks?.length) throw error('INVALID_ARGUMENT', 'Bot contributions cannot register tasks');
    const tools = source.tools?.map((tool) => ({
      ...tool,
      async execute(args, api, context) {
        return runAccepted(async () => {
          await checkOwner(botId, installationId, api.conversationId);
          return tool.execute(args, api, context);
        }, botId);
      },
    }));
    const sections = source.sections?.map((item) => ({
      ...item,
      async render(input, context) {
        return runAccepted(async () => {
          await checkOwner(botId, installationId, input.conversationId);
          return item.render(input, context);
        }, botId);
      },
    }));
    const hooks = source.hooks?.map((item) => ({
      ...item,
      handlers: Object.fromEntries(Object.entries(item.handlers).map(([key, fn]) => [key, async (...args) => {
        return runAccepted(async () => {
          const api = args[args.length - 2];
          await checkOwner(botId, installationId, api.conversationId);
          return fn(...args);
        }, botId);
      }])),
    }));
    const wraps = source.wraps?.map((item) => ({
      ...item,
      wrap(original) {
        const wrapped = item.wrap(original);
        if (item.tool) return { ...wrapped, async execute(args, api, context) {
          return runAccepted(async () => {
            await checkOwner(botId, installationId, api.conversationId);
            return wrapped.execute(args, api, context);
          }, botId);
        } };
        return { ...wrapped, async render(input, context) {
          return runAccepted(async () => {
            await checkOwner(botId, installationId, input.conversationId);
            return wrapped.render(input, context);
          }, botId);
        } };
      },
    }));
    return { ...source, tasks: undefined, tools, sections, hooks, wraps };
  }

  /** 执行内容摘要：只包含会改变执行结果的字段（配置、凭证值、版本），不含展示名称。 */
  function capabilityFingerprint(capability, credentials) {
    const refs = capability.target === 'host' ? capability.credentialRefs ?? [] : [];
    return createHash('sha256').update(JSON.stringify([
      capability.kind, capability.target, capability.targetVersion,
      capability.effectiveConfig ?? null,
      refs.map((ref) => [ref, credentials?.[ref] ?? null]),
    ])).digest('hex');
  }

  /**
   * 需要重建/撤销授权的能力：当前已授权或已绑定，但执行内容已变/已禁用/已移除。
   * 供调用方在“等空闲之前”先收紧授权。
   */
  function staleGrants(botId, capabilities, credentials) {
    const desired = new Map();
    for (const capability of capabilities ?? []) desired.set(capability.installationId, capability);
    const ids = new Set([...(policy.get(botId)?.keys() ?? [])]);
    for (const [installationId, instance] of instances) {
      if (instance.bots.has(botId)) ids.add(installationId);
    }
    const stale = [];
    for (const id of ids) {
      const next = desired.get(id);
      if (!next?.enabled) { stale.push(id); continue; }
      if (fingerprints.get(botKey(botId, id)) !== capabilityFingerprint(next, credentials)) stale.push(id);
    }
    return stale;
  }

  /**
   * 同步删除授权（策略维度，不做任何 await）：供调用方在拿到新快照后先于部署/空闲检查执行。
   * 返回确实被删除的安装 ID（用于后续幂等通知）。
   */
  function dropGrants(botId, installationIds) {
    const dropped = [];
    for (const id of installationIds ?? []) {
      const hadGrant = policy.get(botId)?.delete(id) === true;
      fingerprints.delete(botKey(botId, id));
      if (hadGrant) dropped.push(id);
    }
    return dropped;
  }

  /** 异步通知插件策略（按 Bot 安全顺序由调用方安排）；失败不阻止撤销。 */
  async function notifyGrants(botId, installationIds, capabilities) {
    const desired = new Map();
    for (const capability of capabilities ?? []) desired.set(capability.installationId, capability);
    for (const id of installationIds ?? []) {
      const entry = instances.get(id)?.bots.get(botId);
      if (!entry) continue;
      const next = desired.get(id);
      try {
        await entry.bot.onPolicyChanged?.({ enabled: next?.enabled === true,
          effectiveConfig: next?.effectiveConfig ?? {} });
      } catch { /* 策略通知失败不阻止撤销 */ }
    }
  }

  /**
   * 立即撤销这些能力的授权并通知插件策略（策略维度，独立于实例生命周期）：
   * 旧贡献即使还没释放，后续工具/hook/动作调用也会在授权检查处被拒绝。
   */
  async function revoke(botId, installationIds, capabilities) {
    const dropped = dropGrants(botId, installationIds);
    if (dropped.length) await notifyGrants(botId, dropped, capabilities);
  }

  /** 这些安装实例注册的 Durable 任务名：用于撤销时只结束受影响任务。 */
  function capabilityTaskNames(installationIds) {
    const names = new Set();
    for (const id of installationIds ?? []) {
      for (const task of instances.get(id)?.plugin.durableTasks ?? []) names.add(task.definition.name);
    }
    return names;
  }

  async function releaseInstance(id) {
    const instance = instances.get(id);
    if (!instance || instance.bots.size > 0) return;
    instances.delete(id);
    if (instance.taskExtension) registry.uninstall(instance.taskExtension);
    await instance.plugin.close();
  }

  /** 撤销一个 Bot/能力绑定：先收紧授权，再关闭贡献，错误只收集不抛出。 */
  async function releaseEntry(id, botId, notify) {
    policy.get(botId)?.delete(id);
    fingerprints.delete(botKey(botId, id));
    const instance = instances.get(id);
    const entry = instance?.bots.get(botId);
    if (!entry) return [];
    instance.bots.delete(botId);
    if (entry.extension) registry.uninstall(entry.extension);
    const errors = [];
    if (notify) {
      try { await entry.bot.onPolicyChanged?.(notify); } catch (err) { errors.push(err); }
    }
    try { await entry.bot.quiesce(); } catch (err) { errors.push(err); }
    try { await entry.bot.close(); } catch (err) { errors.push(err); }
    try { await releaseInstance(id); } catch (err) { errors.push(err); }
    return errors;
  }

  /** 打开（或复用）一个安装实例；版本不一致时不复用，由调用方隔离为该能力的失败。 */
  async function openInstance(capability) {
    const id = capability.installationId;
    const existing = instances.get(id);
    if (existing) {
      if (existing.version !== capability.targetVersion) {
        throw error('CAPABILITY_NOT_INSTALLED', 'capability version is not installed');
      }
      return { instance: existing, created: false };
    }
    let installed = null;
    if (!(capability.kind === 'mcp' && capability.target === 'center')) {
      installed = await installer.getInstalled(id);
      if (!installed || installed.version !== capability.targetVersion) {
        throw error('CAPABILITY_NOT_INSTALLED', 'capability version is not installed');
      }
    }
    const checkTarget = (requestedId, botId, allowPreparation) => {
      if (requestedId !== id) throw error('FORBIDDEN', 'capability does not match');
      if (allowPreparation && round?.preparing.has(botKey(botId, id)) && round.enabled.has(botKey(botId, id))) return;
      assertCapabilityAllowed(botId, id);
    };
    const scopedHost = { ...services,
      async tryRunBackgroundTask(botId, task) {
        if (!accepting || !isOnline() || !policy.get(botId)?.get(id)?.enabled) return false;
        await runAccepted(async () => { assertCapabilityAllowed(botId, id); await task(); }, botId);
        return true;
      },
      centerClient: {
        async listCapabilityTools(requestedId, botId, ...args) {
          checkTarget(requestedId, botId, true);
          const result = await services.centerClient.listCapabilityTools(requestedId, botId, ...args);
          checkTarget(requestedId, botId, true);
          return result;
        },
        async callCapabilityTool(requestedId, botId, ...args) {
          checkTarget(requestedId, botId, false);
          const result = await services.centerClient.callCapabilityTool(requestedId, botId, ...args);
          checkTarget(requestedId, botId, false);
          return result;
        },
      },
    };
    const args = {
      installationId: id, version: capability.targetVersion,
      target: capability.target, packageRoot: installed?.packageRoot ?? null,
      dataDir: installed?.dataDir ?? join(host.dataRoot, 'center-capabilities', id),
      host: scopedHost,
    };
    const manifest = installed?.manifest ?? {};
    const plugin = capability.kind === 'mcp' ? await createMcpDriver(args)
      : capability.kind === 'skill' ? await createSkillDriver(args)
      : await loadNativePlugin({ ...args, entry: manifest.components?.host?.entry });
    const instance = { plugin, manifest, version: capability.targetVersion, bots: new Map(), taskExtension: null };
    instances.set(id, instance);
    if (plugin.durableTasks?.length) {
      const tasks = plugin.durableTasks.map((task) => ({ ...task, definition: {
        ...task.definition,
        phases: Object.fromEntries(Object.entries(task.definition.phases).map(([name, phase]) => [name, async (taskState, runtime, context) => {
          return runAccepted(async () => {
            const botId = await services.resolveConversationBot(runtime.conversationId);
            assertCapabilityAllowed(botId, id);
            return phase(taskState, runtime, context);
          });
        }])),
      } }));
      instance.taskExtension = defineExtension({ name: nameFor(id, 'tasks'), tasks });
      try {
        registry.install(instance.taskExtension);
      } catch (err) {
        instances.delete(id);
        try { await plugin.close(); } catch { /* 清理失败不掩盖原错误 */ }
        throw err;
      }
    }
    return { instance, created: true };
  }

  /** 准备单个 Bot/能力绑定；失败时只清理本次新建的实例，不影响其他 Bot 或能力。 */
  async function stageEntry(bot, capability, { deviceId, credentials }) {
    const id = capability.installationId;
    const botId = bot.botId;
    const scopedCredentials = Object.create(null);
    for (const ref of capability.target === 'host' ? capability.credentialRefs ?? [] : []) {
      if (typeof credentials?.[ref] !== 'string') throw error('CREDENTIAL_NOT_FOUND', 'capability credential is unavailable');
      scopedCredentials[ref] = credentials[ref];
    }
    let opened = null;
    try {
      opened = await openInstance(capability);
      const context = { deviceId, botId, installationId: id,
        effectiveConfig: capability.effectiveConfig, credentials: Object.freeze(scopedCredentials) };
      round?.preparing.add(botKey(botId, id));
      try {
        const contribution = await opened.instance.plugin.forBot(context);
        await contribution.prepare();
        const extension = defineExtension({ name: nameFor(id, botId), ...guardContributions(contribution, id, botId) });
        return { id, instance: opened.instance, created: opened.created,
          entry: { bot: contribution, context, extension },
          fingerprint: capabilityFingerprint(capability, credentials) };
      } finally { round?.preparing.delete(botKey(botId, id)); }
    } catch (err) {
      if (opened?.created && opened.instance.bots.size === 0) {
        try { await releaseInstance(id); } catch { /* 清理失败不掩盖原错误 */ }
      }
      throw err;
    }
  }

  async function dropStaged(staged) {
    try { await staged.entry.bot.quiesce(); } catch { /* 已失败绑定的销毁错误忽略 */ }
    try { await staged.entry.bot.close(); } catch { /* 已失败绑定的销毁错误忽略 */ }
    if (staged.created && staged.instance.bots.size === 0) {
      try { await releaseInstance(staged.id); } catch { /* 已失败实例的释放错误忽略 */ }
    }
  }

  /** 禁用且从未绑定的 Host 插件也要撤销本地写策略，避免沿用上次运行的持久化授权。 */
  async function notifyDisabled(bot, capability, deviceId) {
    const id = capability.installationId;
    const instance = instances.get(id);
    if (instance) {
      await instance.plugin.onBotPolicyChanged?.({ deviceId, botId: bot.botId,
        enabled: false, effectiveConfig: capability.effectiveConfig });
      return;
    }
    const installed = await installer.getInstalled(id);
    if (!installed) return;
    const offline = () => { throw error('CENTER_OFFLINE', 'capability is disabled'); };
    const temporary = await loadNativePlugin({ installationId: id, version: installed.version,
      entry: installed.manifest.components?.host?.entry, packageRoot: installed.packageRoot, dataDir: installed.dataDir,
      host: { ...services, tryRunBackgroundTask: async () => false,
        centerClient: { listCapabilityTools: offline, callCapabilityTool: offline } } });
    try {
      await temporary.onBotPolicyChanged?.({ deviceId, botId: bot.botId, enabled: false,
        effectiveConfig: capability.effectiveConfig });
    } finally { await temporary.close(); }
  }

  /**
   * 按 Bot 增量应用中心快照：保留未变化绑定，只重建变化/新增的能力；
   * 单个能力准备或注册失败只记录 RuntimeCapabilityError，其他 Bot 与基础聊天继续服务。
   * 调用方须保证该 Bot 已在安全边界（空闲）。
   */
  async function applyBot(bot, capabilities, { deviceId, credentials }) {
    const botId = bot.botId;
    const capabilityErrors = [];
    const fail = (installationId, err) => capabilityErrors.push({ botId, installationId, error: describe(err) });
    const desired = new Map();
    for (const capability of capabilities ?? []) desired.set(capability.installationId, capability);
    const known = new Set([...desired.keys(), ...(policy.get(botId)?.keys() ?? [])]);
    for (const [id, instance] of instances) if (instance.bots.has(botId)) known.add(id);

    // 1. 未变化的绑定保留；其余先撤销授权，权限收紧立即生效。
    const keep = new Set();
    for (const [id, capability] of desired) {
      if (!capability.enabled) continue;
      const entry = instances.get(id)?.bots.get(botId);
      if (active && entry && fingerprints.get(botKey(botId, id)) === capabilityFingerprint(capability, credentials)) {
        keep.add(id);
      }
    }
    const granted = new Map();
    for (const id of keep) granted.set(id, desired.get(id));
    policy.set(botId, granted);

    // 2. 释放被替换或移除的旧绑定。
    const releasedIds = new Set();
    for (const id of known) {
      if (keep.has(id)) continue;
      const next = desired.get(id);
      const errors = await releaseEntry(id, botId,
        { enabled: next?.enabled === true, effectiveConfig: next?.effectiveConfig ?? {} });
      releasedIds.add(id);
      // 被替换能力的清理错误不掩盖新绑定结果；移除/禁用的才作为能力错误上报。
      if (!next?.enabled) for (const err of errors) fail(id, err);
    }

    // 3. 准备新绑定，单个能力失败隔离。
    round = { preparing: new Set(), enabled: new Set() };
    for (const [id, capability] of desired) if (capability.enabled) round.enabled.add(botKey(botId, id));
    const staged = [];
    try {
      for (const id of known) {
        const capability = desired.get(id);
        if (!capability?.enabled || keep.has(id)) continue;
        try {
          staged.push(await stageEntry(bot, capability, { deviceId, credentials }));
        } catch (err) {
          fail(id, err);
        }
      }
    } finally { round = null; }

    // 4. 该 Bot 的工具名唯一性与单一 context provider。
    const pluginExtensions = new Set();
    for (const instance of instances.values()) {
      for (const entry of instance.bots.values()) if (entry.extension) pluginExtensions.add(entry.extension);
    }
    const toolNames = new Set(registry.snapshot().installed()
      .filter((extension) => !pluginExtensions.has(extension))
      .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)));
    let contextProvider = false;
    for (const id of keep) {
      const entry = instances.get(id)?.bots.get(botId);
      for (const tool of entry?.extension?.tools ?? []) toolNames.add(tool.name);
      if (entry?.bot.requestContributions?.prepareContext) contextProvider = true;
    }
    const committed = [];
    for (const stagedEntry of staged) {
      const tools = stagedEntry.entry.extension.tools ?? [];
      if (tools.some((tool) => toolNames.has(tool.name))) {
        fail(stagedEntry.id, error('INVALID_STATE', 'capability tool name is not unique for this Bot'));
        await dropStaged(stagedEntry);
        continue;
      }
      const provider = Boolean(stagedEntry.entry.bot.requestContributions?.prepareContext);
      if (provider && contextProvider) {
        fail(stagedEntry.id, error('INVALID_STATE', 'multiple context providers for this Bot'));
        await dropStaged(stagedEntry);
        continue;
      }
      for (const tool of tools) toolNames.add(tool.name);
      if (provider) contextProvider = true;
      committed.push(stagedEntry);
    }

    // 5. 提交新绑定（旧绑定已释放，同名扩展不会互相覆盖）。
    for (const stagedEntry of committed) {
      const { id, instance, entry } = stagedEntry;
      try {
        registry.install(entry.extension);
      } catch (err) {
        fail(id, err);
        await dropStaged(stagedEntry);
        continue;
      }
      instance.bots.set(botId, entry);
      fingerprints.set(botKey(botId, id), stagedEntry.fingerprint);
      granted.set(id, desired.get(id));
      policy.set(botId, granted);
      if (active) {
        try { await entry.bot.activate(); }
        catch (err) {
          fail(id, err);
          await releaseEntry(id, botId, { enabled: false, effectiveConfig: entry.context.effectiveConfig });
          granted.delete(id);
          policy.set(botId, granted);
          continue;
        }
      }
      try { await entry.bot.onPolicyChanged?.({ enabled: true, effectiveConfig: entry.context.effectiveConfig }); }
      catch (err) { fail(id, err); }
    }

    // 6. 禁用且本次未释放过的 Host 插件撤销本地策略（避免沿用上次运行的持久化授权）。
    for (const [id, capability] of desired) {
      if (capability.enabled || capability.kind !== 'plugin' || capability.target !== 'host') continue;
      if (keep.has(id) || releasedIds.has(id)) continue;
      try { await notifyDisabled(bot, capability, deviceId); } catch (err) { fail(id, err); }
    }
    return { capabilityErrors };
  }

  async function activate() {
    if (active) return { capabilityErrors: [] };
    const capabilityErrors = [];
    for (const [id, instance] of [...instances]) {
      for (const [botId, entry] of [...instance.bots]) {
        try {
          await entry.bot.activate();
        } catch (err) {
          capabilityErrors.push({ botId, installationId: id, error: describe(err) });
          // 半激活的能力必须撤销授权，不能沿用旧权限继续执行。
          await releaseEntry(id, botId, { enabled: false, effectiveConfig: entry.context.effectiveConfig });
        }
      }
    }
    active = true;
    return { capabilityErrors };
  }

  async function quiesce() {
    active = false;
    for (const action of activeActions) action.controller.abort(error('CENTER_OFFLINE', 'center is offline'));
    const errors = [];
    for (const instance of instances.values()) {
      for (const entry of instance.bots.values()) {
        try { await entry.bot.quiesce(); } catch (err) { errors.push(err); }
      }
    }
    await Promise.allSettled([...activeOperations.keys(), ...[...activeActions].map((action) => action.operation)]);
    if (errors.length) throw new AggregateError(errors, 'plugin quiesce failed');
  }

  function extensionsFor(botId) {
    return [...instances.values()].flatMap((instance) => {
      const entry = instance.bots.get(botId);
      return entry ? [entry.extension] : [];
    });
  }

  async function prepareContext(request, api, context) {
    const botId = await services.resolveConversationBot(api.conversationId);
    const providers = [...instances].flatMap(([id, instance]) => {
      const hook = instance.bots.get(botId)?.bot.requestContributions?.prepareContext;
      return hook ? [{ id, hook }] : [];
    });
    if (providers.length > 1) throw error('INVALID_STATE', 'multiple context providers for this Bot');
    if (!providers.length) return request;
    const { id, hook } = providers[0];
    return runAccepted(async () => {
      context.abortSignal?.throwIfAborted();
      await checkOwner(botId, id, api.conversationId);
      context.abortSignal?.throwIfAborted();
      const next = { ...request, ...(await hook(request, api, context)) };
      context.abortSignal?.throwIfAborted();
      await checkOwner(botId, id, api.conversationId);
      context.abortSignal?.throwIfAborted();
      return next;
    }, botId);
  }

  async function beforeRequest(request, api, context) {
    const botId = await services.resolveConversationBot(api.conversationId);
    let result = request;
    for (const [id, instance] of instances) {
      const entry = instance.bots.get(botId);
      const hook = entry?.bot.requestContributions?.beforeRequest;
      if (!hook) continue;
      result = await runAccepted(async () => {
        context.abortSignal?.throwIfAborted();
        await checkOwner(botId, id, api.conversationId);
        context.abortSignal?.throwIfAborted();
        const next = { ...result, ...(await hook(result, api, context)) };
        context.abortSignal?.throwIfAborted();
        await checkOwner(botId, id, api.conversationId);
        context.abortSignal?.throwIfAborted();
        return next;
      }, botId);
    }
    return result;
  }

  async function action(installationId, actionId, request) {
    if (!accepting) throw error('RUNTIME_BUSY', 'capability execution is not accepting new work');
    if (!request || typeof request.requestId !== 'string' || !request.requestId || typeof request.botId !== 'string' || !request.botId || !Object.hasOwn(request, 'input')) {
      throw error('INVALID_ARGUMENT', 'invalid capability action request');
    }
    if (request.deviceId !== host.deviceId) throw error('FORBIDDEN', 'device does not match');
    assertCapabilityAllowed(request.botId, installationId);
    const instance = instances.get(installationId);
    const entry = instance?.bots.get(request.botId);
    const descriptor = instance?.manifest.actions?.find((item) => item.id === actionId);
    const action = entry?.bot.actions?.[actionId];
    if (!descriptor || !action) throw error('NOT_FOUND', 'capability action not found');
    if (!ajv.validate(descriptor.inputSchema, request.input) || !ajv.validate(action.inputSchema, request.input)) throw error('VALIDATION_FAILED', 'invalid action input');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(error('TIMEOUT', 'capability action timed out')), 120000);
    timer.unref?.();
    const operation = Promise.resolve().then(() => {
      assertCapabilityAllowed(request.botId, installationId);
      controller.signal.throwIfAborted();
      return action.execute(request.input, { ...entry.context, requestId: request.requestId, abortSignal: controller.signal });
    });
    const running = { operation, controller, botId: request.botId };
    activeActions.add(running);
    operation.then(() => activeActions.delete(running), () => activeActions.delete(running));
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let result;
    try { result = await Promise.race([operation, aborted]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
    assertCapabilityAllowed(request.botId, installationId);
    if (descriptor.outputSchema !== undefined && !ajv.validate(descriptor.outputSchema, result)) {
      throw error('VALIDATION_FAILED', 'invalid action output');
    }
    return { result };
  }

  async function actionByName(botId, actionId, input) {
    const matches = [...instances].filter(([id, instance]) => instance.bots.has(botId) &&
      instance.manifest.actions?.some((descriptor) => descriptor.id === actionId));
    if (matches.length === 0) throw error('EXTENSION_DISABLED', 'capability action is unavailable');
    if (matches.length > 1) throw error('INVALID_STATE', 'capability action is ambiguous');
    return (await action(matches[0][0], actionId, { deviceId: host.deviceId, botId, requestId: input?.requestId ?? randomUUID(), input: input ?? {} })).result;
  }

  async function close() {
    const errors = [];
    for (const id of [...instances.keys()]) {
      const instance = instances.get(id);
      for (const botId of [...instance.bots.keys()]) errors.push(...await releaseEntry(id, botId, null));
      try { await releaseInstance(id); } catch (err) { errors.push(err); }
    }
    instances = new Map();
    policy = new Map();
    fingerprints.clear();
    active = false;
    if (errors.length) throw new AggregateError(errors, 'plugin cleanup failed');
  }

  return {
    applyBot, activate, quiesce, close, staleGrants, revoke, dropGrants, notifyGrants, capabilityTaskNames,
    assertCapabilityAllowed, extensionsFor, prepareContext, beforeRequest, action, actionByName,
    isActive: () => active,
    hasActiveExecutions: (botId) => botId === undefined
      ? activeOperations.size > 0 || activeActions.size > 0
      : [...activeOperations.values()].some((id) => id === botId) || [...activeActions].some((item) => item.botId === botId),
    suspend() { accepting = false; },
    resumeAdmissions() { accepting = true; },
    abortActions() { for (const action of activeActions) action.controller.abort(error('CENTER_OFFLINE', 'center is offline')); },
  };
}
