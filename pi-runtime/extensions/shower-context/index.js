/**
 * Pi 0.85.1 fires `context` with a deep copy before each model call.
 * Only that copy is rewritten; session entries and attachments stay as stored.
 */
const omitted = "[历史截图已省略，仅保留最新截图]";

function callAction(part) {
  if (part?.type !== "toolCall" || part.name !== "shower") return undefined;
  const args = part.arguments;
  if (typeof args === "string") {
    try { return JSON.parse(args)?.action; } catch { return undefined; }
  }
  return args && typeof args === "object" ? args.action : undefined;
}

function screenshotCallIds(messages) {
  const ids = new Set();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (callAction(part) === "screenshot" && part.id) ids.add(part.id);
    }
  }
  return ids;
}

function isShowerScreenshot(message, callIds) {
  if (message?.role !== "toolResult" || message.toolName !== "shower" || !Array.isArray(message.content)) return false;
  if (!message.content.some((part) => part?.type === "image")) return false;
  const action = message.details?.action;
  if (action === "screenshot") return true;
  if (action != null) return false;
  return message.details?.engine === "operit-shower" || callIds.has(message.toolCallId);
}

/** Return a new message list, or the same list when nothing needs to change. */
export function pruneShowerContext(messages) {
  if (!Array.isArray(messages)) return messages;
  const callIds = screenshotCallIds(messages);
  const indexes = [];
  for (let i = 0; i < messages.length; i++) if (isShowerScreenshot(messages[i], callIds)) indexes.push(i);
  if (indexes.length <= 1) return messages;
  const drop = new Set(indexes.slice(0, -1));
  return messages.map((message, index) => {
    if (!drop.has(index)) return message;
    return { ...message, content: [
      ...message.content.filter((part) => part?.type !== "image"),
      { type: "text", text: omitted },
    ] };
  });
}

export default function showerContext(pi) {
  pi.on("context", (event) => ({ messages: pruneShowerContext(event.messages) }));
}
