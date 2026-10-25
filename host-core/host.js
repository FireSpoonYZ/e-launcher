import { openStore } from './store.js';
import { ensureSoul, setSoulText } from './bot-soul.js';
// Bot 扩展设置的形状由 extension-manager 统一归一化（B lane），host 不重复定义规则。
import { normalizeBotExtensions } from './extension-manager.js';
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

  // 未知 Bot 抛 BOT_NOT_FOUND；SOUL 路径只在此校验过存在性后由 bot-soul.js 内部生成。
  const requireBot = (botId) => {
    assertId(botId, 'botId');
    const bot = store.getBot(botId);
    if (!bot) throw botNotFound(botId);
    return bot;
  };

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

      const request = { requestId, role, cwd: normalizedCwd, modelRef: resolvedModelRef };
      // Retries for an already-accepted request must not fail when the original
      // cwd has since disappeared; store.createBot does the consistency check.
      if (store.findByRequest(requestId) !== null) {
        // 已受理记录不因上次 SOUL 写入失败而丢失：重试在此幂等补建。
        const retried = store.createBot(request);
        ensureSoul(root, retried.botId, retried.role);
        return retried;
      }

      let stat;
      try {
        stat = fs.statSync(normalizedCwd);
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw invalidCwd(normalizedCwd);
        throw err;
      }
      if (!stat.isDirectory()) throw invalidCwd(normalizedCwd);

      const created = store.createBot(request);
      // 注册记录与 SOUL 文件分两步：文件失败不回滚已受理记录，重试可完成初始化。
      ensureSoul(root, created.botId, created.role);
      return created;
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
    // 内部快照 {botId, revision, extensions, retentionFloor}；缺省值只在首次初始化时复制一次。
    ensureBotExtensions(botId, defaults) {
      requireBot(botId);
      return store.ensureBotExtensionSettings(botId, normalizeBotExtensions(defaults), 0);
    },
    // 行未初始化返回 null；未知 Bot 由调用方先用 getBot 区分。
    getBotExtensions(botId) {
      assertId(botId, 'botId');
      return store.getBotExtensionSettings(botId);
    },
    // options.retentionFloor 只由 Runtime 在离开关闭/只读期时提供，公开调用方不传。
    setBotExtensions(botId, input, options = {}) {
      requireBot(botId);
      if (typeof input !== 'object' || input === null) throw invalidArgument('input must be an object');
      const expectedRevision = input.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw invalidArgument('expectedRevision must be a non-negative integer');
      }
      const extensions = normalizeBotExtensions(input.extensions);
      let retentionFloor;
      if (options?.retentionFloor !== undefined) {
        if (!Number.isSafeInteger(options.retentionFloor) || options.retentionFloor < 0) {
          throw invalidArgument('retentionFloor must be a non-negative integer');
        }
        retentionFloor = options.retentionFloor;
      }
      const current = store.getBotExtensionSettings(botId);
      if (!current || current.revision !== expectedRevision) throw requestConflict();
      const next = store.updateBotExtensionSettings(
        botId,
        expectedRevision,
        extensions,
        retentionFloor === undefined ? current.retentionFloor : retentionFloor
      );
      if (!next) throw requestConflict();
      return next;
    },
    // SOUL：首次/缺失时按持久化 role 一次性补建，已有内容永不覆盖。
    ensureBotSoul(botId) {
      const bot = requireBot(botId);
      return ensureSoul(root, bot.botId, bot.role);
    },
    getBotSoul(botId) {
      // 遗留 Bot 的缺失文档在此幂等补建（读取即初始化）。
      const bot = requireBot(botId);
      return ensureSoul(root, bot.botId, bot.role);
    },
    setBotSoul(botId, input) {
      const bot = requireBot(botId);
      if (typeof input !== 'object' || input === null) throw invalidArgument('input must be an object');
      return setSoulText(root, bot.botId, input.expectedRevision, input.text);
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

function botNotFound(botId) {
  const err = new Error(`bot not found: ${botId}`);
  err.code = 'BOT_NOT_FOUND';
  return err;
}

function requestConflict() {
  const err = new Error('bot settings revision does not match the current state');
  err.code = 'REQUEST_CONFLICT';
  return err;
}

function assertId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw invalidArgument(`${name} must be a non-empty string`);
}

export { openHost as default };
