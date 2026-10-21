// host-core/local-control-adapter.js
// Module 9: authenticated target-local loopback Host control adapter. Talks
// only to the local control server via createControlClient over a bounded
// fetch; never opens Runtime, files, or other local state. All errors carry a
// fixed .code and .outcome (not-sent / unconfirmed / responded).
import { createControlClient, ControlApiError } from './control-client.js';
import { assertId } from './message-protocol.js';
import { MAX_CONTROL_JSON_BYTES } from './remote-control-protocol.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]']);

// Local domain codes the control server may return; forwarded unchanged with
// outcome responded. Everything else (transport/protocol) is mapped below.
const LOCAL_DOMAIN_CODES = new Set([
  'INVALID_ARGUMENT',
  'INVALID_CWD',
  'REQUEST_CONFLICT',
  'BOT_NOT_FOUND',
  'BOT_REQUEST_NOT_FOUND',
  'SUBMISSION_NOT_FOUND',
  'MODEL_REQUIRED',
  'MODEL_NOT_FOUND',
  'RUNTIME_BUSY',
  'UNSUPPORTED_SCHEMA',
  'INTERNAL',
  'REQUEST_TOO_LARGE',
  'INVALID_UTF8',
  'INVALID_JSON',
  'INVALID_BODY',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNAUTHORIZED',
  'ORIGIN_FORBIDDEN',
]);

function controlError(code, outcome) {
  const err = new Error(`local host control ${code.toLowerCase().replace(/_/g, ' ')} (${outcome})`);
  err.name = 'LocalControlError';
  err.code = code;
  err.outcome = outcome;
  return err;
}

/**
 * Synchronous config validation only; no network, files, or sockets here.
 * url must be plain loopback http with path exactly /, no userinfo/query/
 * fragment; token must be a URL-safe opaque string of 32-512 characters.
 */
function validateOptions(options) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('createLocalControlAdapter: options must be an object');
  }
  const hasUrl = Object.prototype.hasOwnProperty.call(options, 'url');
  const hasToken = Object.prototype.hasOwnProperty.call(options, 'token');
  if (Object.keys(options).length !== 2 || !hasUrl || !hasToken) {
    throw new TypeError('createLocalControlAdapter: options must be exactly own { url, token }');
  }
  const { url: rawUrl, token } = options;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TypeError('createLocalControlAdapter: token must be a URL-safe string of 32-512 characters');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError('createLocalControlAdapter: url must be a valid http URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new TypeError('createLocalControlAdapter: url must be http://127.0.0.1 or http://[::1]');
  }
  if (url.pathname !== '/') {
    throw new TypeError('createLocalControlAdapter: url path must be exactly /');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('createLocalControlAdapter: url must not contain user info');
  }
  if (url.search !== '') {
    throw new TypeError('createLocalControlAdapter: url must not contain a query string');
  }
  if (url.hash !== '') {
    throw new TypeError('createLocalControlAdapter: url must not contain a fragment');
  }
  return { url: rawUrl, token };
}

function abortReason(signal) {
  if (signal && signal.reason !== undefined) return signal.reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Bounded fetch: rejects redirects, and reads the response body with a real
 * <=1MiB byte cap. On excess, marks state.tooLarge, cancels the reader, and
 * throws with no partial body, so the caller's state check maps it to
 * RESPONSE_TOO_LARGE (ControlClient would otherwise report NETWORK/BAD_RESPONSE).
 * Normal bounded bodies are returned as a fresh Response built from the bytes.
 */
function boundedFetch(state) {
  return async function fetchBounded(input, init = {}) {
    const signal = init.signal;
    const response = await globalThis.fetch(input, { ...init, redirect: 'error' });
    if (!response.body) return response; // 204/HEAD: no body to bound
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        if (signal && signal.aborted) throw abortReason(signal);
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CONTROL_JSON_BYTES) {
          state.tooLarge = true;
          await reader.cancel();
          throw new Error('host control response exceeds size limit');
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
    const body = chunks.length === 0 ? null : concatChunks(chunks, size);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function historyOptions(params, signal) {
  const options = { signal };
  if (params.limit != null) options.limit = params.limit;
  if (params.cursor != null) options.cursor = params.cursor;
  return options;
}

// Exact mapping to the native ControlClient surface; only method 'abort'
// calls the local abort API. getHostInfo is handled separately after identity
// verification. Map avoids inherited prototype keys being treated as methods.
const METHOD_HANDLERS = new Map([
  ['listBots', (control, params, signal) => control.listBots({ signal })],
  ['createBot', (control, params, signal) => control.createBot(params, { signal })],
  ['getBot', (control, params, signal) => control.getBot(params.botId, { signal })],
  ['findByRequest', (control, params, signal) => control.findByRequest(params.requestId, { signal })],
  ['submit', (control, params, signal) =>
    control.submit(params.botId, { requestId: params.requestId, text: params.text }, { signal })],
  ['getSubmission', (control, params, signal) =>
    control.getSubmission(params.botId, params.requestId, { signal })],
  ['history', (control, params, signal) => control.history(params.botId, historyOptions(params, signal))],
  ['abort', (control, params, signal) => control.abort(params.botId, { signal })],
  ['contextStatus', (control, params, signal) => control.contextStatus(params.botId, { signal })],
]);

function requireValidId(value) {
  try {
    assertId(value, 'expectedDeviceId');
  } catch {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }
}

// Preflight only verifies identity; nothing requested was dispatched, so every
// preflight failure is not-sent.
function preflightError(err, state, signal) {
  if (signal && signal.aborted) return controlError('CANCELLED', 'not-sent');
  if (state.tooLarge) return controlError('RESPONSE_TOO_LARGE', 'not-sent');
  if (err instanceof ControlApiError) {
    if (err.code === 'UNAUTHORIZED') return controlError('CONTROL_UNAUTHORIZED', 'not-sent');
    if (err.code === 'NETWORK' || err.code === 'BAD_RESPONSE') {
      return controlError('CONTROL_UNAVAILABLE', 'not-sent');
    }
  }
  return controlError('CONTROL_UNAVAILABLE', 'not-sent');
}

// Actual method dispatch has begun: transport failures are unconfirmed, and
// known local domain codes are forwarded as responded. Too-large responses are
// responded once dispatched (the host did answer).
function dispatchError(err, state, signal) {
  if (state.tooLarge) return controlError('RESPONSE_TOO_LARGE', 'responded');
  if (signal && signal.aborted) return controlError('CANCELLED', 'unconfirmed');
  if (err instanceof ControlApiError) {
    if (err.code === 'NETWORK') return controlError('NETWORK', 'unconfirmed');
    if (err.code === 'BAD_RESPONSE') return controlError('BAD_RESPONSE', 'unconfirmed');
    if (LOCAL_DOMAIN_CODES.has(err.code)) return controlError(err.code, 'responded');
  }
  return controlError('INTERNAL', 'unconfirmed');
}

async function executeCall(config, expectedDeviceId, method, params, { signal } = {}) {
  requireValidId(expectedDeviceId);
  const handler = METHOD_HANDLERS.get(method);
  if (!handler && method !== 'getHostInfo') throw controlError('INVALID_ARGUMENT', 'not-sent');
  if (params === undefined || params === null) {
    params = {};
  } else if (typeof params !== 'object' || Array.isArray(params)) {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }

  // Per-call state + client: concurrent execute() calls must not share the
  // tooLarge flag. Preflight and dispatch of one call share the same signal.
  const state = { tooLarge: false };
  const control = createControlClient({
    url: config.url,
    token: config.token,
    fetch: boundedFetch(state),
  });

  let info;
  try {
    info = await control.getHostInfo({ signal });
  } catch (err) {
    throw preflightError(err, state, signal);
  }
  if (state.tooLarge) throw controlError('RESPONSE_TOO_LARGE', 'not-sent');
  if (info === null || typeof info !== 'object' || info.deviceId !== expectedDeviceId) {
    throw controlError('CONTROL_IDENTITY_MISMATCH', 'not-sent');
  }
  if (method === 'getHostInfo') return info;

  try {
    const result = await handler(control, params, signal);
    if (state.tooLarge) throw controlError('RESPONSE_TOO_LARGE', 'responded');
    return result;
  } catch (err) {
    throw dispatchError(err, state, signal);
  }
}

export function createLocalControlAdapter(options) {
  const config = validateOptions(options);
  return async function execute(expectedDeviceId, method, params, callOptions = {}) {
    return executeCall(config, expectedDeviceId, method, params, callOptions);
  };
}
