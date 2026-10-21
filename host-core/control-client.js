// Control API client for the standalone Host control server (web-standard fetch only; no Node/Host imports).

import { readControlLive } from './control-live-client.js';

export class ControlApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ControlApiError';
    this.status = options.status;
    this.code = options.code;
  }
}

function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('createControlClient: invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('createControlClient: url must be http or https');
  }
  if (url.username || url.password) {
    throw new TypeError('createControlClient: url must not contain userinfo');
  }
  if (url.hash) {
    throw new TypeError('createControlClient: url must not contain a fragment');
  }
  if (url.searchParams.get('token') !== null) {
    throw new TypeError('createControlClient: url must not contain a token query parameter');
  }
  return url.origin + url.pathname.replace(/\/+$/, '') + '/';
}

async function readJson(response, signal) {
  try {
    return await response.json();
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return null;
  }
}

async function ensureOk(response, signal) {
  if (response.ok) return;
  const apiError = extractApiError(await readJson(response, signal));
  throw new ControlApiError(
    apiError ? apiError.message : `Host control API error (HTTP ${response.status})`,
    {
      status: response.status,
      code: apiError ? apiError.code : 'BAD_RESPONSE'
    }
  );
}

function extractApiError(data) {
  if (!data || typeof data !== 'object' || !data.error || typeof data.error !== 'object') return null;
  const { code, message } = data.error;
  if (typeof code === 'string' && typeof message === 'string') return { code, message };
  return null;
}

function callOptions(options) {
  return options && options.signal ? { signal: options.signal } : {};
}

export function createControlClient({ url, token, fetch: fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) {
    throw new TypeError('createControlClient: token must be a URL-safe string of 32-512 characters');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createControlClient: fetch must be a function');
  }
  const base = parseBaseUrl(url);
  const host = new URL(base).host;

  async function request(method, segments, { signal, query, body } = {}) {
    const target = new URL(segments.map(encodeURIComponent).join('/'), base);
    if (query && query.size > 0) target.search = query.toString();

    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw new ControlApiError(
        `Cannot reach host control API at ${host}`,
        { code: 'NETWORK' }
      );
    }

    await ensureOk(response, signal);

    const data = await readJson(response, signal);
    if (data === null || typeof data !== 'object') {
      throw new ControlApiError(
        `Host control API success response is not valid JSON (HTTP ${response.status})`,
        { status: response.status, code: 'BAD_RESPONSE' }
      );
    }
    return data;
  }

  return {
    getHostInfo(options) {
      return request('GET', ['v1', 'host'], callOptions(options));
    },
    listBots(options) {
      return request('GET', ['v1', 'bots'], callOptions(options));
    },
    createBot(input, options) {
      return request('POST', ['v1', 'bots'], { ...callOptions(options), body: input });
    },
    getBot(botId, options) {
      return request('GET', ['v1', 'bots', botId], callOptions(options));
    },
    findByRequest(requestId, options) {
      return request('GET', ['v1', 'bot-requests', requestId], callOptions(options));
    },
    submit(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'submissions'], { ...callOptions(options), body: input });
    },
    getSubmission(botId, requestId, options) {
      return request('GET', ['v1', 'bots', botId, 'submissions', requestId], callOptions(options));
    },
    history(botId, options) {
      const query = new URLSearchParams();
      if (options && options.limit != null) query.set('limit', String(options.limit));
      if (options && options.cursor != null) query.set('cursor', JSON.stringify(options.cursor));
      return request('GET', ['v1', 'bots', botId, 'history'], { signal: options && options.signal, query });
    },
    abort(botId, options) {
      return request('POST', ['v1', 'bots', botId, 'abort'], { ...callOptions(options), body: {} });
    },
    contextStatus(botId, options) {
      return request('GET', ['v1', 'bots', botId, 'context'], callOptions(options));
    },
    // 固定 ~ 前缀避免 '.'/'..' scope 被 URL 折叠；request 仍逐段 URI 编码。
    getWorkContext(botId, scopeId, options) {
      return request('GET', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId], callOptions(options));
    },
    syncWorkContext(botId, scopeId, input = {}, options) {
      return request('POST', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'sync'], { ...callOptions(options), body: input });
    },
    workHistory(botId, scopeId, options) {
      const query = new URLSearchParams();
      if (options && options.limit != null) query.set('limit', String(options.limit));
      if (options && options.cursor != null) query.set('cursor', JSON.stringify(options.cursor));
      return request('GET', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'history'], { signal: options && options.signal, query });
    },
    workContextStatus(botId, scopeId, options) {
      return request('GET', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'context'], callOptions(options));
    },
    getWorkActivity(botId, scopeId, options) {
      return request('GET', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'activity'], callOptions(options));
    },
    stopWork(botId, scopeId, options) {
      return request('POST', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'stop'], { ...callOptions(options), body: {} });
    },
    resumeWork(botId, scopeId, options) {
      return request('POST', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'resume'], { ...callOptions(options), body: {} });
    },
    async *live(botId, options = {}) {
      const signal = options.signal;
      const target = new URL(['v1', 'bots', botId, 'live'].map(encodeURIComponent).join('/'), base);
      const headers = {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`
      };
      let response;
      try {
        response = await fetchImpl(target, { method: 'GET', headers, signal });
      } catch (err) {
        if (signal && signal.aborted) throw err;
        throw new ControlApiError(
          `Cannot reach host control API at ${host}`,
          { code: 'NETWORK' }
        );
      }
      await ensureOk(response, signal);
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'text/event-stream') {
        try {
          await response.body?.cancel();
        } catch { /* body already gone */ }
        throw new ControlApiError(
          `Host control API live response is not text/event-stream (HTTP ${response.status})`,
          { status: response.status, code: 'BAD_RESPONSE' }
        );
      }
      try {
        for await (const frame of readControlLive(response, { botId, signal })) {
          yield frame;
        }
      } catch (err) {
        if (signal && signal.aborted) throw err;
        if (err && err.name === 'AbortError') throw err;
        if (err && err.code === 'LIVE_PROTOCOL') {
          throw new ControlApiError(err.message, { code: 'BAD_RESPONSE' });
        }
        throw new ControlApiError(
          `Host control live stream failed at ${host}`,
          { code: 'NETWORK' }
        );
      }
    }
  };
}
