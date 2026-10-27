import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normalizeHindsightConfig } from './hindsight-client.js';
import { openHindsightStore } from './hindsight-store.js';
import { createRuntimeHindsight } from './runtime-hindsight.js';
import { createHindsightTools } from './hindsight-tools.js';
import { migrateLegacyHindsight } from './migration.js';

const descriptors = JSON.parse(readFileSync(new URL('./capability.json', import.meta.url), 'utf8')).actions;
const WRITE_ACTIONS = new Set(['retainMemory', 'correctMemory', 'retryMemory']);

export function createPlugin({ installationId, dataDir, host }) {
  const bots = new Set();
  return {
    async forBot({ deviceId, botId, effectiveConfig, credentials }) {
      const { baseUrl, apiKeyRef, mode = 'read-write', sharedMemory, timeoutMs, reflectTimeoutMs } = effectiveConfig;
      const normalized = normalizeHindsightConfig({ baseUrl, ...(sharedMemory === undefined ? {} : { sharedMemory }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(reflectTimeoutMs === undefined ? {} : { reflectTimeoutMs }) });
      const apiKey = apiKeyRef === undefined ? undefined : credentials[apiKeyRef];
      if (apiKeyRef !== undefined && (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey))) {
        throw Object.assign(new Error('Hindsight credential is unavailable or invalid.'), { code: 'INVALID_ARGUMENT' });
      }
      const config = { ...normalized, apiKey, timeoutMs: normalized.timeoutMs ?? 30000, reflectTimeoutMs: normalized.reflectTimeoutMs ?? 120000 };
      const botKey = createHash('sha256').update(botId).digest('hex');
      const botDataDir = join(dataDir, botKey);
      const policyFile = join(dataDir, botKey + '.policy.json');
      let policy = existsSync(policyFile)
        ? JSON.parse(readFileSync(policyFile, 'utf8'))
        : { writable: false, floor: host.host.getBotExtensions(botId)?.retentionFloor ?? 0 };
      let active = false;
      let closed = false;
      const check = () => {
        if (!active || closed) throw Object.assign(new Error('Hindsight is not active.'), { code: 'EXTENSION_DISABLED' });
        host.assertCapabilityAllowed(botId, installationId);
      };
      const getBotPolicy = (id) => {
        if (id !== botId || !active || closed) return { enabled: false, canWrite: false };
        try { host.assertCapabilityAllowed(botId, installationId); } catch { return { enabled: false, canWrite: false }; }
        return { enabled: true, canRead: true, canWrite: mode === 'read-write', mode, retentionFloor: policy.floor };
      };
      const localHost = Object.create(host.host);
      Object.defineProperty(localHost, 'dataRoot', { value: botDataDir });
      const memory = createRuntimeHindsight({ host: localHost, getHarness: host.getHarness,
        getWorkContexts: host.getWorkContexts, getWorkActivity: host.getWorkActivity,
        context: host.context, documents: host.documents, countMessageTokens: host.countMessageTokens,
        config, getBotPolicy });
      const controller = {
        async fromTool(api, context, operation, input) {
          check();
          if (await host.resolveConversationBot(api.conversationId) !== botId) {
            throw Object.assign(new Error('Conversation does not belong to this Bot.'), { code: 'BOT_CONTEXT_REQUIRED' });
          }
          check();
          return memory.fromTool(api, context, operation, input);
        },
      };
      const actions = Object.fromEntries(descriptors.map(({ id, inputSchema }) => [id, {
        inputSchema,
        async execute(input, invocationContext) {
          check();
          if (WRITE_ACTIONS.has(id) && mode !== 'read-write') {
            throw Object.assign(new Error('Hindsight is read-only.'), { code: 'EXTENSION_READ_ONLY' });
          }
          return id === 'retainMemory' || id === 'correctMemory'
            ? memory[id](botId, input, undefined, invocationContext)
            : memory[id](botId, input, invocationContext);
        },
      }]));
      const bot = {
        durableContributions: { tools: createHindsightTools(controller, host.sdk.defineTool) },
        requestContributions: {
          async beforeRequest(request, api, context) {
            check();
            if (await host.resolveConversationBot(api.conversationId) !== botId) return undefined;
            check();
            return memory.beforeRequest(request, api, context);
          },
        },
        actions,
        async prepare() {
          await migrateLegacyHindsight({ legacyDataRoot: host.host.dataRoot, dataDir: botDataDir, deviceId, botId,
            endpoint: config.baseUrl, initializeTarget: (tempDataDir) => {
              const endpointHash = createHash('sha256').update(config.baseUrl).digest('hex');
              openHindsightStore({ dataRoot: tempDataDir, deviceId, endpointHash }).close();
            } });
        },
        async onPolicyChanged({ enabled, effectiveConfig: nextConfig }) {
          if (existsSync(policyFile)) policy = JSON.parse(readFileSync(policyFile, 'utf8'));
          const writable = enabled && (nextConfig?.mode ?? 'read-write') === 'read-write';
          const floor = writable && !policy.writable
            ? Math.max(policy.floor, await host.getBotEntryWatermark(botId)) : policy.floor;
          const next = { writable, floor };
          mkdirSync(dataDir, { recursive: true });
          const temporary = policyFile + '.tmp';
          writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
          renameSync(temporary, policyFile);
          policy = next;
        },
        async activate() { host.assertCapabilityAllowed(botId, installationId); active = true; memory.resume(); },
        async quiesce() { active = false; closed = true; await memory.quiesce(); },
        async close() { await bot.quiesce(); await memory.close(); bots.delete(bot); },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map(bot => bot.close())); },
  };
}
