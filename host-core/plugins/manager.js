import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import { defineExtension } from '@earendil-works/pi-durable';
import { loadNativePlugin } from './index.js';
import { createMcpDriver } from '../capabilities/mcp.js';
import { createSkillDriver } from '../capabilities/skill.js';

const error = (code, message) => Object.assign(new Error(message), { code });
const nameFor = (...parts) => 'cap-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function createPluginManager({ host, registry, installer, services, isOnline }) {
  const ajv = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, strict: false });
  ajv.addFormat('credential-ref', true);
  let snapshot = null;
  let instances = new Map();
  let active = false;
  let accepting = false;
  const activeOperations = new Set();
  let policy = new Map();
  const activeActions = new Set();

  function assertCapabilityAllowed(botId, installationId) {
    if (!isOnline()) throw error('CENTER_OFFLINE', 'center is offline');
    if (!policy.get(botId)?.get(installationId)?.enabled) {
      throw error('EXTENSION_DISABLED', 'capability is disabled for this Bot');
    }
  }

  async function runAccepted(operation) {
    if (!accepting) throw error('RUNTIME_BUSY', 'capability execution is not accepting new work');
    const running = Promise.resolve().then(operation);
    activeOperations.add(running);
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
        });
      },
    }));
    const sections = source.sections?.map((item) => ({
      ...item,
      async render(input, context) {
        return runAccepted(async () => {
          await checkOwner(botId, installationId, input.conversationId);
          return item.render(input, context);
        });
      },
    }));
    const hooks = source.hooks?.map((item) => ({
      ...item,
      handlers: Object.fromEntries(Object.entries(item.handlers).map(([key, fn]) => [key, async (...args) => {
        return runAccepted(async () => {
          const api = args[args.length - 2];
          await checkOwner(botId, installationId, api.conversationId);
          return fn(...args);
        });
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
          });
        } };
        return { ...wrapped, async render(input, context) {
          return runAccepted(async () => {
            await checkOwner(botId, installationId, input.conversationId);
            return wrapped.render(input, context);
          });
        } };
      },
    }));
    return { ...source, tasks: undefined, tools, sections, hooks, wraps };
  }

  async function dispose(map, policyChanges = false, nextPolicy = new Map()) {
    const errors = [];
    for (const [id, instance] of map) {
      for (const [botId, entry] of instance.bots) {
        if (policyChanges) {
          const next = nextPolicy.get(botId)?.get(id);
          if (!next?.enabled || !isDeepStrictEqual(next.effectiveConfig, entry.context.effectiveConfig)) {
            try { await entry.bot.onPolicyChanged?.({ enabled: next?.enabled === true, effectiveConfig: next?.effectiveConfig ?? {} }); }
            catch (err) { errors.push(err); }
          }
        }
        try { await entry.bot.quiesce(); } catch (err) { errors.push(err); }
        try { await entry.bot.close(); } catch (err) { errors.push(err); }
      }
      try { await instance.plugin.close(); } catch (err) { errors.push(err); }
    }
    if (errors.length) throw new AggregateError(errors, 'plugin cleanup failed');
  }

  async function apply(next) {
    const nextPolicy = new Map(next.bots.map((bot) => [bot.botId,
      new Map(bot.capabilities.map((capability) => [capability.installationId, capability]))]));
    const staged = new Map();
    const oldBindings = new Set([...instances].flatMap(([id, instance]) => [...instance.bots.keys()].map((botId) => JSON.stringify([id, botId]))));
    const toolNames = new Set(registry.snapshot().installed().flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)));
    for (const instance of instances.values()) for (const entry of instance.bots.values()) {
      for (const tool of entry.extension?.tools ?? []) toolNames.delete(tool.name);
    }
    try {
      await dispose(instances, true, nextPolicy);
      for (const instance of instances.values()) {
        for (const entry of instance.bots.values()) registry.uninstall(entry.extension);
        if (instance.taskExtension) registry.uninstall(instance.taskExtension);
      }
      instances = new Map();
      policy = new Map();
      snapshot = null;
      for (const bot of next.bots) {
        for (const capability of bot.capabilities) {
          if (!capability.enabled) continue;
          const id = capability.installationId;
          let instance = staged.get(id);
          if (!instance) {
            let installed = null;
            if (!(capability.kind === 'mcp' && capability.target === 'center')) {
              installed = await installer.getInstalled(id);
              if (!installed || installed.version !== capability.targetVersion) {
                throw error('CAPABILITY_NOT_INSTALLED', 'capability version is not installed');
              }
            }
            const phase = { preparing: true };
            const checkTarget = (requestedId, botId, allowPreparation) => {
              if (requestedId !== id) throw error('FORBIDDEN', 'capability does not match');
              if (allowPreparation && phase.preparing && nextPolicy.get(botId)?.get(id)?.enabled) return;
              assertCapabilityAllowed(botId, id);
            };
            const scopedHost = { ...services,
              async tryRunBackgroundTask(botId, task) {
                if (!accepting || !isOnline() || !policy.get(botId)?.get(id)?.enabled) return false;
                await runAccepted(async () => { assertCapabilityAllowed(botId, id); await task(); });
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
            } };
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
            instance = { plugin, manifest, phase, bots: new Map(), taskExtension: null };
            staged.set(id, instance);
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
            }
          }
          const credentials = Object.create(null);
          for (const ref of capability.target === 'host' ? capability.credentialRefs ?? [] : []) {
            if (typeof next.credentials[ref] !== 'string') throw error('CREDENTIAL_NOT_FOUND', 'capability credential is unavailable');
            credentials[ref] = next.credentials[ref];
          }
          const context = { deviceId: next.deviceId, botId: bot.botId, installationId: id,
            effectiveConfig: capability.effectiveConfig, credentials: Object.freeze(credentials) };
          const contribution = await instance.plugin.forBot(context);
          const entry = { bot: contribution, context, extension: null };
          instance.bots.set(bot.botId, entry);
          await contribution.prepare();
          entry.extension = defineExtension({ name: nameFor(id, bot.botId), ...guardContributions(contribution, id, bot.botId) });
          for (const tool of entry.extension.tools ?? []) {
            if (toolNames.has(tool.name)) throw error('INVALID_STATE', 'capability tool name is not unique');
            toolNames.add(tool.name);
          }
        }
      }
      for (const bot of next.bots) {
        for (const capability of bot.capabilities) {
          if (capability.enabled || capability.kind !== 'plugin' || capability.target !== 'host' || oldBindings.has(JSON.stringify([capability.installationId, bot.botId]))) continue;
          const id = capability.installationId;
          let instance = staged.get(id);
          let temporary;
          if (!instance) {
            const installed = await installer.getInstalled(id);
            if (!installed) continue;
            const offline = () => { throw error('CENTER_OFFLINE', 'capability is disabled'); };
            temporary = await loadNativePlugin({ installationId: id, version: installed.version,
              entry: installed.manifest.components?.host?.entry, packageRoot: installed.packageRoot, dataDir: installed.dataDir,
              host: { ...services, tryRunBackgroundTask: async () => false, centerClient: { listCapabilityTools: offline, callCapabilityTool: offline } } });
          }
          try {
            await (instance?.plugin ?? temporary).onBotPolicyChanged?.({ deviceId: next.deviceId, botId: bot.botId,
              enabled: false, effectiveConfig: capability.effectiveConfig });
          } finally { if (temporary) await temporary.close(); }
        }
      }
      for (const instance of staged.values()) instance.phase.preparing = false;
      instances = staged;
      policy = nextPolicy;
      snapshot = next;
      for (const instance of instances.values()) {
        if (instance.taskExtension) registry.install(instance.taskExtension);
        for (const entry of instance.bots.values()) {
          registry.install(entry.extension);
          await entry.bot.onPolicyChanged?.({ enabled: true, effectiveConfig: entry.context.effectiveConfig });
        }
      }
      active = false;
    } catch (err) {
      for (const instance of staged.values()) {
        instance.phase.preparing = false;
        for (const entry of instance.bots.values()) if (entry.extension) registry.uninstall(entry.extension);
        if (instance.taskExtension) registry.uninstall(instance.taskExtension);
      }
      await dispose(staged).catch(() => {});
      if (instances === staged) instances = new Map();
      policy = new Map();
      snapshot = null;
      active = false;
      throw err;
    }
  }

  async function activate() {
    if (!snapshot) throw error('INVALID_STATE', 'no center snapshot is applied');
    if (active) return;
    for (const instance of instances.values()) {
      for (const entry of instance.bots.values()) await entry.bot.activate();
    }
    active = true;
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
    await Promise.allSettled([...activeOperations, ...[...activeActions].map((action) => action.operation)]);
    if (errors.length) throw new AggregateError(errors, 'plugin quiesce failed');
  }

  function extensionsFor(botId) {
    return [...instances.values()].flatMap((instance) => {
      const entry = instance.bots.get(botId);
      return entry ? [entry.extension] : [];
    });
  }

  async function beforeRequest(request, api, context) {
    const botId = await services.resolveConversationBot(api.conversationId);
    let result = request;
    for (const [id, instance] of instances) {
      const entry = instance.bots.get(botId);
      const hook = entry?.bot.requestContributions?.beforeRequest;
      if (!hook) continue;
      result = await runAccepted(async () => {
        assertCapabilityAllowed(botId, id);
        const next = { ...result, ...(await hook(result, api, context)) };
        assertCapabilityAllowed(botId, id);
        return next;
      });
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
    const running = { operation, controller };
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
    if (matches.length !== 1) throw error('INVALID_STATE', 'memory action is unavailable or ambiguous');
    return (await action(matches[0][0], actionId, { deviceId: host.deviceId, botId, requestId: input?.requestId ?? randomUUID(), input: input ?? {} })).result;
  }

  return { apply, activate, quiesce, assertCapabilityAllowed, extensionsFor, beforeRequest, action, actionByName,
    hasActiveExecutions: () => activeOperations.size > 0 || activeActions.size > 0,
    suspend() { accepting = false; },
    resumeAdmissions() { accepting = true; },
    abortActions() { for (const action of activeActions) action.controller.abort(error('CENTER_OFFLINE', 'center is offline')); },
    async close() { await dispose(instances); instances = new Map(); policy = new Map(); snapshot = null; } };
}
