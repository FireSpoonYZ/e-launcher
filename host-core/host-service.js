// 模块 14：统一 Host 服务入口。组装 settings 库、控制服务器与本机设备链路；
// 只管理生命周期与状态聚合，不做模型/凭证/网络细节。
import path from 'node:path';
import { openHost } from './host.js';
import { openHostSettings, normalizeHostSettings } from './host-settings.js';
import { parseRuntimeConfig } from './runtime-models.js';
import { openControlServer } from './control-server.js';
import { openDeviceLink } from './device-link.js';
import { parseRelayUrl, assertDeviceToken } from './relay-protocol.js';
import { readTextFile } from './cli-input.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_OPTIONS = new Set(['dataRoot', 'token', 'port', 'initialSettings']);

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

function validateCaPem(ca) {
  if (
    typeof ca !== 'string' ||
    !ca.isWellFormed() ||
    ca.trim() === '' ||
    !ca.includes('-----BEGIN CERTIFICATE-----') ||
    !ca.includes('-----END CERTIFICATE-----')
  ) {
    throw invalidArgument('ca must be a non-empty PEM certificate string');
  }
}

/**
 * 打开统一本机服务。token/port/initialSettings 在任何数据打开前完整校验；
 * 控制监听成功后异步连接 relay（connecting/backoff 不算启动失败）。
 */
export async function openHostService(options) {
  // 未知键直接拒绝，防拼错字段被静默忽略。
  for (const key of Object.keys(options ?? {})) {
    if (!ALLOWED_OPTIONS.has(key)) throw invalidArgument(`unknown option: ${key}`);
  }

  const dataRoot = options?.dataRoot;
  const token = options?.token;
  const port = options?.port;
  const initialSettings = options?.initialSettings;

  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
    throw invalidArgument('dataRoot must be a non-empty absolute path');
  }
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw invalidArgument('token must be a URL-safe opaque string of 32-512 characters');
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw invalidArgument('port must be an integer between 0 and 65535');
  }
  if (initialSettings !== undefined) {
    normalizeHostSettings(initialSettings);
  }

  // 探针登记连接取 deviceId，随即关闭；不持有额外 Host。
  let deviceId;
  {
    const probe = openHost({ dataRoot });
    try {
      deviceId = probe.deviceId;
    } finally {
      probe.close();
    }
  }

  let settingsStore = null;
  let control = null;
  let link = null;
  let phase = 'starting';
  let listening = false;
  let activeRevision = null;
  let lastRevision = null;
  let frozen = null;

  try {
    settingsStore = openHostSettings({ dataRoot, deviceId, initialSettings });
    const snapshot = settingsStore.get();
    activeRevision = snapshot.revision;
    lastRevision = activeRevision;
    // parse 在打开 runtime/listener 前校验/解析 Hindsight 凭证；模型 key 在实际请求懒读。
    const runtimeConfig = parseRuntimeConfig(snapshot.settings.runtime);

    let relayToken = null;
    let ca = null;
    const relay = snapshot.settings.relay;
    if (relay) {
      parseRelayUrl(relay.url);
      if (typeof relay.tokenEnv !== 'string' || !ENV_NAME.test(relay.tokenEnv)) {
        throw invalidArgument('relay.tokenEnv must be a valid environment variable name');
      }
      relayToken = process.env[relay.tokenEnv];
      if (relayToken === undefined || relayToken === '') {
        throw invalidArgument(`environment variable ${relay.tokenEnv} is not set`);
      }
      assertDeviceToken(relayToken);
      if (relayToken === token) {
        throw invalidArgument('relay token must differ from control token');
      }
      if (relay.caFile !== undefined && relay.caFile !== null) {
        if (typeof relay.caFile !== 'string' || !path.isAbsolute(relay.caFile)) {
          throw invalidArgument('relay.caFile must be an absolute path');
        }
        ca = await readTextFile(relay.caFile, 'relay CA');
        validateCaPem(ca);
      }
    }

    control = await openControlServer({
      dataRoot,
      token,
      port,
      models: runtimeConfig.models,
      defaultModel: runtimeConfig.defaultModel,
      bashPath: runtimeConfig.bashPath,
      toolPaths: runtimeConfig.toolPaths,
      hindsight: runtimeConfig.hindsight,
      settings: { store: settingsStore, activeRevision },
      getServiceStatus: () => getStatus(),
    });
    listening = true;
    phase = 'running';

    if (relay) {
      link = await openDeviceLink({
        dataRoot,
        url: relay.url,
        token: relayToken,
        ca,
        control: { url: control.url, token },
      });
    }
  } catch (err) {
    // 局部启动失败：已打开资源按反序关闭，再抛原错误。
    const errors = [];
    if (link) {
      try { await link.close(); } catch (closeErr) { errors.push(closeErr); }
    }
    if (control) {
      try { await control.close(); } catch (closeErr) { errors.push(closeErr); }
    }
    if (settingsStore) {
      try { settingsStore.close(); } catch (closeErr) { errors.push(closeErr); }
    }
    throw errors.length > 0 ? new AggregateError([err, ...errors], 'host service startup failed') : err;
  }

  function getStatus() {
    if (frozen) return structuredClone(frozen);
    // 正常 running/closing 读取失败必须抛出，由 HTTP 错误映射处理，不伪装当前状态。
    const revision = settingsStore.get().revision;
    lastRevision = revision;
    return {
      deviceId,
      phase,
      control: { url: control.url, listening },
      relay: link ? link.getStatus() : null,
      activeSettingsRevision: activeRevision,
      settingsRevision: revision,
      restartRequired: revision !== activeRevision,
    };
  }

  let closePromise = null;
  const close = () => {
    closePromise ??= (async () => {
      phase = 'closing';
      const errors = [];
      // 状态取样纳入错误收集，但取样失败仍继续关闭全部资源。
      let revision = lastRevision;
      try { revision = settingsStore.get().revision; } catch (err) { errors.push(err); }
      if (link) {
        try { await link.close(); } catch (err) { errors.push(err); }
      }
      // link.close 后读取 closed 状态（不查 DB）；取样失败记错误并保持 relay:null，不伪造伪状态。
      let relayStatus = null;
      if (link) {
        try { relayStatus = link.getStatus(); } catch (err) { errors.push(err); }
      }
      if (control) {
        try { await control.close(); } catch (err) { errors.push(err); }
      }
      try { settingsStore.close(); } catch (err) { errors.push(err); }
      frozen = Object.freeze({
        deviceId,
        phase: 'closed',
        control: { url: control.url, listening: false },
        relay: relayStatus,
        activeSettingsRevision: activeRevision,
        settingsRevision: revision,
        restartRequired: revision !== activeRevision,
      });
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'host service close failed');
    })();
    return closePromise;
  };

  return { deviceId, url: control.url, getStatus, close };
}
