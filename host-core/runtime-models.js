import { readFile } from 'node:fs/promises';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function invalidArgument(message) {
  return errWithCode(message, 'INVALID_ARGUMENT');
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse a provider/modelId reference such as "local/model" into
 * { provider, modelId }. The split is on the first "/"; modelId may contain
 * further slashes. Strings are kept exactly as given.
 */
export function parseModelRef(value) {
  if (typeof value !== 'string') throw invalidArgument('modelRef must be a string');
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw invalidArgument(`modelRef must be provider/modelId: ${value}`);
  }
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  if (provider.trim() === '' || modelId.trim() === '') {
    throw invalidArgument(`modelRef must be provider/modelId: ${value}`);
  }
  return { provider, modelId };
}

/**
 * Read a user-provided runtime config JSON file and register its providers in a
 * fresh pi-ai Models collection. Only the given file is read; nothing is
 * scanned or written. Returns { models, defaultModel }, where defaultModel is
 * the config value as written (null when omitted).
 */
export async function loadRuntimeConfig(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' || err?.code === 'EISDIR') {
      throw invalidArgument(`runtime config file not found: ${file}`);
    }
    throw err;
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw invalidArgument(`runtime config is not valid JSON: ${err.message}`);
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw invalidArgument('runtime config must be a JSON object');
  }

  const providers = validateProviders(config.providers);
  const models = createModels();
  for (const provider of providers) {
    models.setProvider(buildProvider(provider));
  }

  let defaultModel = null;
  if (config.defaultModel !== undefined && config.defaultModel !== null) {
    const ref = parseModelRef(config.defaultModel);
    if (!models.getModel(ref.provider, ref.modelId)) {
      throw errWithCode(`defaultModel not in registered models: ${config.defaultModel}`, 'MODEL_NOT_FOUND');
    }
    defaultModel = config.defaultModel;
  }

  return { models, defaultModel };
}

function validateProviders(providers) {
  if (!Array.isArray(providers)) throw invalidArgument('runtime config: providers must be an array');
  const seenProviders = new Set();
  const out = [];
  for (const p of providers) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw invalidArgument('runtime config: each provider must be an object');
    }
    const id = p.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw invalidArgument('runtime config: provider id must be a non-empty string');
    }
    if (seenProviders.has(id)) throw invalidArgument(`runtime config: duplicate provider id: ${id}`);
    seenProviders.add(id);

    if (typeof p.baseUrl !== 'string' || !isHttpUrl(p.baseUrl)) {
      throw invalidArgument(`runtime config: provider baseUrl must be an http(s) URL: ${String(p.baseUrl)}`);
    }
    let apiKeyEnv;
    if (p.apiKeyEnv !== undefined) {
      if (typeof p.apiKeyEnv !== 'string' || !ENV_NAME.test(p.apiKeyEnv)) {
        throw invalidArgument(`runtime config: apiKeyEnv must be a valid environment variable name: ${String(p.apiKeyEnv)}`);
      }
      apiKeyEnv = p.apiKeyEnv;
    }
    if (!Array.isArray(p.models)) throw invalidArgument(`runtime config: provider "${id}" models must be an array`);

    const seenModels = new Set();
    const models = [];
    for (const m of p.models) {
      if (typeof m !== 'object' || m === null || Array.isArray(m)) {
        throw invalidArgument(`runtime config: each model of provider "${id}" must be an object`);
      }
      const modelId = m.id;
      if (typeof modelId !== 'string' || modelId.trim() === '') {
        throw invalidArgument('runtime config: model id must be a non-empty string');
      }
      if (seenModels.has(modelId)) throw invalidArgument(`runtime config: duplicate model id in provider "${id}": ${modelId}`);
      seenModels.add(modelId);
      if (m.name !== undefined && (typeof m.name !== 'string' || m.name.trim() === '')) {
        throw invalidArgument(`runtime config: model "${modelId}" name must be a non-empty string`);
      }
      if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') {
        throw invalidArgument(`runtime config: model "${modelId}" reasoning must be a boolean`);
      }
      const contextWindow = m.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const maxTokens = m.maxTokens ?? DEFAULT_MAX_TOKENS;
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        throw invalidArgument(`runtime config: model "${modelId}" contextWindow must be a positive integer`);
      }
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
        throw invalidArgument(`runtime config: model "${modelId}" maxTokens must be a positive integer`);
      }
      if (maxTokens > contextWindow) {
        throw invalidArgument(`runtime config: model "${modelId}" maxTokens must not exceed contextWindow`);
      }
      models.push({ id: modelId, name: m.name, reasoning: m.reasoning, contextWindow, maxTokens });
    }
    out.push({ id, baseUrl: p.baseUrl, apiKeyEnv, models });
  }
  return out;
}

function buildProvider(provider) {
  const models = provider.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: 'openai-completions',
    provider: provider.id,
    baseUrl: provider.baseUrl,
    input: ['text'],
    reasoning: m.reasoning ?? false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
  return createProvider({
    id: provider.id,
    baseUrl: provider.baseUrl,
    auth: { apiKey: createApiKeyAuth(provider.apiKeyEnv) },
    models,
    api: openAICompletionsApi(),
  });
}

function createApiKeyAuth(apiKeyEnv) {
  return {
    name: apiKeyEnv ? 'API key' : 'No key required',
    async resolve() {
      if (!apiKeyEnv) {
        return { auth: { apiKey: 'not-required' }, source: 'keyless' };
      }
      const key = process.env[apiKeyEnv];
      if (key === undefined || key === '') {
        throw new Error(`environment variable ${apiKeyEnv} is not set`);
      }
      return { auth: { apiKey: key }, source: apiKeyEnv };
    },
  };
}
