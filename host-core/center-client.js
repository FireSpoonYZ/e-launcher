import http from 'node:http';
import https from 'node:https';
import { assertDeviceToken } from './relay-protocol.js';
import { assertId } from './message-protocol.js';

function centerError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function connectCenter({ centerUrl, deviceId, deviceToken, ca, onDisconnect, onChange }) {
  let base;
  try { base = new URL(centerUrl); } catch { throw centerError('INVALID_ARGUMENT', 'invalid center URL'); }
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw centerError('INVALID_ARGUMENT', 'center URL must be an HTTPS origin or loopback HTTP origin');
  }
  assertId(deviceId, 'deviceId');
  assertDeviceToken(deviceToken);
  const transport = base.protocol === 'https:' ? https : http;
  const requests = new Set();
  let closed = false;
  let events;
  let ownerCookie = '';
  let ownerCsrf = '';
  let ownerQueue = Promise.resolve();
  const headers = { Authorization: `Bearer ${deviceToken}`, 'X-Device-Id': deviceId };
  const start = (path, { method = 'GET', body, signal } = {}) => {
    if (closed) throw centerError('CENTER_OFFLINE', 'center is disconnected');
    const req = transport.request(new URL(path, base), {
      method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ca, signal,
    });
    requests.add(req);
    req.once('close', () => requests.delete(req));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
    return req;
  };
  const request = async (path, options = {}) => {
    const req = start(path, options);
    req.setTimeout(30000, () => req.destroy(centerError('CENTER_OFFLINE', 'center request timed out')));
    const response = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw centerError(response.statusCode === 401 || response.statusCode === 403 ? 'UNAUTHENTICATED' : 'CENTER_REQUEST_FAILED', 'center request failed');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > (options.binary ? 256 * 1024 * 1024 : 16 * 1024 * 1024)) {
        response.destroy();
        throw centerError('CENTER_REQUEST_FAILED', 'center response too large');
      }
      chunks.push(chunk);
    }
    const result = Buffer.concat(chunks);
    if (options.binary) return result;
    if (response.statusCode === 204) return;
    try { return JSON.parse(result.toString('utf8')); }
    catch { throw centerError('CENTER_REQUEST_FAILED', 'invalid center response'); }
  };
  const ownerRequest = (path, { method = 'GET', body, signal } = {}) => {
    const run = ownerQueue.then(async () => {
      if (closed || signal?.aborted) throw centerError('CENTER_OFFLINE', 'center is disconnected');
      const req = transport.request(new URL(path, base), {
        method, ca, signal,
        headers: { ...(ownerCookie ? { Cookie: ownerCookie } : {}),
          ...(method !== 'GET' ? { 'X-CSRF-Token': ownerCsrf } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      });
      requests.add(req);
      req.once('close', () => requests.delete(req));
      req.setTimeout(30000, () => req.destroy(centerError('CENTER_OFFLINE', 'center request timed out')));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
      const response = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
      if (closed || signal?.aborted) { response.resume(); throw centerError('CENTER_OFFLINE', 'center is disconnected'); }
      const cookies = response.headers['set-cookie'];
      if (cookies?.length) ownerCookie = cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        const code = response.statusCode === 409 ? 'REQUEST_CONFLICT' : response.statusCode === 401 || response.statusCode === 403 ? 'CONTROL_UNAUTHORIZED' : 'BAD_RESPONSE';
        throw centerError(code, response.statusCode === 409 ? 'center revision conflict; reload before saving' : response.statusCode === 401 || response.statusCode === 403 ? 'center administrator authentication failed' : `center request failed (${response.statusCode})`);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { response.destroy(); throw centerError('BAD_RESPONSE', 'center response too large'); }
        chunks.push(chunk);
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw centerError('BAD_RESPONSE', 'invalid center response'); }
      if (closed || signal?.aborted) throw centerError('CENTER_OFFLINE', 'center is disconnected');
      if (path === '/api/session') {
        if (typeof result?.authenticated !== 'boolean' || typeof result.csrfToken !== 'string' || !result.csrfToken) throw centerError('BAD_RESPONSE', 'invalid center session');
        ownerCsrf = result.csrfToken;
      }
      return result;
    });
    ownerQueue = run.catch(() => {});
    return run;
  };
  const ownerSession = async (signal) => {
    const session = await ownerRequest('/api/session', { signal });
    return { authenticated: session.authenticated };
  };
  const botModelPath = (targetDeviceId, botId) => '/api/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/model-config';
  try {
    const req = start('/api/host/events');
    req.setTimeout(15000, () => req.destroy(centerError('CENTER_OFFLINE', 'center connection timed out')));
    events = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
    req.setTimeout(0);
    if (events.statusCode !== 200 || !String(events.headers['content-type'] ?? '').startsWith('text/event-stream')) {
      events.resume();
      throw centerError('UNAUTHENTICATED', 'center event stream rejected');
    }
    let buffer = '';
    let watchdog;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => events.destroy(), 45000);
      watchdog.unref?.();
    };
    const disconnected = () => {
      clearTimeout(watchdog);
      if (!closed) { closed = true; ownerCookie = ''; ownerCsrf = ''; for (const active of requests) active.destroy(); onDisconnect?.(centerError('CENTER_OFFLINE', 'center event stream disconnected')); }
    };
    events.setEncoding('utf8');
    events.on('data', (chunk) => {
      arm();
      buffer += chunk;
      if (buffer.length > 65536) { events.destroy(); return; }
      let end;
      while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, end);
        const separator = /^\r?\n\r?\n/.exec(buffer.slice(end))[0];
        buffer = buffer.slice(end + separator.length);
        if (frame.split(/\r?\n/).some((line) => line === 'event: config-changed')) onChange?.();
      }
    });
    events.once('end', disconnected);
    events.once('error', disconnected);
    events.once('close', disconnected);
    arm();
  } catch (error) {
    closed = true;
    for (const active of requests) active.destroy();
    throw error;
  }
  return {
    ownerSession,
    async ownerLogin(password, signal) {
      await ownerSession(signal);
      const session = await ownerRequest('/api/session', { method: 'POST', body: { password }, signal });
      return { authenticated: session.authenticated };
    },
    botModelGet: (targetDeviceId, botId, signal) => ownerRequest(botModelPath(targetDeviceId, botId), { signal }),
    botModelSet: (targetDeviceId, botId, input, signal) => ownerRequest(botModelPath(targetDeviceId, botId), { method: 'PUT', body: input, signal }),
    bootstrap: (bots) => request('/api/host/bootstrap', { method: 'POST', body: { deviceId, capabilityProtocol: 1, bots } }),
    getConnection: () => request('/api/host/connection'),
    getSnapshot: () => request('/api/host/snapshot'),
    reportRuntime: (receipt) => request('/api/host/receipt', { method: 'POST', body: receipt }),
    getDeployments: () => request('/api/host/deployments'),
    reportDeployment: (receipt) => request('/api/host/deployments/receipt', { method: 'POST', body: receipt }),
    fetchArtifact: (ref) => request('/api/host/artifacts/' + encodeURIComponent(ref), { binary: true }),
    listCapabilityTools: (id, botId, options = {}) => request('/api/host/capabilities/' + encodeURIComponent(id) + '/tools/list', { method: 'POST', body: { botId }, signal: options.signal }),
    callCapabilityTool: (id, botId, name, args, callId, options = {}) => request('/api/host/capabilities/' + encodeURIComponent(id) + '/tools/call', { method: 'POST', body: { botId, name, args, callId }, signal: options.signal }),
    async close() { closed = true; ownerCookie = ''; ownerCsrf = ''; for (const active of requests) active.destroy(); events.destroy(); },
  };
}
