// 模块：Host 扩展管理。只管 Hindsight 一个原生扩展的目录/可用性/每 Bot 策略与资源生命周期；
// 不加载任意代码，也不自带第二套扩展运行时。工具定义始终注册（历史/恢复可用），
// 由每 Bot 策略决定会话内工具与自动任务是否执行。
import { normalizeHindsightConfig } from './hindsight-client.js';

const EXTENSION_ID = 'hindsight';
// 与 hindsight-tools.js 的 createHindsightTools 名称保持一致。
const READ_TOOL_NAMES = ['hindsight_status', 'hindsight_recall', 'hindsight_reflect', 'hindsight_get', 'hindsight_source'];
const WRITE_TOOL_NAMES = ['hindsight_retain', 'hindsight_correct', 'hindsight_retry'];
const ALL_TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES];
const BOT_MODES = new Set(['read-write', 'read-only']);
const DEFAULT_MODE = 'read-write';

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

function assertBotId(botId) {
  if (typeof botId !== 'string' || botId.trim() === '') {
    throw invalidArgument('botId must be a non-empty string');
  }
}

/** 严格 Bot 扩展开关/策略；两字段都必填，mode 只接受 read-write/read-only。 */
export function normalizeBotExtensions(value) {
  if (!isPlainObject(value)) throw invalidArgument('bot extensions must be a plain object');
  rejectUnknownFields(value, new Set(['hindsight']), 'bot extensions');
  const hindsight = value.hindsight;
  if (!isPlainObject(hindsight)) throw invalidArgument('bot extensions.hindsight must be a plain object');
  rejectUnknownFields(hindsight, new Set(['enabled', 'mode']), 'bot extensions.hindsight');
  if (typeof hindsight.enabled !== 'boolean') {
    throw invalidArgument('bot extensions.hindsight.enabled must be a boolean');
  }
  if (typeof hindsight.mode !== 'string' || !BOT_MODES.has(hindsight.mode)) {
    throw invalidArgument('bot extensions.hindsight.mode must be "read-write" or "read-only"');
  }
  return { hindsight: { enabled: hindsight.enabled, mode: hindsight.mode } };
}

/**
 * 规范 Host 扩展配置：{hindsight?:{enabled,defaultEnabled,config?}}。
 * enabled=true 时 config 必填且按 Hindsight 选项校验；disabled 时 config 可保留。
 * defaultEnabled 省略时跟随 enabled（与 legacy runtime.hindsight 语义一致）。
 */
export function normalizeRuntimeExtensions(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw invalidArgument('runtime config: extensions must be a plain object');
  rejectUnknownFields(value, new Set([EXTENSION_ID]), 'runtime config extensions');
  const normalized = {};
  if (value.hindsight !== undefined) {
    const hindsight = value.hindsight;
    if (!isPlainObject(hindsight)) throw invalidArgument('runtime config: extensions.hindsight must be a plain object');
    rejectUnknownFields(hindsight, new Set(['enabled', 'defaultEnabled', 'config']), 'runtime config extensions.hindsight');
    if (typeof hindsight.enabled !== 'boolean') {
      throw invalidArgument('runtime config: extensions.hindsight.enabled must be a boolean');
    }
    if (hindsight.defaultEnabled !== undefined && typeof hindsight.defaultEnabled !== 'boolean') {
      throw invalidArgument('runtime config: extensions.hindsight.defaultEnabled must be a boolean');
    }
    const defaultEnabled = hindsight.defaultEnabled === undefined ? hindsight.enabled : hindsight.defaultEnabled;
    const config = normalizeHindsightConfig(hindsight.config);
    if (hindsight.enabled && config === undefined) {
      throw invalidArgument('runtime config: extensions.hindsight.config is required when enabled');
    }
    normalized.hindsight = { enabled: hindsight.enabled, defaultEnabled };
    if (config !== undefined) normalized.hindsight.config = config;
  }
  return normalized;
}

/**
 * 生效的规范扩展映射：显式 extensions 优先；仅当 extensions 缺省时才把 legacy
 * runtime.hindsight 解析为 enabled:true/defaultEnabled:true/config:legacy。
 */
export function resolveRuntimeExtensions({ extensions, hindsight } = {}) {
  const canonical = normalizeRuntimeExtensions(extensions);
  if (canonical !== undefined) return canonical;
  if (hindsight === undefined) return {};
  return { hindsight: { enabled: true, defaultEnabled: true, config: normalizeHindsightConfig(hindsight) } };
}

/**
 * Host 扩展管理器。host 只需提供本契约冻结的 Bot 扩展/SOUL 方法；
 * 所有变更走 host 的同步 CAS，管理器不缓存可变策略。
 */
export function createHostExtensionManager(options) {
  const host = options?.host;
  if (!host || typeof host !== 'object') throw invalidArgument('host is required');
  for (const name of ['getBot', 'ensureBotExtensions', 'getBotExtensions', 'setBotExtensions', 'ensureBotSoul']) {
    if (typeof host[name] !== 'function') throw invalidArgument(`host must provide ${name}`);
  }
  const canonical = resolveRuntimeExtensions({ extensions: options?.extensions, hindsight: options?.hindsight });
  const hindsightExtension = canonical.hindsight;
  const configured = hindsightExtension !== undefined;
  // 可用 = 已知道连接配置；仅 enabled=false 而无 config 不算可用。
  const available = configured && hindsightExtension.config !== undefined;
  const hostEnabled = available && hindsightExtension.enabled;
  // 仅在可用且启用时暴露连接配置；disabled/未配置不解析凭证、不连接。
  const hindsightConfig = hostEnabled ? hindsightExtension.config : undefined;
  const defaultEnabled = configured ? hindsightExtension.defaultEnabled : false;

  const runtimes = new Map();
  let installedRegistry = null;
  let quiescePromise = null;
  let closePromise = null;

  // Bot 首次初始化只复制一次 Host 默认；之后 Host 编辑不影响该 Bot。
  function defaultBotExtensions() {
    return { hindsight: { enabled: hostEnabled && defaultEnabled, mode: DEFAULT_MODE } };
  }

  function ensureBot(botId) {
    assertBotId(botId);
    const snapshot = host.ensureBotExtensions(botId, defaultBotExtensions());
    host.ensureBotSoul(botId);
    return snapshot;
  }

  function effectiveOf(extensions) {
    const bot = extensions.hindsight;
    const enabled = bot.enabled && hostEnabled;
    let reason = null;
    if (!bot.enabled) reason = 'bot-disabled';
    else if (!available) reason = 'not-configured';
    else if (!hostEnabled) reason = 'host-disabled';
    return { hindsight: { enabled, mode: bot.mode, reason } };
  }

  function toPublic(snapshot) {
    const extensions = normalizeBotExtensions(snapshot.extensions);
    return {
      botId: snapshot.botId,
      revision: snapshot.revision,
      extensions,
      effective: effectiveOf(extensions),
    };
  }

  // 未初始化行按需幂等初始化；Bot 不存在才报 BOT_NOT_FOUND。
  function readSnapshot(botId) {
    const snapshot = host.getBotExtensions(botId);
    if (snapshot) return snapshot;
    if (!host.getBot(botId)) throw errWithCode('bot not found', 'BOT_NOT_FOUND');
    return ensureBot(botId);
  }

  function getBotExtensions(botId) {
    assertBotId(botId);
    return toPublic(readSnapshot(botId));
  }

  function setBotExtensions(botId, input, setOptions = {}) {
    assertBotId(botId);
    if (!isPlainObject(input)) throw invalidArgument('input must be a plain object');
    rejectUnknownFields(input, new Set(['expectedRevision', 'extensions']), 'bot extensions input');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw invalidArgument('expectedRevision must be a nonnegative safe integer');
    }
    const extensions = normalizeBotExtensions(input.extensions);
    if (!isPlainObject(setOptions)) throw invalidArgument('options must be a plain object');
    rejectUnknownFields(setOptions, new Set(['retentionFloor']), 'bot extensions options');
    const hostOptions = {};
    if (setOptions.retentionFloor !== undefined) {
      // 内部参数：由 runtime 计算的写入下限，公开调用者不提供。
      if (!Number.isSafeInteger(setOptions.retentionFloor) || setOptions.retentionFloor < 0) {
        throw invalidArgument('retentionFloor must be a nonnegative safe integer');
      }
      hostOptions.retentionFloor = setOptions.retentionFloor;
    }
    const snapshot = host.setBotExtensions(botId, { expectedRevision: input.expectedRevision, extensions }, hostOptions);
    return toPublic(snapshot);
  }

  /** 只读生效策略；热路径不写库，未初始化行按 Host 默认推算。 */
  function getPolicy(botId) {
    assertBotId(botId);
    const snapshot = host.getBotExtensions(botId);
    const extensions = snapshot ? snapshot.extensions : defaultBotExtensions();
    const effective = effectiveOf(extensions);
    const floor = snapshot && Number.isSafeInteger(snapshot.retentionFloor) && snapshot.retentionFloor >= 0
      ? snapshot.retentionFloor
      : 0;
    return {
      enabled: effective.hindsight.enabled,
      mode: effective.hindsight.mode,
      canRead: effective.hindsight.enabled,
      canWrite: effective.hindsight.enabled && effective.hindsight.mode === 'read-write',
      retentionFloor: floor,
    };
  }

  function listExtensions() {
    return {
      extensions: [{
        id: EXTENSION_ID,
        name: 'Hindsight',
        version: '1',
        scope: 'bot',
        enabled: hostEnabled,
        available,
        defaultEnabled,
        reason: !available ? 'not-configured' : hostEnabled ? null : 'host-disabled',
      }],
    };
  }

  /** 关闭 Bot 对该扩展的工具：关闭=全部工具，只读=写入类工具。 */
  function disabledToolNames(botId) {
    const policy = getPolicy(botId);
    if (!policy.enabled) return [...ALL_TOOL_NAMES];
    if (policy.mode !== 'read-write') return [...WRITE_TOOL_NAMES];
    return [];
  }

  /** 注册本 Runtime 已创建的扩展定义与资源；定义始终可安装，策略另行控制执行。 */
  function registerRuntime(id, resources) {
    if (id !== EXTENSION_ID) throw invalidArgument(`unknown extension: ${String(id)}`);
    if (!isPlainObject(resources)) throw invalidArgument('runtime extension resources must be a plain object');
    rejectUnknownFields(resources, new Set(['extension', 'quiesce', 'close']), 'runtime extension resources');
    if (resources.extension === undefined || resources.extension === null) {
      throw invalidArgument('runtime extension resources require extension');
    }
    for (const name of ['quiesce', 'close']) {
      if (resources[name] !== undefined && typeof resources[name] !== 'function') {
        throw invalidArgument(`runtime extension ${name} must be a function`);
      }
    }
    runtimes.set(id, { extension: resources.extension, quiesce: resources.quiesce, close: resources.close });
  }

  function install(registry) {
    if (!registry || typeof registry.install !== 'function') {
      throw invalidArgument('registry must provide install');
    }
    if (installedRegistry === registry) return;
    installedRegistry = registry;
    for (const resources of runtimes.values()) registry.install(resources.extension);
  }

  // 反序拆解资源；重复调用返回同一 Promise，错误合并抛出而不吞掉。
  async function drain(method) {
    const errors = [];
    for (const resources of [...runtimes.values()].reverse()) {
      const fn = resources[method];
      if (!fn) continue;
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `extension ${method} failed`);
  }

  return {
    hindsightConfig,
    ensureBot,
    getBotExtensions,
    setBotExtensions,
    getPolicy,
    listExtensions,
    registerRuntime,
    install,
    disabledToolNames,
    quiesce() {
      quiescePromise ??= drain('quiesce');
      return quiescePromise;
    },
    close() {
      closePromise ??= drain('close');
      return closePromise;
    },
  };
}
