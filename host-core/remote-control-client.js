// host-core/remote-control-client.js
//
// 模块 9 远程控制 client 角色：通过已认证中继向目标 Host 发起 JSON 控制调用。
// 与 DeviceLink 共用同一 Node ws 传输规则（TLS/URL/CA/无 Origin/无重定向/
// 无压缩/maxPayload），但只持有 client 角色 —— 不打开任何本地文件/MessageLog/
// Runtime/owner 锁；不自动重连、不重试、不记录凭证。
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  parseRelayUrl,
  assertDeviceToken,
  encodeRelayFrame,
  readServerFrame,
  MAX_RELAY_FRAME_BYTES,
  RELAY_HIGH_WATER_BYTES,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_HEARTBEAT_MS,
  RELAY_CLOSE,
} from './relay-protocol.js';
import { messageError, assertId } from './message-protocol.js';
import {
  CONTROL_MAX_CLIENT_CALLS,
  CONTROL_CLIENT_TIMEOUT_MS,
  normalizeControlCall,
} from './remote-control-protocol.js';

const WATCHDOG_MS = RELAY_HEARTBEAT_MS * 3;

export class RemoteControlError extends Error {
  constructor(code, outcome) {
    super(`${outcome}: ${code}`);
    this.name = 'RemoteControlError';
    this.code = code;
    this.outcome = outcome;
  }
}

function invalid(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function validateCa(ca) {
  if (
    typeof ca !== 'string' ||
    !ca.isWellFormed() ||
    ca.trim() === '' ||
    !ca.includes('-----BEGIN CERTIFICATE-----') ||
    !ca.includes('-----END CERTIFICATE-----')
  ) {
    throw invalid('ca must be a non-empty PEM certificate string');
  }
}

function isAbortSignal(signal) {
  return (
    signal &&
    typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
  );
}

export async function openRemoteControl(options) {
  let deviceId;
  let url;
  let token;
  let ca;
  let signal;
  try {
    if (!options || typeof options !== 'object') throw invalid('options must be an object');
    deviceId = options.deviceId;
    assertId(deviceId, 'deviceId');
    url = parseRelayUrl(options.url);
    token = options.token;
    assertDeviceToken(token);
    if (options.ca !== undefined && options.ca !== null) {
      ca = options.ca;
      validateCa(ca);
    }
    signal = options.signal;
    if (signal !== undefined && !isAbortSignal(signal)) throw invalid('signal must be an AbortSignal');
  } catch {
    throw new RemoteControlError('INVALID_ARGUMENT', 'not-sent');
  }
  if (signal && signal.aborted) {
    throw new RemoteControlError('CANCELLED', 'not-sent');
  }

  const client = {
    deviceId: null,
    ws: null,
    ready: false,
    opened: false,
    closed: false,
    violated: false,
    startAborted: false,
    readyTimedOut: false,
    pending: new Map(),
    readyTimer: null,
    watchdogTimer: null,
    openResolve: null,
    openReject: null,
    removeStartAbort: null,
  };

  function clearTimers() {
    if (client.readyTimer) {
      clearTimeout(client.readyTimer);
      client.readyTimer = null;
    }
    if (client.watchdogTimer) {
      clearTimeout(client.watchdogTimer);
      client.watchdogTimer = null;
    }
  }

  function removeStartAbort() {
    if (client.removeStartAbort) {
      client.removeStartAbort();
      client.removeStartAbort = null;
    }
  }

  // 序列化 + 尺寸检查；socket 必须 OPEN。返回 {ok:true} 或 {ok:false,code}。
  // 帧字节上限由 encodeRelayFrame 强制，这里只做高水位检查。
  function sendFrame(frame) {
    const ws = client.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return { ok: false, code: 'NOT_CONNECTED' };
    let text;
    try {
      text = encodeRelayFrame(frame);
    } catch {
      return { ok: false, code: 'INVALID_ARGUMENT' };
    }
    if (ws.bufferedAmount + Buffer.byteLength(text, 'utf8') > RELAY_HIGH_WATER_BYTES) {
      return { ok: false, code: 'BACKPRESSURE' };
    }
    try {
      ws.send(text, (err) => {
        // 发送回调出错说明 socket 正在损坏：终止以触发统一断开处理，不泄漏原始错误。
        if (err && ws === client.ws && !client.closed) {
          ws.terminate();
        }
      });
    } catch {
      return { ok: false, code: 'NETWORK' };
    }
    return { ok: true };
  }

  function settle(record, makeResult) {
    if (record.settled) return;
    record.settled = true;
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    if (record.onAbort) {
      record.signal.removeEventListener('abort', record.onAbort);
      record.onAbort = null;
    }
    client.pending.delete(record.callId);
    const result = makeResult();
    if (result.kind === 'resolve') {
      record.resolve(result.value);
    } else {
      record.reject(result.error);
    }
  }

  function cancelBestEffort(record) {
    sendFrame({ type: 'control-cancel', callId: record.callId });
  }

  function handleCallTimeout(record) {
    if (record.settled) return;
    cancelBestEffort(record);
    settle(record, () => ({ kind: 'reject', error: new RemoteControlError('TIMEOUT', 'unconfirmed') }));
  }

  function handleCallAbort(record) {
    if (record.settled) return;
    if (!record.sent) {
      settle(record, () => ({ kind: 'reject', error: new RemoteControlError('CANCELLED', 'not-sent') }));
      return;
    }
    cancelBestEffort(record);
    settle(record, () => ({ kind: 'reject', error: new RemoteControlError('CANCELLED', 'unconfirmed') }));
  }

  async function call(targetDeviceId, method, params, options) {
    if (client.closed) throw new RemoteControlError('NOT_CONNECTED', 'not-sent');
    let norm;
    try {
      assertId(targetDeviceId, 'targetDeviceId');
      norm = normalizeControlCall(method, params);
    } catch (err) {
      throw new RemoteControlError(err && err.code === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_ARGUMENT', 'not-sent');
    }
    let callSignal;
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw new RemoteControlError('INVALID_ARGUMENT', 'not-sent');
      }
      callSignal = options.signal;
      if (callSignal !== undefined && !isAbortSignal(callSignal)) {
        throw new RemoteControlError('INVALID_ARGUMENT', 'not-sent');
      }
    }
    if (callSignal && callSignal.aborted) {
      throw new RemoteControlError('CANCELLED', 'not-sent');
    }
    if (client.pending.size >= CONTROL_MAX_CLIENT_CALLS) {
      throw new RemoteControlError('RPC_BUSY', 'not-sent');
    }

    const callId = randomUUID();
    const record = {
      callId,
      targetDeviceId,
      signal: callSignal,
      timer: null,
      onAbort: null,
      sent: false,
      settled: false,
    };
    record.promise = new Promise((resolve, reject) => {
      record.resolve = resolve;
      record.reject = reject;
    });
    client.pending.set(callId, record);

    if (callSignal) {
      record.onAbort = () => handleCallAbort(record);
      callSignal.addEventListener('abort', record.onAbort, { once: true });
    }

    const sent = sendFrame({ type: 'control-call', callId, targetDeviceId, method: norm.method, params: norm.params });
    if (!sent.ok) {
      settle(record, () => ({ kind: 'reject', error: new RemoteControlError(sent.code, 'not-sent') }));
      return record.promise;
    }
    record.sent = true;
    record.timer = setTimeout(() => handleCallTimeout(record), CONTROL_CLIENT_TIMEOUT_MS);
    return record.promise;
  }

  function failOpen(error) {
    if (client.opened) return;
    client.opened = true;
    removeStartAbort();
    client.openReject(error);
  }

  function finishOpen() {
    if (client.opened) return;
    client.opened = true;
    removeStartAbort();
    client.openResolve({ deviceId: client.deviceId, call, close });
  }

  function rejectPending(error) {
    for (const record of [...client.pending.values()]) {
      settle(record, () => ({ kind: 'reject', error }));
    }
  }

  function failOpenOrPending(error) {
    if (!client.opened) {
      failOpen(error);
      return;
    }
    rejectPending(error);
  }

  // 协议违规：立即终结处理并拒绝，禁止违规之后的任何帧满足 call；close 事件
  // 只做清理，不再重复拒绝。
  function protocolViolation() {
    if (client.violated) return;
    client.violated = true;
    clearTimers();
    if (client.ws) client.ws.terminate();
    failOpenOrPending(new RemoteControlError('BAD_FRAME', client.ready ? 'unconfirmed' : 'not-sent'));
  }

  function armWatchdog(ws) {
    if (client.watchdogTimer) clearTimeout(client.watchdogTimer);
    client.watchdogTimer = setTimeout(() => {
      client.watchdogTimer = null;
      if (ws === client.ws && !client.closed) ws.terminate();
    }, WATCHDOG_MS);
  }

  function handleMessage(data, isBinary) {
    if (client.violated || client.closed) return;
    let frame;
    try {
      frame = readServerFrame(data, isBinary);
    } catch {
      protocolViolation();
      return;
    }
    if (!client.ready) {
      // readServerFrame 已验证 protocolVersion/deviceId；这里只要求显式 client
      // 角色且身份匹配，其余帧（含 host ready）均视为违规。
      if (frame.type !== 'ready' || frame.role !== 'client' || frame.deviceId !== deviceId) {
        protocolViolation();
        return;
      }
      client.ready = true;
      client.deviceId = frame.deviceId;
      if (client.readyTimer) {
        clearTimeout(client.readyTimer);
        client.readyTimer = null;
      }
      finishOpen();
      return;
    }
    // ready 之后只允许 control-result；重复 ready/其他帧均为违规。
    if (frame.type !== 'control-result') {
      protocolViolation();
      return;
    }
    const record = client.pending.get(frame.callId);
    if (!record) return; // 迟到/未匹配回复：忽略
    if (frame.targetDeviceId !== record.targetDeviceId) {
      // 活跃调用的目标不匹配：协议违规
      protocolViolation();
      return;
    }
    settle(record, () => {
      if (frame.ok) return { kind: 'resolve', value: frame.result };
      return { kind: 'reject', error: new RemoteControlError(frame.code, frame.outcome) };
    });
  }

  function onClose(ws, code) {
    if (ws !== client.ws || client.closed) return;
    client.ws = null;
    client.closed = true;
    clearTimers();
    removeStartAbort();
    if (client.violated) {
      failOpenOrPending(new RemoteControlError('BAD_FRAME', client.ready ? 'unconfirmed' : 'not-sent'));
      return;
    }
    if (client.startAborted) {
      failOpenOrPending(new RemoteControlError('CANCELLED', client.ready ? 'unconfirmed' : 'not-sent'));
      return;
    }
    if (client.readyTimedOut && !client.ready) {
      failOpenOrPending(new RemoteControlError('TIMEOUT', 'not-sent'));
      return;
    }
    let codeName = null;
    if (code === RELAY_CLOSE.UNAUTHORIZED) codeName = 'UNAUTHORIZED';
    else if (code === RELAY_CLOSE.REVOKED) codeName = 'REVOKED';
    else if (code === RELAY_CLOSE.REPLACED) codeName = 'REPLACED';
    else if (code === RELAY_CLOSE.BAD_FRAME) codeName = 'BAD_FRAME';
    else if (code === RELAY_CLOSE.HELLO_TIMEOUT) codeName = 'TIMEOUT';
    if (codeName) {
      failOpenOrPending(new RemoteControlError(codeName, client.ready ? 'unconfirmed' : 'not-sent'));
      return;
    }
    failOpenOrPending(
      new RemoteControlError(client.ready ? 'DISCONNECTED' : 'CONNECT_FAILED', client.ready ? 'unconfirmed' : 'not-sent')
    );
  }

  function connect() {
    let ws;
    try {
      ws = new WebSocket(url.href, {
        ...(ca !== undefined ? { ca } : {}),
        maxPayload: MAX_RELAY_FRAME_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: RELAY_HELLO_TIMEOUT_MS,
      });
    } catch {
      failOpen(new RemoteControlError('CONNECT_FAILED', 'not-sent'));
      return;
    }
    client.ws = ws;

    ws.on('open', () => {
      if (ws !== client.ws || client.closed) return;
      client.readyTimer = setTimeout(() => {
        client.readyTimer = null;
        if (ws === client.ws && !client.ready && !client.closed) {
          client.readyTimedOut = true;
          ws.terminate();
        }
      }, RELAY_HELLO_TIMEOUT_MS);
      armWatchdog(ws);
      sendFrame({ type: 'hello', protocolVersion: 1, deviceId, token, role: 'client' });
    });

    ws.on('message', (data, isBinary) => {
      if (ws !== client.ws || client.closed) return;
      armWatchdog(ws);
      handleMessage(data, isBinary);
    });

    ws.on('ping', () => {
      if (ws === client.ws && !client.closed) armWatchdog(ws);
    });
    ws.on('pong', () => {
      if (ws === client.ws && !client.closed) armWatchdog(ws);
    });
    // 吞掉原始错误，仅由 close 汇总为固定 code，绝不向外部暴露网络错误文本。
    ws.on('error', () => {});

    ws.on('close', (code) => onClose(ws, code));
  }

  function close() {
    if (client.closed) return;
    client.closed = true;
    clearTimers();
    removeStartAbort();
    const ws = client.ws;
    client.ws = null;
    if (ws) {
      try { ws.terminate(); } catch { /* terminate 失败忽略 */ }
    }
    if (!client.opened) {
      failOpen(new RemoteControlError('CANCELLED', 'not-sent'));
      return;
    }
    rejectPending(new RemoteControlError('DISCONNECTED', 'unconfirmed'));
  }

  if (signal) {
    const onStartAbort = () => {
      client.startAborted = true;
      if (client.ws) client.ws.terminate();
    };
    client.removeStartAbort = () => signal.removeEventListener('abort', onStartAbort);
    signal.addEventListener('abort', onStartAbort, { once: true });
  }

  const openPromise = new Promise((resolve, reject) => {
    client.openResolve = resolve;
    client.openReject = reject;
  });
  connect();
  return openPromise;
}
