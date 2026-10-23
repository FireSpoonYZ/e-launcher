// M16 legacy import core: staging->permanent archive, passive Durable import
// into a new Host Bot, read-only status/draft pagination.
// 只读旧源/归档；不创建 Task/Submission/模型任务/记忆 job；不触发模型。
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  loadLegacySnapshot,
  analyzeLegacySnapshot,
  readLegacyManifest,
  readLegacyFile,
} from './legacy-snapshot.js';
import { parseModelRef } from './runtime-models.js';
import { createPrimaryInTransaction, PrimaryIndex } from './runtime-docs.js';
import { LegacyImportMarkers } from './legacy-import-docs.js';

const HEX64 = /^[0-9a-f]{64}$/;
const SOURCE_KEY_PREFIX = 'android-chat:';
const STAGING_DIR_NAME = 'legacy-staging';
const ARCHIVES_DIR_NAME = 'legacy-archives';
const DRAFT_TEXT_PAGE_UNITS = 8192;
const DRAFT_ATTACHMENTS_PAGE = 50;
// 明确外部历史 user 文本；原消息角色仅作 provenance，绝不作 pi.user/认证/工具任务。
const LEGACY_MODEL_PREFIX = 'External legacy history (historical data, not a new request; no author authentication):\n';

const PREVIEW_KEYS = new Set(['snapshotId', 'role', 'cwd', 'modelRef']);
const STATUS_KEYS = new Set(['sourceKey', 'requestId']);
const DRAFT_KEYS = new Set(['sourceKey', 'requestId', 'textOffset', 'attachmentOffset']);
const FROZEN_KEYS = new Set(['sourceKey', 'snapshotId', 'requestId', 'role', 'cwd', 'modelRef']);

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}
const invalidArgument = (message) => errWithCode(message, 'INVALID_ARGUMENT');
const invalidSource = (message) => errWithCode(message, 'INVALID_SOURCE');
const conflict = (message) => errWithCode(message, 'REQUEST_CONFLICT');
const ioError = (message) => errWithCode(message, 'IO_ERROR');

/** 部分导入：reserve 后未确认完成。保留原因，调用方只读对账或显式继续。 */
function unconfirmed(cause) {
  const err = errWithCode('legacy import outcome is unconfirmed', 'IO_ERROR');
  err.outcome = 'unconfirmed';
  err.cause = cause;
  return err;
}

function assertInputObject(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidArgument(label + ' must be an object');
  }
  return input;
}

function assertKnownKeys(input, allowed, label) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw invalidArgument(label + ' has unknown field');
  }
}

function assertExactKeys(input, allowed, label) {
  assertInputObject(input, label);
  assertKnownKeys(input, allowed, label);
  for (const key of allowed) {
    if (!Object.hasOwn(input, key)) throw invalidArgument(label + ' is missing a required field');
  }
}

function assertSnapshotId(snapshotId) {
  if (typeof snapshotId !== 'string' || !HEX64.test(snapshotId)) {
    throw invalidArgument('snapshotId must be a lower-case SHA-256 hex string');
  }
  return snapshotId;
}

function assertNoAsciiControls(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function assertRole(role) {
  // 角色允许任意可打印及空白字符（含换行/制表/回车），原文保留；只拒绝空/非字符串/非 well-formed/超长。
  if (typeof role !== 'string' || role.trim() === '' || !role.isWellFormed()) {
    throw invalidArgument('role must be non-blank well-formed text');
  }
  if (Buffer.byteLength(role, 'utf8') > 65536) {
    throw invalidArgument('role exceeds 65536 UTF-8 bytes');
  }
  return role;
}

function normalizeCwd(cwd) {
  if (
    typeof cwd !== 'string' || cwd.trim() === '' || !cwd.isWellFormed()
    || cwd.includes('\0') || Buffer.byteLength(cwd, 'utf8') > 65536
    || !path.isAbsolute(cwd)
  ) {
    throw invalidArgument('cwd must be a well-formed absolute path');
  }
  return path.resolve(cwd);
}

function assertCwdExists(cwd) {
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw errWithCode('cwd is not an existing directory', 'INVALID_CWD');
    }
    throw ioError('cwd check failed');
  }
  if (!stat.isDirectory()) {
    throw errWithCode('cwd is not an existing directory', 'INVALID_CWD');
  }
}

function assertModelRef(modelRef) {
  if (
    typeof modelRef !== 'string' || modelRef.trim() === '' || !modelRef.isWellFormed()
    || !assertNoAsciiControls(modelRef) || Buffer.byteLength(modelRef, 'utf8') > 4096
  ) {
    throw invalidArgument('modelRef must be a non-blank well-formed string');
  }
  try {
    parseModelRef(modelRef); // 仅校验 provider/modelId 格式；不读凭据/配置/模型。
  } catch {
    throw invalidArgument('modelRef must be provider/modelId');
  }
  return modelRef;
}

function assertSourceKey(sourceKey) {
  if (
    typeof sourceKey !== 'string' || !sourceKey.isWellFormed()
    || !sourceKey.startsWith(SOURCE_KEY_PREFIX) || Buffer.byteLength(sourceKey, 'utf8') > 256
    || !assertNoAsciiControls(sourceKey)
  ) {
    throw invalidArgument('sourceKey must be android-chat:<conversationId>');
  }
  // 仅用 trim 判断非空；返回/保存仍用原始 sourceKey。
  if (sourceKey.slice(SOURCE_KEY_PREFIX.length).trim() === '') {
    throw invalidArgument('sourceKey conversation id is empty');
  }
  return sourceKey;
}

function assertSafeOffset(value, label) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidArgument(label + ' must be a non-negative safe integer');
  }
  return value;
}

function assertRequestId(requestId) {
  if (typeof requestId !== 'string' || !HEX64.test(requestId)) {
    throw invalidArgument('requestId must be a lower-case SHA-256 hex string');
  }
  return requestId;
}

/** 冻结请求摘要：键序固定 version/sourceKey/snapshotId/role/cwd/modelRef，cwd 为规范化目标。 */
function requestDigest(sourceKey, snapshotId, role, cwd, modelRef) {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, sourceKey, snapshotId, role, cwd, modelRef }))
    .digest('hex');
}

function validatePreviewInput(input) {
  assertExactKeys(input, PREVIEW_KEYS, 'preview input');
  const snapshotId = assertSnapshotId(input.snapshotId);
  const role = assertRole(input.role);
  const cwd = normalizeCwd(input.cwd);
  assertCwdExists(cwd);
  const modelRef = assertModelRef(input.modelRef);
  return { snapshotId, role, cwd, modelRef };
}

function validateStatusInput(input) {
  assertInputObject(input, 'status input');
  assertKnownKeys(input, STATUS_KEYS, 'status input');
  if (!Object.hasOwn(input, 'sourceKey')) throw invalidArgument('status input is missing a required field');
  const sourceKey = assertSourceKey(input.sourceKey);
  let requestId = null;
  if (input.requestId !== undefined) {
    requestId = assertRequestId(input.requestId);
  }
  return { sourceKey, requestId };
}

function validateFrozenInput(input) {
  assertExactKeys(input, FROZEN_KEYS, 'frozen input');
  return {
    sourceKey: assertSourceKey(input.sourceKey),
    snapshotId: assertSnapshotId(input.snapshotId),
    requestId: assertRequestId(input.requestId),
    role: assertRole(input.role),
    cwd: normalizeCwd(input.cwd),
    modelRef: assertModelRef(input.modelRef),
  };
}

function validateDraftInput(input) {
  assertInputObject(input, 'draft input');
  assertKnownKeys(input, DRAFT_KEYS, 'draft input');
  if (!Object.hasOwn(input, 'sourceKey') || !Object.hasOwn(input, 'requestId')) {
    throw invalidArgument('draft input is missing a required field');
  }
  return {
    sourceKey: assertSourceKey(input.sourceKey),
    requestId: assertRequestId(input.requestId),
    textOffset: assertSafeOffset(input.textOffset, 'textOffset'),
    attachmentOffset: assertSafeOffset(input.attachmentOffset, 'attachmentOffset'),
  };
}

/** LegacyStatus：missing 全 null；prepared 预留身份不外泄（bot 仅 completed）。 */
function toLegacyStatus(row, sourceKey) {
  if (!row) {
    return { phase: 'missing', sourceKey, requestId: null, snapshotId: null, definition: null, bot: null };
  }
  return {
    phase: row.phase,
    sourceKey: row.sourceKey,
    requestId: row.requestId,
    snapshotId: row.snapshotId,
    definition: { role: row.bot.role, cwd: row.bot.cwd, modelRef: row.bot.modelRef },
    bot: row.phase === 'completed' ? row.bot : null,
  };
}

function stagingRootOf(host) {
  return path.join(path.dirname(host.dataRoot), STAGING_DIR_NAME);
}

function archivesRootOf(host) {
  return path.join(host.dataRoot, ARCHIVES_DIR_NAME);
}

function mapLoadError(err) {
  if (err && typeof err === 'object') {
    if (err.code === 'BUSY') return err;
    if (err.code === 'INVALID_ARGUMENT') {
      return invalidSource('legacy snapshot is invalid or missing');
    }
  }
  return ioError('legacy snapshot read failed');
}

async function loadManagedSnapshot(root, snapshotId) {
  try {
    return await loadLegacySnapshot(root, snapshotId);
  } catch (err) {
    throw mapLoadError(err);
  }
}

async function loadStagingSnapshot(host, snapshotId) {
  return loadManagedSnapshot(stagingRootOf(host), snapshotId);
}

/** 归档已存在必须可验证；损坏永不覆盖。目录不存在返回 null。 */
async function tryLoadArchive(archivesRoot, snapshotId) {
  const dest = path.join(archivesRoot, snapshotId);
  let st;
  try {
    st = await fsp.lstat(dest);
  } catch (err) {
    if (err?.code === 'ENOENT') return null; // 仅 ENOENT 表示缺失
    throw ioError('legacy archive check failed');
  }
  if (!st.isDirectory()) throw ioError('existing archive is not a directory');
  try {
    return await loadLegacySnapshot(archivesRoot, snapshotId);
  } catch {
    throw ioError('existing archive is corrupt');
  }
}

async function requireArchive(archivesRoot, snapshotId) {
  const loaded = await tryLoadArchive(archivesRoot, snapshotId);
  if (!loaded) throw ioError('legacy archive is missing');
  return loaded;
}

/** 归档根只允许真实目录：不存在可创建；symlink/非目录/中间路径失效一律拒绝。 */
async function ensureArchiveRoot(archivesRoot) {
  let st;
  try {
    st = await fsp.lstat(archivesRoot);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      await fsp.mkdir(archivesRoot, { recursive: true });
      return;
    }
    throw ioError('legacy archives root check failed');
  }
  if (st.isSymbolicLink()) throw ioError('legacy archives root is a symbolic link');
  if (!st.isDirectory()) throw ioError('legacy archives root is not a directory');
}

/**
 * 原子发布逐字节一致的归档：manifest 精确字节 + manifest 声明文件。逐记录用
 * readLegacyFile 有界/hash/UTF8 读取后以独占创建写入自有临时目录，load 重新
 * 校验后 rename。并发同内容发布复用已验证目标；损坏归档永不覆盖。
 */
async function publishArchive(archivesRoot, snapshot, snapshotId) {
  await ensureArchiveRoot(archivesRoot);
  const dest = path.join(archivesRoot, snapshotId);
  let st;
  try {
    st = await fsp.lstat(dest);
  } catch (err) {
    if (err?.code === 'ENOENT') st = null; // 仅 ENOENT 表示缺失；ENOTDIR 等固定 IO 错误
    else throw ioError('legacy archive check failed');
  }
  if (st) {
    if (!st.isDirectory()) throw ioError('existing archive is not a directory');
    try {
      await loadLegacySnapshot(archivesRoot, snapshotId);
      return;
    } catch {
      throw ioError('existing archive is corrupt');
    }
  }

  const tmpRoot = path.join(archivesRoot, `.tmp-${snapshotId}-${randomUUID()}`);
  const tmpSnapshotRoot = path.join(tmpRoot, snapshotId);
  try {
    await fsp.mkdir(tmpSnapshotRoot, { recursive: true });
    await fsp.writeFile(path.join(tmpSnapshotRoot, 'manifest.json'), snapshot.manifestBytes, { flag: 'wx' });
    const parents = new Set();
    for (const record of snapshot.fileRecords.values()) {
      const parent = path.posix.dirname(record.relPath);
      if (parent !== '.') parents.add(parent);
    }
    for (const parent of parents) {
      await fsp.mkdir(path.join(tmpSnapshotRoot, parent), { recursive: true });
    }
    try {
      for (const record of snapshot.fileRecords.values()) {
        const buf = await readLegacyFile(record); // 有界 size/hash；非附件 fatal UTF8
        await fsp.writeFile(path.join(tmpSnapshotRoot, record.relPath), buf, { flag: 'wx' });
      }
    } catch {
      throw ioError('legacy archive copy failed');
    }
    try {
      await loadLegacySnapshot(tmpRoot, snapshotId);
    } catch {
      throw ioError('copied archive did not validate');
    }
    try {
      await fsp.rename(path.join(tmpRoot, snapshotId), dest);
    } catch (err) {
      // 并发同内容发布：验证目标归档后复用，绝不覆盖。
      let st2;
      try {
        st2 = await fsp.lstat(dest);
      } catch {
        throw ioError('legacy archive publish failed');
      }
      if (!st2 || !st2.isDirectory()) throw ioError('legacy archive publish failed');
      try {
        await loadLegacySnapshot(archivesRoot, snapshotId);
      } catch {
        throw ioError('existing archive is corrupt');
      }
    }
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function readArchiveManifest(archivesRoot, snapshotId) {
  try {
    return await readLegacyManifest(archivesRoot, snapshotId);
  } catch {
    throw ioError('legacy archive is missing or invalid');
  }
}

async function readArchiveFile(record) {
  try {
    return await readLegacyFile(record);
  } catch {
    throw ioError('legacy archive file read failed');
  }
}

/** 投影消息：保留文本与 quoted 工具信息；附件/archiveFile 映射永久绝对归档路径。 */
const KEPT_MESSAGE_FIELDS = new Set([
  'role', 'content', 'tool_calls', 'tool_call_id', 'name',
  'attachments', 'id', 'toolCallId', 'toolName', 'isError',
]);

function projectMessage(message, attachmentById, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw invalidSource('invalid legacy message');
  }
  const out = {};
  for (const key of Object.keys(message)) {
    if (!KEPT_MESSAGE_FIELDS.has(key)) continue;
    if (key === 'attachments') {
      if (!Array.isArray(message.attachments)) continue;
      out.attachments = message.attachments.map((a) => remapAttachment(a, attachmentById, ctx.archiveRoot));
      continue;
    }
    if (key === 'content') {
      out.content = projectContent(message.content, attachmentById, ctx);
      continue;
    }
    if (key === 'tool_calls') {
      if (!Array.isArray(message.tool_calls)) continue;
      out.tool_calls = message.tool_calls.map((c) => {
        if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.id !== 'string' || typeof c.name !== 'string') {
          throw invalidSource('invalid tool call');
        }
        const call = { id: c.id, name: c.name };
        if (typeof c.arguments === 'string') call.arguments = c.arguments;
        else if (c.arguments !== undefined) call.arguments = JSON.stringify(c.arguments);
        return call;
      });
      continue;
    }
    out[key] = message[key];
  }
  return out;
}

function remapAttachment(a, attachmentById, archiveRoot) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.id !== 'string' || !a.id) {
    throw invalidSource('invalid attachment descriptor');
  }
  const copy = attachmentById.get(a.id);
  if (!copy) throw invalidSource('attachment reference missing');
  return {
    id: copy.id,
    name: copy.name,
    mimeType: copy.mimeType,
    kind: copy.kind,
    size: copy.size,
    path: path.join(archiveRoot, copy.path), // codec.path 为相对路径，映射永久绝对路径
    sourcePath: copy.sourcePath, // 仅 provenance，不作可用路径
  };
}

function projectContent(content, attachmentById, ctx) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ?? null;
  const out = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string') out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'toolCall') {
      // SDK content 内 toolCall 保留 quoted 历史 id/name/arguments。
      if (typeof block.id === 'string' && typeof block.name === 'string') {
        const call = { type: 'toolCall', id: block.id, name: block.name };
        if (typeof block.arguments === 'string') call.arguments = block.arguments;
        else if (block.arguments !== undefined) call.arguments = JSON.stringify(block.arguments);
        out.push(call);
      }
      continue;
    }
    if (block.type === 'image') {
      const ref = imageArchiveRef(block, attachmentById, ctx.archiveRoot);
      if (ref) {
        out.push(ref);
      } else {
        // 无 attachment id 的内联图像：仍提供永久归档 + 真实 record/content 索引引用。
        out.push({ type: 'image', archiveFile: ctx.archiveFile, source: { ...ctx.source, contentIndex: i } });
      }
      continue;
    }
    // thinking/signature/usage/base64 等非文本块不投影（归档保留原文）。
  }
  return out;
}

function imageArchiveRef(block, attachmentById, archiveRoot) {
  const rawId = block.attachment?.id ?? block.id;
  if (typeof rawId === 'string' && rawId) {
    const copy = attachmentById.get(rawId);
    if (copy) return { type: 'image', id: copy.id, path: path.join(archiveRoot, copy.path) };
  }
  return null;
}

function createLegacyEntry(frozen, bot, archivesRoot, snapshotId, snapshot) {
  const attachmentById = new Map(snapshot.attachments.map((a) => [a.id, a]));
  const archiveRoot = path.join(archivesRoot, snapshotId);
  return (record) => {
    const archiveFile = path.join(archiveRoot, record.source.file); // 永久绝对路径
    const data = {
      version: 1,
      sourceKey: frozen.sourceKey,
      requestId: frozen.requestId,
      snapshotId: frozen.snapshotId,
      botId: bot.botId,
      primaryConversationId: bot.primaryConversationId,
      role: record.role,
      source: record.source, // 真实原 provenance（相对 file/index/nodeId/entryId）
      archiveFile,
      message: projectMessage(record.message, attachmentById, { archiveRoot, archiveFile, source: record.source }),
    };
    return {
      kind: 'host.legacy-message',
      data,
      model: [{ role: 'user', content: LEGACY_MODEL_PREFIX + JSON.stringify(data), timestamp: 0 }],
    };
  };
}

function markerEquals(marker, frozen, bot, recordCount, expectedNativeId) {
  if (!marker || typeof marker !== 'object') return false;
  // nativeId/expectedNativeId 必须均为正安全整数；禁止两处 undefined/null 相等即跳过。
  if (!Number.isSafeInteger(expectedNativeId) || expectedNativeId <= 0) return false;
  if (!Number.isSafeInteger(marker.nativeId) || marker.nativeId <= 0) return false;
  return marker.version === 1
    && marker.sourceKey === frozen.sourceKey
    && marker.requestId === frozen.requestId
    && marker.snapshotId === frozen.snapshotId
    && marker.botId === bot.botId
    && marker.primaryConversationId === bot.primaryConversationId
    && marker.nativeId === expectedNativeId
    && marker.recordCount === recordCount;
}

/** 发布前有效投影检查：逐条消息复用 projectMessage 路径，核格式与附件引用；不分配 Bot、不读文件。 */
function validateRecordsProjection(records, archivesRoot, snapshotId, snapshot) {
  const archiveRoot = path.join(archivesRoot, snapshotId);
  const attachmentById = new Map(snapshot.attachments.map((a) => [a.id, a]));
  for (const record of records) {
    const archiveFile = path.join(archiveRoot, record.source.file);
    projectMessage(record.message, attachmentById, { archiveRoot, archiveFile, source: record.source });
  }
}

function assertAnalysisSourceKey(analysisSourceKey, expected) {
  if (analysisSourceKey !== expected) {
    throw invalidSource('snapshot source does not match sourceKey');
  }
}

function assertDefinitionMatches(existing, frozen) {
  if (
    existing.snapshotId !== frozen.snapshotId
    || existing.bot.role !== frozen.role
    || existing.bot.cwd !== frozen.cwd
    || existing.bot.modelRef !== frozen.modelRef
  ) {
    throw conflict('sourceKey already reserved with a different definition');
  }
}

/**
 * 预览：只读 staging + 分析 + registry，返回小 DTO（无 records/raw body/凭据）。
 * 不入任何模型/provider 查询，不继承旧默认配置。
 */
export async function previewLegacyImport(host, input) {
  const p = validatePreviewInput(input);
  const snapshot = await loadStagingSnapshot(host, p.snapshotId);
  const analysis = await analyzeLegacySnapshot(snapshot);
  const sourceKey = assertSourceKey(analysis.sourceKey);
  validateRecordsProjection(analysis.records, archivesRootOf(host), p.snapshotId, snapshot);
  const requestId = requestDigest(sourceKey, p.snapshotId, p.role, p.cwd, p.modelRef);
  const existing = toLegacyStatus(host.getLegacyImport(sourceKey), sourceKey);
  return {
    sourceKey,
    snapshotId: p.snapshotId,
    requestId,
    source: analysis.source,
    selectedLeafId: analysis.selectedLeafId,
    definition: { role: p.role, cwd: p.cwd, modelRef: p.modelRef },
    counts: analysis.counts,
    warnings: analysis.warnings,
    draft: {
      bytes: snapshot.fileRecords.get('draft.txt').size,
      attachments: analysis.draft.attachments.length,
    },
    existing,
  };
}

/**
 * 状态：只读 registry；绝不打开 Harness/归档/源，不恢复/complete。
 * 提供的 requestId 必须等于已存行，否则 REQUEST_CONFLICT。
 */
export function getLegacyImportStatus(host, input) {
  const s = validateStatusInput(input);
  const row = host.getLegacyImport(s.sourceKey);
  if (row && s.requestId !== null && row.requestId !== s.requestId) {
    throw conflict('requestId does not match reserved import');
  }
  return toLegacyStatus(row, s.sourceKey);
}

/**
 * 导入：顺序 = registry 先读 → 首次先 load+analyze staging 并核 sourceKey/有效投影，
 * 再原子发布永久归档（后续投影一律基于已验证永久 archive，不再重读 staging）→ reserve →
 * 单 Durable commit（映射+entries+marker）→ complete。completed 幂等不重查源/cwd，
 * 但返回前仍核定义一致；prepared 重试用冻结归档并复用 marker，绝不重复 append。
 * reserve 后归档/commit/complete 失败保留 outcome=unconfirmed（参数/身份冲突明确拒绝）。
 */
export async function importLegacySnapshot(host, harness, input, context) {
  const frozen = validateFrozenInput(input);
  if (frozen.requestId !== requestDigest(frozen.sourceKey, frozen.snapshotId, frozen.role, frozen.cwd, frozen.modelRef)) {
    throw invalidArgument('requestId does not match frozen definition');
  }

  const archivesRoot = archivesRootOf(host);
  const existing = host.getLegacyImport(frozen.sourceKey);
  if (existing) {
    if (existing.requestId !== frozen.requestId) throw conflict('requestId does not match reserved import');
    assertDefinitionMatches(existing, frozen);
    if (existing.phase === 'completed') return toLegacyStatus(existing, frozen.sourceKey);
  }

  let snapshot;
  let analysis;
  if (existing) {
    // prepared 重试：归档/回退 staging/最终分析/投影失败同样保留 unconfirmed（身份/参数冲突明确拒绝）。
    try {
      const archived = await tryLoadArchive(archivesRoot, frozen.snapshotId);
      if (archived) {
        snapshot = archived;
      } else {
        snapshot = await loadStagingSnapshot(host, frozen.snapshotId);
        analysis = await analyzeLegacySnapshot(snapshot);
        assertAnalysisSourceKey(analysis.sourceKey, frozen.sourceKey);
        validateRecordsProjection(analysis.records, archivesRoot, frozen.snapshotId, snapshot); // 发布前有效投影
        await publishArchive(archivesRoot, snapshot, frozen.snapshotId);
        snapshot = await requireArchive(archivesRoot, frozen.snapshotId);
      }
      // 投影/记录一律基于已验证永久 archive；prepared 内最终 analyze/投影错误保留 unconfirmed。
      analysis = await analyzeLegacySnapshot(snapshot);
      assertAnalysisSourceKey(analysis.sourceKey, frozen.sourceKey);
      validateRecordsProjection(analysis.records, archivesRoot, frozen.snapshotId, snapshot);
    } catch (err) {
      if (err && (err.code === 'REQUEST_CONFLICT' || err.code === 'INVALID_ARGUMENT' || err.code === 'BUSY')) throw err;
      throw unconfirmed(err);
    }
  } else {
    // 首次导入：确认目标 cwd 存在（prepared/completed 重试不依赖当前 cwd）。
    assertCwdExists(frozen.cwd);
    snapshot = await loadStagingSnapshot(host, frozen.snapshotId);
    analysis = await analyzeLegacySnapshot(snapshot);
    assertAnalysisSourceKey(analysis.sourceKey, frozen.sourceKey);
    validateRecordsProjection(analysis.records, archivesRoot, frozen.snapshotId, snapshot); // 发布前有效投影
    await publishArchive(archivesRoot, snapshot, frozen.snapshotId);
    snapshot = await requireArchive(archivesRoot, frozen.snapshotId);
    // 首次导入 reserve 前：最终归档分析/投影错误属普通错误（无未决状态）。
    analysis = await analyzeLegacySnapshot(snapshot);
    assertAnalysisSourceKey(analysis.sourceKey, frozen.sourceKey);
    validateRecordsProjection(analysis.records, archivesRoot, frozen.snapshotId, snapshot);
  }

  // registry reserve 分配稳定新 Bot/primary UUID（一次）；并发同定义幂等。
  const row = host.reserveLegacyImport({
    sourceKey: frozen.sourceKey,
    requestId: frozen.requestId,
    snapshotId: frozen.snapshotId,
    role: frozen.role,
    cwd: frozen.cwd,
    modelRef: frozen.modelRef,
  });

  try {
    await harness.commit(async (tx) => {
      const markers = await tx.doc(LegacyImportMarkers);
      const prior = markers.bySourceKey[frozen.sourceKey];
      if (prior !== undefined) {
        const primaryIndex = await tx.doc(PrimaryIndex);
        const expectedNativeId = primaryIndex.byPrimary[row.bot.primaryConversationId];
        if (!markerEquals(prior, frozen, row.bot, analysis.records.length, expectedNativeId)) {
          throw conflict('legacy import marker conflict');
        }
        return; // 已存在完整 marker：不 append、不 create。
      }
      const nativeId = await createPrimaryInTransaction(tx, row.bot, { defaultModel: frozen.modelRef });
      const entry = createLegacyEntry(frozen, row.bot, archivesRoot, frozen.snapshotId, snapshot);
      for (const record of analysis.records) {
        await tx.appendEntry(nativeId, entry(record));
      }
      markers.bySourceKey[frozen.sourceKey] = {
        version: 1,
        sourceKey: frozen.sourceKey,
        requestId: frozen.requestId,
        snapshotId: frozen.snapshotId,
        botId: row.bot.botId,
        primaryConversationId: row.bot.primaryConversationId,
        nativeId,
        recordCount: analysis.records.length,
      };
    }, context);
  } catch (err) {
    if (err && (err.code === 'REQUEST_CONFLICT' || err.code === 'INVALID_ARGUMENT')) throw err;
    throw unconfirmed(err);
  }

  let done;
  try {
    done = host.completeLegacyImport(frozen.sourceKey, frozen.requestId);
  } catch (err) {
    throw unconfirmed(err);
  }
  return toLegacyStatus(done, frozen.sourceKey);
}

/**
 * 草稿分页：仅 completed 行；只读归档 manifest + draft.txt + draft-attachments.json，
 * 不扫描 SDK；BOM 忽略解码，UTF-16 分页不拆代理对；≤50 附件/页映射永久绝对路径。
 */
export async function readLegacyDraft(host, input) {
  const d = validateDraftInput(input);
  const row = host.getLegacyImport(d.sourceKey);
  if (!row) throw invalidArgument('legacy import not found');
  if (row.requestId !== d.requestId) throw conflict('requestId does not match reserved import');
  if (row.phase !== 'completed') throw invalidArgument('legacy import is not completed');

  const archivesRoot = archivesRootOf(host);
  const manifest = await readArchiveManifest(archivesRoot, row.snapshotId);
  const archiveRoot = path.join(archivesRoot, row.snapshotId);
  const draftBuf = await readArchiveFile(manifest.fileRecords.get('draft.txt'));
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(draftBuf);
  const totalTextLength = text.length;
  if (d.textOffset > totalTextLength) {
    throw invalidArgument('textOffset exceeds total text length');
  }
  const start = d.textOffset;
  if (start > 0 && start < totalTextLength && isLowSurrogate(text.charCodeAt(start))) {
    throw invalidArgument('textOffset splits a surrogate pair');
  }
  let end = Math.min(start + DRAFT_TEXT_PAGE_UNITS, totalTextLength);
  if (end < totalTextLength && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  const pageText = text.slice(start, end);
  const nextTextOffset = end < totalTextLength ? end : null;

  const attachBuf = await readArchiveFile(manifest.fileRecords.get('draft-attachments.json'));
  const ids = parseDraftAttachmentIds(attachBuf);
  const totalAttachments = ids.length;
  if (d.attachmentOffset > totalAttachments) {
    throw invalidArgument('attachmentOffset exceeds total attachments');
  }
  const byId = new Map(manifest.attachments.map((a) => [a.id, a]));
  const pageIds = ids.slice(d.attachmentOffset, d.attachmentOffset + DRAFT_ATTACHMENTS_PAGE);
  const attachments = pageIds.map((item) => {
    const copy = byId.get(item.id);
    if (!copy) throw invalidSource('draft attachment reference missing');
    return {
      id: copy.id,
      name: copy.name,
      mimeType: copy.mimeType,
      kind: copy.kind,
      size: copy.size,
      path: path.join(archiveRoot, copy.path), // 永久绝对路径
      sourcePath: copy.sourcePath, // 仅 provenance
      sha256: copy.sha256,
    };
  });
  const nextAttachmentOffset = d.attachmentOffset + pageIds.length < totalAttachments
    ? d.attachmentOffset + pageIds.length
    : null;

  return {
    sourceKey: d.sourceKey,
    requestId: d.requestId,
    botId: row.bot.botId,
    snapshotId: row.snapshotId,
    text: pageText,
    textOffset: start,
    nextTextOffset,
    totalTextLength,
    attachments,
    attachmentOffset: d.attachmentOffset,
    nextAttachmentOffset,
    totalAttachments,
  };
}

function isLowSurrogate(unit) {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function parseDraftAttachmentIds(buf) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } catch {
    throw invalidSource('invalid draft attachments json');
  }
  if (!Array.isArray(parsed)) throw invalidSource('invalid draft attachments json');
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id) {
      throw invalidSource('invalid draft attachment descriptor');
    }
    out.push({ id: item.id });
  }
  return out;
}
