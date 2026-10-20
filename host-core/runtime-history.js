// 模块 2：Pi Durable 本机主私聊的只读 helper。
// 不启动调度、不写记录、不合成回答；由后续运行时集成 worker 调用。

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
  const { limit = DEFAULT_LIMIT, cursor } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalidArgument('limit must be an integer between 1 and 200');
  }
  const normalizedCursor = cursor ?? undefined;
  if (normalizedCursor !== undefined && (typeof normalizedCursor !== 'object' || Array.isArray(normalizedCursor))) {
    throw invalidArgument('cursor must be null or a plain object');
  }
  return { limit, cursor: normalizedCursor };
}

/**
 * 分页读取主私聊历史（最旧在前）。只读，不触发调度，不修改原文。
 */
export async function readPrimaryHistory(conversation, options = {}, context) {
  const { limit, cursor } = normalizeHistoryOptions(options);
  const page = await conversation.entries({ order: 'ascending' }, limit, cursor, context);
  return { items: page.items, nextCursor: page.next ?? null };
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
