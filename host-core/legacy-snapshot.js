// M16 legacy codec: read-only snapshot load + analysis.
// 不读写宿主运行时/数据库/设置，不创建 SDK 实例，不把旧消息投影为外部历史（由未来 importer 负责）。
// 错误一律固定简洁，不回显源正文；模块只用本地 staging 快照内的不可变副本。
import { createHash } from 'node:crypto';
import { open, readdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SNAPSHOT_VERSION = 1;
const APP_ID = 'com.example.launcherprobe';
const HEX64 = /^[0-9a-f]{64}$/;
// Java UUID.nameUUIDFromBytes(nodeId).toString()：连字符小写 UUID v3（36 字符）。
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMITS = Object.freeze({
  manifestBytes: 2097152,
  jsonFileBytes: 33554432, // history/contexts/ui/draft-attachments 与 draft.txt 共用
  attachmentFileBytes: 67108864,
  totalBytes: 268435456,
  files: 4096,
  historyNodes: 10000,
});
const MODEL_ROLES = new Set(['user', 'assistant', 'toolResult']);
const KIND_ALLOWED = new Set(['history', 'draft', 'draft-attachments', 'sdk', 'ui', 'attachment']);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}
const invalid = (message) => fail('INVALID_ARGUMENT', message);
const busied = (message) => fail('BUSY', message);
const invalidSource = (message) => fail('INVALID_SOURCE', message);
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

function fatalDecode(buf, label, ignoreBOM = false) {
  try {
    const decoder = ignoreBOM ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : FATAL_UTF8;
    return decoder.decode(buf);
  } catch {
    invalid('invalid ' + label + ' encoding');
  }
}

function parseJsonVerified(buf, label) {
  const text = fatalDecode(buf, label);
  try {
    return JSON.parse(text);
  } catch {
    invalid('invalid ' + label + ' json');
  }
}

/** Java UUID.nameUUIDFromBytes(nodeId)：MD5(UTF-8 nodeId) 按 RFC 4122 v3 格式化。 */
function nameUuidFromBytes(nodeId) {
  const digest = createHash('md5').update(Buffer.from(nodeId, 'utf8')).digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16)
    + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

async function readBounded(absPath, maxBytes, verify = {}) {
  let st0;
  try {
    st0 = await lstat(absPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') invalid('snapshot file missing');
    throw new Error('snapshot read failed');
  }
  if (st0.isSymbolicLink()) invalid('symlink in snapshot');
  if (!st0.isFile()) invalid('snapshot file is not a regular file');
  if (st0.size > maxBytes) invalid('snapshot file exceeds limit');
  let fh;
  try {
    fh = await open(absPath, 'r');
  } catch {
    throw new Error('snapshot read failed');
  }
  try {
    const first = await fh.stat();
    if (!first.isFile()) invalid('snapshot file is not a regular file');
    if (first.size > maxBytes) invalid('snapshot file exceeds limit');
    const buf = Buffer.allocUnsafe(first.size);
    let off = 0;
    while (off < first.size) {
      const { bytesRead } = await fh.read(buf, off, first.size - off, off);
      if (bytesRead <= 0) invalid('snapshot file read incomplete');
      off += bytesRead;
    }
    const after = await fh.stat();
    if (after.size !== first.size) invalid('snapshot file changed');
    if (verify.size !== undefined && after.size !== verify.size) invalid('file size mismatch');
    if (verify.sha256 !== undefined && sha256Hex(buf) !== verify.sha256) invalid('file digest mismatch');
    return buf;
  } finally {
    await fh.close();
  }
}

async function readdirChecked(dir) {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') invalid('snapshot directory missing');
    throw new Error('snapshot read failed');
  }
  return items;
}

/** 只允许根下 manifest/history/draft 固定文件与 contexts/ui/attachments 一层规范目录（深度 ≤2）。 */
async function enumerateSnapshot(root) {
  const out = new Map();
  const topFiles = new Set(['manifest.json', 'history.json', 'draft.txt', 'draft-attachments.json']);
  const topDirs = new Set(['contexts', 'ui', 'attachments']);
  const seenDirs = new Set();
  const items = await readdirChecked(root);
  for (const item of items) {
    if (item.isSymbolicLink()) invalid('symlink in snapshot');
    if (item.isDirectory()) {
      const dir = item.name;
      if (!topDirs.has(dir)) invalid('unexpected directory in snapshot');
      if (seenDirs.has(dir)) invalid('duplicate snapshot directory');
      seenDirs.add(dir);
      const children = await readdirChecked(join(root, dir));
      for (const child of children) {
        if (child.isSymbolicLink()) invalid('symlink in snapshot');
        if (child.isDirectory()) invalid('snapshot layout too deep');
        if (!child.isFile()) invalid('unexpected snapshot entry');
        if (out.size + 1 > LIMITS.files) invalid('snapshot exceeds file limit');
        const rel = dir + '/' + child.name;
        if (out.has(rel)) invalid('duplicate snapshot path');
        out.set(rel, join(root, dir, child.name));
      }
    } else if (item.isFile()) {
      if (!topFiles.has(item.name)) invalid('unexpected file in snapshot');
      if (out.size + 1 > LIMITS.files) invalid('snapshot exceeds file limit');
      if (out.has(item.name)) invalid('duplicate snapshot path');
      out.set(item.name, join(root, item.name));
    } else {
      invalid('unexpected snapshot entry');
    }
  }
  return out;
}

function validRelPath(p) {
  const parts = p.split('/');
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function fileKindPath(kind, path) {
  switch (kind) {
    case 'history': return path === 'history.json';
    case 'draft': return path === 'draft.txt';
    case 'draft-attachments': return path === 'draft-attachments.json';
    case 'sdk': return /^contexts\/[0-9a-f-]{36}\.json$/.test(path);
    case 'ui': return /^ui\/[0-9a-f-]{36}\.json$/.test(path);
    case 'attachment': return /^attachments\/[0-9a-f]{64}$/.test(path);
    default: return false;
  }
}

function limitForKind(kind) {
  if (kind === 'attachment') return LIMITS.attachmentFileBytes;
  return LIMITS.jsonFileBytes;
}

function validateEmbeddedAttachment(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) invalid('invalid attachment descriptor');
  if (typeof a.id !== 'string' || !a.id) invalid('invalid attachment id');
  if (typeof a.path !== 'string' || !a.path) invalid('invalid attachment path');
}

function validateChatMessage(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid('invalid history message');
  if (typeof v.role !== 'string' || !v.role) invalid('invalid history message');
  if ('content' in v && v.content !== null && typeof v.content !== 'string') invalid('invalid history content');
  if ('tool_call_id' in v && typeof v.tool_call_id !== 'string') invalid('invalid tool call id');
  if (v.attachments !== undefined) {
    if (!Array.isArray(v.attachments)) invalid('invalid history attachments');
    for (const a of v.attachments) validateEmbeddedAttachment(a);
  }
  if (v.tool_calls !== undefined) {
    if (!Array.isArray(v.tool_calls)) invalid('invalid history tool calls');
    for (const c of v.tool_calls) {
      if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.id !== 'string' || typeof c.name !== 'string') {
        invalid('invalid history tool call');
      }
      if ('arguments' in c && typeof c.arguments !== 'string') invalid('invalid tool call arguments');
    }
  }
  return v;
}

function assertAcyclic(nodes, getId, getParent, byId, cycleMessage) {
  const state = new Map(); // 1=visiting, 2=done
  const chain = [];
  for (const node of nodes) {
    let cur = node;
    while (cur) {
      const id = getId(cur);
      const s = state.get(id);
      if (s === 2) break;
      if (s === 1) invalid(cycleMessage);
      state.set(id, 1);
      chain.push(id);
      const pid = getParent(cur);
      cur = pid == null ? null : byId.get(pid);
    }
    for (const id of chain) state.set(id, 2);
    chain.length = 0;
  }
}

function parseHistory(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid('invalid history json');
  }
  if (Array.isArray(parsed)) {
    if (parsed.length > LIMITS.historyNodes) invalid('history exceeds node limit');
    const nodes = parsed.map((v, i) => ({
      id: 'legacy-node-' + i,
      parentId: i === 0 ? null : 'legacy-node-' + (i - 1),
      arrayIndex: i,
      originalId: null,
      message: validateChatMessage(v),
    }));
    return { legacy: true, nodes, leaf: nodes.length ? 'legacy-node-' + (nodes.length - 1) : null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('invalid history json');
  if (parsed.version !== 1) invalid('unknown history version');
  const arr = parsed.nodes;
  if (!Array.isArray(arr)) invalid('invalid history envelope');
  if (arr.length > LIMITS.historyNodes) invalid('history exceeds node limit');
  const nodes = [];
  const byId = new Map();
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!v || typeof v !== 'object' || Array.isArray(v)) invalid('invalid history node');
    if (typeof v.id !== 'string' || !v.id) invalid('invalid history node id');
    if (byId.has(v.id)) invalid('duplicate history node');
    const parentId = v.parent_id == null ? null : v.parent_id;
    if (parentId !== null && typeof parentId !== 'string') invalid('invalid history parent');
    nodes.push({ id: v.id, parentId, arrayIndex: i, originalId: v.id, message: validateChatMessage(v) });
    byId.set(v.id, nodes[i]);
  }
  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) invalid('orphan history node');
  }
  assertAcyclic(nodes, (n) => n.id, (n) => n.parentId, byId, 'history parent cycle');
  const leaf = parsed.leaf == null ? null : parsed.leaf;
  if (leaf === null) {
    if (nodes.length) invalid('history leaf missing');
  } else if (typeof leaf !== 'string' || !byId.has(leaf)) {
    invalid('history leaf missing');
  }
  return { legacy: false, nodes, leaf };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) invalid('invalid manifest');
  if (manifest.version !== SNAPSHOT_VERSION) invalid('unsupported manifest version');
  const source = manifest.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) invalid('invalid source');
  if (source.kind !== 'android-chat') invalid('invalid source kind');
  if (source.applicationId !== APP_ID) invalid('invalid application id');
  if (typeof source.conversationId !== 'string' || !source.conversationId) invalid('invalid conversation id');
  if (source.title !== null && typeof source.title !== 'string') invalid('invalid conversation title');
  for (const key of ['createdAt', 'updatedAt', 'archivedAt']) {
    if (source[key] != null && typeof source[key] !== 'number') invalid('invalid source timestamp');
  }
  if (typeof source.draftOnly !== 'boolean') invalid('invalid draftOnly');
  let modelSelection = null;
  if (source.modelSelection != null) {
    if (typeof source.modelSelection !== 'object' || Array.isArray(source.modelSelection)) invalid('invalid model selection');
    if (typeof source.modelSelection.provider !== 'string' || typeof source.modelSelection.model !== 'string') {
      invalid('invalid model selection');
    }
    const thinkingLevel = source.modelSelection.thinkingLevel;
    if (thinkingLevel !== undefined && thinkingLevel !== null && typeof thinkingLevel !== 'string') invalid('invalid model selection');
    modelSelection = { provider: source.modelSelection.provider, model: source.modelSelection.model, thinkingLevel: thinkingLevel ?? null };
  }

  const nativeNodes = [];
  if (!Array.isArray(manifest.nativeNodes)) invalid('invalid native nodes');
  const nativeSet = new Set();
  for (const id of manifest.nativeNodes) {
    if (typeof id !== 'string' || !id || nativeSet.has(id)) invalid('invalid native nodes');
    nativeSet.add(id);
    nativeNodes.push(id);
  }
  const pendingUserIds = [];
  if (!Array.isArray(manifest.pendingUserIds)) invalid('invalid pending user ids');
  const pendingSet = new Set();
  for (const id of manifest.pendingUserIds) {
    if (typeof id !== 'string' || !id || pendingSet.has(id)) invalid('invalid pending user ids');
    pendingSet.add(id);
    pendingUserIds.push(id);
  }

  if (!Array.isArray(manifest.files)) invalid('invalid manifest files');
  if (manifest.files.length + 1 > LIMITS.files) invalid('snapshot exceeds file limit');
  const files = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('invalid manifest file entry');
    if (typeof entry.kind !== 'string' || !KIND_ALLOWED.has(entry.kind)) invalid('invalid manifest file kind');
    if (typeof entry.path !== 'string' || !validRelPath(entry.path) || !fileKindPath(entry.kind, entry.path)) {
      invalid('invalid manifest file path');
    }
    if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) invalid('invalid manifest file size');
    if (entry.size > limitForKind(entry.kind)) invalid('snapshot file exceeds limit');
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) invalid('invalid manifest file digest');
    if (entry.kind === 'attachment' && entry.path !== 'attachments/' + entry.sha256) invalid('invalid manifest file path');
    if (entry.kind === 'sdk' || entry.kind === 'ui') {
      if (typeof entry.nodeId !== 'string' || !entry.nodeId) invalid('invalid manifest node id');
      const base = entry.path.slice(entry.path.indexOf('/') + 1, -5);
      if (!UUID_SHAPE.test(base) || base !== nameUuidFromBytes(entry.nodeId)) invalid('invalid manifest node id');
    }
    if (files.has(entry.path)) invalid('duplicate manifest file');
    files.set(entry.path, entry);
  }
  for (const required of ['history.json', 'draft.txt', 'draft-attachments.json']) {
    if (!files.has(required)) invalid('missing manifest file');
  }

  if (!Array.isArray(manifest.attachments)) invalid('invalid attachments');
  const attachments = [];
  const idsSeen = new Set();
  const referencedFiles = new Set();
  for (const item of manifest.attachments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('invalid attachment descriptor');
    const id = item.id;
    if (typeof id !== 'string' || !id || /[/\\]/.test(id) || id === '.' || id === '..') invalid('invalid attachment id');
    if (idsSeen.has(id)) invalid('duplicate attachment id');
    idsSeen.add(id);
    const size = item.size === undefined ? 0 : item.size;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) invalid('invalid attachment size');
    const kind = typeof item.kind === 'string' ? item.kind : 'file';
    if (kind !== 'image' && kind !== 'file') invalid('invalid attachment kind');
    if (typeof item.sha256 !== 'string' || !HEX64.test(item.sha256)) invalid('invalid attachment digest');
    const path = item.path;
    if (typeof path !== 'string' || path !== 'attachments/' + item.sha256) invalid('invalid attachment path');
    if (typeof item.sourcePath !== 'string' || item.sourcePath !== 'chat-attachments/' + id) invalid('attachment source path invalid');
    const meta = files.get(path);
    if (!meta || meta.kind !== 'attachment' || meta.sha256 !== item.sha256 || meta.size !== size) {
      invalid('attachment file missing');
    }
    referencedFiles.add(path);
    attachments.push({
      id,
      name: typeof item.name === 'string' ? item.name : '附件',
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream',
      kind,
      size,
      sha256: item.sha256,
      path,
      sourcePath: item.sourcePath,
    });
  }
  for (const meta of files.values()) {
    if (meta.kind === 'attachment' && !referencedFiles.has(meta.path)) invalid('unreferenced attachment file');
  }

  return {
    source: {
      kind: source.kind,
      applicationId: source.applicationId,
      conversationId: source.conversationId,
      title: source.title ?? null,
      createdAt: source.createdAt ?? null,
      updatedAt: source.updatedAt ?? null,
      archivedAt: source.archivedAt ?? null,
      draftOnly: source.draftOnly,
      modelSelection,
    },
    nativeNodes,
    pendingUserIds,
    files,
    attachments,
  };
}

/**
 * 有界读取单个已验证 fileRecord，返回原始 Buffer；非附件文件统一 fatal UTF-8 校验。
 * 仅内部使用（契约 codec.fileReader），不暴露为任意路径用户 API。
 */
export async function readLegacyFile(fileRecord) {
  if (!fileRecord || typeof fileRecord !== 'object' || typeof fileRecord.absPath !== 'string'
      || typeof fileRecord.kind !== 'string' || !KIND_ALLOWED.has(fileRecord.kind)
      || typeof fileRecord.size !== 'number' || !Number.isInteger(fileRecord.size) || fileRecord.size < 0
      || typeof fileRecord.sha256 !== 'string' || !HEX64.test(fileRecord.sha256)) {
    invalid('invalid file record');
  }
  // 打开前核所有已知父目录（stagingRoot/snapshotRoot/即时子目录）：必须是真实目录且非 symlink。
  // 由 relPath 结构推导根层次，不携带额外 root 字段、不改 manifest 原 bytes/相对 path。
  const chain = [dirname(fileRecord.absPath)];
  if (fileRecord.relPath.includes('/')) chain.push(dirname(chain[0]));
  chain.push(dirname(chain[chain.length - 1]));
  for (const parent of chain) {
    let parentStat;
    try {
      parentStat = await lstat(parent);
    } catch {
      invalid('snapshot directory missing');
    }
    if (parentStat.isSymbolicLink()) invalid('symlink in snapshot');
    if (!parentStat.isDirectory()) invalid('snapshot directory missing');
  }
  const buf = await readBounded(fileRecord.absPath, limitForKind(fileRecord.kind),
    { size: fileRecord.size, sha256: fileRecord.sha256 });
  if (fileRecord.kind !== 'attachment') {
    try {
      FATAL_UTF8.decode(buf);
    } catch {
      invalid('invalid snapshot file encoding');
    }
  }
  return buf;
}

/**
 * 契约 codec.manifestReader：仅校验根目录、manifest 字节 SHA、形状/路径/声明预算，
 * 不证明文件内容。返回 {root,snapshotId,manifest,manifestBytes,source,nativeNodes:Set,
 * pendingUserIds:Set,fileRecords:Map,contexts:Map,ui:Map,attachments}。
 */
export async function readLegacyManifest(parentRoot, snapshotId) {
  if (typeof parentRoot !== 'string' || typeof snapshotId !== 'string' || !HEX64.test(snapshotId)) {
    invalid('invalid snapshot id');
  }
  let stagingStat;
  try {
    stagingStat = await lstat(parentRoot);
  } catch {
    invalid('snapshot directory missing');
  }
  if (stagingStat.isSymbolicLink()) invalid('symlink in snapshot');
  if (!stagingStat.isDirectory()) invalid('snapshot directory missing');
  const root = join(parentRoot, snapshotId);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    invalid('snapshot directory missing');
  }
  if (rootStat.isSymbolicLink()) invalid('symlink in snapshot');
  if (!rootStat.isDirectory()) invalid('snapshot directory missing');

  const entries = await enumerateSnapshot(root);
  const manifestRel = 'manifest.json';
  if (!entries.has(manifestRel)) invalid('manifest not found');
  const manifestBuf = await readBounded(entries.get(manifestRel), LIMITS.manifestBytes);
  if (sha256Hex(manifestBuf) !== snapshotId) invalid('manifest hash mismatch');
  const manifestJson = parseJsonVerified(manifestBuf, 'manifest');
  const manifest = validateManifest(manifestJson);

  const expected = new Set([manifestRel]);
  let totalBytes = manifestBuf.length;
  for (const meta of manifest.files.values()) {
    expected.add(meta.path);
    totalBytes += meta.size;
  }
  if (totalBytes > LIMITS.totalBytes) invalid('snapshot exceeds total bytes');
  for (const rel of entries.keys()) {
    if (!expected.has(rel)) invalid('unexpected file in snapshot');
  }
  for (const rel of expected) {
    if (!entries.has(rel)) invalid('snapshot file missing');
  }

  const fileRecords = new Map();
  const contexts = new Map();
  const ui = new Map();
  for (const meta of manifest.files.values()) {
    const record = { relPath: meta.path, absPath: entries.get(meta.path), kind: meta.kind, size: meta.size, sha256: meta.sha256, nodeId: meta.nodeId ?? null };
    fileRecords.set(meta.path, record);
    if (meta.kind === 'sdk') {
      if (contexts.has(meta.nodeId)) invalid('duplicate manifest node id');
      contexts.set(meta.nodeId, record);
    }
    if (meta.kind === 'ui') {
      if (ui.has(meta.nodeId)) invalid('duplicate manifest node id');
      ui.set(meta.nodeId, record);
    }
  }

  return {
    root,
    snapshotId,
    manifest: manifestJson,
    manifestBytes: manifestBuf,
    source: manifest.source,
    nativeNodes: new Set(manifest.nativeNodes),
    pendingUserIds: new Set(manifest.pendingUserIds),
    fileRecords,
    contexts,
    ui,
    attachments: manifest.attachments,
  };
}

/** 完整加载：目录/文件清单来自 readLegacyManifest，每个文件经 readLegacyFile 核实。 */
export async function loadLegacySnapshot(stagingRoot, snapshotId) {
  const loaded = await readLegacyManifest(stagingRoot, snapshotId);
  const verifiedText = new Map(); // history.json/draft.txt/draft-attachments.json 已核字节
  for (const record of loaded.fileRecords.values()) {
    const buf = await readLegacyFile(record);
    if (record.relPath === 'history.json' || record.relPath === 'draft.txt' || record.relPath === 'draft-attachments.json') {
      verifiedText.set(record.relPath, buf);
    }
  }

  const historyRaw = fatalDecode(verifiedText.get('history.json'), 'history');
  const history = parseHistory(historyRaw === '' ? '[]' : historyRaw);
  const draftText = fatalDecode(verifiedText.get('draft.txt'), 'draft', true); // 保留 BOM 字节，decode 忽略
  const draftAttachments = (() => {
    const raw = fatalDecode(verifiedText.get('draft-attachments.json'), 'draft attachments');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalid('invalid draft attachments json');
    }
    if (!Array.isArray(parsed)) invalid('invalid draft attachments json');
    const out = [];
    for (const item of parsed) {
      validateEmbeddedAttachment(item);
      out.push(item);
    }
    return out;
  })();

  // 逐条核 history/draft 中的附件 id 都有匹配副本（manifest.attachments）。
  const attachmentById = new Map(loaded.attachments.map((d) => [d.id, d]));
  const referencedIds = new Set();
  for (const node of history.nodes) {
    const list = node.message.attachments;
    if (Array.isArray(list)) for (const a of list) referencedIds.add(a.id);
  }
  for (const a of draftAttachments) referencedIds.add(a.id);
  for (const id of referencedIds) {
    if (!attachmentById.has(id)) invalid('attachment reference missing');
  }
  // 派生草稿返回副本描述符（staging 内路径），不用旧绝对路径。
  const draftDescriptorAttachments = draftAttachments.map((a) => {
    const copy = attachmentById.get(a.id);
    return { id: copy.id, name: copy.name, mimeType: copy.mimeType, kind: copy.kind, size: copy.size, path: copy.path, sourcePath: copy.sourcePath };
  });

  return {
    root: loaded.root,
    snapshotId: loaded.snapshotId,
    manifest: loaded.manifest,
    manifestBytes: loaded.manifestBytes,
    source: loaded.source,
    nativeNodes: loaded.nativeNodes,
    pendingUserIds: loaded.pendingUserIds,
    fileRecords: loaded.fileRecords,
    contexts: loaded.contexts,
    ui: loaded.ui,
    historyRaw,
    history,
    draftText,
    draftAttachments: draftDescriptorAttachments,
    attachments: loaded.attachments,
  };
}

function selectedPath(history) {
  const byId = new Map(history.nodes.map((node) => [node.id, node]));
  const path = [];
  let current = history.leaf == null ? null : byId.get(history.leaf);
  while (current) {
    path.push(current);
    current = current.parentId == null ? null : byId.get(current.parentId);
  }
  path.reverse();
  return path;
}

function normalizeSdk(array) {
  if (!Array.isArray(array)) invalidSource('invalid SDK snapshot contents');
  const sessions = array.filter((e) => e && typeof e === 'object' && e.type === 'session');
  if (sessions.length > 1) invalidSource('invalid SDK snapshot contents');
  if (sessions.length === 0) {
    const entries = array.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.role !== 'string' || !item.role) {
        invalidSource('invalid SDK message entry');
      }
      return { index: i, id: 'sdk-msg-' + i, parentId: i === 0 ? null : 'sdk-msg-' + (i - 1), type: 'message', raw: item, originalId: null };
    });
    return { version: 0, entries };
  }
  // header 必须首项且唯一。
  if (array[0] !== sessions[0]) invalidSource('invalid SDK snapshot contents');
  const header = sessions[0];
  const version = header.version === undefined ? 1 : header.version;
  if (!Number.isInteger(version) || version < 1 || version > 3) invalidSource('unsupported SDK snapshot version');
  if (typeof header.id !== 'string' || !header.id) invalidSource('invalid SDK session id');
  const entries = [];
  for (let i = 1; i < array.length; i++) {
    const e = array[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) invalidSource('invalid SDK snapshot contents');
    if (e.type === 'session') invalidSource('invalid SDK snapshot contents');
    if (typeof e.type !== 'string' || !e.type) invalidSource('invalid SDK entry');
    let id;
    let parentId;
    let originalId = null;
    if (version < 2) {
      // v1 迁移语义：线性父链；内部一律按索引确定性编号，原 id 仅作 provenance，不混入编号空间。
      id = 'sdk-node-' + entries.length;
      parentId = entries.length === 0 ? null : entries[entries.length - 1].id;
      if (typeof e.id === 'string' && e.id) originalId = e.id;
    } else {
      if (typeof e.id !== 'string' || !e.id) invalidSource('SDK entry missing id');
      id = e.id;
      originalId = e.id;
      parentId = e.parentId === undefined ? null : e.parentId;
      if (parentId !== null && typeof parentId !== 'string') invalidSource('invalid SDK parent id');
    }
    entries.push({ index: i, id, parentId, type: e.type, raw: e, originalId });
  }
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) invalidSource('duplicate SDK entry id');
    seen.add(entry.id);
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) invalidSource('SDK parent missing');
  }
  assertAcyclic(entries, (e) => e.id, (e) => e.parentId, byId, 'SDK parent cycle');
  return { version, entries };
}

function sdkLineage(entries) {
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const leaf = entries[entries.length - 1];
  const path = [];
  let cur = leaf;
  while (cur) {
    path.push(cur);
    cur = cur.parentId == null ? null : byId.get(cur.parentId);
  }
  path.reverse();
  return path;
}

/**
 * 分析已加载快照：按 ChatStore.piResume 逆向选择最近 SDK 快照血缘。
 * 纯只读；records 的 file 指向 staging 内不可变副本。async：选中上下文用 bounded/hash reader 重读。
 */
export async function analyzeLegacySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) invalid('invalid snapshot');
  const path = selectedPath(snapshot.history);

  // 匹配必须用原节点 ID；legacy 内部索引节点（无原 ID）不参与 pending/native/context 关联。
  const pending = path.find((node) => node.originalId != null && snapshot.pendingUserIds.has(node.originalId));
  if (pending) busied('selected node has pending Pi turn');

  let contextMeta = null;
  let cut = -1;
  let earlyMissing = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    if (node.originalId == null) continue;
    if (snapshot.contexts.has(node.originalId)) {
      contextMeta = snapshot.contexts.get(node.originalId);
      cut = i;
      break;
    }
    if (snapshot.nativeNodes.has(node.originalId)) invalidSource('missing SDK snapshot for selected native node');
  }
  if (cut >= 0) {
    for (let i = cut - 1; i >= 0; i--) {
      const node = path[i];
      if (node.originalId != null && snapshot.nativeNodes.has(node.originalId)
          && !snapshot.contexts.has(node.originalId)) earlyMissing++;
    }
  }

  const records = [];
  const warnings = [];
  let sdkEntries = 0;

  const pushChatRecord = (node) => {
    if (node.message.role === 'system') return;
    const source = { file: 'history.json', index: node.arrayIndex };
    if (node.originalId != null) source.nodeId = node.originalId;
    records.push({ source, role: node.message.role, message: structuredClone(node.message) });
  };

  if (contextMeta) {
    const buf = await readLegacyFile(contextMeta);
    const array = parseJsonVerified(buf, 'sdk');
    const normalized = normalizeSdk(array);
    sdkEntries = normalized.entries.length;
    const lineage = sdkLineage(normalized.entries);
    const ownerNode = path[cut];
    let omittedNonMessage = 0;
    for (const entry of lineage) {
      let msg;
      if (normalized.version === 0) {
        // raw Message[]：每一项本身就是消息对象（无入口包装）。
        msg = entry.raw;
      } else {
        if (entry.type !== 'message') {
          omittedNonMessage++;
          continue;
        }
        msg = entry.raw && typeof entry.raw === 'object' ? entry.raw.message : undefined;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string' || !msg.role) {
        invalidSource('invalid SDK message entry');
      }
      if (!MODEL_ROLES.has(msg.role)) {
        omittedNonMessage++;
        continue;
      }
      const source = { file: contextMeta.relPath, index: entry.index };
      if (normalized.version !== 0 && entry.originalId != null) source.entryId = entry.originalId;
      if (ownerNode.originalId != null) source.nodeId = ownerNode.originalId;
      records.push({ source, role: msg.role, message: structuredClone(msg) });
    }
    if (omittedNonMessage > 0) warnings.push({ code: 'omitted-sdk-non-message', count: omittedNonMessage });
    for (let j = cut + 1; j < path.length; j++) pushChatRecord(path[j]);
  } else {
    warnings.push({ code: 'no-sdk-lineage' });
    for (const node of path) pushChatRecord(node);
  }

  if (earlyMissing > 0) warnings.push({ code: 'missing-native-snapshot-archived', count: earlyMissing });
  const archivedContexts = snapshot.contexts.size - (contextMeta ? 1 : 0);
  if (archivedContexts > 0) warnings.push({ code: 'archived-contexts', count: archivedContexts });
  if (snapshot.ui.size > 0) warnings.push({ code: 'archived-ui-questionnaires', count: snapshot.ui.size });

  return {
    sourceKey: 'android-chat:' + snapshot.source.conversationId,
    snapshotId: snapshot.snapshotId,
    source: snapshot.source,
    // legacy 数组无原节点 ID，只暴露 null；内部索引仍用于选路。
    selectedLeafId: snapshot.history.legacy ? null : snapshot.history.leaf,
    records,
    draft: { text: snapshot.draftText, attachments: snapshot.draftAttachments },
    counts: {
      nodes: snapshot.history.nodes.length,
      selectedNodes: path.length,
      sdkEntries,
      contextRecords: records.length,
      attachments: snapshot.attachments.length,
    },
    warnings,
  };
}
