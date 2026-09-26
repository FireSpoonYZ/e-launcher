import type { Attachment, ConversationNode } from './native';

export type ToolResultPairs = {
  byCall: Map<string, ConversationNode[]>;
  byMessage: Map<string, ConversationNode[][]>;
  embeddedResultIds: Set<string>;
};

export const toolCallKey = (nodeId: string, index: number) => `${nodeId}:${index}`;

export function summarizeToolArgs(source: string): string {
  let summary = source;
  try {
    const args: unknown = JSON.parse(source);
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const fields = args as Record<string, unknown>;
      if (!Object.keys(fields).length) return '';
      for (const key of ['command', 'cmd', 'filePath', 'path', 'file', 'url', 'query', 'code']) {
        if (typeof fields[key] === 'string' && fields[key].trim()) { summary = fields[key]; break; }
      }
    }
  } catch { /* Incomplete or non-JSON arguments remain readable as plain text. */ }
  const line = summary.replace(/\s+/g, ' ').trim();
  return line.length > 180 ? `${line.slice(0, 180)}…` : line;
}

export function toolOutputPreview(output: string): string {
  return output.trim().slice(0, 600).split(/\r?\n/, 3).join('\n');
}

export function toolResultAttachments(results: ConversationNode[]): Attachment[] {
  return results.flatMap(result => result.message.attachments);
}

const noResults: ConversationNode[] = [];

/** Pair within one assistant/tool run; retain unchanged per-message props for React.memo. */
export function pairToolResults(nodes: ConversationNode[], previous?: ToolResultPairs): ToolResultPairs {
  const byCall = new Map<string, ConversationNode[]>();
  const embeddedResultIds = new Set<string>();
  let calls = new Map<string, string | null>();

  for (const node of nodes) {
    if (node.message.role !== 'tool') {
      calls = new Map();
      if (node.message.role === 'assistant') node.message.toolCalls.forEach((call, index) => {
        calls.set(call.id, calls.has(call.id) ? null : toolCallKey(node.id, index));
      });
      continue;
    }

    const key = node.message.toolCallId && calls.get(node.message.toolCallId);
    if (!key) continue;
    byCall.set(key, [...(byCall.get(key) ?? []), node]);
    embeddedResultIds.add(node.id);
  }

  for (const [key, results] of byCall) {
    const before = previous?.byCall.get(key);
    if (before && before.length === results.length && results.every((node, index) => node === before[index])) byCall.set(key, before);
  }
  const byMessage = new Map<string, ConversationNode[][]>();
  for (const node of nodes) {
    if (!node.message.toolCalls.length) continue;
    const results = node.message.toolCalls.map((_, index) => byCall.get(toolCallKey(node.id, index)) ?? noResults);
    const before = previous?.byMessage.get(node.id);
    byMessage.set(node.id, before && before.length === results.length && results.every((value, index) => value === before[index]) ? before : results);
  }
  return {byCall, byMessage, embeddedResultIds};
}
