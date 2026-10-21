// host-core/relay-server.js
// Module 8 authenticated device relay + Module 9 control routing: one HTTP(S)
// listener with a single /v1/link WebSocket upgrade path. Authenticated sockets
// carry a role (host default, client explicit); hosts are the sole entry in
// deviceMap and route legacy delivery frames, while clients of the same
// registered device place bounded control calls that are correlated by routeId.
// The relay never persists messages and keeps no business state beyond peers.

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { WebSocketServer } from 'ws';
import { openRelayRegistry } from './relay-registry.js';
import {
  RELAY_CLOSE,
  RELAY_HIGH_WATER_BYTES,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_HEARTBEAT_MS,
  MAX_RELAY_FRAME_BYTES,
  DELIVERY_REJECT_CODES,
  readClientFrame,
  encodeRelayFrame
} from './relay-protocol.js';
import { digest, messageError } from './message-protocol.js';
import {
  openControlRoutes,
  CONTROL_MAX_CLIENT_CALLS,
  CONTROL_MAX_HOST_CALLS,
  CONTROL_MAX_PENDING
} from './relay-control.js';

const DEFAULT_PORT = 8790;
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const MAX_CONNECTIONS = 256;
const WS_OPEN = 1; // WebSocket.OPEN

function invalid(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function noop() {}

function rejectUpgrade(socket, status, body) {
  socket.on('error', noop);
  const payload = Buffer.from(body);
  socket.end(
    `HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nContent-Type: text/plain\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n` + body
  );
}

// Bounded write: high-water check on every outbound frame (incl. ready).
// Returns false when the socket is closed or the buffer would exceed 4 MiB.
function writeFrame(ws, frame, onError) {
  let text;
  try {
    text = encodeRelayFrame(frame);
  } catch {
    return false;
  }
  if (ws.readyState !== WS_OPEN) return false;
  if (ws.bufferedAmount + Buffer.byteLength(text) > RELAY_HIGH_WATER_BYTES) {
    return false;
  }
  try {
    ws.send(text, (err) => {
      if (err) onError?.(err);
    });
  } catch {
    return false;
  }
  return true;
}

export async function openRelayServer(options = {}) {
  const dataRoot = options.dataRoot;
  const port = options.port === undefined ? DEFAULT_PORT : options.port;
  const listenHost = options.listenHost === undefined ? DEFAULT_LISTEN_HOST : options.listenHost;
  const tls = options.tls;

  // All validation happens before any registry data / sockets are created.
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !isAbsolute(dataRoot)) {
    throw invalid('dataRoot must be a non-empty absolute path');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw invalid('port must be an integer between 0 and 65535');
  }
  if (typeof listenHost !== 'string' || isIP(listenHost) === 0) {
    throw invalid('listenHost must be a literal IP address');
  }

  let tlsOptions = null;
  if (tls !== undefined) {
    if (
      typeof tls !== 'object' || tls === null ||
      typeof tls.cert !== 'string' || tls.cert === '' ||
      typeof tls.key !== 'string' || tls.key === ''
    ) {
      throw invalid('tls requires non-empty PEM cert and key strings');
    }
    try {
      createSecureContext({ cert: tls.cert, key: tls.key });
    } catch {
      throw invalid('tls cert/key are not valid PEM');
    }
    tlsOptions = { cert: tls.cert, key: tls.key };
  } else if (listenHost !== '127.0.0.1' && listenHost !== '::1') {
    // Plain WS is only allowed on literal loopback; every other bind requires TLS.
    throw invalid('TLS is required unless listening on literal 127.0.0.1 or ::1');
  }

  const requestHandler = (req, res) => {
    res.writeHead(404, {
      'Content-Type': 'text/plain',
      'Content-Length': 9,
      'Connection': 'close'
    });
    res.end('Not Found');
  };

  let wss = null;
  let server = null;
  let registry = null;
  try {
    wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_RELAY_FRAME_BYTES,
      perMessageDeflate: false
    });
    server = tlsOptions
      ? createHttpsServer(tlsOptions, requestHandler)
      : createServer(requestHandler);
    registry = openRelayRegistry({ dataRoot });
  } catch (err) {
    try { wss?.close(); } catch { /* ignore */ }
    try { server?.close(); } catch { /* ignore */ }
    try { registry?.close(); } catch { /* ignore */ }
    throw err;
  }

  const deviceMap = new Map(); // deviceId -> host conn (authenticated)
  const allConns = new Set();  // every accepted WS, authenticated or not
  const upgradeSockets = new Set();
  const controlRoutes = openControlRoutes(); // bounded control-call correlation
  let closed = false;

  function connCleanup(conn) {
    clearTimeout(conn.helloTimer);
    if (conn.deviceId !== null && deviceMap.get(conn.deviceId) === conn) {
      deviceMap.delete(conn.deviceId);
    }
    // A leaving client abandons its pending calls (best-effort host cancel);
    // a leaving host fails its pending calls as unconfirmed.
    cancelClientControlRoutes(conn);
    failHostControlRoutes(conn);
  }

  function closeWith(conn, code) {
    if (conn.dead) return;
    conn.dead = true;
    connCleanup(conn);
    try {
      conn.ws.close(code);
    } catch {
      /* already closing/closed */
    }
  }

  // Target must still be registered, un-revoked and on the same credentialVersion
  // before any forward, so a just-revoked peer cannot receive new content between
  // registry scans. Registry read failure => not usable (no unverified forward).
  function peerUsable(conn) {
    if (conn.dead || conn.replaced || conn.ws.readyState !== WS_OPEN) return false;
    try {
      const device = registry.get(conn.deviceId);
      return device !== null && device.revokedAt === null && device.credentialVersion === conn.version;
    } catch {
      return false;
    }
  }

  function sendUnavailable(conn, targetDeviceId, messageId, digestHex, code) {
    writeFrame(conn.ws, {
      type: 'unavailable',
      targetDeviceId,
      messageId,
      digest: digestHex,
      code
    }, noop);
  }

  function routeDeliver(conn, frame) {
    const target = frame.targetDeviceId;
    const peer = deviceMap.get(target);
    const message = frame.message;
    const digestHex = digest(message);
    const outbound = { type: 'deliver', fromDeviceId: conn.deviceId, message };
    if (!peer || !peerUsable(peer)) {
      return sendUnavailable(conn, target, message.messageId, digestHex, 'OFFLINE');
    }
    let text;
    try {
      text = encodeRelayFrame(outbound);
    } catch {
      return sendUnavailable(conn, target, message.messageId, digestHex, 'BACKPRESSURE');
    }
    if (peer.ws.bufferedAmount + Buffer.byteLength(text) > RELAY_HIGH_WATER_BYTES) {
      return sendUnavailable(conn, target, message.messageId, digestHex, 'BACKPRESSURE');
    }
    try {
      peer.ws.send(text, (err) => {
        if (err) {
          try { peer.ws.terminate(); } catch { /* socket gone */ }
        }
      });
    } catch {
      sendUnavailable(conn, target, message.messageId, digestHex, 'BACKPRESSURE');
    }
  }

  function routeAck(conn, frame) {
    const peer = deviceMap.get(frame.targetDeviceId);
    if (!peer || !peerUsable(peer)) return; // offline/revoked: drop, sender retries
    writeFrame(peer.ws, {
      type: 'ack',
      fromDeviceId: conn.deviceId,
      ack: frame.ack
    }, (err) => {
      if (err) {
        try { peer.ws.terminate(); } catch { /* socket gone */ }
      }
    });
  }

  function routeReject(conn, frame) {
    const peer = deviceMap.get(frame.targetDeviceId);
    if (!peer || !peerUsable(peer)) return; // offline/revoked: drop
    writeFrame(peer.ws, {
      type: 'reject',
      fromDeviceId: conn.deviceId,
      messageId: frame.messageId,
      digest: frame.digest,
      code: frame.code
    }, (err) => {
      if (err) {
        try { peer.ws.terminate(); } catch { /* socket gone */ }
      }
    });
  }

  // ---- Module 9 control routing ----

  function sendControlFailure(conn, callId, targetDeviceId, code, outcome) {
    if (!writeFrame(conn.ws, {
      type: 'control-result',
      callId,
      targetDeviceId,
      ok: false,
      code,
      outcome
    }, noop)) {
      try { conn.ws.terminate(); } catch { /* socket gone */ }
    }
  }

  function routeControlCall(conn, frame) {
    if (controlRoutes.findByClientCall(conn, frame.callId)) {
      return closeWith(conn, RELAY_CLOSE.BAD_FRAME);
    }
    if (
      controlRoutes.size() >= CONTROL_MAX_PENDING ||
      controlRoutes.countClient(conn) >= CONTROL_MAX_CLIENT_CALLS
    ) {
      return sendControlFailure(conn, frame.callId, frame.targetDeviceId, 'RPC_BUSY', 'not-sent');
    }
    const peer = deviceMap.get(frame.targetDeviceId);
    if (!peer || !peerUsable(peer)) {
      return sendControlFailure(conn, frame.callId, frame.targetDeviceId, 'OFFLINE', 'not-sent');
    }
    if (peer.controlProtocol !== 1) {
      return sendControlFailure(conn, frame.callId, frame.targetDeviceId, 'CONTROL_UNAVAILABLE', 'not-sent');
    }
    if (controlRoutes.countHost(peer) >= CONTROL_MAX_HOST_CALLS) {
      return sendControlFailure(conn, frame.callId, frame.targetDeviceId, 'RPC_BUSY', 'not-sent');
    }
    const record = controlRoutes.add(conn, frame.callId, peer, frame.targetDeviceId);
    if (!writeFrame(peer.ws, {
      type: 'control-request',
      routeId: record.routeId,
      fromDeviceId: conn.deviceId,
      method: frame.method,
      params: frame.params
    }, (err) => {
      if (err) {
        // Accepted send failed asynchronously: the host may have seen it, so
        // the pending call resolves via close/timeout as unconfirmed.
        try { peer.ws.terminate(); } catch { /* socket gone */ }
      }
    })) {
      controlRoutes.remove(record.routeId);
      const code = peer.dead || peer.ws.readyState !== WS_OPEN ? 'OFFLINE' : 'BACKPRESSURE';
      sendControlFailure(conn, frame.callId, frame.targetDeviceId, code, 'not-sent');
    }
  }

  function routeControlCancel(conn, frame) {
    const record = controlRoutes.findByClientCall(conn, frame.callId);
    if (!record) return; // duplicate/late cancel is harmless
    controlRoutes.remove(record.routeId);
    if (peerUsable(record.host)) {
      writeFrame(record.host.ws, {
        type: 'control-cancel',
        routeId: record.routeId
      }, noop);
    }
  }

  function routeControlResult(conn, frame) {
    const record = controlRoutes.findByRoute(frame.routeId);
    // Only the exact host conn a call was forwarded to may answer it; stale,
    // late, duplicate or wrong-host replies are ignored.
    if (!record || record.host !== conn) return;
    if (!peerUsable(conn)) {
      controlRoutes.remove(record.routeId);
      sendControlResult(record, false, 'DISCONNECTED', 'unconfirmed');
      return;
    }
    controlRoutes.remove(record.routeId);
    if (frame.ok) {
      sendControlResult(record, true, frame.result);
    } else {
      sendControlResult(record, false, frame.code, frame.outcome);
    }
  }

  function sendControlResult(record, ok, value, outcome) {
    if (!peerUsable(record.client)) return false;
    const frame = ok
      ? { type: 'control-result', callId: record.callId, targetDeviceId: record.targetDeviceId, ok: true, result: value }
      : { type: 'control-result', callId: record.callId, targetDeviceId: record.targetDeviceId, ok: false, code: value, outcome };
    if (!writeFrame(record.client.ws, frame, noop)) {
      // Backpressured client cannot learn the real outcome: terminate rather
      // than invent success.
      try { record.client.ws.terminate(); } catch { /* socket gone */ }
      return false;
    }
    return true;
  }

  function cancelClientControlRoutes(conn) {
    for (const record of controlRoutes.listForClient(conn)) {
      controlRoutes.remove(record.routeId);
      if (peerUsable(record.host)) {
        writeFrame(record.host.ws, {
          type: 'control-cancel',
          routeId: record.routeId
        }, noop);
      }
    }
  }

  function failHostControlRoutes(conn) {
    for (const record of controlRoutes.listForHost(conn)) {
      controlRoutes.remove(record.routeId);
      sendControlResult(record, false, 'DISCONNECTED', 'unconfirmed');
    }
  }

  function onFrame(conn, data, isBinary) {
    let frame;
    try {
      frame = readClientFrame(data, isBinary);
    } catch {
      return closeWith(conn, RELAY_CLOSE.BAD_FRAME);
    }

    if (conn.deviceId === null) {
      if (frame.type !== 'hello') {
        return closeWith(conn, RELAY_CLOSE.BAD_FRAME);
      }
      let device;
      try {
        device = registry.authenticate(frame.deviceId, frame.token);
      } catch {
        device = null;
      }
      if (device === null) {
        return closeWith(conn, RELAY_CLOSE.UNAUTHORIZED);
      }
      conn.deviceId = device.deviceId;
      conn.version = device.credentialVersion;
      conn.alive = true;
      conn.role = frame.role === 'client' ? 'client' : 'host';
      conn.controlProtocol = frame.controlProtocol === 1 ? 1 : 0;
      clearTimeout(conn.helloTimer);

      // One host conn per device (legacy REPLACED semantics); clients of the
      // same registered device are independent peers and never replace it.
      if (conn.role === 'host') {
        const previous = deviceMap.get(conn.deviceId);
        deviceMap.set(conn.deviceId, conn);
        if (previous) {
          previous.replaced = true;
          closeWith(previous, RELAY_CLOSE.REPLACED);
        }
      }
      const ready = {
        type: 'ready',
        protocolVersion: 1,
        deviceId: conn.deviceId
      };
      if (conn.role === 'client') ready.role = 'client';
      if (!writeFrame(conn.ws, ready, noop)) {
        closeWith(conn, 1009);
      }
      return;
    }

    if (frame.type === 'hello') {
      return closeWith(conn, RELAY_CLOSE.BAD_FRAME);
    }
    if (conn.replaced) return;

    // Source still enabled at the authenticated credentialVersion? Registry read
    // failure means the frame is not routed (no unverified pass-through).
    let current;
    try {
      current = registry.get(conn.deviceId);
    } catch {
      return;
    }
    if (
      current === null || current.revokedAt !== null ||
      current.credentialVersion !== conn.version
    ) {
      return closeWith(conn, RELAY_CLOSE.REVOKED);
    }

    // Roles separate traffic, not credential privilege: clients only
    // place/cancel control calls; hosts only send legacy frames and control
    // results. Role violations close 4403 (REVOKED) without routing.
    if (conn.role === 'client') {
      if (frame.type !== 'control-call' && frame.type !== 'control-cancel') {
        return closeWith(conn, RELAY_CLOSE.REVOKED);
      }
    } else if (frame.type === 'control-call' || frame.type === 'control-cancel') {
      return closeWith(conn, RELAY_CLOSE.REVOKED);
    }

    switch (frame.type) {
      case 'deliver': {
        if (
          frame.message.sourceDeviceId !== conn.deviceId ||
          frame.targetDeviceId === conn.deviceId
        ) {
          return closeWith(conn, RELAY_CLOSE.REVOKED);
        }
        return routeDeliver(conn, frame);
      }
      case 'ack': {
        if (
          frame.ack.recipientDeviceId !== conn.deviceId ||
          frame.targetDeviceId === conn.deviceId
        ) {
          return closeWith(conn, RELAY_CLOSE.REVOKED);
        }
        return routeAck(conn, frame);
      }
      case 'reject': {
        if (!DELIVERY_REJECT_CODES.has(frame.code)) {
          return closeWith(conn, RELAY_CLOSE.BAD_FRAME);
        }
        return routeReject(conn, frame);
      }
      case 'control-call':
        return routeControlCall(conn, frame);
      case 'control-cancel':
        return routeControlCancel(conn, frame);
      case 'control-result':
        return routeControlResult(conn, frame);
      default:
        return closeWith(conn, RELAY_CLOSE.BAD_FRAME);
    }
  }

  function onConnection(ws) {
    if (closed) {
      try { ws.terminate(); } catch { /* socket gone */ }
      return;
    }
    const conn = {
      ws,
      deviceId: null,
      version: 0,
      role: 'host',
      controlProtocol: 0,
      helloTimer: null,
      alive: true,
      dead: false,
      replaced: false
    };
    allConns.add(conn);

    ws.on('error', noop); // socket errors are terminal; close event cleans up
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (conn.dead) return;
      onFrame(conn, data, isBinary);
    });
    ws.on('close', () => {
      conn.dead = true;
      connCleanup(conn);
      allConns.delete(conn);
    });

    conn.helloTimer = setTimeout(() => {
      closeWith(conn, RELAY_CLOSE.HELLO_TIMEOUT);
    }, RELAY_HELLO_TIMEOUT_MS);
  }

  server.on('upgrade', (req, socket, head) => {
    if (closed) {
      return rejectUpgrade(socket, 503, 'Service Unavailable');
    }
    // Exact upgrade path only: no query/hash/userinfo.
    if (req.url !== '/v1/link') {
      return rejectUpgrade(socket, 404, 'Not Found');
    }
    if (req.headers.origin !== undefined || req.headers['sec-websocket-origin'] !== undefined) {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    if (upgradeSockets.size >= MAX_CONNECTIONS) {
      return rejectUpgrade(socket, 503, 'Service Unavailable');
    }
    upgradeSockets.add(socket);
    socket.on('error', noop);
    socket.on('close', () => {
      upgradeSockets.delete(socket);
    });
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws);
      });
    } catch {
      socket.destroy();
    }
  });

  server.on('error', noop); // listener errors after bind never crash the process

  // Credential and heartbeat scans cover every authenticated host AND client
  // connection, not only deviceMap hosts.
  const registryCheckTimer = setInterval(() => {
    for (const conn of allConns) {
      if (conn.dead || conn.replaced || conn.deviceId === null) continue;
      let device;
      try {
        device = registry.get(conn.deviceId);
      } catch {
        continue;
      }
      if (
        device === null || device.revokedAt !== null ||
        device.credentialVersion !== conn.version
      ) {
        closeWith(conn, RELAY_CLOSE.REVOKED);
      }
    }
  }, 1000);

  const heartbeatTimer = setInterval(() => {
    for (const conn of allConns) {
      if (conn.dead || conn.replaced || conn.deviceId === null) continue;
      if (!conn.alive) {
        // previous ping was unanswered: peer is dead
        try {
          conn.ws.terminate();
        } catch {
          /* socket gone */
        }
      } else {
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          /* socket gone */
        }
      }
    }
  }, RELAY_HEARTBEAT_MS);

  // Control-call TTL scan (<=1s granularity): expire -> TIMEOUT/unconfirmed,
  // then best-effort host cancellation.
  const controlTimer = setInterval(() => {
    const now = Date.now();
    for (const record of controlRoutes.expired(now)) {
      controlRoutes.remove(record.routeId);
      sendControlResult(record, false, 'TIMEOUT', 'unconfirmed');
      if (peerUsable(record.host)) {
        writeFrame(record.host.ws, {
          type: 'control-cancel',
          routeId: record.routeId
        }, noop);
      }
    }
  }, 1000);

  let closing = null;
  function close() {
    if (closing === null) {
      closing = (async () => {
        closed = true;
        const errors = [];
        const capture = (fn) => {
          try { fn(); } catch (err) { errors.push(err); }
        };
        clearInterval(registryCheckTimer);
        clearInterval(heartbeatTimer);
        clearInterval(controlTimer);
        for (const conn of allConns) {
          clearTimeout(conn.helloTimer);
          conn.dead = true;
          capture(() => conn.ws.terminate());
        }
        deviceMap.clear();
        controlRoutes.clear();
        for (const socket of upgradeSockets) {
          capture(() => socket.destroy());
        }
        upgradeSockets.clear();
        await new Promise((resolve) => {
          try {
            wss.close(() => resolve());
          } catch (err) {
            errors.push(err);
            resolve();
          }
        });
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          try {
            server.close(finish);
            // Pending slow/keep-alive HTTP connections must not block close.
            server.closeIdleConnections();
            server.closeAllConnections();
          } catch (err) {
            errors.push(err);
            finish();
          }
        });
        capture(() => registry.close());
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'relay server close cleanup failed');
      })();
    }
    return closing;
  }

  try {
    await new Promise((resolve, reject) => {
      const onListenError = (err) => reject(err);
      server.once('error', onListenError);
      server.listen(port, listenHost, () => {
        server.removeListener('error', onListenError);
        resolve();
      });
    });
  } catch (err) {
    closed = true;
    clearInterval(registryCheckTimer);
    clearInterval(heartbeatTimer);
    clearInterval(controlTimer);
    controlRoutes.clear();
    for (const conn of allConns) {
      clearTimeout(conn.helloTimer);
      try { conn.ws.terminate(); } catch { /* ignore */ }
    }
    try { wss.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { registry.close(); } catch { /* ignore */ }
    throw err;
  }

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const scheme = tlsOptions ? 'wss' : 'ws';
  const hostPart = listenHost.includes(':') ? `[${listenHost}]` : listenHost;

  return {
    url: `${scheme}://${hostPart}:${actualPort}/v1/link`,
    getStatus() {
      const onlineDeviceIds = [];
      for (const [deviceId, conn] of deviceMap) {
        if (!conn.dead && !conn.replaced) onlineDeviceIds.push(deviceId);
      }
      onlineDeviceIds.sort();
      let pendingConnections = 0;
      for (const conn of allConns) {
        if (!conn.dead && conn.deviceId === null) pendingConnections += 1;
      }
      return { onlineDeviceIds, pendingConnections };
    },
    close
  };
}
