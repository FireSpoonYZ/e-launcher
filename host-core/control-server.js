// 模块 5：本机长期控制服务。认证与 HTTP IO 边界由 control-http.js 提供；
// 本文件只负责路由、并发跟踪与生命周期/资源释放。
import http from 'node:http';
import { openHost } from './host.js';
import { openRuntime } from './runtime.js';
import { parseHindsightOptions } from './hindsight-client.js';
import {
  ControlHttpError,
  createControlAuthorizer,
  readControlBody,
  writeControlJson,
  writeControlError,
} from './control-http.js';
import { serveBotLive, serveWorkLive } from './control-live.js';

const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const PROTOCOL_VERSION = 1;
const JOB_STATE_RE = /^(pending|accepted|completed|failed)$/;
const MAX_STATUS_LIMIT = 200;

const routes = [
  { method: 'GET', key: '/v1/host', pattern: /^\/v1\/host\/?$/, params: [], hasBody: false, handler: getHostInfo },
  { method: 'GET', key: '/v1/bots', pattern: /^\/v1\/bots\/?$/, params: [], hasBody: false, handler: listBots },
  { method: 'POST', key: '/v1/bots', pattern: /^\/v1\/bots\/?$/, params: [], hasBody: true, handler: createBot },
  { method: 'GET', key: '/v1/bots/:botId', pattern: /^\/v1\/bots\/([^/]+)\/?$/, params: ['botId'], hasBody: false, handler: getBot },
  { method: 'GET', key: '/v1/bots/:botId/live', pattern: /^\/v1\/bots\/([^/]+)\/live\/?$/, params: ['botId'], hasBody: false, handler: live },
  { method: 'GET', key: '/v1/bot-requests/:requestId', pattern: /^\/v1\/bot-requests\/([^/]+)\/?$/, params: ['requestId'], hasBody: false, handler: findByRequest },
  { method: 'POST', key: '/v1/bots/:botId/submissions', pattern: /^\/v1\/bots\/([^/]+)\/submissions\/?$/, params: ['botId'], hasBody: true, handler: submit },
  { method: 'GET', key: '/v1/bots/:botId/submissions/:requestId', pattern: /^\/v1\/bots\/([^/]+)\/submissions\/([^/]+)\/?$/, params: ['botId', 'requestId'], hasBody: false, handler: getSubmission },
  { method: 'GET', key: '/v1/bots/:botId/history', pattern: /^\/v1\/bots\/([^/]+)\/history\/?$/, params: ['botId'], hasBody: false, handler: history },
  { method: 'POST', key: '/v1/bots/:botId/abort', pattern: /^\/v1\/bots\/([^/]+)\/abort\/?$/, params: ['botId'], hasBody: true, handler: abort },
  { method: 'GET', key: '/v1/bots/:botId/memory', pattern: /^\/v1\/bots\/([^/]+)\/memory\/?$/, params: ['botId'], hasBody: false, handler: memoryStatus },
  { method: 'POST', key: '/v1/bots/:botId/memory/recall', pattern: /^\/v1\/bots\/([^/]+)\/memory\/recall\/?$/, params: ['botId'], hasBody: true, handler: memoryRecall },
  { method: 'POST', key: '/v1/bots/:botId/memory/reflect', pattern: /^\/v1\/bots\/([^/]+)\/memory\/reflect\/?$/, params: ['botId'], hasBody: true, handler: memoryReflect },
  { method: 'POST', key: '/v1/bots/:botId/memory/retain', pattern: /^\/v1\/bots\/([^/]+)\/memory\/retain\/?$/, params: ['botId'], hasBody: true, handler: memoryRetain },
  { method: 'POST', key: '/v1/bots/:botId/memory/get', pattern: /^\/v1\/bots\/([^/]+)\/memory\/get\/?$/, params: ['botId'], hasBody: true, handler: memoryGet },
  { method: 'POST', key: '/v1/bots/:botId/memory/source', pattern: /^\/v1\/bots\/([^/]+)\/memory\/source\/?$/, params: ['botId'], hasBody: true, handler: memorySource },
  { method: 'POST', key: '/v1/bots/:botId/memory/correct', pattern: /^\/v1\/bots\/([^/]+)\/memory\/correct\/?$/, params: ['botId'], hasBody: true, handler: memoryCorrect },
  { method: 'POST', key: '/v1/bots/:botId/memory/retry', pattern: /^\/v1\/bots\/([^/]+)\/memory\/retry\/?$/, params: ['botId'], hasBody: true, handler: memoryRetry },
  { method: 'GET', key: '/v1/bots/:botId/context', pattern: /^\/v1\/bots\/([^/]+)\/context\/?$/, params: ['botId'], hasBody: false, handler: contextStatus },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: getWorkContext },
  { method: 'POST', key: '/v1/bots/:botId/work-contexts/:scopeKey/sync', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/sync\/?$/, params: ['botId', 'scopeKey'], hasBody: true, handler: syncWorkContext },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey/history', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/history\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: workHistory },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey/context', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/context\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: workContextStatus },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey/activity', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/activity\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: getWorkActivity },
  { method: 'POST', key: '/v1/bots/:botId/work-contexts/:scopeKey/stop', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/stop\/?$/, params: ['botId', 'scopeKey'], hasBody: true, handler: stopWork },
  { method: 'POST', key: '/v1/bots/:botId/work-contexts/:scopeKey/resume', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/resume\/?$/, params: ['botId', 'scopeKey'], hasBody: true, handler: resumeWork },
  { method: 'GET', key: '/v1/models', pattern: /^\/v1\/models\/?$/, params: [], hasBody: false, handler: models },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey/live', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/live\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: workLive },
  { method: 'GET', key: '/v1/scopes', pattern: /^\/v1\/scopes\/?$/, params: [], hasBody: false, handler: listScopes },
  { method: 'POST', key: '/v1/scopes', pattern: /^\/v1\/scopes\/?$/, params: [], hasBody: true, handler: createScope },
  { method: 'GET', key: '/v1/scopes/:scopeKey/history', pattern: /^\/v1\/scopes\/([^/]+)\/history\/?$/, params: ['scopeKey'], hasBody: false, handler: scopeHistory },
  { method: 'GET', key: '/v1/scopes/:scopeKey/messages/:messageKey', pattern: /^\/v1\/scopes\/([^/]+)\/messages\/([^/]+)\/?$/, params: ['scopeKey', 'messageKey'], hasBody: false, handler: scopeMessage },
  { method: 'GET', key: '/v1/scopes/:scopeKey/messages/:messageKey/delivery', pattern: /^\/v1\/scopes\/([^/]+)\/messages\/([^/]+)\/delivery\/?$/, params: ['scopeKey', 'messageKey'], hasBody: false, handler: scopeMessageDelivery },
  { method: 'GET', key: '/v1/settings', pattern: /^\/v1\/settings\/?$/, params: [], hasBody: false, handler: getSettings },
  { method: 'PUT', key: '/v1/settings', pattern: /^\/v1\/settings\/?$/, params: [], hasBody: true, handler: putSettings },
  { method: 'GET', key: '/v1/service', pattern: /^\/v1\/service\/?$/, params: [], hasBody: false, handler: serviceStatus },
  { method: 'GET', key: '/v1/scopes/:scopeKey', pattern: /^\/v1\/scopes\/([^/]+)\/?$/, params: ['scopeKey'], hasBody: false, handler: getScopeState },
  { method: 'POST', key: '/v1/scopes/:scopeKey/members', pattern: /^\/v1\/scopes\/([^/]+)\/members\/?$/, params: ['scopeKey'], hasBody: true, handler: updateScopeMembers },
  { method: 'POST', key: '/v1/scopes/:scopeKey/messages', pattern: /^\/v1\/scopes\/([^/]+)\/messages\/?$/, params: ['scopeKey'], hasBody: true, handler: publishUserMessage },
  { method: 'GET', key: '/v1/scopes/:scopeKey/replicas', pattern: /^\/v1\/scopes\/([^/]+)\/replicas\/?$/, params: ['scopeKey'], hasBody: false, handler: listScopeReplicas },
];

/**
 * 打开长期本机控制服务。token 与 port 在打开任何数据前校验；
 * 只固定绑定 127.0.0.1；单个 openRuntime + 单独 openHost 登记连接。
 */
export async function openControlServer(options) {
  const { token, port = DEFAULT_PORT, settings, getServiceStatus, ...runtimeOptions } = options ?? {};
  // 可选 settings/callback 一旦提供必须完整合法，否则 INVALID_ARGUMENT，不静默当未配置。
  let settingsStore = null;
  let activeRevision = null;
  if (settings !== undefined) {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings must be an object');
    }
    const store = settings.store;
    if (typeof store !== 'object' || store === null ||
        typeof store.get !== 'function' || typeof store.replace !== 'function' || typeof store.close !== 'function') {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings.store must expose get/replace/close');
    }
    if (!Number.isSafeInteger(settings.activeRevision) || settings.activeRevision <= 0) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings.activeRevision must be a positive safe integer');
    }
    settingsStore = store;
    activeRevision = settings.activeRevision;
  }
  if (getServiceStatus !== undefined && typeof getServiceStatus !== 'function') {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'getServiceStatus must be a function');
  }
  const ctx = {
    settingsStore,
    activeRevision,
    getServiceStatus: getServiceStatus ?? null,
  };
  assertPort(port);
  // token 格式由 createControlAuthorizer 校验；在打开任何数据前调用并保留结果。
  const authorize = createControlAuthorizer(token);

  // 先校验 Hindsight 配置（含 apiKeyEnv 解析），再打开本服务自己的 Host；
  // 仍把原始字段传给 openRuntime，绝不把归一化后的 apiKey 对象送回公共解析器。
  parseHindsightOptions(runtimeOptions.hindsight);

  const host = openHost({ dataRoot: runtimeOptions.dataRoot });
  let runtime;
  try {
    runtime = await openRuntime(runtimeOptions);
  } catch (err) {
    try { host.close(); } catch { /* 打开失败清理不掩盖原错误 */ }
    throw err;
  }

  let closed = false;
  const inflight = new Set();
  const track = (task) => {
    inflight.add(task);
    task.then(() => inflight.delete(task), () => inflight.delete(task));
  };

  const server = http.createServer((req, res) => {
    if (closed) {
      res.destroy();
      return;
    }
    track((async () => {
      try {
        await dispatch(host, runtime, authorize, req, res, ctx);
      } catch (err) {
        if (!res.writableEnded) {
          try { writeControlError(res, err); } catch { res.destroy(); }
        }
      }
    })());
  });
  // 头部/请求体读取有界，慢请求不会让关闭无限等待。
  server.headersTimeout = 15000;
  server.requestTimeout = 60000;
  server.timeout = 30000;

  await listen(server, port).catch(async (err) => {
    try { server.close(); } catch { /* 释放本次资源不掩盖原错误 */ }
    try { await runtime.close(); } catch { /* 释放本次资源不掩盖原错误 */ }
    try { host.close(); } catch { /* 释放本次资源不掩盖原错误 */ }
    throw err;
  });

  try {
    runtime.resume(); // 仅监听成功后启动已有任务调度
  } catch (err) {
    try { server.close(); server.closeAllConnections(); } catch { /* 不掩盖原错误 */ }
    try { await runtime.close(); } catch { /* 不掩盖原错误 */ }
    try { host.close(); } catch { /* 不掩盖原错误 */ }
    throw err;
  }

  const url = 'http://' + BIND_HOST + ':' + server.address().port;
  let closePromise = null;
  const close = () => {
    closePromise ??= (async () => {
      closed = true;
      const errors = [];
      const serverClosed = new Promise((resolve) => server.once('close', resolve));
      // 先关闭监听与本次连接：慢请求体读取被取消，不会拖住关闭。
      try { server.close(); } catch (err) { errors.push(err); }
      try { server.closeIdleConnections(); } catch (err) { errors.push(err); }
      try { server.closeAllConnections(); } catch (err) { errors.push(err); }
      // 再等待已接受调用收尾，最后关闭运行时与登记连接。
      try {
        while (inflight.size > 0) await Promise.allSettled([...inflight]);
      } catch (err) { errors.push(err); }
      try { await serverClosed; } catch (err) { errors.push(err); }
      try { await runtime.close(); } catch (err) { errors.push(err); }
      try { host.close(); } catch (err) { errors.push(err); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'control server close failed');
    })();
    return closePromise;
  };

  return { deviceId: host.deviceId, url, close };
}

async function dispatch(host, runtime, authorize, req, res, ctx) {
  authorize(req);
  let url;
  try {
    url = new URL(req.url, 'http://' + BIND_HOST);
  } catch {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'malformed request URL');
  }
  const method = req.method.toUpperCase();
  // 先收集全部路径匹配项，再按方法选择：避免同路径 GET 挡住 POST。
  const pathMatches = [];
  for (const route of routes) {
    const m = route.pattern.exec(url.pathname);
    if (m) pathMatches.push({ route, segments: m.slice(1) });
  }
  if (pathMatches.length === 0) throw new ControlHttpError(404, 'NOT_FOUND', 'unknown route: ' + url.pathname);
  const match = pathMatches.find((item) => item.route.method === method);
  if (!match) {
    const allowed = [...new Set(pathMatches.map((item) => item.route.method))];
    res.setHeader('Allow', allowed.join(', '));
    throw new ControlHttpError(405, 'METHOD_NOT_ALLOWED', 'method ' + method + ' not allowed for ' + url.pathname);
  }

  const params = {};
  match.route.params.forEach((name, i) => {
    params[name] = decodeSegment(match.segments[i]);
  });

  let body;
  if (match.route.hasBody) {
    body = await readControlBody(req);
  } else {
    req.resume(); // 排空多余请求体，避免占用保活连接
  }
  await match.route.handler(host, runtime, params, body, req, res, ctx);
}

async function getHostInfo(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: host.deviceId,
    platform: process.platform,
    arch: process.arch,
  });
}

async function listBots(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, host.listBots());
}

async function createBot(host, runtime, params, body, req, res) {
  writeControlJson(res, 201, host.createBot(body));
}

async function getBot(host, runtime, params, body, req, res) {
  const bot = host.getBot(params.botId);
  if (!bot) throw new ControlHttpError(404, 'BOT_NOT_FOUND', 'bot not found');
  writeControlJson(res, 200, bot);
}

async function live(host, runtime, params, body, req, res) {
  await serveBotLive(req, res, runtime, params.botId);
}

async function findByRequest(host, runtime, params, body, req, res) {
  const bot = host.findByRequest(params.requestId);
  if (!bot) throw new ControlHttpError(404, 'BOT_REQUEST_NOT_FOUND', 'request not found');
  writeControlJson(res, 200, bot);
}

async function submit(host, runtime, params, body, req, res) {
  // 只等待受理，不等待模型回答。
  const submission = await runtime.submit(params.botId, body);
  writeControlJson(res, 202, submission);
}

async function getSubmission(host, runtime, params, body, req, res) {
  const submission = await runtime.getSubmission(params.botId, params.requestId);
  if (!submission) throw new ControlHttpError(404, 'SUBMISSION_NOT_FOUND', 'submission not found');
  writeControlJson(res, 200, submission);
}

async function history(host, runtime, params, body, req, res) {
  const { limit, cursor } = parseHistoryQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams);
  const page = await runtime.history(params.botId, { limit, cursor });
  writeControlJson(res, 200, page);
}

async function abort(host, runtime, params, body, req, res) {
  await runtime.abort(params.botId);
  writeControlJson(res, 200, { botId: params.botId });
}

async function memoryStatus(host, runtime, params, body, req, res) {
  const input = parseMemoryStatusQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams);
  writeControlJson(res, 200, await runtime.memoryStatus(params.botId, input));
}

async function memoryRecall(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.recallMemory(params.botId, body));
}

async function memoryReflect(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.reflectMemory(params.botId, body));
}

async function memoryRetain(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 202, await runtime.retainMemory(params.botId, body));
}

async function memoryGet(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.getMemory(params.botId, body));
}

async function memorySource(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.getMemorySource(params.botId, body));
}

async function memoryCorrect(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 202, await runtime.correctMemory(params.botId, body));
}

async function memoryRetry(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 202, await runtime.retryMemory(params.botId, body));
}

async function contextStatus(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.contextStatus(params.botId));
}

async function getWorkContext(host, runtime, params, body, req, res) {
  const record = await runtime.getWorkContext(params.botId, workScopeId(params.scopeKey));
  if (!record) throw new ControlHttpError(404, 'WORK_CONTEXT_NOT_FOUND', 'work context not found');
  writeControlJson(res, 200, record);
}

async function syncWorkContext(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.syncWorkContext(params.botId, workScopeId(params.scopeKey), body));
}

async function workHistory(host, runtime, params, body, req, res) {
  const scopeId = workScopeId(params.scopeKey);
  const options = parseHistoryQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams);
  writeControlJson(res, 200, await runtime.workHistory(params.botId, scopeId, options));
}

async function workContextStatus(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.workContextStatus(params.botId, workScopeId(params.scopeKey)));
}

async function getWorkActivity(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.getWorkActivity(params.botId, workScopeId(params.scopeKey)));
}

async function stopWork(host, runtime, params, body, req, res) {
  if (Object.keys(body).length !== 0) throw invalidArgument('stopWork body must be an empty object');
  writeControlJson(res, 200, await runtime.stopWork(params.botId, workScopeId(params.scopeKey)));
}

async function resumeWork(host, runtime, params, body, req, res) {
  if (Object.keys(body).length !== 0) throw invalidArgument('resumeWork body must be an empty object');
  writeControlJson(res, 200, await runtime.resumeWork(params.botId, workScopeId(params.scopeKey)));
}

async function listScopes(host, runtime, params, body, req, res) {
  const options = parseScopeQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams, ['limit', 'cursor']);
  writeControlJson(res, 200, await runtime.listScopeStates(options));
}

async function createScope(host, runtime, params, body, req, res) {
  writeControlJson(res, 201, await runtime.createScope(body));
}

async function getScopeState(host, runtime, params, body, req, res) {
  // get-scope 不允许任何查询参数；从严拒绝未知/重复查询字段。
  parseScopeQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams, []);
  writeControlJson(res, 200, await runtime.getScopeState(workScopeId(params.scopeKey)));
}

async function updateScopeMembers(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.updateScope(workScopeId(params.scopeKey), body));
}

async function publishUserMessage(host, runtime, params, body, req, res) {
  writeControlJson(res, 202, await runtime.publishUserMessage(workScopeId(params.scopeKey), body));
}

async function listScopeReplicas(host, runtime, params, body, req, res) {
  const options = parseScopeQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams, ['limit', 'cursor']);
  writeControlJson(res, 200, await runtime.listScopeReplicas(workScopeId(params.scopeKey), options));
}

async function models(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.getModelCatalog());
}

async function workLive(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  await serveWorkLive(req, res, runtime, params.botId, workScopeId(params.scopeKey));
}

async function scopeHistory(host, runtime, params, body, req, res) {
  const options = parseScopeQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams, ['limit', 'cursor']);
  writeControlJson(res, 200, await runtime.scopeHistory(workScopeId(params.scopeKey), options));
}

async function scopeMessage(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  // messageKey 也固定 ~ 前缀（与 scopeKey 同一套保护/解码）。
  const message = await runtime.getScopeMessage(workScopeId(params.scopeKey), workScopeId(params.messageKey));
  if (!message) throw new ControlHttpError(404, 'MESSAGE_NOT_FOUND', 'message not found');
  writeControlJson(res, 200, message);
}

async function scopeMessageDelivery(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  const delivery = await runtime.getScopeMessageDelivery(workScopeId(params.scopeKey), workScopeId(params.messageKey));
  if (!delivery) throw new ControlHttpError(404, 'DELIVERY_NOT_FOUND', 'delivery not found');
  writeControlJson(res, 200, delivery);
}

async function getSettings(host, runtime, params, body, req, res, ctx) {
  assertNoQuery(req);
  if (!ctx.settingsStore) throw new ControlHttpError(503, 'CONTROL_UNAVAILABLE', 'settings store is not configured');
  const snapshot = ctx.settingsStore.get();
  writeControlJson(res, 200, {
    ...snapshot,
    activeRevision: ctx.activeRevision,
    restartRequired: snapshot.revision !== ctx.activeRevision,
  });
}

async function putSettings(host, runtime, params, body, req, res, ctx) {
  assertNoQuery(req);
  if (!ctx.settingsStore) throw new ControlHttpError(503, 'CONTROL_UNAVAILABLE', 'settings store is not configured');
  const snapshot = ctx.settingsStore.replace(validateSettingsUpdate(body));
  writeControlJson(res, 200, {
    ...snapshot,
    activeRevision: ctx.activeRevision,
    restartRequired: snapshot.revision !== ctx.activeRevision,
  });
}

function validateSettingsUpdate(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings update must be a JSON object');
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('expectedRevision') || !keys.includes('settings')) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings update must contain exactly expectedRevision and settings');
  }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision <= 0) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'expectedRevision must be a positive safe integer');
  }
  if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings must be a JSON object');
  }
  return { expectedRevision: body.expectedRevision, settings: body.settings };
}

async function serviceStatus(host, runtime, params, body, req, res, ctx) {
  assertNoQuery(req);
  if (!ctx.getServiceStatus) throw new ControlHttpError(503, 'CONTROL_UNAVAILABLE', 'service status is not configured');
  writeControlJson(res, 200, await ctx.getServiceStatus());
}

function workScopeId(scopeKey) {
  // dispatch 已解码一次；固定前缀保护 '.'/'..' scope，避免 URL 路径折叠。
  if (!scopeKey.startsWith('~')) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'work context scope path segment must start with ~');
  }
  return scopeKey.slice(1);
}

function parseHistoryQuery(searchParams) {
  const rawLimit = searchParams.get('limit');
  let limit;
  if (rawLimit !== null) {
    if (!/^[1-9]\d*$/.test(rawLimit)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'limit must be a positive decimal integer');
    }
    limit = Number(rawLimit);
  }
  const rawCursor = searchParams.get('cursor');
  let cursor;
  if (rawCursor !== null) {
    try {
      cursor = JSON.parse(rawCursor);
    } catch {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'cursor must be a JSON object');
    }
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'cursor must be a JSON object');
    }
  }
  return { limit, cursor };
}

// 新 scope 路由严格查询解析：只允许指定键、每个键至多一次，拒绝未知/重复字段。
function parseScopeQuery(searchParams, allowed) {
  const seen = new Set();
  const options = {};
  for (const [key, value] of searchParams) {
    if (!allowed.includes(key)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'unknown query parameter: ' + key);
    }
    if (seen.has(key)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'query parameter may appear at most once: ' + key);
    }
    seen.add(key);
    if (key === 'limit') {
      if (!/^[1-9]\d*$/.test(value)) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'limit must be a positive decimal integer');
      }
      options.limit = Number(value);
    } else {
      try {
        options.cursor = JSON.parse(value);
      } catch {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'cursor must be a JSON object');
      }
      if (options.cursor === null || typeof options.cursor !== 'object' || Array.isArray(options.cursor)) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'cursor must be a JSON object');
      }
    }
  }
  return options;
}

// GET memory 状态严格查询解析：只允许 target/state/limit/cursor，每键至多一次，
// 拒绝未知/重复/畸形值；无任何参数时返回 {}（默认 primary、全部状态、limit20）。
function parseMemoryStatusQuery(searchParams) {
  const seen = new Set();
  const input = {};
  for (const [key, value] of searchParams) {
    if (key !== 'target' && key !== 'state' && key !== 'limit' && key !== 'cursor') {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'unknown query parameter: ' + key);
    }
    if (seen.has(key)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'query parameter may appear at most once: ' + key);
    }
    seen.add(key);
    if (key === 'state') {
      if (!JOB_STATE_RE.test(value)) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'state must be pending, accepted, completed, or failed');
      }
      input.state = value;
    } else if (key === 'limit') {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_STATUS_LIMIT) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', `limit must be a strict positive integer between 1 and ${MAX_STATUS_LIMIT}`);
      }
      input.limit = Number(value);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', key + ' must be a JSON object');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', key + ' must be a JSON object');
      }
      input[key] = parsed;
    }
  }
  return input;
}

// memory POST 路由不允许任何查询参数；从严拒绝未知/重复查询字段。
function assertNoQuery(req) {
  if (new URL(req.url, 'http://' + BIND_HOST).searchParams.size > 0) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'query parameters are not allowed for this route');
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'malformed percent-encoding in URL path');
  }
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw invalidArgument('port must be an integer between 0 and 65535');
  }
}

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
