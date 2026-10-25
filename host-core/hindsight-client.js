// host-core/hindsight-client.js
// Hindsight REST client adapter for Pi Durable. Frozen upstream protocol from
// @vectorize-io/hindsight-client 0.9.2 generated SDK (bank GET updated to /config,
// PUT bank, POST memories, GET/PATCH memory, POST recall/reflect, GET
// operation/document, POST operation retry). Built-in fetch only; no new
// dependencies.

const MAX_BODY_BYTES = 2 * 1024 * 1024; // request/response UTF-8 bound, 2MiB
const TIMEOUT_MS = 30_000;

const BANK_PATH = '/v1/default/banks';

const OPERATION_STATUSES = new Set([
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'not_found',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_SAFE_TOKEN_RE = /^[\x21-\x7E]+$/;

export class HindsightClientError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'HindsightClientError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function clientError(code, message) {
  return new HindsightClientError(code, message);
}

function closedError() {
  return clientError('HINDSIGHT_CLOSED', 'HINDSIGHT_CLOSED');
}

function unavailableError() {
  return clientError('HINDSIGHT_UNAVAILABLE', 'HINDSIGHT_UNAVAILABLE');
}

function protocolError(message = 'HINDSIGHT_PROTOCOL_ERROR') {
  return clientError('HINDSIGHT_PROTOCOL_ERROR', message);
}

function statusError(code, status) {
  return new HindsightClientError(code, code, status);
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return !!error && typeof error === 'object' && error.name === 'AbortError';
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl must use http or https');
  }
  if (url.username || url.password) {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl must not contain credentials');
  }
  if (url.search || url.hash) {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl must not contain query or fragment');
  }
  if (url.protocol === 'http:') {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      throw clientError('INVALID_ARGUMENT', 'hindsight http baseUrl must target loopback');
    }
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * 纯 Hindsight 配置校验：不读环境变量/文件/网络。
 * undefined -> undefined；拒 null/非 plain/未知 key；baseUrl 沿用原规则；
 * apiKeyEnv 只校验名称，sharedMemory 默认 false。
 */
export function normalizeHindsightConfig(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw clientError('INVALID_ARGUMENT', 'hindsight options must be a plain object');
  }
  const allowed = new Set(['baseUrl', 'apiKeyEnv', 'sharedMemory']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw clientError('INVALID_ARGUMENT', `unknown hindsight option key: ${key}`);
    }
  }
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length === 0) {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl is required');
  }
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  let apiKeyEnv;
  if (value.apiKeyEnv !== undefined) {
    if (typeof value.apiKeyEnv !== 'string' || !ENV_NAME_RE.test(value.apiKeyEnv)) {
      throw clientError('INVALID_ARGUMENT', 'hindsight apiKeyEnv must be a standard environment variable name');
    }
    apiKeyEnv = value.apiKeyEnv;
  }
  let sharedMemory = false;
  if (value.sharedMemory !== undefined) {
    if (typeof value.sharedMemory !== 'boolean') {
      throw clientError('INVALID_ARGUMENT', 'hindsight sharedMemory must be a boolean');
    }
    sharedMemory = value.sharedMemory;
  }
  const normalized = { baseUrl, sharedMemory };
  if (apiKeyEnv !== undefined) normalized.apiKeyEnv = apiKeyEnv;
  return normalized;
}

/**
 * Parse Host-provided hindsight options into a normalized config.
 * Returns null when undefined; rejects null/non-plain/unknown keys.
 * 复用 normalizeHindsightConfig 纯校验后，再在此解析环境变量：
 * 显式 apiKeyEnv 必须是标准环境名且解析为 nonempty header-safe ASCII token；
 * 省略 apiKeyEnv 是受支持的无鉴权本地服务场景。
 */
export function parseHindsightOptions(value) {
  if (value === undefined) return null;
  const normalized = normalizeHindsightConfig(value);
  let apiKey;
  if (normalized.apiKeyEnv !== undefined) {
    const resolved = process.env[normalized.apiKeyEnv];
    if (resolved === undefined || resolved.length === 0 || !HEADER_SAFE_TOKEN_RE.test(resolved)) {
      throw clientError(
        'INVALID_ARGUMENT',
        `hindsight apiKeyEnv ${normalized.apiKeyEnv} must resolve to a nonempty header-safe ASCII token`,
      );
    }
    apiKey = resolved;
  }
  return { baseUrl: normalized.baseUrl, apiKey, sharedMemory: normalized.sharedMemory };
}

/**
 * Create a Hindsight client. No network happens in the constructor.
 */
export function createHindsightClient(config) {
  // config is the normalized output of parseHindsightOptions ({baseUrl, apiKey,
  // sharedMemory}); URL/env/header/sharedMemory validation already happened there.
  // Only a minimal structural guard remains so a broken internal config fails early.
  if (!isPlainObject(config) || typeof config.baseUrl !== 'string' || config.baseUrl.length === 0) {
    throw clientError('INVALID_ARGUMENT', 'hindsight client config must be a normalized plain object with baseUrl');
  }
  const baseUrl = config.baseUrl;
  const apiKey = config.apiKey; // already header-safe or undefined
  let closed = false;
  const pending = new Set(); // {cancel, promise} per in-flight request

  const seg = (id) => encodeURIComponent(id);
  const bankPath = (bankId) => `${BANK_PATH}/${seg(mustResourceId(bankId, 'bankId'))}`;

  function mustString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
      throw clientError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
    }
    return value;
  }

  function mustResourceId(value, name) {
    mustString(value, name);
    if (value === '.' || value === '..') {
      throw clientError('INVALID_ARGUMENT', `${name} must not be '.' or '..'`);
    }
    if (!value.isWellFormed()) {
      throw clientError('INVALID_ARGUMENT', `${name} must not contain lone surrogates`);
    }
    return value;
  }

  function mustPlain(value, name) {
    if (!isPlainObject(value)) {
      throw clientError('INVALID_ARGUMENT', `${name} must be a plain object`);
    }
    return value;
  }

  function mustOptString(value, name) {
    if (value !== undefined && typeof value !== 'string') {
      throw clientError('INVALID_ARGUMENT', `${name} must be a string`);
    }
    return value;
  }

  function mustSafePositiveInt(value, name) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw clientError('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
    }
    return value;
  }

  function mustStringArray(value, name) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw clientError('INVALID_ARGUMENT', `${name} must be an array of strings`);
    }
    return value;
  }

  function plainObject(value) {
    if (!isPlainObject(value)) throw protocolError();
    return value;
  }

  function protocolCheck(condition, message) {
    if (!condition) throw protocolError(message);
  }

  function validateBankResponse(response, bankId) {
    plainObject(response);
    protocolCheck(response.bank_id === bankId, 'bank response bank_id mismatch');
    return response;
  }

  async function readTextLimited(response) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw protocolError();
    }
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_BYTES) throw protocolError();
      return decodeUtf8(buffer);
    }
    const reader = response.body.getReader();
    let cancelled = false;
    const cancelOnce = async () => {
      if (cancelled) return;
      cancelled = true;
      await reader.cancel().catch(() => {});
    };
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await cancelOnce();
          throw protocolError();
        }
        chunks.push(value);
      }
    } catch (error) {
      await cancelOnce();
      throw error;
    } finally {
      reader.releaseLock();
    }
    return decodeUtf8(Buffer.concat(chunks));
  }

  function decodeUtf8(buffer) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw protocolError();
    }
  }

  async function handleResponse(response) {
    if (response.status >= 200 && response.status < 300) {
      const text = await readTextLimited(response);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw protocolError();
      }
      return data;
    }
    if (response.body) await response.body.cancel().catch(() => {});
    switch (response.status) {
      case 401:
      case 403:
        throw statusError('HINDSIGHT_AUTH_FAILED', response.status);
      case 404:
        throw statusError('HINDSIGHT_NOT_FOUND', response.status);
      case 409:
        throw statusError('HINDSIGHT_CONFLICT', response.status);
      default:
        if (response.status >= 500) {
          throw statusError('HINDSIGHT_UNAVAILABLE', response.status);
        }
        throw statusError('HINDSIGHT_INVALID_REQUEST', response.status);
    }
  }

  async function doRequest(method, path, options, ctrl, cancel, getCause) {
    const signal = options?.signal;
    let body;
    const json = options?.json;
    if (json !== undefined) {
      body = JSON.stringify(json);
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        throw clientError('INVALID_ARGUMENT', 'hindsight request body exceeds 2MiB limit');
      }
    }
    const onAbort = () => cancel('caller');
    if (signal) {
      if (signal.aborted) throw abortError();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => cancel('timeout'), TIMEOUT_MS);
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(baseUrl + path, {
        method,
        headers,
        body,
        signal: ctrl.signal,
        redirect: 'error',
      });
      return await handleResponse(response);
    } catch (error) {
      // First cancel cause wins: even if the body reader throws after cancellation,
      // classify from the recorded cause rather than the thrown error type.
      const cause = getCause();
      if (cause === 'caller') throw abortError();
      if (cause === 'close') throw closedError();
      if (cause === 'timeout') throw unavailableError();
      if (error instanceof HindsightClientError) throw error;
      if (isAbortError(error)) throw abortError();
      throw unavailableError();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function request(method, path, options) {
    if (closed) return Promise.reject(closedError());
    const ctrl = new AbortController();
    let cause = null;
    const cancel = (reason) => {
      if (cause !== null) return; // first cause wins
      cause = reason;
      ctrl.abort();
    };
    const entry = { cancel };
    const promise = doRequest(method, path, options, ctrl, cancel, () => cause).finally(() =>
      pending.delete(entry),
    );
    entry.promise = promise;
    pending.add(entry);
    return promise;
  }

  function close() {
    close.promise ??= (async () => {
      if (!closed) {
        closed = true; // seal admission synchronously
        for (const entry of pending) entry.cancel('close');
      }
      await Promise.allSettled([...pending].map((entry) => entry.promise));
    })();
    return close.promise;
  }

  return {
    async getBank(bankId, signal) {
      const response = await request('GET', `${bankPath(bankId)}/config`, { signal });
      return validateBankResponse(response, bankId);
    },
    async createBank(bankId, options = {}, signal) {
      const opts = mustPlain(options ?? {}, 'createBank options');
      const payload = {};
      if (opts.name !== undefined) payload.name = mustOptString(opts.name, 'name');
      if (opts.retainMission !== undefined) {
        payload.retain_mission = mustOptString(opts.retainMission, 'retainMission');
      }
      if (opts.reflectMission !== undefined) {
        payload.reflect_mission = mustOptString(opts.reflectMission, 'reflectMission');
      }
      const response = await request('PUT', bankPath(bankId), { json: payload, signal });
      return validateBankResponse(response, bankId);
    },
    async retain(bankId, input, signal) {
      const opts = mustPlain(input, 'retain input');
      const documentId = mustString(opts.documentId, 'documentId');
      const operationId = mustString(opts.operationId, 'operationId');
      if (!UUID_RE.test(operationId)) {
        throw clientError('INVALID_ARGUMENT', 'operationId must be a UUID');
      }
      const content = mustString(opts.content, 'content');
      const item = { content, document_id: documentId, update_mode: 'replace' };
      if (opts.context !== undefined) item.context = mustOptString(opts.context, 'context');
      if (opts.metadata !== undefined) {
        const metadata = mustPlain(opts.metadata, 'metadata');
        for (const value of Object.values(metadata)) {
          if (typeof value !== 'string') {
            throw clientError('INVALID_ARGUMENT', 'metadata values must be strings');
          }
        }
        item.metadata = metadata;
      }
      if (opts.tags !== undefined) item.tags = mustStringArray(opts.tags, 'tags');
      if (opts.timestamp !== undefined) item.timestamp = mustOptString(opts.timestamp, 'timestamp');
      const response = await request('POST', `${bankPath(bankId)}/memories`, {
        json: { items: [item], async: true, operation_id: operationId },
        signal,
      });
      plainObject(response);
      protocolCheck(response.success === true, 'retain response success must be true');
      protocolCheck(response.bank_id === bankId, 'retain response bank_id mismatch');
      protocolCheck(response.async === true, 'retain response async must be true');
      protocolCheck(response.operation_id === operationId, 'retain response operation_id mismatch');
      return response;
    },
    async getOperation(bankId, operationId, signal) {
      const opId = mustResourceId(operationId, 'operationId');
      const response = await request('GET', `${bankPath(bankId)}/operations/${seg(opId)}`, {
        signal,
      });
      plainObject(response);
      protocolCheck(response.operation_id === opId, 'operation response operation_id mismatch');
      protocolCheck(OPERATION_STATUSES.has(response.status), 'operation response status invalid');
      return response;
    },
    async retryOperation(bankId, operationId, signal) {
      const opId = mustResourceId(operationId, 'operationId');
      const response = await request(
        'POST',
        `${bankPath(bankId)}/operations/${seg(opId)}/retry`,
        { signal },
      );
      plainObject(response);
      protocolCheck(response.success === true, 'retry response success must be true');
      protocolCheck(typeof response.message === 'string', 'retry response message must be a string');
      protocolCheck(response.operation_id === opId, 'retry response operation_id mismatch');
      return response;
    },
    async recall(bankId, input, signal) {
      const opts = mustPlain(input, 'recall input');
      const query = mustString(opts.query, 'query');
      const body = { query, budget: 'mid', include: { source_facts: {} } };
      if (opts.maxTokens !== undefined) {
        const maxTokens = mustSafePositiveInt(opts.maxTokens, 'maxTokens');
        body.max_tokens = maxTokens;
        body.include.source_facts.max_tokens = maxTokens;
      }
      const response = await request('POST', `${bankPath(bankId)}/memories/recall`, {
        json: body,
        signal,
      });
      plainObject(response);
      protocolCheck(Array.isArray(response.results), 'recall response results must be an array');
      for (const item of response.results) {
        plainObject(item);
        protocolCheck(typeof item.id === 'string', 'recall result id must be a string');
        protocolCheck(typeof item.text === 'string', 'recall result text must be a string');
        if (item.type !== undefined && item.type !== null && typeof item.type !== 'string') {
          throw protocolError('recall result type must be a string or null');
        }
        if (
          item.document_id !== undefined &&
          item.document_id !== null &&
          typeof item.document_id !== 'string'
        ) {
          throw protocolError('recall result document_id must be a string or null');
        }
        if (item.source_fact_ids !== undefined && item.source_fact_ids !== null) {
          if (
            !Array.isArray(item.source_fact_ids) ||
            !item.source_fact_ids.every((v) => typeof v === 'string')
          ) {
            throw protocolError('recall result source_fact_ids must be an array of strings or null');
          }
        }
      }
      if (response.source_facts !== undefined && response.source_facts !== null) {
        if (typeof response.source_facts !== 'object' || Array.isArray(response.source_facts)) {
          throw protocolError('recall source_facts must be an object or null');
        }
        for (const entry of Object.values(response.source_facts)) {
          plainObject(entry);
          protocolCheck(typeof entry.id === 'string', 'recall source_fact id must be a string');
          protocolCheck(typeof entry.text === 'string', 'recall source_fact text must be a string');
        }
      }
      if (
        response.source_facts_truncated !== undefined &&
        response.source_facts_truncated !== null &&
        typeof response.source_facts_truncated !== 'boolean'
      ) {
        throw protocolError('recall source_facts_truncated must be a boolean or null');
      }
      return response;
    },
    async reflect(bankId, input, signal) {
      const opts = mustPlain(input, 'reflect input');
      const query = mustString(opts.query, 'query');
      const body = { query, budget: 'mid', include: { facts: {} } };
      if (opts.maxTokens !== undefined) {
        body.max_tokens = mustSafePositiveInt(opts.maxTokens, 'maxTokens');
      }
      const response = await request('POST', `${bankPath(bankId)}/reflect`, {
        json: body,
        signal,
      });
      plainObject(response);
      protocolCheck(typeof response.text === 'string', 'reflect response text must be a string');
      return response;
    },
    async getMemory(bankId, memoryId, signal) {
      const response = await request(
        'GET',
        `${bankPath(bankId)}/memories/${seg(mustResourceId(memoryId, 'memoryId'))}`,
        { signal },
      );
      return plainObject(response);
    },
    async updateMemory(bankId, memoryId, input, signal) {
      const opts = mustPlain(input, 'updateMemory input');
      if (opts.text === undefined && opts.state === undefined) {
        throw clientError('INVALID_ARGUMENT', 'updateMemory requires text or state');
      }
      const payload = {};
      if (opts.text !== undefined) payload.text = mustOptString(opts.text, 'text');
      if (opts.state !== undefined) {
        if (opts.state !== 'valid' && opts.state !== 'invalidated') {
          throw clientError('INVALID_ARGUMENT', 'state must be valid or invalidated');
        }
        payload.state = opts.state;
      }
      if (opts.reason !== undefined) payload.reason = mustOptString(opts.reason, 'reason');
      const response = await request(
        'PATCH',
        `${bankPath(bankId)}/memories/${seg(mustResourceId(memoryId, 'memoryId'))}`,
        { json: payload, signal },
      );
      return plainObject(response);
    },
    async getDocument(bankId, documentId, signal) {
      const docId = mustResourceId(documentId, 'documentId');
      const response = await request('GET', `${bankPath(bankId)}/documents/${seg(docId)}`, {
        signal,
      });
      plainObject(response);
      protocolCheck(response.id === docId, 'document response id mismatch');
      protocolCheck(response.bank_id === bankId, 'document response bank_id mismatch');
      return response;
    },
    close,
  };
}
