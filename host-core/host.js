import { openStore } from './store.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Open the local bot/host registry for the machine.
 * dataRoot must be a non-empty absolute path; it is resolved and handed to the
 * store, which is responsible for creating it.
 */
export function openHost(options) {
  const dataRoot = options?.dataRoot;
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
    throw invalidArgument('dataRoot must be a non-empty absolute path');
  }
  const root = path.resolve(dataRoot);
  const store = openStore(root);

  return {
    deviceId: store.deviceId,
    dataRoot: root,
    createBot(input) {
      if (typeof input !== 'object' || input === null) throw invalidArgument('input must be an object');
      const { requestId, role, cwd, modelRef } = input;
      if (typeof requestId !== 'string' || requestId.trim() === '') throw invalidArgument('requestId must be a non-empty string');
      if (typeof role !== 'string' || role.trim() === '') throw invalidArgument('role must be non-blank text');
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw invalidArgument('cwd must be an absolute path');
      let resolvedModelRef = null;
      if (modelRef !== undefined && modelRef !== null) {
        if (typeof modelRef !== 'string' || modelRef.trim() === '') throw invalidArgument('modelRef must be null or a non-blank string');
        resolvedModelRef = modelRef;
      }
      const normalizedCwd = path.resolve(cwd);

      // Retries for an already-accepted request must not fail when the original
      // cwd has since disappeared; store.createBot does the consistency check.
      if (store.findByRequest(requestId) !== null) {
        return store.createBot({ requestId, role, cwd: normalizedCwd, modelRef: resolvedModelRef });
      }

      let stat;
      try {
        stat = fs.statSync(normalizedCwd);
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw invalidCwd(normalizedCwd);
        throw err;
      }
      if (!stat.isDirectory()) throw invalidCwd(normalizedCwd);

      return store.createBot({ requestId, role, cwd: normalizedCwd, modelRef: resolvedModelRef });
    },
    getBot(botId) {
      assertId(botId, 'botId');
      return store.getBot(botId);
    },
    findByRequest(requestId) {
      assertId(requestId, 'requestId');
      return store.findByRequest(requestId);
    },
    listBots() {
      return store.listBots();
    },
    // M16 内部遗留迁移登记：只转发 store 三方法，不暴露于 HTTP/relay/plugin；
    // 入参校验由 legacy-import.js 在可信调用前完成。
    reserveLegacyImport(input) {
      return store.reserveLegacyImport(input);
    },
    getLegacyImport(sourceKey) {
      return store.getLegacyImport(sourceKey);
    },
    completeLegacyImport(sourceKey, requestId) {
      return store.completeLegacyImport(sourceKey, requestId);
    },
    close() {
      store.close();
    },
  };
}

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

function invalidCwd(cwd) {
  const err = new Error(`cwd is not an existing directory: ${cwd}`);
  err.code = 'INVALID_CWD';
  return err;
}

function assertId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw invalidArgument(`${name} must be a non-empty string`);
}

export { openHost as default };
