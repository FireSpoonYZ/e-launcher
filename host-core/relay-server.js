// host-core/relay-server.js
// Module 8 authenticated device relay: one HTTP(S) listener with a single
// /v1/link WebSocket upgrade path. Authenticated sockets are bound to a
// deviceId; frames are routed one-to-one between bound devices. The relay
// never persists messages and keeps no business state beyond online peers.

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

  const deviceMap = new Map(); // deviceId -> conn (authenticated)
  const allConns = new Set();  // every accepted WS, authenticated or not
  const upgradeSockets = new Set();
  let closed = false;

  function connCleanup(conn) {
    clearTimeout(conn.helloTimer);
    if (conn.deviceId !== null && deviceMap.get(conn.deviceId) === conn) {
      deviceMap.delete(conn.deviceId);
    }
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
      clearTimeout(conn.helloTimer);

      const previous = deviceMap.get(conn.deviceId);
      deviceMap.set(conn.deviceId, conn);
      if (previous) {
        // Replacement: old socket stops routing; its close handler must not
        // delete the new map entry (identity guard in connCleanup).
        previous.replaced = true;
        closeWith(previous, RELAY_CLOSE.REPLACED);
      }
      if (!writeFrame(conn.ws, {
        type: 'ready',
        protocolVersion: 1,
        deviceId: conn.deviceId
      }, noop)) {
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

  const registryCheckTimer = setInterval(() => {
    for (const conn of deviceMap.values()) {
      if (conn.dead || conn.replaced) continue;
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
    for (const conn of deviceMap.values()) {
      if (conn.dead || conn.replaced) continue;
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
        for (const conn of allConns) {
          clearTimeout(conn.helloTimer);
          conn.dead = true;
          capture(() => conn.ws.terminate());
        }
        deviceMap.clear();
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
