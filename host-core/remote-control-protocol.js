// host-core/remote-control-protocol.js
// Module 9 pure boundary parsers for authenticated remote Host JSON control.
// Directional frame readers only: no ws/network/Runtime/storage. Imports
// message-protocol.js only and defines its own control limits.

import { messageError, assertId } from './message-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';

export const MAX_CONTROL_JSON_BYTES = 1048576; // 1 MiB, params/result JSON UTF-8 bytes
export const CONTROL_TIMEOUT_MS = 20000;
export const CONTROL_CLIENT_TIMEOUT_MS = 25000;
export const CONTROL_MAX_CLIENT_CALLS = 8;
export const CONTROL_MAX_HOST_CALLS = 8;
export const CONTROL_MAX_PENDING = 128;

export const CONTROL_METHODS = Object.freeze([
  'getHostInfo',
  'listBots',
  'createBot',
  'getBot',
  'findByRequest',
  'submit',
  'getSubmission',
  'history',
  'abort',
  'contextStatus',
]);

// Never mutate this Set; it is the complete wire error code table.
export const CONTROL_ERROR_CODES = new Set([
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
  'NETWORK',
  'BAD_RESPONSE',
  'OFFLINE',
  'BACKPRESSURE',
  'RPC_BUSY',
  'TIMEOUT',
  'DISCONNECTED',
  'CANCELLED',
  'NOT_CONNECTED',
  'REVOKED',
  'BAD_FRAME',
  'CONNECT_FAILED',
  'CONTROL_UNAVAILABLE',
  'CONTROL_IDENTITY_MISMATCH',
  'CONTROL_UNAUTHORIZED',
  'RESPONSE_TOO_LARGE',
]);

// Failure outcome semantics across the control protocol.
export const CONTROL_OUTCOMES = new Set(['not-sent', 'unconfirmed', 'responded']);

function invalid(message) {
  return messageError(INVALID_ARGUMENT, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unknown field: ${key}`);
    }
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.trim() === '') {
    throw invalid(`${name} must be a well-formed non-empty string`);
  }
}

// Params normalize per method; unknown keys, missing required fields and
// malformed values are rejected. cwd/role/text are only checked as strings;
// no source-device resolution happens here.
function normalizeControlParams(method, params) {
  switch (method) {
    case 'getHostInfo':
    case 'listBots': {
      rejectUnknownFields(params, new Set(), 'params');
      return {};
    }
    case 'createBot': {
      rejectUnknownFields(params, new Set(['requestId', 'role', 'cwd', 'modelRef']), 'params');
      assertId(params.requestId, 'requestId');
      assertNonEmptyString(params.role, 'role');
      assertNonEmptyString(params.cwd, 'cwd');
      let modelRef = null;
      if (params.modelRef !== undefined && params.modelRef !== null) {
        assertNonEmptyString(params.modelRef, 'modelRef');
        modelRef = params.modelRef;
      }
      return { requestId: params.requestId, role: params.role, cwd: params.cwd, modelRef };
    }
    case 'getBot':
    case 'abort':
    case 'contextStatus': {
      rejectUnknownFields(params, new Set(['botId']), 'params');
      assertId(params.botId, 'botId');
      return { botId: params.botId };
    }
    case 'findByRequest': {
      rejectUnknownFields(params, new Set(['requestId']), 'params');
      assertId(params.requestId, 'requestId');
      return { requestId: params.requestId };
    }
    case 'submit': {
      rejectUnknownFields(params, new Set(['botId', 'requestId', 'text']), 'params');
      assertId(params.botId, 'botId');
      assertId(params.requestId, 'requestId');
      assertNonEmptyString(params.text, 'text');
      return { botId: params.botId, requestId: params.requestId, text: params.text };
    }
    case 'getSubmission': {
      rejectUnknownFields(params, new Set(['botId', 'requestId']), 'params');
      assertId(params.botId, 'botId');
      assertId(params.requestId, 'requestId');
      return { botId: params.botId, requestId: params.requestId };
    }
    case 'history': {
      rejectUnknownFields(params, new Set(['botId', 'limit', 'cursor']), 'params');
      assertId(params.botId, 'botId');
      const normalized = { botId: params.botId, cursor: null };
      if (params.limit !== undefined) {
        if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200) {
          throw invalid('limit must be a positive integer between 1 and 200');
        }
        normalized.limit = params.limit;
      }
      if (params.cursor !== undefined && params.cursor !== null) {
        if (!isPlainObject(params.cursor)) {
          throw invalid('cursor must be a plain JSON object or null');
        }
        normalized.cursor = params.cursor;
      }
      return normalized;
    }
    default:
      throw invalid('unknown control method');
  }
}

/**
 * Validate a control method name and its params object against the fixed
 * method table. Throws messageError INVALID_ARGUMENT on unknown method/invalid
 * params, REQUEST_TOO_LARGE when normalized params exceed 1 MiB UTF-8.
 */
export function normalizeControlCall(method, params) {
  if (typeof method !== 'string' || !CONTROL_METHODS.includes(method)) {
    throw invalid('unknown control method');
  }
  if (params === undefined) params = {};
  if (!isPlainObject(params)) {
    throw invalid('params must be an object');
  }
  const normalized = normalizeControlParams(method, params);
  let json;
  try {
    json = JSON.stringify(normalized);
  } catch {
    throw invalid('params must be JSON-serializable');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_CONTROL_JSON_BYTES) {
    throw messageError('REQUEST_TOO_LARGE', 'control params exceed 1 MiB');
  }
  return { method, params: normalized };
}

// Shared success/failure half of a control-result frame. Success carries only
// a non-null JSON object/array result; failure carries only an allowed code +
// outcome. No free-form message/stack/status on the wire.
function normalizeControlResult(parsed, label) {
  if (typeof parsed.ok !== 'boolean') {
    throw invalid(`${label}.ok must be a boolean`);
  }
  if (parsed.ok) {
    if (parsed.code !== undefined || parsed.outcome !== undefined) {
      throw invalid(`${label} success must not carry code/outcome`);
    }
    if (!isPlainObject(parsed.result) && !Array.isArray(parsed.result)) {
      throw invalid(`${label}.result must be a non-null JSON object or array`);
    }
    let json;
    try {
      json = JSON.stringify(parsed.result);
    } catch {
      throw invalid(`${label}.result must be JSON-serializable`);
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_CONTROL_JSON_BYTES) {
      throw messageError('RESPONSE_TOO_LARGE', `${label} result exceeds 1 MiB`);
    }
    return { ok: true, result: parsed.result };
  }
  if (parsed.result !== undefined) {
    throw invalid(`${label} failure must not carry result`);
  }
  if (typeof parsed.code !== 'string' || !CONTROL_ERROR_CODES.has(parsed.code)) {
    throw invalid(`${label}.code must be an allowed control error code`);
  }
  if (typeof parsed.outcome !== 'string' || !CONTROL_OUTCOMES.has(parsed.outcome)) {
    throw invalid(`${label}.outcome must be one of not-sent, unconfirmed, responded`);
  }
  return { ok: false, code: parsed.code, outcome: parsed.outcome };
}

/**
 * Parse a control frame sent by a remote client to the relay: control-call or
 * control-cancel(callId). Throws INVALID_ARGUMENT on any protocol violation.
 */
export function readControlClientFrame(parsed) {
  if (!isPlainObject(parsed)) {
    throw invalid('control frame must be an object');
  }
  switch (parsed.type) {
    case 'control-call': {
      rejectUnknownFields(parsed, new Set(['type', 'callId', 'targetDeviceId', 'method', 'params']), 'control-call frame');
      assertId(parsed.callId, 'callId');
      assertId(parsed.targetDeviceId, 'targetDeviceId');
      const { method, params } = normalizeControlCall(parsed.method, parsed.params);
      return {
        type: 'control-call',
        callId: parsed.callId,
        targetDeviceId: parsed.targetDeviceId,
        method,
        params,
      };
    }
    case 'control-cancel': {
      rejectUnknownFields(parsed, new Set(['type', 'callId']), 'control-cancel frame');
      assertId(parsed.callId, 'callId');
      return { type: 'control-cancel', callId: parsed.callId };
    }
    default:
      throw invalid('unknown control client frame type');
  }
}

/**
 * Parse a control frame sent by a Host to the relay: control-result(routeId).
 * Throws INVALID_ARGUMENT on any protocol violation. (Extra directional helper
 * used by relay-protocol.js; host control-result has no callId/targetDeviceId.)
 */
export function readControlHostFrame(parsed) {
  if (!isPlainObject(parsed)) {
    throw invalid('control frame must be an object');
  }
  if (parsed.type !== 'control-result') {
    throw invalid('unknown control host frame type');
  }
  rejectUnknownFields(parsed, new Set(['type', 'routeId', 'ok', 'result', 'code', 'outcome']), 'control-result frame');
  assertId(parsed.routeId, 'routeId');
  const result = normalizeControlResult(parsed, 'control-result');
  return { type: 'control-result', routeId: parsed.routeId, ...result };
}

/**
 * Parse a control frame sent by the relay server: control-request,
 * control-cancel(routeId), or control-result(callId,targetDeviceId). Throws
 * INVALID_ARGUMENT on any protocol violation.
 */
export function readControlServerFrame(parsed) {
  if (!isPlainObject(parsed)) {
    throw invalid('control frame must be an object');
  }
  switch (parsed.type) {
    case 'control-request': {
      rejectUnknownFields(parsed, new Set(['type', 'routeId', 'fromDeviceId', 'method', 'params']), 'control-request frame');
      assertId(parsed.routeId, 'routeId');
      assertId(parsed.fromDeviceId, 'fromDeviceId');
      const { method, params } = normalizeControlCall(parsed.method, parsed.params);
      return {
        type: 'control-request',
        routeId: parsed.routeId,
        fromDeviceId: parsed.fromDeviceId,
        method,
        params,
      };
    }
    case 'control-cancel': {
      rejectUnknownFields(parsed, new Set(['type', 'routeId']), 'control-cancel frame');
      assertId(parsed.routeId, 'routeId');
      return { type: 'control-cancel', routeId: parsed.routeId };
    }
    case 'control-result': {
      rejectUnknownFields(parsed, new Set(['type', 'callId', 'targetDeviceId', 'ok', 'result', 'code', 'outcome']), 'control-result frame');
      assertId(parsed.callId, 'callId');
      assertId(parsed.targetDeviceId, 'targetDeviceId');
      const result = normalizeControlResult(parsed, 'control-result');
      return {
        type: 'control-result',
        callId: parsed.callId,
        targetDeviceId: parsed.targetDeviceId,
        ...result,
      };
    }
    default:
      throw invalid('unknown control server frame type');
  }
}
