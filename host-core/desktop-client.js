// host-core/desktop-client.js
// Module 17: client-only Node broker for the desktop Tauri client.
// Reuses existing fixed control clients (createLocalControlAdapter,
// openRemoteControl), pending outbox (openPendingClient), and private UI state
// store (openDesktopUiStore). Never starts a Host, Runtime, or model loop;
// close/disconnect aborts client transports and observations only.
import path from 'node:path';
import { connectCenter } from './center-client.js';
import { createHash } from 'node:crypto';
import { assertId, assertRevision, messageError } from './message-protocol.js';
import { assertUuid } from './pending-store.js';
import { openPendingClient } from './pending-client.js';
import { collectBotDirectory } from './bot-directory.js';
import { createLocalControlAdapter } from './local-control-adapter.js';
import { openRemoteControl } from './remote-control-client.js';
import {
  CONTROL_ERROR_CODES,
  CONTROL_OUTCOMES,
  CONTROL_CLIENT_TIMEOUT_MS,
  CONTROL_MAX_CLIENT_CALLS,
  controlBrokerTimeoutMs,
  normalizeControlCall,
} from './remote-control-protocol.js';
import {
  LIVE_MAX_CLIENT_SUBSCRIPTIONS,
  normalizeLiveTarget,
} from './remote-live-protocol.js';
import { parseRelayUrl, assertDeviceToken } from './relay-protocol.js';
import { normalizeHostSettings } from './host-settings.js';
import {
  openDesktopUiStore,
  validateLocalControlUrl,
} from './desktop-ui-store.js';

export const DESKTOP_MAX_IN_FLIGHT_REQUESTS = CONTROL_MAX_CLIENT_CALLS; // 8
export const DESKTOP_MAX_OBSERVATIONS = LIVE_MAX_CLIENT_SUBSCRIPTIONS; // 8
export const DESKTOP_CALL_TIMEOUT_MS = CONTROL_CLIENT_TIMEOUT_MS; // 25000 for ordinary calls
const MAX_CA_PEM_BYTES = 65536; // 64 KiB
const MAX_ERROR_MESSAGE_BYTES = 512;
const STABLE_ERROR_CODES = new Set([...CONTROL_ERROR_CODES, 'REPLACED', 'PENDING_BUSY']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function brokerError(code, outcome, message) {
  const safeCode = typeof code === 'string' && STABLE_ERROR_CODES.has(code) ? code : 'INTERNAL';
  const safeOutcome = typeof outcome === 'string' && CONTROL_OUTCOMES.has(outcome) ? outcome : 'unconfirmed';
  const defaultMsg = `desktop client ${safeCode.toLowerCase().replace(/_/g, ' ')} (${safeOutcome})`;
  let safeMessage = typeof message === 'string' && message.isWellFormed() && message.trim() !== ''
    ? message
    : defaultMsg;
  if (Buffer.byteLength(safeMessage, 'utf8') > MAX_ERROR_MESSAGE_BYTES) {
    safeMessage = defaultMsg;
  }
  const err = new Error(safeMessage);
  err.name = 'DesktopClientError';
  err.code = safeCode;
  err.outcome = safeOutcome;
  return err;
}

function invalid(message) {
  return brokerError('INVALID_ARGUMENT', 'not-sent', message);
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} has unknown field: ${key}`);
    }
  }
}

export function normalizeDesktopError(err, fallbackOutcome = 'unconfirmed') {
  if (err && err.name === 'DesktopClientError' && STABLE_ERROR_CODES.has(err.code) && CONTROL_OUTCOMES.has(err.outcome)) {
    return { code: err.code, message: err.message, outcome: err.outcome };
  }
  const rawCode = err && typeof err.code === 'string' ? err.code : null;
  const code = rawCode && STABLE_ERROR_CODES.has(rawCode) ? rawCode : 'INTERNAL';
  let outcome = fallbackOutcome;
  if (err && typeof err.outcome === 'string' && CONTROL_OUTCOMES.has(err.outcome)) {
    outcome = err.outcome;
  } else if (code === 'INVALID_ARGUMENT' || code === 'REQUEST_TOO_LARGE' || code === 'NOT_CONNECTED' || code === 'RPC_BUSY') {
    outcome = 'not-sent';
  } else if (code === 'REQUEST_CONFLICT' || code === 'UNSUPPORTED_SCHEMA' || code === 'STORE_FAILED' || code === 'PENDING_BUSY') {
    outcome = 'responded';
  }
  const defaultMsg = `desktop client ${code.toLowerCase().replace(/_/g, ' ')} (${outcome})`;
  const message =
    code !== 'INTERNAL' && err && typeof err.message === 'string' && err.message.isWellFormed() && err.message.trim() !== '' &&
    Buffer.byteLength(err.message, 'utf8') <= MAX_ERROR_MESSAGE_BYTES
      ? err.message
      : defaultMsg;
  return { code, message, outcome };
}

function validateCaPem(ca) {
  if (
    typeof ca !== 'string' ||
    !ca.isWellFormed() ||
    ca.trim() === '' ||
    Buffer.byteLength(ca, 'utf8') > MAX_CA_PEM_BYTES ||
    !ca.includes('-----BEGIN CERTIFICATE-----') ||
    !ca.includes('-----END CERTIFICATE-----')
  ) {
    throw invalid('ca must be a valid PEM certificate string of at most 64 KiB');
  }
  return ca;
}

function normalizeConnectionInput(raw) {
  if (!isPlainObject(raw)) throw invalid('connection must be a plain object');
  if (raw.kind === 'local') {
    rejectUnknownFields(raw, new Set(['kind', 'url', 'token', 'expectedDeviceId']), 'local connection');
    const url = validateLocalControlUrl(raw.url);
    try {
      assertDeviceToken(raw.token);
    } catch {
      throw invalid('token must be a URL-safe string of 32-512 characters');
    }
    let expectedDeviceId;
    if (raw.expectedDeviceId !== undefined) {
      try {
        assertId(raw.expectedDeviceId, 'expectedDeviceId');
      } catch (err) {
        throw invalid(err.message);
      }
      expectedDeviceId = raw.expectedDeviceId;
    }
    return {
      kind: 'local',
      url,
      token: raw.token,
      ...(expectedDeviceId !== undefined ? { expectedDeviceId } : {}),
    };
  }
  if (raw.kind === 'relay') {
    rejectUnknownFields(raw, new Set(['kind', 'url', 'deviceId', 'token', 'ca']), 'relay connection');
    try {
      parseRelayUrl(raw.url);
    } catch (err) {
      throw invalid(err.message);
    }
    try {
      assertId(raw.deviceId, 'deviceId');
    } catch (err) {
      throw invalid(err.message);
    }
    try {
      assertDeviceToken(raw.token);
    } catch {
      throw invalid('token must be a URL-safe string of 32-512 characters');
    }
    let ca;
    if (raw.ca !== undefined) {
      ca = validateCaPem(raw.ca);
    }
    return {
      kind: 'relay',
      url: raw.url,
      deviceId: raw.deviceId,
      token: raw.token,
      ...(ca !== undefined ? { ca } : {}),
    };
  }
  throw invalid("connection.kind must be 'local' or 'relay'");
}

export function derivePendingProfileKey(connection) {
  const tuple = connection.kind === 'local'
    ? ['local', connection.url, '']
    : ['relay', connection.url, connection.deviceId];
  return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
}

function redactConnection(conn, resolvedDeviceId) {
  if (!conn) return null;
  if (conn.kind === 'local') {
    const out = { kind: 'local', url: conn.url };
    if (conn.expectedDeviceId !== undefined) out.expectedDeviceId = conn.expectedDeviceId;
    if (resolvedDeviceId) out.deviceId = resolvedDeviceId;
    return out;
  }
  return {
    kind: 'relay',
    url: conn.url,
    deviceId: conn.deviceId,
  };
}

function withCallTimeout(parentSignal, ms) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  let onParentAbort = null;
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      onParentAbort = () => controller.abort();
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (onParentAbort && parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    },
  };
}

export function openDesktopClient(options) {
  if (!isPlainObject(options)) {
    throw invalid('openDesktopClient: options must be a plain object');
  }
  rejectUnknownFields(options, new Set(['dataRoot', 'onEvent']), 'openDesktopClient options');
  const { dataRoot, onEvent } = options;
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
    throw invalid('openDesktopClient: dataRoot must be a non-empty absolute path');
  }
  if (onEvent !== undefined && typeof onEvent !== 'function') {
    throw invalid('openDesktopClient: onEvent must be a function when provided');
  }

  const resolvedDataRoot = path.resolve(dataRoot);
  const uiStore = openDesktopUiStore({ dataRoot: resolvedDataRoot });
  const clientId = uiStore.clientId;
  const emitEvent = onEvent ?? (() => {});

  let closed = false;
  let closePromise = null;

  // Connection state & generation fence
  let generation = 0;
  let phase = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'failed'
  let redactedConn = null;
  let lastObservedAt = null;
  let errorCode = null;
  let activeSession = null; // { generation, kind, adapter?, remote?, localDeviceId?, connectController? }
  let centerClient = null;
  let centerGeneration = 0;
  let centerState = 'disconnected';
  let centerUrl = '';

  async function opCenterConnect(params) {
    rejectUnknownFields(params, new Set(['url', 'deviceId', 'deviceToken', 'ca']), 'center_connect params');
    const myGeneration = ++centerGeneration;
    const previous = centerClient;
    centerClient = null;
    centerState = 'connecting';
    centerUrl = '';
    try {
      const parsed = new URL(params.url);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) centerUrl = parsed.origin;
    } catch { /* connectCenter rejects invalid input */ }
    dropTransportForCenter();
    for (const rec of inflightRequests.values()) {
      if (rec.op !== 'center_connect' && rec.op !== 'center_status') rec.controller.abort();
    }
    if (previous) await previous.close();
    try {
      const client = await connectCenter({ centerUrl: params.url, deviceId: params.deviceId,
        deviceToken: params.deviceToken, ca: params.ca,
        onDisconnect: () => {
          if (myGeneration !== centerGeneration) return;
          centerClient = null;
          centerState = 'disconnected';
          dropTransportForCenter();
          for (const rec of inflightRequests.values()) {
            if (rec.op !== 'center_connect' && rec.op !== 'center_status') rec.controller.abort();
          }
        }, onChange: () => {} });
      if (closed || myGeneration !== centerGeneration || centerState !== 'connecting') {
        await client.close();
        throw brokerError('NOT_CONNECTED', 'not-sent', 'center connection superseded');
      }
      centerClient = client;
      centerState = 'ready';
      return centerStatus();
    } catch {
      if (myGeneration === centerGeneration) centerState = 'disconnected';
      throw brokerError('NOT_CONNECTED', 'not-sent', 'center connection failed');
    }
  }

  function centerStatus() {
    return { state: centerState, centerUrl, appliedRevision: null, error: null, clientId };
  }
  async function opCenterStatus(params) {
    rejectUnknownFields(params, new Set(), 'center_status params');
    return centerStatus();
  }
  async function opCenterDisconnect(params) {
    rejectUnknownFields(params, new Set(), 'center_disconnect params');
    centerGeneration += 1;
    centerState = 'disconnected';
    dropTransportForCenter();
    for (const rec of inflightRequests.values()) {
      if (rec.op !== 'center_disconnect' && rec.op !== 'center_status') rec.controller.abort();
    }
    const previous = centerClient;
    centerClient = null;
    if (previous) await previous.close();
    return centerStatus();
  }
  function requireCenter() {
    if (centerState !== 'ready') throw brokerError('NOT_CONNECTED', 'not-sent', 'center is disconnected');
  }
  function dropTransportForCenter() {
    generation += 1;
    phase = 'disconnected';
    redactedConn = null;
    abortAllObservations();
    if (activeSession) {
      closeTransportSession(activeSession);
      activeSession = null;
    }
  }

  // Synchronous connect/disconnect switch guard: overlapping lifecycle switches
  // fail fast with RPC_BUSY instead of interleaving session teardown.
  let switching = false;

  // Pending profile management
  let currentProfileKey = null;
  let pendingClient = null;
  let pendingSwitchChain = Promise.resolve();

  // Bounded in-flight requests and observations
  const inflightRequests = new Map(); // internalId -> { controller, promise }
  let nextInternalRequestId = 1;
  const observations = new Map(); // observationId -> { id, controller, generation, promise, settled }

  function buildStatusSnapshot() {
    return {
      clientId,
      phase,
      connection: redactedConn ? { ...redactedConn } : null,
      generation,
      lastObservedAt,
      errorCode,
    };
  }

  function markObserved(gen) {
    if (gen === generation) {
      lastObservedAt = new Date().toISOString();
    }
  }

  function abortAllObservations() {
    for (const obs of observations.values()) {
      obs.controller.abort();
    }
  }

  async function joinObservations() {
    await Promise.allSettled([...observations.values()].map((obs) => obs.promise));
  }

  async function cancelAndJoinInflight(excludeRec) {
    const pending = [];
    for (const rec of inflightRequests.values()) {
      if (rec !== excludeRec) {
        rec.controller.abort();
        pending.push(rec.promise);
      }
    }
    await Promise.allSettled(pending);
  }

  function closeTransportSession(session) {
    if (!session) return;
    if (session.connectController) {
      session.connectController.abort();
    }
    if (session.remote) {
      try {
        session.remote.close();
      } catch {
        /* best effort */
      }
      session.remote = null;
    }
    session.adapter = null;
  }

  // Injected transport for PendingClient: routes through the active session
  // when connected; fails fast with {code:'NOT_CONNECTED', outcome:'not-sent'}
  // when disconnected/connecting/failed so offline enqueue/get/list remain usable
  // and accidental offline send never mutates or hangs.
  async function pendingTransportCall(targetDeviceId, method, params, callOpts = {}) {
    requireCenter();
    if (closed || phase !== 'connected' || !activeSession) {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'desktop client is not connected');
    }
    await requireTargetReady(targetDeviceId, callOpts.signal);
    requireCenter();
    const session = activeSession;
    const sessionGen = session.generation;
    const timeout = withCallTimeout(callOpts.signal, controlBrokerTimeoutMs(method));
    try {
      let res;
      if (session.kind === 'local') {
        res = await session.adapter(targetDeviceId, method, params, { signal: timeout.signal });
      } else {
        res = await session.remote.call(targetDeviceId, method, params, { signal: timeout.signal });
      }
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(callOpts.signal && callOpts.signal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'control call timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      if (sessionGen === generation && (norm.code === 'DISCONNECTED' || norm.code === 'REPLACED' || norm.code === 'REVOKED' || norm.code === 'BAD_FRAME')) {
        phase = 'failed';
        errorCode = norm.code;
      }
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function ensurePendingProfile(profileKey) {
    const run = pendingSwitchChain.then(async () => {
      if (closed) throw brokerError('NOT_CONNECTED', 'not-sent', 'desktop client is closed');
      if (currentProfileKey === profileKey && pendingClient) {
        return pendingClient;
      }
      if (pendingClient) {
        const old = pendingClient;
        pendingClient = null;
        currentProfileKey = null;
        await old.close();
      }
      if (closed) throw brokerError('NOT_CONNECTED', 'not-sent', 'desktop client is closed');
      const profileDir = path.join(resolvedDataRoot, 'pending', profileKey);
      pendingClient = openPendingClient({
        dataRoot: profileDir,
        deviceId: clientId,
        call: pendingTransportCall,
      });
      currentProfileKey = profileKey;
      return pendingClient;
    });
    pendingSwitchChain = run.catch(() => {});
    return run;
  }

  function requirePendingClient() {
    if (!pendingClient) {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'no connection profile has been configured for pending operations');
    }
    return pendingClient;
  }

  function requireConnectedSession() {
    if (phase !== 'connected' || !activeSession) {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'desktop client is not connected');
    }
    return activeSession;
  }

  function requireLocalSession(targetDeviceId) {
    try {
      assertId(targetDeviceId, 'targetDeviceId');
    } catch (err) {
      throw invalid(err.message);
    }
    const session = requireConnectedSession();
    if (session.kind !== 'local' || !session.adapter) {
      throw invalid('operation is supported only on a local Host connection');
    }
    return session;
  }

  // ---- Operations ----

  async function opConnect(params, reqSignal, rec) {
    if (switching) {
      throw brokerError('RPC_BUSY', 'not-sent', 'another connect/disconnect is already in progress');
    }
    switching = true;
    try {
      rejectUnknownFields(params, new Set(['connection']), 'connect params');
      const conn = normalizeConnectionInput(params.connection);
      const profileKey = derivePendingProfileKey(conn);

      // Update phase after validation but before the first await so concurrent
      // requests never target the old session during the drain.
      phase = 'connecting';
      redactedConn = redactConnection(conn, null);
      errorCode = null;

      generation += 1;
      const myGen = generation;
      // Issue every abort before joining; then re-check close/supersede before
      // publishing the new session so a concurrent close cannot be overwritten.
      abortAllObservations();
      await cancelAndJoinInflight(rec);
      await joinObservations();
      if (closed || (reqSignal && reqSignal.aborted) || myGen !== generation) {
        throw brokerError('CANCELLED', 'not-sent', 'connect superseded or cancelled');
      }
      if (activeSession) {
        closeTransportSession(activeSession);
        activeSession = null;
      }

      const connectController = new AbortController();
      const onReqAbort = () => connectController.abort();
      if (reqSignal) {
        if (reqSignal.aborted) connectController.abort();
        else reqSignal.addEventListener('abort', onReqAbort, { once: true });
      }

      const session = {
        generation: myGen,
        kind: conn.kind,
        adapter: null,
        remote: null,
        localDeviceId: null,
        connectController,
      };
      activeSession = session;

      try {
        await ensurePendingProfile(profileKey);
        if (myGen !== generation || connectController.signal.aborted || closed) {
          throw brokerError('CANCELLED', 'not-sent', 'connect superseded or cancelled');
        }

        if (conn.kind === 'local') {
          const adapter = createLocalControlAdapter({ url: conn.url, token: conn.token });
          const timeout = withCallTimeout(connectController.signal, DESKTOP_CALL_TIMEOUT_MS);
          let info;
          try {
            info = await adapter.getHostInfo({ signal: timeout.signal });
          } catch (err) {
            if (timeout.wasTimedOut() && !connectController.signal.aborted) {
              throw brokerError('TIMEOUT', 'not-sent', 'local host discovery timed out');
            }
            throw err;
          } finally {
            timeout.cleanup();
          }
          if (myGen !== generation || connectController.signal.aborted || closed) {
            throw brokerError('CANCELLED', 'not-sent', 'connect superseded or cancelled');
          }
          if (conn.expectedDeviceId !== undefined && info.deviceId !== conn.expectedDeviceId) {
            throw brokerError('CONTROL_IDENTITY_MISMATCH', 'not-sent', 'local host deviceId does not match expectedDeviceId');
          }
          session.adapter = adapter;
          session.localDeviceId = info.deviceId;
          session.connectController = null;
          phase = 'connected';
          redactedConn = redactConnection(conn, info.deviceId);
          lastObservedAt = new Date().toISOString();
          errorCode = null;
          return buildStatusSnapshot();
        }

        // Relay connection
        const timeout = withCallTimeout(connectController.signal, DESKTOP_CALL_TIMEOUT_MS);
        let remote;
        try {
          remote = await openRemoteControl({
            deviceId: conn.deviceId,
            url: conn.url,
            token: conn.token,
            ...(conn.ca !== undefined ? { ca: conn.ca } : {}),
            signal: timeout.signal,
            onClose: (err) => {
              if (activeSession !== session || myGen !== generation || closed) return;
              const error = normalizeDesktopError(err, 'unconfirmed');
              session.terminalError = error;
              phase = 'failed';
              errorCode = error.code;
              for (const record of observations.values()) {
                if (record.connection && record.generation === myGen) {
                  record.settled = true;
                  void Promise.resolve(emitEvent({ type: 'event', observationId: record.id, error })).catch(() => {});
                  record.controller.abort();
                }
              }
            },
          });
        } catch (err) {
          if (timeout.wasTimedOut() && !connectController.signal.aborted) {
            throw brokerError('TIMEOUT', 'not-sent', 'relay connect timed out');
          }
          throw err;
        } finally {
          timeout.cleanup();
        }

        if (myGen !== generation || connectController.signal.aborted || closed) {
          try { remote.close(); } catch { /* ignore */ }
          throw brokerError('CANCELLED', 'not-sent', 'connect superseded or cancelled');
        }

        if (session.terminalError) {
          remote.close();
          throw brokerError(session.terminalError.code, session.terminalError.outcome, session.terminalError.message);
        }
        session.remote = remote;
        session.connectController = null;
        phase = 'connected';
        redactedConn = redactConnection(conn, null);
        lastObservedAt = new Date().toISOString();
        errorCode = null;
        return buildStatusSnapshot();
      } catch (err) {
        const norm = normalizeDesktopError(err, 'not-sent');
        if (myGen === generation) {
          closeTransportSession(session);
          activeSession = null;
          phase = 'failed';
          errorCode = norm.code;
        }
        throw brokerError(norm.code, norm.outcome, norm.message);
      } finally {
        if (reqSignal) reqSignal.removeEventListener('abort', onReqAbort);
      }
    } finally {
      switching = false;
    }
  }

  async function opDisconnect(params, reqSignal, rec) {
    if (switching) {
      throw brokerError('RPC_BUSY', 'not-sent', 'another connect/disconnect is already in progress');
    }
    switching = true;
    try {
      rejectUnknownFields(params, new Set(), 'disconnect params');
      phase = 'disconnected';
      errorCode = null;
      generation += 1;
      abortAllObservations();
      await cancelAndJoinInflight(rec);
      await joinObservations();
      if (activeSession) {
        closeTransportSession(activeSession);
        activeSession = null;
      }
      // Leave current profile's pendingClient open for offline enqueue/list/get.
      return buildStatusSnapshot();
    } finally {
      switching = false;
    }
  }

  async function opStatus(params) {
    rejectUnknownFields(params, new Set(), 'status params');
    return buildStatusSnapshot();
  }

  async function opDevices(params, reqSignal) {
    rejectUnknownFields(params, new Set(['limit', 'cursor']), 'devices params');
    let limit = 20;
    if (params.limit !== undefined) {
      if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200) {
        throw invalid('limit must be a positive integer between 1 and 200');
      }
      limit = params.limit;
    }
    let cursor = null;
    if (params.cursor !== undefined && params.cursor !== null) {
      if (!isPlainObject(params.cursor) || Object.keys(params.cursor).length !== 1 || !('afterDeviceId' in params.cursor)) {
        throw invalid('cursor must be {afterDeviceId} or null');
      }
      try {
        assertId(params.cursor.afterDeviceId, 'cursor.afterDeviceId');
      } catch (err) {
        throw invalid(err.message);
      }
      cursor = { afterDeviceId: params.cursor.afterDeviceId };
    }

    const session = requireConnectedSession();
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      if (session.kind === 'local') {
        const info = await session.adapter.getHostInfo({ signal: timeout.signal });
        if (session.localDeviceId && info.deviceId !== session.localDeviceId) {
          throw brokerError('CONTROL_IDENTITY_MISMATCH', 'not-sent', 'local host deviceId changed');
        }
        session.localDeviceId = info.deviceId;
        if (redactedConn && redactedConn.kind === 'local') {
          redactedConn.deviceId = info.deviceId;
        }
        markObserved(sessionGen);
        const row = {
          deviceId: info.deviceId,
          displayName: info.displayName || info.deviceId,
          ...(info.platform ? { platform: info.platform } : {}),
          online: true,
          controlProtocol: 2,
          scopeProtocol: 1,
        };
        const include =
          cursor === null ||
          Buffer.compare(Buffer.from(info.deviceId, 'utf8'), Buffer.from(cursor.afterDeviceId, 'utf8')) > 0;
        return {
          items: include ? [row] : [],
          nextCursor: null,
        };
      }

      const page = await session.remote.listDevices({
        limit,
        ...(cursor !== null ? { cursor } : {}),
        signal: timeout.signal,
      });
      markObserved(sessionGen);
      return page;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'devices query timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      if (sessionGen === generation && (norm.code === 'DISCONNECTED' || norm.code === 'REPLACED' || norm.code === 'REVOKED' || norm.code === 'BAD_FRAME')) {
        phase = 'failed';
        errorCode = norm.code;
      }
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opBotDirectory(params, reqSignal) {
    rejectUnknownFields(params, new Set(), 'bot_directory params');
    return collectBotDirectory({
      listDevices: (options) => opDevices(options, reqSignal),
      listBots: (deviceId) => opCall({ targetDeviceId: deviceId, method: 'listBots', params: {} }, reqSignal),
    });
  }

  async function opRenameDevice(params, reqSignal) {
    rejectUnknownFields(params, new Set(['deviceId', 'displayName']), 'rename_device params');
    const session = requireConnectedSession();
    if (session.kind !== 'relay') throw invalid('central device rename requires a relay connection');
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      const result = await session.remote.renameDevice(
        { deviceId: params.deviceId, displayName: params.displayName }, { signal: timeout.signal },
      );
      markObserved(session.generation);
      return result;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'device rename timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opCall(params, reqSignal) {
    rejectUnknownFields(params, new Set(['targetDeviceId', 'method', 'params']), 'call params');
    try {
      assertId(params.targetDeviceId, 'targetDeviceId');
    } catch (err) {
      throw invalid(err.message);
    }
    let normalized;
    try {
      normalized = normalizeControlCall(params.method, params.params);
    } catch (err) {
      const code = err && err.code === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_ARGUMENT';
      throw brokerError(code, 'not-sent', err.message);
    }
    await requireTargetReady(params.targetDeviceId, reqSignal);
    requireCenter();
    const session = requireConnectedSession();
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, controlBrokerTimeoutMs(normalized.method));
    try {
      let res;
      if (session.kind === 'local') {
        res = await session.adapter(params.targetDeviceId, normalized.method, normalized.params, { signal: timeout.signal });
      } else {
        res = await session.remote.call(params.targetDeviceId, normalized.method, normalized.params, { signal: timeout.signal });
      }
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'control call timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      if (sessionGen === generation && (norm.code === 'DISCONNECTED' || norm.code === 'REPLACED' || norm.code === 'REVOKED' || norm.code === 'BAD_FRAME')) {
        phase = 'failed';
        errorCode = norm.code;
      }
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opSettingsGet(params, reqSignal) {
    rejectUnknownFields(params, new Set(['targetDeviceId']), 'settings_get params');
    const session = requireLocalSession(params.targetDeviceId);
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      const res = await session.adapter.getSettings(params.targetDeviceId, { signal: timeout.signal });
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'settings_get timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opSettingsSet(params, reqSignal) {
    rejectUnknownFields(params, new Set(['targetDeviceId', 'input']), 'settings_set params');
    const session = requireLocalSession(params.targetDeviceId);
    if (!isPlainObject(params.input)) {
      throw invalid('settings_set input must be a plain object');
    }
    rejectUnknownFields(params.input, new Set(['expectedRevision', 'settings']), 'settings_set input');
    try {
      assertRevision(params.input.expectedRevision, 'expectedRevision');
      normalizeHostSettings(params.input.settings);
    } catch (err) {
      throw invalid(err.message);
    }
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      const res = await session.adapter.setSettings(
        params.targetDeviceId,
        { expectedRevision: params.input.expectedRevision, settings: params.input.settings },
        { signal: timeout.signal },
      );
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'settings_set timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function opServiceStatus(params, reqSignal) {
    rejectUnknownFields(params, new Set(['targetDeviceId']), 'service_status params');
    try { assertId(params.targetDeviceId, 'targetDeviceId'); } catch (err) { throw invalid(err.message); }
    const session = requireConnectedSession();
    const sessionGen = session.generation;
    const timeout = withCallTimeout(reqSignal, DESKTOP_CALL_TIMEOUT_MS);
    try {
      const res = session.kind === 'local'
        ? await session.adapter.getServiceStatus(params.targetDeviceId, { signal: timeout.signal })
        : await session.remote.call(params.targetDeviceId, 'getServiceStatus', {}, { signal: timeout.signal });
      markObserved(sessionGen);
      return res;
    } catch (err) {
      if (timeout.wasTimedOut() && !(reqSignal && reqSignal.aborted)) {
        throw brokerError('TIMEOUT', 'unconfirmed', 'service_status timed out');
      }
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    } finally {
      timeout.cleanup();
    }
  }

  async function requireTargetReady(targetDeviceId, signal) {
    const status = await opServiceStatus({ targetDeviceId }, signal);
    let matches = false;
    try {
      matches = status?.center?.state === 'ready' && new URL(status.center.centerUrl).origin === new URL(centerUrl).origin;
    } catch { /* A malformed remote status cannot establish readiness. */ }
    if (!matches) throw brokerError('NOT_CONNECTED', 'not-sent', 'target Host is not connected to this center');
  }

  async function opPendingEnqueue(params) {
    rejectUnknownFields(params, new Set(['input']), 'pending_enqueue params');
    const pending = requirePendingClient();
    try {
      return await pending.enqueue(params.input);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingGet(params) {
    rejectUnknownFields(params, new Set(['id']), 'pending_get params');
    try {
      assertUuid(params.id, 'id');
    } catch (err) {
      throw invalid(err.message);
    }
    const pending = requirePendingClient();
    try {
      return await pending.get(params.id);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingList(params) {
    rejectUnknownFields(params, new Set(['options']), 'pending_list params');
    const pending = requirePendingClient();
    try {
      return await pending.list(params.options === undefined ? {} : params.options);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingSend(params, reqSignal) {
    rejectUnknownFields(params, new Set(['id']), 'pending_send params');
    try {
      assertUuid(params.id, 'id');
    } catch (err) {
      throw invalid(err.message);
    }
    const pending = requirePendingClient();
    try {
      return await pending.send(params.id, { signal: reqSignal });
    } catch (err) {
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingReconcile(params, reqSignal) {
    rejectUnknownFields(params, new Set(['id']), 'pending_reconcile params');
    try {
      assertUuid(params.id, 'id');
    } catch (err) {
      throw invalid(err.message);
    }
    const pending = requirePendingClient();
    try {
      return await pending.reconcile(params.id, { signal: reqSignal });
    } catch (err) {
      const norm = normalizeDesktopError(err, 'unconfirmed');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opPendingCancel(params) {
    rejectUnknownFields(params, new Set(['id']), 'pending_cancel params');
    try {
      assertUuid(params.id, 'id');
    } catch (err) {
      throw invalid(err.message);
    }
    const pending = requirePendingClient();
    try {
      return await pending.cancel(params.id);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opUiGet(params) {
    rejectUnknownFields(params, new Set(), 'ui_get params');
    try {
      return uiStore.get();
    } catch (err) {
      const norm = normalizeDesktopError(err, 'responded');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opUiSet(params) {
    rejectUnknownFields(params, new Set(['expectedRevision', 'state']), 'ui_set params');
    try {
      return uiStore.replace(params);
    } catch (err) {
      const norm = normalizeDesktopError(err, 'responded');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }
  }

  async function opObserve(params) {
    rejectUnknownFields(params, new Set(['observationId', 'targetDeviceId', 'target']), 'observe params');
    try {
      assertUuid(params.observationId, 'observationId');
      assertId(params.targetDeviceId, 'targetDeviceId');
    } catch (err) {
      throw invalid(err.message);
    }
    const connection = isPlainObject(params.target) && params.target.kind === 'connection';
    let normTarget;
    if (connection) {
      rejectUnknownFields(params.target, new Set(['kind']), 'connection observation target');
    } else {
      try {
        normTarget = normalizeLiveTarget(params.target);
      } catch (err) {
        throw invalid(err.message);
      }
    }
    if (observations.has(params.observationId)) {
      throw invalid(`observationId already active: ${params.observationId}`);
    }
    if (connection ? [...observations.values()].some((obs) => obs.connection)
      : [...observations.values()].filter((obs) => !obs.connection).length >= DESKTOP_MAX_OBSERVATIONS) {
      throw brokerError('RPC_BUSY', 'not-sent', 'maximum concurrent observations reached');
    }

    if (!connection) await requireTargetReady(params.targetDeviceId);
    requireCenter();
    const session = requireConnectedSession();
    const sessionGen = session.generation;
    const controller = new AbortController();
    const observationId = params.observationId;

    // Install observation record before starting the live stream so routing is
    // ready before any synchronous or immediate snapshot arrives.
    const record = {
      id: observationId,
      controller,
      generation: sessionGen,
      promise: null,
      settled: false,
    };
    observations.set(observationId, record);
    if (connection) {
      record.connection = true;
      record.promise = new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => {
          if (observations.get(observationId) === record) observations.delete(observationId);
          resolve();
        }, { once: true });
      });
      return { observationId };
    }

    let iterable;
    try {
      if (session.kind === 'local') {
        iterable = session.adapter.live(params.targetDeviceId, normTarget, { signal: controller.signal });
      } else {
        iterable = session.remote.live(params.targetDeviceId, normTarget, { signal: controller.signal });
      }
    } catch (err) {
      observations.delete(observationId);
      const norm = normalizeDesktopError(err, 'not-sent');
      throw brokerError(norm.code, norm.outcome, norm.message);
    }

    record.promise = (async () => {
      const iter = iterable[Symbol.asyncIterator]();
      try {
        for (;;) {
          const { value: frame, done } = await iter.next();
          if (done) break;
          if (record.settled || closed || sessionGen !== generation) break;
          markObserved(sessionGen);
          if (frame && frame.type === 'end') {
            record.settled = true;
            await emitEvent({ type: 'event', observationId, frame });
            return;
          }
          await emitEvent({ type: 'event', observationId, frame });
        }
        if (!record.settled && !closed) {
          record.settled = true;
          const error = controller.signal.aborted
            ? { code: 'CANCELLED', message: 'observation cancelled', outcome: 'unconfirmed' }
            : { code: 'BAD_RESPONSE', message: 'live stream ended without an end frame', outcome: 'unconfirmed' };
          await emitEvent({ type: 'event', observationId, error });
        }
      } catch (err) {
        if (!record.settled && !closed) {
          record.settled = true;
          let error;
          if (controller.signal.aborted || (err && err.name === 'AbortError')) {
            error = { code: 'CANCELLED', message: 'observation cancelled', outcome: 'unconfirmed' };
          } else {
            error = normalizeDesktopError(err, 'unconfirmed');
          }
          if (sessionGen === generation && (error.code === 'DISCONNECTED' || error.code === 'REPLACED' || error.code === 'REVOKED' || error.code === 'BAD_FRAME')) {
            phase = 'failed';
            errorCode = error.code;
          }
          await emitEvent({ type: 'event', observationId, error });
        }
      } finally {
        observations.delete(observationId);
        try {
          await iter.return?.();
        } catch {
          /* best effort */
        }
      }
    })();
    record.promise.catch(() => {});

    return { observationId };
  }

  async function opUnobserve(params) {
    rejectUnknownFields(params, new Set(['observationId']), 'unobserve params');
    try {
      assertUuid(params.observationId, 'observationId');
    } catch (err) {
      throw invalid(err.message);
    }
    const obs = observations.get(params.observationId);
    if (obs) {
      obs.controller.abort();
    }
    return { observationId: params.observationId };
  }

  const OP_HANDLERS = new Map([
    ['center_connect', opCenterConnect],
    ['center_status', opCenterStatus],
    ['center_disconnect', opCenterDisconnect],
    ['connect', opConnect],
    ['disconnect', opDisconnect],
    ['status', opStatus],
    ['devices', opDevices],
    ['bot_directory', opBotDirectory],
    ['rename_device', opRenameDevice],
    ['call', opCall],
    ['settings_get', opSettingsGet],
    ['settings_set', opSettingsSet],
    ['service_status', opServiceStatus],
    ['pending_enqueue', opPendingEnqueue],
    ['pending_get', opPendingGet],
    ['pending_list', opPendingList],
    ['pending_send', opPendingSend],
    ['pending_reconcile', opPendingReconcile],
    ['pending_cancel', opPendingCancel],
    ['ui_get', opUiGet],
    ['ui_set', opUiSet],
    ['observe', opObserve],
    ['unobserve', opUnobserve],
  ]);

  async function request(op, params = {}) {
    if (closed) {
      throw brokerError('NOT_CONNECTED', 'not-sent', 'desktop client is closed');
    }
    if (typeof op !== 'string' || !OP_HANDLERS.has(op)) {
      throw invalid(`unknown desktop client operation: ${String(op)}`);
    }
    if (params === undefined) params = {};
    if (!isPlainObject(params)) {
      throw invalid(`${op} params must be a plain object`);
    }
    if (!['center_connect', 'center_status', 'center_disconnect', 'status', 'disconnect', 'unobserve'].includes(op)) requireCenter();
    if (op === 'settings_set') throw brokerError('NOT_CONNECTED', 'not-sent', 'settings are managed by the center');
    // unobserve only aborts a local subscription synchronously (no network, no wait): it must
    // never queue behind the 8 in-flight RPCs or a connect/disconnect switch (a switch already
    // aborts every client observation before its first await), or a cancelled client
    // observation would leak its broker slot. It cannot accumulate: opUnobserve returns at once.
    const localCancel = op === 'unobserve';
    if (
      !localCancel && switching &&
      op !== 'status' && op !== 'ui_get' && op !== 'ui_set' &&
      op !== 'connect' && op !== 'disconnect'
    ) {
      throw brokerError('RPC_BUSY', 'not-sent', 'desktop client is switching connections');
    }
    if (!localCancel && inflightRequests.size >= DESKTOP_MAX_IN_FLIGHT_REQUESTS) {
      throw brokerError('RPC_BUSY', 'not-sent', 'desktop client request capacity reached');
    }

    const handler = OP_HANDLERS.get(op);
    const internalId = nextInternalRequestId++;
    const controller = new AbortController();
    const rec = { controller, promise: null, op };
    inflightRequests.set(internalId, rec);

    rec.promise = (async () => {
      try {
        return await handler(params, controller.signal, rec);
      } finally {
        inflightRequests.delete(internalId);
      }
    })();

    return rec.promise;
  }

  function close() {
    if (!closePromise) {
      closePromise = (async () => {
        closed = true;
        centerGeneration += 1;
        centerState = 'disconnected';
        if (centerClient) { await centerClient.close(); centerClient = null; }
        generation += 1;
        // Abort all in-flight broker requests and observations
        for (const rec of inflightRequests.values()) {
          rec.controller.abort();
        }
        abortAllObservations();
        if (activeSession) {
          closeTransportSession(activeSession);
          activeSession = null;
        }
        phase = 'disconnected';

        await Promise.allSettled([...inflightRequests.values()].map((r) => r.promise));
        await Promise.allSettled([...observations.values()].map((r) => r.promise));

        // Wait for any in-flight pending profile switch, then close pendingClient
        try {
          await pendingSwitchChain;
        } catch {
          /* ignore */
        }
        if (pendingClient) {
          const p = pendingClient;
          pendingClient = null;
          currentProfileKey = null;
          try {
            await p.close();
          } catch {
            /* best effort */
          }
        }
        try {
          uiStore.close();
        } catch {
          /* best effort */
        }
      })();
    }
    return closePromise;
  }

  return {
    request,
    close,
  };
}
