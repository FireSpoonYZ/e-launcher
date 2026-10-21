import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMessageQueries } from './message-queries.js';
import {
  messageError,
  streamIdForScope,
  normalizeEnvelope,
  digest,
  assertScopeMessage,
} from './message-protocol.js';

const SCHEMA_VERSION = 1;
const DB_FILE = 'messages.sqlite';

// 模块 7 消息账本 schema：7 张表 + queries 需要的索引，参数化 SQL 各处使用。
const SCHEMA_SQL = `
  CREATE TABLE message_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL
  );
  CREATE TABLE message_scopes (
    scope_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('dm', 'room'))
  );
  CREATE TABLE message_scope_revisions (
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    members_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (scope_id, revision),
    FOREIGN KEY (scope_id) REFERENCES message_scopes(scope_id)
  );
  CREATE TABLE message_events (
    local_id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    source_device_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    envelope_json TEXT NOT NULL,
    digest TEXT NOT NULL,
    publish_fingerprint TEXT,
    stored_at TEXT NOT NULL,
    UNIQUE (source_device_id, stream_id, source_seq),
    FOREIGN KEY (scope_id, revision) REFERENCES message_scope_revisions(scope_id, revision)
  );
  CREATE TABLE message_outbox (
    message_id TEXT NOT NULL,
    target_device_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'acked')),
    acked_at TEXT,
    PRIMARY KEY (message_id, target_device_id),
    FOREIGN KEY (message_id) REFERENCES message_events(message_id)
  );
  CREATE TABLE message_local_targets (
    message_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    PRIMARY KEY (message_id, bot_id),
    FOREIGN KEY (message_id) REFERENCES message_events(message_id)
  );
  CREATE TABLE message_streams (
    source_device_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    highest_seq INTEGER NOT NULL,
    contiguous_seq INTEGER NOT NULL,
    PRIMARY KEY (source_device_id, stream_id),
    FOREIGN KEY (scope_id, revision) REFERENCES message_scope_revisions(scope_id, revision)
  );
  CREATE INDEX idx_message_events_scope_local ON message_events(scope_id, local_id);
  CREATE INDEX idx_message_local_targets_bot ON message_local_targets(bot_id, message_id);
  CREATE INDEX idx_message_outbox_state_target ON message_outbox(state, target_device_id);
`;

function initSchema(db, deviceId) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) {
      throw messageError('UNSUPPORTED_SCHEMA', 'message database schema version is newer than supported');
    }
    if (version === 0) {
      const existingTables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all();
      if (existingTables.length > 0) {
        throw messageError('UNSUPPORTED_SCHEMA', 'database file already contains unrecognized tables');
      }
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO message_meta (id, device_id) VALUES (1, ?)').run(deviceId);
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    } else {
      const row = db.prepare('SELECT device_id FROM message_meta WHERE id = 1').get();
      if (!row) {
        throw messageError('UNSUPPORTED_SCHEMA', 'message database is missing identity row');
      }
      if (row.device_id !== deviceId) {
        throw messageError('REQUEST_CONFLICT', 'message database owner deviceId does not match host deviceId');
      }
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

export function openMessageStore(dataRoot, deviceId) {
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
    initSchema(db, deviceId);

    const stmtGetScopeRev = db.prepare('SELECT * FROM message_scope_revisions WHERE scope_id = ? AND revision = ?');
    const stmtGetScopeKind = db.prepare('SELECT kind FROM message_scopes WHERE scope_id = ?');
    const stmtCountScopeRevs = db.prepare('SELECT COUNT(*) AS n FROM message_scope_revisions WHERE scope_id = ?');
    const stmtGetLatestScope = db.prepare(
      'SELECT * FROM message_scope_revisions WHERE scope_id = ? ORDER BY revision DESC LIMIT 1'
    );
    const stmtInsertScope = db.prepare('INSERT INTO message_scopes (scope_id, kind) VALUES (?, ?)');
    const stmtInsertRevision = db.prepare(
      'INSERT INTO message_scope_revisions (scope_id, revision, members_json, fingerprint) VALUES (?, ?, ?, ?)'
    );

    const stmtGetEventByMsg = db.prepare('SELECT * FROM message_events WHERE message_id = ?');
    const stmtGetEventBySrcStreamSeq = db.prepare(
      'SELECT * FROM message_events WHERE source_device_id = ? AND stream_id = ? AND source_seq = ?'
    );
    const stmtHasNewInput = db.prepare(
      `SELECT 1 FROM message_events e
         WHERE e.scope_id = ? AND e.local_id > ?
           AND EXISTS (
             SELECT 1 FROM message_local_targets t
             WHERE t.message_id = e.message_id AND t.bot_id = ?
           )
           AND NOT (
             e.source_device_id = ?
             AND json_extract(e.envelope_json, '$.author.kind') = 'bot'
             AND json_extract(e.envelope_json, '$.author.botId') = ?
           )
         ORDER BY e.local_id ASC
         LIMIT 1`
    );
    const stmtInsertEvent = db.prepare(
      'INSERT INTO message_events (message_id, source_device_id, stream_id, source_seq, scope_id, revision, envelope_json, digest, publish_fingerprint, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const stmtInsertOutbox = db.prepare(
      "INSERT INTO message_outbox (message_id, target_device_id, state, acked_at) VALUES (?, ?, 'pending', NULL)"
    );
    const stmtInsertLocalTarget = db.prepare(
      'INSERT INTO message_local_targets (message_id, bot_id) VALUES (?, ?)'
    );

    const stmtGetStream = db.prepare('SELECT * FROM message_streams WHERE source_device_id = ? AND stream_id = ?');
    const stmtInsertStream = db.prepare(
      'INSERT INTO message_streams (source_device_id, stream_id, scope_id, revision, highest_seq, contiguous_seq) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const stmtUpdateStream = db.prepare(
      'UPDATE message_streams SET highest_seq = ?, contiguous_seq = ?, scope_id = ?, revision = ? WHERE source_device_id = ? AND stream_id = ?'
    );
    const stmtHasSeq = db.prepare(
      'SELECT 1 FROM message_events WHERE source_device_id = ? AND stream_id = ? AND source_seq = ?'
    );

    const stmtGetOutbox = db.prepare('SELECT * FROM message_outbox WHERE message_id = ? AND target_device_id = ?');
    const stmtUpdateOutboxAcked = db.prepare(
      "UPDATE message_outbox SET state = 'acked', acked_at = ? WHERE message_id = ? AND target_device_id = ?"
    );

    const queries = createMessageQueries(db, { deviceId });

    const makeAck = (row, sourceDeviceId) => ({
      protocolVersion: 1,
      messageId: row.message_id,
      sourceDeviceId,
      recipientDeviceId: deviceId,
      digest: row.digest,
      storedAt: row.stored_at,
    });

    const applyStreamPublish = (scopeId, revision, streamId, seq) => {
      const row = stmtGetStream.get(deviceId, streamId);
      if (!row) {
        stmtInsertStream.run(deviceId, streamId, scopeId, revision, seq, seq === 1 ? 1 : 0);
        return;
      }
      const contiguous = row.contiguous_seq === row.highest_seq ? seq : row.contiguous_seq;
      stmtUpdateStream.run(seq, contiguous, scopeId, revision, deviceId, streamId);
    };

    // 只沿已存在的序列推进 contiguous；绝不按 1..highest 整数范围循环。
    const applyStreamReceive = (sourceDeviceId, scopeId, revision, streamId, seq) => {
      const row = stmtGetStream.get(sourceDeviceId, streamId);
      if (!row) {
        stmtInsertStream.run(sourceDeviceId, streamId, scopeId, revision, seq, seq === 1 ? 1 : 0);
        return;
      }
      const highest = Math.max(row.highest_seq, seq);
      let contiguous = row.contiguous_seq;
      if (seq === contiguous + 1) {
        let c = seq;
        while (c < highest && stmtHasSeq.get(sourceDeviceId, streamId, c + 1)) c += 1;
        contiguous = c;
      }
      if (highest !== row.highest_seq || contiguous !== row.contiguous_seq) {
        stmtUpdateStream.run(highest, contiguous, scopeId, revision, sourceDeviceId, streamId);
      }
    };

    const installScope = (input) => inTransaction(db, () => {
      const fingerprint = digest(input);
      const existing = stmtGetScopeRev.get(input.scopeId, input.revision);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw messageError('REQUEST_CONFLICT', 'scope revision already installed with a different definition');
        }
        const kindRow = stmtGetScopeKind.get(input.scopeId);
        return {
          scopeId: input.scopeId,
          kind: kindRow.kind,
          revision: input.revision,
          members: JSON.parse(existing.members_json),
        };
      }
      const kindRow = stmtGetScopeKind.get(input.scopeId);
      if (kindRow && kindRow.kind !== input.kind) {
        throw messageError('REQUEST_CONFLICT', 'scope kind cannot change across revisions');
      }
      if (kindRow?.kind === 'dm' && stmtGetLatestScope.get(input.scopeId).members_json !== JSON.stringify(input.members)) {
        throw messageError('REQUEST_CONFLICT', 'DM participants are fixed; create a different scope for another pair');
      }
      if (stmtCountScopeRevs.get(input.scopeId).n === 0) {
        const hasLocalMember = input.members.some((member) => member.deviceId === deviceId);
        if (!hasLocalMember) {
          throw messageError('SCOPE_FORBIDDEN', 'first installed scope revision must include a local member bot');
        }
      }
      if (!kindRow) {
        stmtInsertScope.run(input.scopeId, input.kind);
      }
      stmtInsertRevision.run(input.scopeId, input.revision, JSON.stringify(input.members), fingerprint);
      return { scopeId: input.scopeId, kind: input.kind, revision: input.revision, members: input.members };
    });

    const publish = (input, guard = null) => inTransaction(db, () => {
      const fingerprint = digest(input);
      // 去重先于目标/来源 scope 与新输入检查：同请求重试返回原封套（保留老目标/序号）。
      const existing = stmtGetEventByMsg.get(input.messageId);
      if (existing) {
        if (existing.publish_fingerprint !== null && existing.publish_fingerprint === fingerprint) {
          return queries.getMessage(existing.message_id);
        }
        throw messageError('REQUEST_CONFLICT', 'messageId already used with a different publish request');
      }

      const scope = stmtGetLatestScope.get(input.scopeId);
      if (!scope) {
        throw messageError('SCOPE_NOT_FOUND', 'scope not installed');
      }
      const members = JSON.parse(scope.members_json);

      let rootId = input.messageId;
      if (input.replyTo) {
        const parentRow = stmtGetEventByMsg.get(input.replyTo);
        if (!parentRow || parentRow.scope_id !== input.scopeId) {
          throw messageError('MESSAGE_NOT_FOUND', 'replyTo does not reference a stored message in the same scope');
        }
        rootId = JSON.parse(parentRow.envelope_json).rootId;
      }
      if (input.author.kind === 'user') {
        rootId = input.messageId;
      }

      const streamId = streamIdForScope(input.scopeId, scope.revision);
      const streamRow = stmtGetStream.get(deviceId, streamId);
      const sequence = (streamRow ? streamRow.highest_seq : 0) + 1;

      const envelope = normalizeEnvelope({
        protocolVersion: 1,
        messageId: input.messageId,
        sourceDeviceId: deviceId,
        streamId,
        sequence,
        scopeId: input.scopeId,
        revision: scope.revision,
        author: input.author,
        category: input.category,
        rootId,
        replyTo: input.replyTo,
        text: input.text,
        targets: members,
        createdAt: new Date().toISOString(),
      });
      // 与 receive 相同的协议检查：作者成员资格/类别/scope 参与，杜绝非成员 Bot、human 进 DM、wrong category、Host 退出后发信。
      const scopeObj = {
        scopeId: input.scopeId,
        kind: stmtGetScopeKind.get(input.scopeId).kind,
        revision: scope.revision,
        members,
      };
      assertScopeMessage(scopeObj, envelope, deviceId);
      if (guard !== null) {
        // guard 绑定模型读取的来源 scope，不一定是本次发送目标。
        const originScope = stmtGetLatestScope.get(guard.scopeId);
        if (!originScope) {
          throw messageError('SCOPE_NOT_FOUND', 'origin scope not installed');
        }
        const originMembers = JSON.parse(originScope.members_json);
        const botId = input.author.botId;
        if (!originMembers.some((member) => member.deviceId === deviceId && member.botId === botId)) {
          throw messageError('SCOPE_FORBIDDEN', 'publisher bot must be a current member of the origin scope');
        }
        if (stmtHasNewInput.get(guard.scopeId, guard.afterLocalId, botId, deviceId, botId)) {
          throw messageError('STALE_INPUT', 'new input arrived before publication');
        }
      }
      const envelopeDigest = digest(envelope);
      const storedAt = new Date().toISOString();
      stmtInsertEvent.run(
        envelope.messageId,
        envelope.sourceDeviceId,
        envelope.streamId,
        envelope.sequence,
        envelope.scopeId,
        envelope.revision,
        JSON.stringify(envelope),
        envelopeDigest,
        fingerprint,
        storedAt
      );
      const localTargets = [];
      const remoteHosts = new Set();
      for (const member of envelope.targets) {
        if (member.deviceId === deviceId) {
          localTargets.push(member.botId);
        } else {
          remoteHosts.add(member.deviceId);
        }
      }
      for (const botId of localTargets) {
        stmtInsertLocalTarget.run(envelope.messageId, botId);
      }
      for (const targetDeviceId of remoteHosts) {
        stmtInsertOutbox.run(envelope.messageId, targetDeviceId);
      }
      applyStreamPublish(envelope.scopeId, envelope.revision, envelope.streamId, envelope.sequence);
      return queries.getMessage(envelope.messageId);
    });

    const receive = (peer, envelope) => inTransaction(db, () => {
      if (peer.deviceId !== envelope.sourceDeviceId) {
        throw messageError('PEER_MISMATCH', 'peer deviceId does not match envelope sourceDeviceId');
      }
      const scope = stmtGetScopeRev.get(envelope.scopeId, envelope.revision);
      if (!scope) {
        throw messageError('SCOPE_NOT_FOUND', 'scope revision not installed');
      }
      const kindRow = stmtGetScopeKind.get(envelope.scopeId);
      const scopeObj = {
        scopeId: envelope.scopeId,
        kind: kindRow.kind,
        revision: envelope.revision,
        members: JSON.parse(scope.members_json),
      };
      // 作者/类别/scope 目标（含 streamId）检查由协议 assertScopeMessage 完成；本机 Bot 存在性由 facade 检查。
      assertScopeMessage(scopeObj, envelope, deviceId);
      const envelopeDigest = digest(envelope);

      const existing = stmtGetEventByMsg.get(envelope.messageId);
      if (existing) {
        if (existing.digest === envelopeDigest) {
          return {
            message: queries.getMessage(existing.message_id),
            ack: makeAck(existing, envelope.sourceDeviceId),
            duplicate: true,
          };
        }
        throw messageError('REQUEST_CONFLICT', 'messageId already used with a different envelope');
      }
      const seqUsed = stmtGetEventBySrcStreamSeq.get(envelope.sourceDeviceId, envelope.streamId, envelope.sequence);
      if (seqUsed) {
        throw messageError('REQUEST_CONFLICT', 'source sequence already used by a different message');
      }

      for (const ref of [envelope.rootId, envelope.replyTo]) {
        if (!ref || ref === envelope.messageId) continue;
        const known = stmtGetEventByMsg.get(ref);
        if (known && known.scope_id !== envelope.scopeId) {
          throw messageError('REQUEST_CONFLICT', 'reference points outside the message scope');
        }
      }

      const storedAt = new Date().toISOString();
      stmtInsertEvent.run(
        envelope.messageId,
        envelope.sourceDeviceId,
        envelope.streamId,
        envelope.sequence,
        envelope.scopeId,
        envelope.revision,
        JSON.stringify(envelope),
        envelopeDigest,
        null,
        storedAt
      );
      for (const member of envelope.targets) {
        if (member.deviceId === deviceId) {
          stmtInsertLocalTarget.run(envelope.messageId, member.botId);
        }
      }
      applyStreamReceive(envelope.sourceDeviceId, envelope.scopeId, envelope.revision, envelope.streamId, envelope.sequence);

      const row = stmtGetEventByMsg.get(envelope.messageId);
      return {
        message: queries.getMessage(row.message_id),
        ack: makeAck(row, envelope.sourceDeviceId),
        duplicate: false,
      };
    });

    const acknowledge = (peer, ack) => {
      inTransaction(db, () => {
        if (peer.deviceId !== ack.recipientDeviceId) {
          throw messageError('PEER_MISMATCH', 'peer deviceId does not match ack recipientDeviceId');
        }
        if (ack.sourceDeviceId !== deviceId) {
          throw messageError('REQUEST_CONFLICT', 'ack sourceDeviceId is not this host');
        }
        const event = stmtGetEventByMsg.get(ack.messageId);
        if (!event) {
          throw messageError('MESSAGE_NOT_FOUND', 'message not found');
        }
        if (event.source_device_id !== deviceId) {
          throw messageError('SCOPE_FORBIDDEN', 'message was not originated on this host');
        }
        if (event.digest !== ack.digest) {
          throw messageError('REQUEST_CONFLICT', 'ack digest does not match stored message');
        }
        const outbox = stmtGetOutbox.get(ack.messageId, ack.recipientDeviceId);
        if (!outbox) {
          throw messageError('DELIVERY_NOT_FOUND', 'delivery target not found');
        }
        if (outbox.state === 'pending') {
          stmtUpdateOutboxAcked.run(new Date().toISOString(), ack.messageId, ack.recipientDeviceId);
        }
      });
      return queries.deliveryStatus(ack.messageId);
    };

    return {
      deviceId,
      ...queries,
      installScope,
      publish,
      receive,
      acknowledge,
      close,
    };
  } catch (err) {
    try { close(); } catch { /* close 失败不掩盖原错误 */ }
    throw err;
  }
}
