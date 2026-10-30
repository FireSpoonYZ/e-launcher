// 模块 6：Bot 主私聊实时投影的纯 helper。只读 ConversationView，不触发调度、不写记录，
// 不调用 Session；由 runtime-live.js 与传输/客户端消费。无新依赖。
//
// 安全窗口：仅投影文本与当前工具安全字段，不透传 raw docs、task memory、参数或签名。
// 性能：历史/消息均从最新向前扫描，找到上限即停止，不遍历/暂存全部原文。

const MAX_HISTORY_ENTRIES = 50; // 最新可显示条目数
const MAX_MESSAGES_PER_ENTRY = 8; // 每条目最多消息数（保留最新）
const MAX_MESSAGE_UNITS = 4096; // 单条消息文本上限（UTF-16 单元）
const MAX_TOTAL_TEXT_UNITS = 65536; // 历史窗口文本总上限，超限丢弃最旧整条
const MAX_GENERATION_UNITS = 32768; // 当前生成文本上限
const MAX_TOOLS = 32; // 工具槽总数上限（tools + nestedTools）
const MAX_TOOL_OUTPUT_UNITS = 4096; // 工具运行输出保留尾部上限

/**
 * 从 UTF-16 单元边界安全截断前缀，不拆分代理对。只读 max 附近的单元，
 * 不遍历巨型原文，也不使用 Array.from。
 */
function truncatePrefix(s, max) {
  if (s.length <= max) return { text: s, truncated: false };
  let end = max;
  const unit = s.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1; // 切在高代理后：回退一个单元
  return { text: s.slice(0, end), truncated: true };
}

/** 保留输出尾部 max 个 UTF-16 单元；窗口起点落在低代理上时前进避开。 */
function truncateTail(s, max) {
  if (s.length <= max) return { text: s, truncated: false };
  let start = s.length - max;
  const unit = s.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  return { text: s.slice(start), truncated: true };
}

/**
 * 抽取 content 中的 text 块并按换行连接；跳过 thinking/toolCall/image 等非文本块。
 * 单块可极大，累计到 cap 即截断并置 truncated，不保留超出部分。
 */
function textFromBlocks(content, cap) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
  let out = '';
  let len = 0;
  let truncated = false;
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    const sep = len > 0 ? 1 : 0;
    if (len + sep + block.text.length <= cap) {
      out += (sep ? '\n' : '') + block.text;
      len += sep + block.text.length;
    } else {
      const room = cap - len;
      if (room > sep) {
        const part = truncatePrefix(block.text, room - sep);
        out += (sep ? '\n' : '') + part.text;
      }
      truncated = true;
      break;
    }
  }
  return { text: out, truncated };
}

function toolCallsFromBlocks(content) {
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const block of content) {
    if (!block || block.type !== 'toolCall' || typeof block.name !== 'string' || block.name === '') continue;
    calls.push({
      callId: typeof block.id === 'string' ? block.id : '',
      name: block.name,
    });
    if (calls.length >= MAX_TOOLS) break;
  }
  return calls;
}

/** 投影一条消息；跳过 system/未知角色与无内容消息，只带文本和工具安全字段与时间戳。 */
function projectMessage(message) {
  const role = message?.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return null;
  const { text, truncated } = textFromBlocks(message.content, MAX_MESSAGE_UNITS);
  const toolCalls = role === 'assistant' ? toolCallsFromBlocks(message.content) : [];
  const hasToolResultIdentity =
    role === 'toolResult' &&
    ((typeof message.toolName === 'string' && message.toolName !== '') ||
      (typeof message.toolCallId === 'string' && message.toolCallId !== ''));
  const isAssistantError =
    role === 'assistant' &&
    (message.stopReason === 'error' || (typeof message.errorMessage === 'string' && message.errorMessage.trim() !== ''));

  if (text === '' && toolCalls.length === 0 && !hasToolResultIdentity && !isAssistantError) return null;

  const projected = { role, text, truncated };
  if (role === 'toolResult') {
    if (typeof message.toolName === 'string') projected.toolName = message.toolName;
    if (typeof message.toolCallId === 'string') projected.toolCallId = message.toolCallId;
    if (message.isError === true) projected.isError = true;
  } else if (role === 'assistant') {
    if (toolCalls.length > 0) projected.toolCalls = toolCalls;
    if (isAssistantError) projected.isError = true;
  }
  if (Number.isSafeInteger(message.timestamp) && message.timestamp >= 0) {
    projected.timestamp = message.timestamp;
  }
  if (Number.isSafeInteger(message.durationMs) && message.durationMs >= 0) {
    projected.durationMs = message.durationMs;
  }
  return projected;
}

/**
 * 投影一条条目：从最新向前保留最多 8 条可显示消息，遇到第 9 条即判定丢消息并停止，
 * 不遍历/暂存更旧消息。messagesDropped 由调用方置 historyTruncated 标示窗口不完整。
 * 无可显示消息则整条不可显示，返回 null。
 */
function projectEntry(entry) {
  const model = entry?.model ?? [];
  const messages = [];
  let seenMessages = 0;
  let messagesDropped = false;
  for (let i = model.length - 1; i >= 0; i--) {
    const projected = projectMessage(model[i]);
    if (!projected) continue;
    seenMessages++;
    if (seenMessages > MAX_MESSAGES_PER_ENTRY) {
      messagesDropped = true;
      break;
    }
    messages.unshift(projected);
  }
  if (messages.length === 0) return null;
  return { item: { id: entry.id, kind: entry.kind, messages }, messagesDropped };
}

function entryTextUnits(entry) {
  let units = 0;
  for (const message of entry.messages) units += message.text.length;
  return units;
}

/** 投影一个工具槽：只带安全字段，不带任务内存/details/参数/诊断。 */
function projectTool(slot) {
  const truncated = (slot.droppedBytes ?? 0) > 0 || (slot.droppedLines ?? 0) > 0;
  const tool = {
    callId: slot.callId,
    name: slot.name,
    status: slot.status,
    output: '',
    truncated,
    droppedBytes: slot.droppedBytes ?? 0,
    droppedLines: slot.droppedLines ?? 0,
  };
  if (typeof slot.parentCallId === 'string') tool.parentCallId = slot.parentCallId;
  if (typeof slot.entry === 'number') tool.entryId = slot.entry;
  if (typeof slot.output === 'string' && slot.output !== '') {
    const tail = truncateTail(slot.output, MAX_TOOL_OUTPUT_UNITS);
    tool.output = tail.text;
    if (tail.truncated) tool.truncated = true;
  }
  return tool;
}

/**
 * 投影当前生成：从 pi.live.generation.message 取文本块，限制 32768 单元。
 * 无 generation/message 时为 null。
 */
function projectGeneration(message) {
  const { text, truncated } = textFromBlocks(message.content, MAX_GENERATION_UNITS);
  return { text, truncated };
}

/** 初始空状态。 */
export function emptyLiveState() {
  return {
    history: [],
    historyTruncated: false,
    lastEntryId: null,
    generation: null,
    tools: [],
    toolsTruncated: false,
    busy: false,
    queuedCount: 0,
  };
}

/**
 * 从 ConversationView 投影实时状态。历史从最新向前累计，50 条可显示后遇到第 51 条即停；
 * 总文本超 65536 单元丢弃最旧整条并立即 break，保证窗口是连续最新段。工具仅映射
 * tools/nestedTools 前 32 个。busy 由 pi.live.run 存在决定，queuedCount 取 pi.inbox.items 长度。
 */
export function projectLiveState(view) {
  const live = view.docs?.['pi.live'] ?? null;
  const inbox = view.docs?.['pi.inbox'] ?? null;

  const entries = view.entries ?? [];
  const history = [];
  let usedUnits = 0;
  let seenDisplayable = 0;
  let lastEntryId = null;
  let historyTruncated = false;

  for (let i = entries.length - 1; i >= 0; i--) {
    const projected = projectEntry(entries[i]);
    if (!projected) continue;
    seenDisplayable++;
    if (seenDisplayable > MAX_HISTORY_ENTRIES) {
      historyTruncated = true;
      break;
    }
    if (lastEntryId === null) lastEntryId = projected.item.id;
    if (projected.messagesDropped) historyTruncated = true;
    const units = entryTextUnits(projected.item);
    if (units + usedUnits > MAX_TOTAL_TEXT_UNITS) {
      historyTruncated = true;
      break;
    }
    usedUnits += units;
    history.unshift(projected.item);
  }

  const generation = live?.generation?.message ? projectGeneration(live.generation.message) : null;

  const liveTools = live?.tools ?? [];
  const nestedTools = live?.nestedTools ?? [];
  const tools = [];
  const toolCount = Math.min(liveTools.length, MAX_TOOLS);
  for (let i = 0; i < toolCount; i++) tools.push(projectTool(liveTools[i]));
  const nestedCount = Math.min(nestedTools.length, MAX_TOOLS - tools.length);
  for (let i = 0; i < nestedCount; i++) tools.push(projectTool(nestedTools[i]));

  return {
    history,
    historyTruncated,
    lastEntryId,
    generation,
    tools,
    toolsTruncated: liveTools.length + nestedTools.length > MAX_TOOLS,
    busy: Boolean(live?.run),
    queuedCount: Array.isArray(inbox?.items) ? inbox.items.length : 0,
  };
}

const STATE_KEYS = [
  'history',
  'historyTruncated',
  'lastEntryId',
  'generation',
  'tools',
  'toolsTruncated',
  'busy',
  'queuedCount',
];

/**
 * 逐字段整体替换 diff：字段变化则以新值整体替换，无变化返回 null。
 * 固定有界字段 JSON 比较：所有字段由投影上限封顶且键序固定，结果确定。
 */
export function diffLiveState(previous, next) {
  const changes = {};
  for (const key of STATE_KEYS) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = next[key];
  }
  return Object.keys(changes).length === 0 ? null : changes;
}
