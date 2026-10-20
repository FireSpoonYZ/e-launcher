// 模块 5：本机长期控制服务。认证与 HTTP IO 边界由 control-http.js 提供；
// 本文件只负责路由、并发跟踪与生命周期/资源释放。
import http from 'node:http';
import { openHost } from './host.js';
import { openRuntime } from './runtime.js';
import {
  ControlHttpError,
  createControlAuthorizer,
  readControlBody,
  writeControlJson,
  writeControlError,
} from './control-http.js';

const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const PROTOCOL_VERSION = 1;

const routes = [
  { method: 'GET', key: '/v1/host', pattern: /^\/v1\/host\/?$/, params: [], hasBody: false, handler: getHostInfo },
  { method: 'GET', key: '/v1/bots', pattern: /^\/v1\/bots\/?$/, params: [], hasBody: false, handler: listBots },
  { method: 'POST', key: '/v1/bots', pattern: /^\/v1\/bots\/?$/, params: [], hasBody: true, handler: createBot },
  { method: 'GET', key: '/v1/bots/:botId', pattern: /^\/v1\/bots\/([^/]+)\/?$/, params: ['botId'], hasBody: false, handler: getBot },
  { method: 'GET', key: '/v1/bot-requests/:requestId', pattern: /^\/v1\/bot-requests\/([^/]+)\/?$/, params: ['requestId'], hasBody: false, handler: findByRequest },
  { method: 'POST', key: '/v1/bots/:botId/submissions', pattern: /^\/v1\/bots\/([^/]+)\/submissions\/?$/, params: ['botId'], hasBody: true, handler: submit },
  { method: 'GET', key: '/v1/bots/:botId/submissions/:requestId', pattern: /^\/v1\/bots\/([^/]+)\/submissions\/([^/]+)\/?$/, params: ['botId', 'requestId'], hasBody: false, handler: getSubmission },
  { method: 'GET', key: '/v1/bots/:botId/history', pattern: /^\/v1\/bots\/([^/]+)\/history\/?$/, params: ['botId'], hasBody: false, handler: history },
  { method: 'POST', key: '/v1/bots/:botId/abort', pattern: /^\/v1\/bots\/([^/]+)\/abort\/?$/, params: ['botId'], hasBody: true, handler: abort },
  { method: 'GET', key: '/v1/bots/:botId/context', pattern: /^\/v1\/bots\/([^/]+)\/context\/?$/, params: ['botId'], hasBody: false, handler: contextStatus },
];

/**
 * 打开长期本机控制服务。token 与 port 在打开任何数据前校验；
 * 只固定绑定 127.0.0.1；单个 openRuntime + 单独 openHost 登记连接。
 */
export async function openControlServer(options) {
  const { token, port = DEFAULT_PORT, ...runtimeOptions } = options ?? {};
  assertPort(port);
  // token 格式由 createControlAuthorizer 校验；在打开任何数据前调用并保留结果。
  const authorize = createControlAuthorizer(token);

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
        await dispatch(host, runtime, authorize, req, res);
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

async function dispatch(host, runtime, authorize, req, res) {
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
  await match.route.handler(host, runtime, params, body, req, res);
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

async function contextStatus(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.contextStatus(params.botId));
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
