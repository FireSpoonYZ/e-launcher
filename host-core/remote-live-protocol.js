// host-core/remote-live-protocol.js
// Module 14 pure boundary parsers for remote live preview over the relay.
// Directional frame readers only: no ws/network/Runtime/database. Imports
// message-protocol.js (ids) and the control error code table. Snapshot state
// mirrors the existing BotLiveState projection exactly; unknown fields and
// raw docs/task memory/thinking/arguments/signatures are rejected here.

import { messageError, assertId } from './message-protocol.js';
import { normalizeDeviceName, normalizeDevicePlatform } from './device-metadata.js';
import { CONTROL_ERROR_CODES } from './remote-control-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';

export const LIVE_MAX_CLIENT_SUBSCRIPTIONS = 8;
export const LIVE_MAX_HOST_SUBSCRIPTIONS = 8;
export const LIVE_MAX_SUBSCRIPTIONS = 128;
export const LIVE_OPEN_TIMEOUT_MS = 20000;
export const MAX_LIVE_JSON_BYTES = 1048576; // 1 MiB per frame, UTF-8 bytes

const END_REASONS = new Set([
  'stopped',
  'cancelled',
  'session_closed',
  'retired',
  'listener_error',
  'session_failed',
  'error',
]);

const DEFAULT_DIRECTORY_LIMIT = 20;
const MAX_DIRECTORY_LIMIT = 200;
const MAX_DIRECTORY_ITEMS = 200;

const STATE_KEYS = new Set([
  'history',
  'historyTruncated',
  'lastEntryId',
  'generation',
  'tools',
  'toolsTruncated',
  'busy',
  'queuedCount',
]);
const HISTORY_ITEM_KEYS = new Set(['id', 'kind', 'messages']);
const MESSAGE_KEYS = new Set(['role', 'text', 'truncated', 'toolName', 'toolCallId', 'isError']);
const TOOL_KEYS = new Set([
  'callId',
  'name',
  'status',
  'output',
  'truncated',
  'droppedBytes',
  'droppedLines',
  'parentCallId',
  'entryId',
]);
// Roles emitted by the existing projection; no extra roles are invented here.
const MESSAGE_ROLES = new Set(['user', 'assistant', 'toolResult']);

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

function assertText(value, name) {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw invalid(`${name} must be a well-formed string`);
  }
}

function assertNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${name} must be a safe nonnegative integer`);
  }
}

/**
 * Normalize a live target. Exact {kind:'primary',botId} or
 * {kind:'work',botId,scopeId}; no caller native IDs.
 */
export function normalizeLiveTarget(target) {
  if (!isPlainObject(target)) throw invalid('live target must be a plain object');
  if (target.kind === 'primary') {
    rejectUnknownFields(target, new Set(['kind', 'botId']), 'live target');
    assertId(target.botId, 'target.botId');
    return { kind: 'primary', botId: target.botId };
  }
  if (target.kind === 'work') {
    rejectUnknownFields(target, new Set(['kind', 'botId', 'scopeId']), 'live target');
    assertId(target.botId, 'target.botId');
    assertId(target.scopeId, 'target.scopeId');
    return { kind: 'work', botId: target.botId, scopeId: target.scopeId };
  }
  throw invalid("live target.kind must be 'primary' or 'work'");
}

function normalizeLiveState(state) {
  if (!isPlainObject(state)) throw invalid('state must be a plain object');
  rejectUnknownFields(state, STATE_KEYS, 'state');
  if (!Array.isArray(state.history)) throw invalid('state.history must be an array');
  for (const item of state.history) {
    if (!isPlainObject(item)) throw invalid('state.history items must be plain objects');
    rejectUnknownFields(item, HISTORY_ITEM_KEYS, 'history item');
    assertNonNegativeSafeInteger(item.id, 'history item id');
    assertText(item.kind, 'history item kind');
    if (!Array.isArray(item.messages)) throw invalid('history item messages must be an array');
    for (const message of item.messages) {
      if (!isPlainObject(message)) throw invalid('history messages must be plain objects');
      rejectUnknownFields(message, MESSAGE_KEYS, 'history message');
      if (!MESSAGE_ROLES.has(message.role)) {
        throw invalid("message role must be 'user', 'assistant' or 'toolResult'");
      }
      assertText(message.text, 'message text');
      if (typeof message.truncated !== 'boolean') throw invalid('message truncated must be a boolean');
      if (message.toolName !== undefined) assertText(message.toolName, 'message toolName');
      if (message.toolCallId !== undefined) assertText(message.toolCallId, 'message toolCallId');
      if (message.isError !== undefined && typeof message.isError !== 'boolean') {
        throw invalid('message isError must be a boolean');
      }
    }
  }
  for (const key of ['historyTruncated', 'toolsTruncated', 'busy']) {
    if (typeof state[key] !== 'boolean') throw invalid(`state.${key} must be a boolean`);
  }
  if (state.lastEntryId !== null) assertNonNegativeSafeInteger(state.lastEntryId, 'state.lastEntryId');
  if (state.generation !== null) {
    if (!isPlainObject(state.generation)) throw invalid('state.generation must be null or a plain object');
    rejectUnknownFields(state.generation, new Set(['text', 'truncated']), 'generation');
    assertText(state.generation.text, 'generation text');
    if (typeof state.generation.truncated !== 'boolean') throw invalid('generation truncated must be a boolean');
  }
  if (!Array.isArray(state.tools)) throw invalid('state.tools must be an array');
  for (const tool of state.tools) {
    if (!isPlainObject(tool)) throw invalid('tools must be plain objects');
    rejectUnknownFields(tool, TOOL_KEYS, 'tool');
    assertText(tool.callId, 'tool callId');
    assertText(tool.name, 'tool name');
    assertText(tool.status, 'tool status');
    assertText(tool.output, 'tool output');
    if (typeof tool.truncated !== 'boolean') throw invalid('tool truncated must be a boolean');
    for (const key of ['droppedBytes', 'droppedLines']) {
      assertNonNegativeSafeInteger(tool[key], `tool ${key}`);
    }
    if (tool.parentCallId !== undefined) assertText(tool.parentCallId, 'tool parentCallId');
    if (tool.entryId !== undefined) assertNonNegativeSafeInteger(tool.entryId, 'tool entryId');
  }
  assertNonNegativeSafeInteger(state.queuedCount, 'state.queuedCount');
  return state;
}

/**
 * Normalize a snapshot frame. Two strict variants are discriminated by the
 * presence of the scopeId field:
 *  - work: carries scopeId, always the target scopeId (a non-empty id; null
 *    is never allowed), and conversationId may be null until the work session
 *    is bound;
 *  - primary: has no scopeId field at all and conversationId is a non-empty
 *    id.
 * The 1 MiB JSON budget is enforced before any traversal of untrusted arrays,
 * so oversized frames are rejected before deep state validation. When a
 * target is supplied, botId and the scopeId presence/value must match exactly.
 */
export function normalizeLiveSnapshot(frame, target) {
  if (!isPlainObject(frame)) throw invalid('snapshot frame must be a plain object');
  rejectUnknownFields(frame, new Set(['type', 'botId', 'conversationId', 'sequence', 'state', 'scopeId']), 'snapshot frame');
  if (frame.type !== 'snapshot') throw invalid('snapshot frame type must be snapshot');
  assertId(frame.botId, 'botId');
  assertNonNegativeSafeInteger(frame.sequence, 'snapshot sequence');
  const isWork = frame.scopeId !== undefined;
  if (isWork) {
    assertId(frame.scopeId, 'scopeId'); // null scopeId is never valid
    if (frame.conversationId !== null) {
      assertId(frame.conversationId, 'conversationId');
    }
  } else {
    assertId(frame.conversationId, 'conversationId');
  }
  // Budget first: reject oversized frames before traversing untrusted arrays.
  let json;
  try {
    json = JSON.stringify({
      type: frame.type,
      botId: frame.botId,
      conversationId: frame.conversationId,
      sequence: frame.sequence,
      state: frame.state,
      scopeId: isWork ? frame.scopeId : undefined,
    });
  } catch {
    throw invalid('snapshot frame must be JSON-serializable');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_LIVE_JSON_BYTES) {
    throw messageError('REQUEST_TOO_LARGE', 'live frame exceeds 1 MiB');
  }
  const snapshot = {
    type: 'snapshot',
    botId: frame.botId,
    conversationId: frame.conversationId,
    sequence: frame.sequence,
    state: normalizeLiveState(frame.state),
  };
  if (isWork) snapshot.scopeId = frame.scopeId;
  if (target) {
    if (frame.botId !== target.botId) throw invalid('snapshot botId does not match target');
    if (target.kind === 'work') {
      if (!isWork) throw invalid('work snapshot must carry scopeId');
      if (frame.scopeId !== target.scopeId) {
        throw invalid('snapshot scopeId does not match target scopeId');
      }
    } else if (isWork) {
      throw invalid('primary snapshot must not carry scopeId');
    }
  }
  return snapshot;
}

function normalizeLiveEnd(frame, label) {
  if (typeof frame.reason !== 'string' || !END_REASONS.has(frame.reason)) {
    throw invalid(`${label} reason must be an allowed live end reason`);
  }
  const normalized = { reason: frame.reason };
  if (frame.reason === 'error') {
    if (typeof frame.code !== 'string' || !CONTROL_ERROR_CODES.has(frame.code)) {
      throw invalid(`${label} code must be an allowed control error code`);
    }
    normalized.code = frame.code;
  } else if (frame.code !== undefined) {
    throw invalid(`${label} code is allowed only for the error reason`);
  }
  return normalized;
}

function normalizeDevicesListOptions(frame) {
  let limit = DEFAULT_DIRECTORY_LIMIT;
  if (frame.limit !== undefined) {
    if (!Number.isSafeInteger(frame.limit) || frame.limit < 1 || frame.limit > MAX_DIRECTORY_LIMIT) {
      throw invalid('limit must be a positive integer between 1 and 200');
    }
    limit = frame.limit;
  }
  let cursor = null;
  if (frame.cursor !== undefined && frame.cursor !== null) {
    if (!isPlainObject(frame.cursor)) throw invalid('cursor must be a plain JSON object or null');
    rejectUnknownFields(frame.cursor, new Set(['afterDeviceId']), 'devices-list cursor');
    assertId(frame.cursor.afterDeviceId, 'cursor.afterDeviceId');
    cursor = { afterDeviceId: frame.cursor.afterDeviceId };
  }
  return { limit, cursor };
}

// Relay SQLite side stores deviceId as BINARY; keyset continuation and page
// sort therefore use UTF-8 byte order, not JS UTF-16 code-unit comparison.
function compareDeviceIdAsc(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function normalizeDirectoryItem(item) {
  if (!isPlainObject(item)) throw invalid('device item must be an object');
  rejectUnknownFields(item, new Set(['deviceId', 'online', 'controlProtocol', 'scopeProtocol', 'displayName', 'platform']), 'device item');
  assertId(item.deviceId, 'item.deviceId');
  if (typeof item.online !== 'boolean') throw invalid('item online must be a boolean');
  if (![0, 1, 2].includes(item.controlProtocol) || ![0, 1].includes(item.scopeProtocol)) throw invalid('invalid device protocol');
  if (item.displayName !== undefined && item.displayName !== item.deviceId) normalizeDeviceName(item.displayName);
  if (item.platform !== undefined) normalizeDevicePlatform(item.platform);
  return { ...item, displayName: item.displayName ?? item.deviceId };
}

function normalizeDevicesResult(frame) {
  if (frame.ok === true) {
    rejectUnknownFields(frame, new Set(['type', 'callId', 'ok', 'items', 'nextCursor']), 'devices-result frame');
    assertId(frame.callId, 'callId');
    if (!Array.isArray(frame.items) || frame.items.length > MAX_DIRECTORY_ITEMS) {
      throw invalid('devices-result items must be an array of at most 200 devices');
    }
    for (const item of frame.items) {
      normalizeDirectoryItem(item);
    }
    for (let i = 1; i < frame.items.length; i += 1) {
      if (compareDeviceIdAsc(frame.items[i - 1].deviceId, frame.items[i].deviceId) >= 0) {
        throw invalid('devices-result items must ascend by deviceId in UTF-8 byte order');
      }
    }
    // nextCursor must be explicitly present on success (null allowed); a
    // missing field is malformed, never a normal end page.
    if (frame.nextCursor === undefined) {
      throw invalid('devices-result must carry nextCursor');
    }
    let nextCursor = null;
    if (frame.nextCursor !== null) {
      if (!isPlainObject(frame.nextCursor)) throw invalid('nextCursor must be a plain JSON object or null');
      rejectUnknownFields(frame.nextCursor, new Set(['afterDeviceId']), 'devices-result nextCursor');
      assertId(frame.nextCursor.afterDeviceId, 'nextCursor.afterDeviceId');
      if (frame.items.length === 0 || frame.nextCursor.afterDeviceId !== frame.items[frame.items.length - 1].deviceId) {
        throw invalid('nextCursor must reflect the last returned item');
      }
      nextCursor = { afterDeviceId: frame.nextCursor.afterDeviceId };
    }
    return { type: 'devices-result', callId: frame.callId, ok: true, items: frame.items.map(normalizeDirectoryItem), nextCursor };
  }
  if (frame.ok === false) {
    rejectUnknownFields(frame, new Set(['type', 'callId', 'ok', 'code']), 'devices-result frame');
    assertId(frame.callId, 'callId');
    if (typeof frame.code !== 'string' || !CONTROL_ERROR_CODES.has(frame.code)) {
      throw invalid('devices-result code must be an allowed control error code');
    }
    return { type: 'devices-result', callId: frame.callId, ok: false, code: frame.code };
  }
  throw invalid('devices-result ok must be a boolean');
}

/**
 * Parse a live frame sent by a relay client: live-open, live-cancel(watchId)
 * or devices-list. Throws INVALID_ARGUMENT on any protocol violation.
 */
export function readLiveClientFrame(parsed) {
  if (!isPlainObject(parsed)) throw invalid('live frame must be an object');
  switch (parsed.type) {
    case 'live-open': {
      rejectUnknownFields(parsed, new Set(['type', 'watchId', 'targetDeviceId', 'target']), 'live-open frame');
      assertId(parsed.watchId, 'watchId');
      assertId(parsed.targetDeviceId, 'targetDeviceId');
      return {
        type: 'live-open',
        watchId: parsed.watchId,
        targetDeviceId: parsed.targetDeviceId,
        target: normalizeLiveTarget(parsed.target),
      };
    }
    case 'live-cancel': {
      rejectUnknownFields(parsed, new Set(['type', 'watchId']), 'live-cancel frame');
      assertId(parsed.watchId, 'watchId');
      return { type: 'live-cancel', watchId: parsed.watchId };
    }
    case 'devices-list': {
      rejectUnknownFields(parsed, new Set(['type', 'callId', 'limit', 'cursor', 'names']), 'devices-list frame');
      assertId(parsed.callId, 'callId');
      const { limit, cursor } = normalizeDevicesListOptions(parsed);
      if (parsed.names !== undefined && parsed.names !== 1) throw invalid('names must be 1');
      return { type: 'devices-list', callId: parsed.callId, limit, cursor, names: parsed.names };
    }
    case 'device-rename': {
      rejectUnknownFields(parsed, new Set(['type', 'callId', 'deviceId', 'displayName']), 'device-rename frame');
      assertId(parsed.callId, 'callId');
      assertId(parsed.deviceId, 'deviceId');
      return { type: 'device-rename', callId: parsed.callId, deviceId: parsed.deviceId, displayName: normalizeDeviceName(parsed.displayName) };
    }
    default:
      throw invalid('unknown live client frame type');
  }
}

/**
 * Parse a live frame sent by a Host to the relay: live-frame(routeId) or
 * live-end(routeId). Throws INVALID_ARGUMENT on any protocol violation.
 */
export function readLiveHostFrame(parsed) {
  if (!isPlainObject(parsed)) throw invalid('live frame must be an object');
  switch (parsed.type) {
    case 'live-frame': {
      rejectUnknownFields(parsed, new Set(['type', 'routeId', 'frame']), 'live-frame frame');
      assertId(parsed.routeId, 'routeId');
      return { type: 'live-frame', routeId: parsed.routeId, frame: normalizeLiveSnapshot(parsed.frame) };
    }
    case 'live-end': {
      rejectUnknownFields(parsed, new Set(['type', 'routeId', 'reason', 'code']), 'live-end frame');
      assertId(parsed.routeId, 'routeId');
      return { type: 'live-end', routeId: parsed.routeId, ...normalizeLiveEnd(parsed, 'live-end') };
    }
    default:
      throw invalid('unknown live host frame type');
  }
}

/**
 * Parse a live frame sent by the relay server: live-request, live-cancel
 * (routeId), live-frame, live-end(watchId,targetDeviceId) or
 * devices-result. Throws INVALID_ARGUMENT on any protocol violation.
 */
export function readLiveServerFrame(parsed) {
  if (!isPlainObject(parsed)) throw invalid('live frame must be an object');
  switch (parsed.type) {
    case 'live-request': {
      rejectUnknownFields(parsed, new Set(['type', 'routeId', 'fromDeviceId', 'target']), 'live-request frame');
      assertId(parsed.routeId, 'routeId');
      assertId(parsed.fromDeviceId, 'fromDeviceId');
      return {
        type: 'live-request',
        routeId: parsed.routeId,
        fromDeviceId: parsed.fromDeviceId,
        target: normalizeLiveTarget(parsed.target),
      };
    }
    case 'live-cancel': {
      rejectUnknownFields(parsed, new Set(['type', 'routeId']), 'live-cancel frame');
      assertId(parsed.routeId, 'routeId');
      return { type: 'live-cancel', routeId: parsed.routeId };
    }
    case 'live-frame': {
      rejectUnknownFields(parsed, new Set(['type', 'watchId', 'targetDeviceId', 'frame']), 'live-frame frame');
      assertId(parsed.watchId, 'watchId');
      assertId(parsed.targetDeviceId, 'targetDeviceId');
      return {
        type: 'live-frame',
        watchId: parsed.watchId,
        targetDeviceId: parsed.targetDeviceId,
        frame: normalizeLiveSnapshot(parsed.frame),
      };
    }
    case 'live-end': {
      rejectUnknownFields(parsed, new Set(['type', 'watchId', 'targetDeviceId', 'reason', 'code']), 'live-end frame');
      assertId(parsed.watchId, 'watchId');
      assertId(parsed.targetDeviceId, 'targetDeviceId');
      return {
        type: 'live-end',
        watchId: parsed.watchId,
        targetDeviceId: parsed.targetDeviceId,
        ...normalizeLiveEnd(parsed, 'live-end'),
      };
    }
    case 'devices-result':
      return normalizeDevicesResult(parsed);
    case 'device-renamed': {
      assertId(parsed.callId, 'callId');
      if (parsed.ok === true) {
        rejectUnknownFields(parsed, new Set(['type', 'callId', 'ok', 'item']), 'device-renamed frame');
        return { type: parsed.type, callId: parsed.callId, ok: true, item: normalizeDirectoryItem(parsed.item) };
      }
      rejectUnknownFields(parsed, new Set(['type', 'callId', 'ok', 'code']), 'device-renamed frame');
      if (parsed.ok !== false || (parsed.code !== 'DEVICE_NOT_FOUND' && !CONTROL_ERROR_CODES.has(parsed.code))) throw invalid('invalid device-renamed failure');
      return { type: parsed.type, callId: parsed.callId, ok: false, code: parsed.code };
    }
    default:
      throw invalid('unknown live server frame type');
  }
}
