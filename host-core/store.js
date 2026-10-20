import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const DB_FILE = 'host.sqlite';
const PRIMARY_KIND = 'primary';

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function toBot(row) {
  if (!row) return null;
  return {
    botId: row.bot_id,
    deviceId: row.device_id,
    role: row.role,
    cwd: row.cwd,
    modelRef: row.model_ref,
    primaryConversationId: row.primary_conversation_id,
    createdAt: row.created_at,
  };
}

// 先取写锁再读版本：并发首次 open 不会都读到 0 而重复插身份。
function initSchema(db) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) {
      throw errWithCode('database schema version is newer than supported', 'UNSUPPORTED_SCHEMA');
    }
    if (version === 0) {
      db.exec(`
        CREATE TABLE host_identity (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          device_id TEXT NOT NULL
        );
        CREATE TABLE bots (
          bot_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          role TEXT NOT NULL,
          cwd TEXT NOT NULL,
          model_ref TEXT,
          primary_conversation_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );
        CREATE TABLE conversations (
          conversation_id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL UNIQUE REFERENCES bots(bot_id),
          kind TEXT NOT NULL CHECK (kind = 'primary')
        );
        CREATE TABLE bot_create_requests (
          request_id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL REFERENCES bots(bot_id),
          role TEXT NOT NULL,
          cwd TEXT NOT NULL,
          model_ref TEXT
        );
      `);
      db.prepare('INSERT INTO host_identity (id, device_id) VALUES (1, ?)').run(randomUUID());
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    } else if (!db.prepare('SELECT 1 AS x FROM host_identity WHERE id = 1').get()) {
      throw new Error('host database is missing identity row');
    }
    db.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
    }
  }
}

export function openStore(dataRoot) {
  mkdirSync(dataRoot, { recursive: true });
  const db = new DatabaseSync(join(dataRoot, DB_FILE));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    initSchema(db);

    const deviceId = db.prepare('SELECT device_id FROM host_identity WHERE id = 1').get().device_id;

    const stmtGetBot = db.prepare('SELECT * FROM bots WHERE bot_id = ?');
    const stmtGetRequest = db.prepare('SELECT * FROM bot_create_requests WHERE request_id = ?');
    const stmtListBots = db.prepare('SELECT * FROM bots ORDER BY created_at ASC, bot_id ASC');
    const stmtInsertBot = db.prepare(
      'INSERT INTO bots (bot_id, device_id, role, cwd, model_ref, primary_conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const stmtInsertConversation = db.prepare(
      'INSERT INTO conversations (conversation_id, bot_id, kind) VALUES (?, ?, ?)'
    );
    const stmtInsertRequest = db.prepare(
      'INSERT INTO bot_create_requests (request_id, bot_id, role, cwd, model_ref) VALUES (?, ?, ?, ?, ?)'
    );

    const getBot = (botId) => toBot(stmtGetBot.get(botId));
    const findByRequest = (requestId) => {
      const row = stmtGetRequest.get(requestId);
      return row ? getBot(row.bot_id) : null;
    };
    const listBots = () => stmtListBots.all().map(toBot);

    const createBot = (input) => {
      const requestId = input.requestId;
      const role = input.role;
      const cwd = input.cwd;
      const modelRef = input.modelRef == null ? null : input.modelRef;

      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        // 事务内查重：并发同 requestId 串行化后在此看到已受理记录
        const existing = stmtGetRequest.get(requestId);
        if (existing) {
          if (existing.role === role && existing.cwd === cwd && existing.model_ref === modelRef) {
            return getBot(existing.bot_id);
          }
          throw errWithCode('requestId already used with different definition', 'REQUEST_CONFLICT');
        }
        const botId = randomUUID();
        const conversationId = randomUUID();
        const createdAt = new Date().toISOString();
        stmtInsertBot.run(botId, deviceId, role, cwd, modelRef, conversationId, createdAt);
        stmtInsertConversation.run(conversationId, botId, PRIMARY_KIND);
        stmtInsertRequest.run(requestId, botId, role, cwd, modelRef);
        db.exec('COMMIT');
        committed = true;
        return getBot(botId);
      } finally {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
        }
      }
    };

    return { deviceId, createBot, getBot, findByRequest, listBots, close };
  } catch (err) {
    try { close(); } catch { /* close 失败不掩盖原错误 */ }
    throw err;
  }
}
