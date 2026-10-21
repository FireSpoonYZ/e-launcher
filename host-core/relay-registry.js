// 模块 8：Host 设备注册表（relay.sqlite）。只存 device_id、SHA-256 token 哈希与
// 凭据版本/时间戳；绝不返回或记录 token/哈希。注册/旋转/撤销/认证均为本地所有者
// CLI 决定，无网络端点，不在 Host/Bot 状态上落任何数据。
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { messageError, assertId } from './message-protocol.js';
import { assertDeviceToken } from './relay-protocol.js';

const SCHEMA_VERSION = 1;
const DB_FILE = 'relay.sqlite';
// 设备未知时与等长假哈希比较，避免通过认证耗时探知设备是否存在。
const DUMMY_HASH = Buffer.alloc(32);

const SCHEMA_SQL = `
  CREATE TABLE relay_devices (
    device_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    credential_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revoked_at TEXT
  );
`;

function initSchema(db) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) {
      throw messageError('UNSUPPORTED_SCHEMA', 'relay database schema version is newer than supported');
    }
    if (version === 0) {
      const existingTables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all();
      if (existingTables.length > 0) {
        throw messageError('UNSUPPORTED_SCHEMA', 'database file already contains unrecognized tables');
      }
      db.exec(SCHEMA_SQL);
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    }
    db.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
    }
  }
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const result = fn();
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
    }
  }
}

function sha256Hex(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toDevice(row) {
  return {
    deviceId: row.device_id,
    credentialVersion: row.credential_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function normalizeCredentialInput(input, label) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw messageError('INVALID_ARGUMENT', `${label} input must be an object`);
  }
  const allowed = new Set(['deviceId', 'token']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw messageError('INVALID_ARGUMENT', `${label} input has unknown field: ${key}`);
    }
  }
  assertId(input.deviceId, 'deviceId');
  assertDeviceToken(input.token);
  return { deviceId: input.deviceId, tokenHash: sha256Hex(input.token) };
}

export function openRelayRegistry(options) {
  const dataRoot = options?.dataRoot;
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !isAbsolute(dataRoot)) {
    throw messageError('INVALID_ARGUMENT', 'dataRoot must be a non-empty absolute path');
  }
  const root = resolve(dataRoot);
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, DB_FILE));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    initSchema(db);

    const stmtGet = db.prepare('SELECT * FROM relay_devices WHERE device_id = ?');
    const stmtList = db.prepare('SELECT * FROM relay_devices ORDER BY device_id');
    const stmtInsert = db.prepare(
      'INSERT INTO relay_devices (device_id, token_hash, credential_version, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const stmtRotate = db.prepare(
      'UPDATE relay_devices SET token_hash = ?, credential_version = ?, updated_at = ?, revoked_at = NULL WHERE device_id = ?'
    );
    const stmtRevoke = db.prepare(
      'UPDATE relay_devices SET credential_version = ?, updated_at = ?, revoked_at = ? WHERE device_id = ?'
    );

    const register = (input) => {
      const { deviceId, tokenHash } = normalizeCredentialInput(input, 'register');
      return inTransaction(db, () => {
        const row = stmtGet.get(deviceId);
        if (!row) {
          const now = new Date().toISOString();
          stmtInsert.run(deviceId, tokenHash, 1, now, now, null);
          return toDevice(stmtGet.get(deviceId));
        }
        if (row.revoked_at !== null) {
          throw messageError('REQUEST_CONFLICT', 'device is revoked; rotate with a new token');
        }
        if (row.token_hash !== tokenHash) {
          throw messageError('REQUEST_CONFLICT', 'device already registered with a different credential');
        }
        return toDevice(row);
      });
    };

    const rotate = (input) => {
      const { deviceId, tokenHash } = normalizeCredentialInput(input, 'rotate');
      return inTransaction(db, () => {
        const row = stmtGet.get(deviceId);
        if (!row) {
          throw messageError('DEVICE_NOT_FOUND', 'device not registered');
        }
        if (row.token_hash === tokenHash) {
          if (row.revoked_at !== null) {
            throw messageError('REQUEST_CONFLICT', 'device revoked with same token; use a new secret');
          }
          return toDevice(row);
        }
        const now = new Date().toISOString();
        stmtRotate.run(tokenHash, row.credential_version + 1, now, deviceId);
        return toDevice(stmtGet.get(deviceId));
      });
    };

    const revoke = (deviceId) => {
      assertId(deviceId, 'deviceId');
      return inTransaction(db, () => {
        const row = stmtGet.get(deviceId);
        if (!row) {
          throw messageError('DEVICE_NOT_FOUND', 'device not registered');
        }
        if (row.revoked_at !== null) {
          return toDevice(row);
        }
        const now = new Date().toISOString();
        stmtRevoke.run(row.credential_version + 1, now, now, deviceId);
        return toDevice(stmtGet.get(deviceId));
      });
    };

    const get = (deviceId) => {
      assertId(deviceId, 'deviceId');
      const row = stmtGet.get(deviceId);
      return row ? toDevice(row) : null;
    };

    const list = () => stmtList.all().map(toDevice);

    const authenticate = (deviceId, token) => {
      let hash;
      try {
        assertId(deviceId, 'deviceId');
        assertDeviceToken(token);
        hash = sha256Hex(token);
      } catch {
        return null;
      }
      const row = stmtGet.get(deviceId);
      const expected = row ? Buffer.from(row.token_hash, 'hex') : DUMMY_HASH;
      if (!timingSafeEqual(Buffer.from(hash, 'hex'), expected)) {
        return null;
      }
      if (!row || row.revoked_at !== null) {
        return null;
      }
      return toDevice(row);
    };

    return {
      dataRoot: root,
      register,
      rotate,
      revoke,
      get,
      list,
      authenticate,
      close,
    };
  } catch (err) {
    try { close(); } catch { /* close 失败不掩盖原错误 */ }
    throw err;
  }
}
