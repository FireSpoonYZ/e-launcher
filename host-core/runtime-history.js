// 模块 2：Pi Durable 本机主私聊的只读 helper。
// 不启动调度、不写记录、不合成回答；由后续运行时集成 worker 调用。
import { ResetEntry, StorageRequestError } from '@earendil-works/pi-durable';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RESET_KIND = ResetEntry.kind;
const RESET_SCAN_LIMIT = 200;
// 给 JSON/IPC 信封留出空间；历史总量和单条记录没有这个大小限制。
const TRANSFER_PAGE_BYTES = 256 * 1024;
const ENTRY_CHUNK_UNITS = 64 * 1024;
const CHUNK_CURSOR_KIND = 'history-entry-chunk';

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

/**
 * 校验并规范化分页选项：limit 默认 50，须为 1..200 的整数；cursor 省略/null 或普通非数组对象，
 * 否则 INVALID_ARGUMENT。供运行时 history 与 readPrimaryHistory 共用。
 */
export function normalizeHistoryOptions(options = {}) {
  const { limit = DEFAULT_LIMIT, cursor, chunked } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalidArgument('limit must be an integer between 1 and 200');
  }
  const normalizedCursor = cursor ?? undefined;
  if (normalizedCursor !== undefined && (typeof normalizedCursor !== 'object' || Array.isArray(normalizedCursor))) {
    throw invalidArgument('cursor must be null or a plain object');
  }
  if (chunked !== undefined && typeof chunked !== 'boolean') {
    throw invalidArgument('chunked must be a boolean');
  }
  return { limit, cursor: normalizedCursor, ...(chunked ? { chunked: true } : {}) };
}

/**
 * 最近一次 pi.reset 之后的可见历史起点；无 reset 返回 0。清空用 reset 保留原始回执条目，
 * 因此只在读取时按 reset 裁剪，不动存储。倒序沿 cursor 扫到 reset 或历史起点，不设页数上限，
 * 否则更早的 reset 之前的历史会在清空后重新出现。
 */
async function latestResetEntryId(conversation, context) {
  let cursor;
  for (;;) {
    const result = await conversation.entries({ order: 'descending' }, RESET_SCAN_LIMIT, cursor, context);
    const reset = result.items.find((entry) => entry.kind === RESET_KIND);
    if (reset) return reset.id;
    if (!result.next) return 0;
    cursor = result.next;
  }
}

/**
 * 分页读取主私聊历史（最旧在前）。只读，不触发调度，不修改原文。
 * afterReset 为真时从最近一次 pi.reset 之后开始（主私聊可见历史）；work 历史不传该选项。
 */
export async function readPrimaryHistory(conversation, options = {}, context, { afterReset = false } = {}) {
  const { limit, cursor, chunked } = normalizeHistoryOptions(options);
  const continuation = chunked && cursor?.kind === CHUNK_CURSOR_KIND ? cursor : null;
  if (continuation && (
    !Number.isSafeInteger(continuation.entryId) || continuation.entryId <= 0 ||
    !Number.isSafeInteger(continuation.offset) || continuation.offset < 0 ||
    (continuation.position !== null && (typeof continuation.position !== 'object' || Array.isArray(continuation.position)))
  )) {
    throw invalidArgument('invalid history chunk cursor');
  }
  const position = continuation ? continuation.position ?? undefined : cursor;
  try {
    const resetId = afterReset ? await latestResetEntryId(conversation, context) : 0;
    const query = resetId > 0 ? { order: 'ascending', minEntryId: resetId + 1 } : { order: 'ascending' };
    const read = (count) => conversation.entries(query, count, position, context);
    let page = await read(continuation ? 1 : limit);
    if (!chunked) return { items: page.items, nextCursor: page.next ?? null };

    if (continuation && page.items[0]?.id !== continuation.entryId) {
      throw invalidArgument('history chunk entry is no longer visible');
    }
    if (!continuation) {
      let count = 0;
      let bytes = 0;
      for (const entry of page.items) {
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
        if (bytes > TRANSFER_PAGE_BYTES) break;
        count++;
      }
      if (count > 0 || page.items.length === 0) {
        // 重读实际返回的前缀，取得 SDK 的精确游标，不跳过放不下的条目。
        if (count < page.items.length) page = await read(count);
        return { items: page.items, nextCursor: page.next ?? null };
      }
      if (page.items.length > 1) page = await read(1);
    }
    const entry = page.items[0];
    const json = JSON.stringify(entry);
    const offset = continuation?.offset ?? 0;
    const firstUnit = json.charCodeAt(offset);
    if (offset >= json.length || (firstUnit >= 0xdc00 && firstUnit <= 0xdfff)) {
      throw invalidArgument('history chunk offset is not a valid character boundary');
    }
    let end = Math.min(offset + ENTRY_CHUNK_UNITS, json.length);
    // 每片都须能独立通过 UTF-8/Rust 桥接，不能把 emoji 的代理对拆开。
    const lastUnit = json.charCodeAt(end - 1);
    if (end < json.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) end--;
    const complete = end === json.length;
    return {
      items: [],
      entryChunk: { entryId: entry.id, offset, json: json.slice(offset, end), complete },
      nextCursor: complete ? page.next ?? null : {
        kind: CHUNK_CURSOR_KIND, position: position ?? null, entryId: entry.id, offset: end,
      },
    };
  } catch (err) {
    // SDK 1.3.0 没有细分游标错误码，不能把其余 StorageRequestError 当成参数错误。
    if (err instanceof StorageRequestError && (
      err.message === 'Invalid storage cursor' ||
      err.message === 'The cursor continues a descending scan; the query asks for ascending'
    )) {
      throw invalidArgument(err.message);
    }
    throw err;
  }
}

/** 把 Durable 提交记录格式化为 PrimarySubmission；conversationId 用公开 UUID。 */
export async function formatPrimarySubmission(harness, bot, record, context) {
  let answerText = null;
  let reason = null;
  if (record.status === 'unanswered') {
    reason = record.reason;
  } else if (record.status === 'done' && record.type === 'input') {
    const entry = await harness.commit((tx) => tx.entry(record.answer), context);
    answerText = assistantText(entry);
  }
  return {
    botId: bot.botId,
    conversationId: bot.primaryConversationId,
    requestId: record.requestId ?? null,
    submissionId: record.id,
    status: record.status,
    answerText,
    reason,
  };
}

/** assistant 消息的 text 块按换行连接；无文字为 ''，忽略 thinking 与 toolCall。 */
function assistantText(entry) {
  const texts = [];
  for (const message of entry?.model ?? []) {
    if (message?.role !== 'assistant') continue;
    for (const block of message.content ?? []) {
      if (block?.type === 'text') texts.push(block.text);
    }
  }
  return texts.join('\n');
}
