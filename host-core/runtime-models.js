import path from 'node:path';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { normalizeHindsightConfig, parseHindsightOptions } from './hindsight-client.js';
import { normalizeRuntimeExtensions, resolveRuntimeExtensions } from './extension-manager.js';
import { readInputObject } from './cli-input.js';

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

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidArgument(`${label} has unknown field: ${key}`);
    }
  }
}

/** Provider baseUrl 仅 http(s)，拒 userinfo/query/fragment；错误不回显 URL。 */
function normalizeProviderBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidArgument('runtime config: provider baseUrl must be an http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidArgument('runtime config: provider baseUrl must be an http(s) URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidArgument('runtime config: provider baseUrl must not contain user info');
  }
  if (url.search !== '' || url.hash !== '') {
    throw invalidArgument('runtime config: provider baseUrl must not contain query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

/** bashPath 允许 bash/bash.exe；Android 另允许精确的 /system/bin/sh，不接受任意 sh.exe。 */
function isShellExecutable(bashPath) {
  const base = path.basename(bashPath).toLowerCase();
  if (base === 'bash' || base === 'bash.exe') return true;
  return process.platform === 'android' && bashPath === '/system/bin/sh';
}

/**
 * 校验执行选项边界：bashPath 与 toolPaths 均可选，仅 undefined 表示未提供；
 * 显式 null 或类型错误一律 INVALID_ARGUMENT。不探测文件存在性——路径是否可用留到实际使用。
 */
export function parseExecutionOptions(options = {}) {
  let bashPath;
  if (options.bashPath !== undefined) {
    if (typeof options.bashPath !== 'string' || options.bashPath.trim() === '' || !path.isAbsolute(options.bashPath)) {
      throw invalidArgument('bashPath must be a non-empty absolute path');
    }
    if (!isShellExecutable(options.bashPath)) {
      throw invalidArgument('bashPath must point to a bash, bash.exe, or /system/bin/sh executable');
    }
    bashPath = options.bashPath;
  }
  let toolPaths;
  if (options.toolPaths !== undefined) {
    if (typeof options.toolPaths !== 'object' || options.toolPaths === null || Array.isArray(options.toolPaths)) {
      throw invalidArgument('toolPaths must be an object');
    }
    toolPaths = {};
    for (const [name, value] of Object.entries(options.toolPaths)) {
      if (name !== 'rg' && name !== 'fd') {
        throw invalidArgument(`toolPaths has unknown tool: ${name}`);
      }
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
        throw invalidArgument(`toolPaths.${name} must be a non-empty absolute path`);
      }
      toolPaths[name] = value;
    }
  }
  return { bashPath, toolPaths };
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
 * 纯运行时配置校验：不读 env/文件/网络；拒未知字段，不悄悄存 apiKey/headers。
 * 扩展配置为 runtime.extensions；legacy runtime.hindsight 仍原样保留在规范化结果里，
 * 两者同时出现属边界歧义，直接拒绝。
 */
export function normalizeRuntimeConfig(raw) {
  if (!isPlainObject(raw)) throw invalidArgument('runtime config must be a JSON object');
  rejectUnknownFields(raw, new Set(['providers', 'defaultModel', 'hindsight', 'extensions', 'bashPath', 'toolPaths']), 'runtime config');
  if (raw.hindsight !== undefined && raw.extensions !== undefined) {
    throw invalidArgument('runtime config must not set both hindsight and extensions');
  }
  const providers = validateProviders(raw.providers);
  let defaultModel = null;
  if (raw.defaultModel !== undefined && raw.defaultModel !== null) {
    const ref = parseModelRef(raw.defaultModel);
    const provider = providers.find((p) => p.id === ref.provider);
    if (!provider || !provider.models.some((m) => m.id === ref.modelId)) {
      throw errWithCode(`defaultModel not in registered models: ${raw.defaultModel}`, 'MODEL_NOT_FOUND');
    }
    defaultModel = raw.defaultModel;
  }
  const execution = parseExecutionOptions(raw);
  const normalized = { providers, defaultModel };
  const hindsight = normalizeHindsightConfig(raw.hindsight);
  const extensions = normalizeRuntimeExtensions(raw.extensions);
  if (hindsight !== undefined) normalized.hindsight = hindsight;
  if (extensions !== undefined) normalized.extensions = extensions;
  if (execution.bashPath !== undefined) normalized.bashPath = execution.bashPath;
  if (execution.toolPaths !== undefined) normalized.toolPaths = execution.toolPaths;
  return normalized;
}

/**
 * 解析运行时配置并构建 pi-ai Models；hindsight 只返回生效启用的配置，凭证也仅此时解析，
 * 另附生效的规范扩展映射供 runtime/控制面使用。
 */
export function parseRuntimeConfig(raw) {
  const normalized = normalizeRuntimeConfig(raw);
  const models = createModels();
  for (const provider of normalized.providers) {
    models.setProvider(buildProvider(provider));
  }
  const extensions = resolveRuntimeExtensions(normalized);
  const hindsight = extensions.hindsight?.enabled ? extensions.hindsight.config : undefined;
  parseHindsightOptions(hindsight);
  return {
    models,
    defaultModel: normalized.defaultModel,
    bashPath: normalized.bashPath,
    toolPaths: normalized.toolPaths,
    hindsight,
    extensions,
  };
}

/**
 * 读取用户显式 runtime 配置文件（复用 cli-input.readInputObject 的有界读取：
 * 普通文件/1MiB/严格 UTF-8/单纯 JSON 对象），解析并构建 pi-ai Models。
 */
export async function loadRuntimeConfig(file) {
  return parseRuntimeConfig(readInputObject(file));
}

function validateProviders(providers) {
  if (!Array.isArray(providers)) throw invalidArgument('runtime config: providers must be an array');
  const seenProviders = new Set();
  const out = [];
  for (const p of providers) {
    if (!isPlainObject(p)) {
      throw invalidArgument('runtime config: each provider must be an object');
    }
    rejectUnknownFields(p, new Set(['id', 'baseUrl', 'apiKeyEnv', 'models']), 'runtime config provider');
    const id = p.id;
    if (typeof id !== 'string' || id.trim() === '' || !id.isWellFormed()) {
      throw invalidArgument('runtime config: provider id must be a non-empty well-formed string');
    }
    if (id.includes('/')) {
      throw invalidArgument(`runtime config: provider id must not contain "/": ${id}`);
    }
    if (seenProviders.has(id)) throw invalidArgument(`runtime config: duplicate provider id: ${id}`);
    seenProviders.add(id);

    const baseUrl = normalizeProviderBaseUrl(p.baseUrl);
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
      if (!isPlainObject(m)) {
        throw invalidArgument(`runtime config: each model of provider "${id}" must be an object`);
      }
      rejectUnknownFields(m, new Set(['id', 'name', 'reasoning', 'contextWindow', 'maxTokens', 'input']), 'runtime config model');
      const modelId = m.id;
      if (typeof modelId !== 'string' || modelId.trim() === '' || !modelId.isWellFormed()) {
        throw invalidArgument('runtime config: model id must be a non-empty well-formed string');
      }
      if (seenModels.has(modelId)) throw invalidArgument(`runtime config: duplicate model id in provider "${id}": ${modelId}`);
      seenModels.add(modelId);
      if (m.name !== undefined && (typeof m.name !== 'string' || m.name.trim() === '' || !m.name.isWellFormed())) {
        throw invalidArgument(`runtime config: model "${modelId}" name must be a non-empty string`);
      }
      if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') {
        throw invalidArgument(`runtime config: model "${modelId}" reasoning must be a boolean`);
      }
      // 仅 undefined 缺省；显式 null 按预算类型拒绝。
      const contextWindow = m.contextWindow !== undefined ? m.contextWindow : DEFAULT_CONTEXT_WINDOW;
      const maxTokens = m.maxTokens !== undefined ? m.maxTokens : DEFAULT_MAX_TOKENS;
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
        throw invalidArgument(`runtime config: model "${modelId}" contextWindow must be a positive safe integer`);
      }
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
        throw invalidArgument(`runtime config: model "${modelId}" maxTokens must be a positive safe integer`);
      }
      if (maxTokens > contextWindow) {
        throw invalidArgument(`runtime config: model "${modelId}" maxTokens must not exceed contextWindow`);
      }
      // 显式 input 仅接受已知模态且 text 必含；规范顺序固定 text 在前、剩余模态按出现序在后。
      let input;
      if (m.input !== undefined) {
        if (!Array.isArray(m.input) || m.input.length === 0) {
          throw invalidArgument(`runtime config: model "${modelId}" input must be a non-empty array`);
        }
        const normalized = [];
        for (const kind of m.input) {
          if (typeof kind !== 'string' || (kind !== 'text' && kind !== 'image')) {
            // 固定文本：String(kind) 对带 toString 的对象可能自身抛错。
            throw invalidArgument(`runtime config: model "${modelId}" input has unknown kind`);
          }
          if (normalized.includes(kind)) {
            throw invalidArgument(`runtime config: model "${modelId}" input has duplicate kind: ${kind}`);
          }
          normalized.push(kind);
        }
        if (!normalized.includes('text')) {
          throw invalidArgument(`runtime config: model "${modelId}" input must include text`);
        }
        input = ['text', ...normalized.filter((kind) => kind !== 'text')];
      }
      const model = { id: modelId, contextWindow, maxTokens };
      if (m.name !== undefined) model.name = m.name;
      if (m.reasoning !== undefined) model.reasoning = m.reasoning;
      if (input !== undefined) model.input = input;
      models.push(model);
    }
    // 规范结果不带 undefined 属性，保证 normalize -> stringify/parse -> normalize 等价。
    const provider = { id, baseUrl, models };
    if (apiKeyEnv !== undefined) provider.apiKeyEnv = apiKeyEnv;
    out.push(provider);
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
    input: m.input ?? ['text'],
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

/** 只读 chat 模型白名单，六字段投影，按 modelRef UTF-8 字节序排序，无凭证/baseUrl/env。 */
export function describeModelCatalog(models, defaultModel) {
  const entries = [];
  for (const model of models.getModels()) {
    entries.push({
      modelRef: `${model.provider}/${model.id}`,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
    });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.modelRef, 'utf8'), Buffer.from(b.modelRef, 'utf8')));
  return { defaultModel: defaultModel ?? null, models: entries };
}
