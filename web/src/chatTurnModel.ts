export interface ChatToolCallItem {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  entryId: number;
  error?: string;
  thinking?: string;
  toolSummary?: string[];
  tools?: ChatToolCallItem[];
  startedAt?: number;
  durationMs?: number;
  isStreaming?: boolean;
  createdAt?: string;
}

export interface ParseHistoryOptions {
  liveTools?: Array<Record<string, unknown>>;
  isBusy?: boolean;
  liveGeneratingText?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function formatTurnDuration(
  durationMs: number,
  t: (zh: string, en: string) => string = (zh) => zh,
): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 10_000) {
    const sec = Math.max(0.1, Math.round(ms / 100) / 10);
    const formatted = Number.isInteger(sec) ? `${sec}s` : `${sec.toFixed(1)}s`;
    return t(`耗时 ${formatted}`, formatted);
  }
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) {
    return t(`耗时 ${totalSec}s`, `${totalSec}s`);
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) {
    const label = secs > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${mins}m`;
    return t(`耗时 ${label}`, label);
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  const label = `${hours}h ${String(remMins).padStart(2, '0')}m`;
  return t(`耗时 ${label}`, label);
}

export function formatWorkingElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, '0')}m`;
}

interface AssistantTurnAccumulator {
  turn: ChatTurn;
  textParts: string[];
  thinkingParts: string[];
  tools: ChatToolCallItem[];
  settledToolIds: Set<string>;
  startMs?: number;
  endMs?: number;
  sumDurationMs: number;
}

export function parseHistoryEntries(
  items: Array<Record<string, unknown>>,
  clearedAfterEntryId = 0,
  options?: ParseHistoryOptions,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let activeUserStartMs: number | undefined;
  let currentAssistant: AssistantTurnAccumulator | null = null;

  const ensureAssistant = (id: string, numericId: number, fallbackStartMs?: number): AssistantTurnAccumulator => {
    if (currentAssistant) return currentAssistant;
    const startMs = activeUserStartMs ?? fallbackStartMs;
    const turn: ChatTurn = {
      id,
      role: 'assistant',
      entryId: Number.isFinite(numericId) ? numericId : 0,
      text: '',
      startedAt: startMs,
    };
    turns.push(turn);
    currentAssistant = {
      turn,
      textParts: [],
      thinkingParts: [],
      tools: [],
      settledToolIds: new Set<string>(),
      startMs,
      endMs: undefined,
      sumDurationMs: 0,
    };
    return currentAssistant;
  };

  const finalizeCurrentAssistant = (isStillActive: boolean) => {
    if (!currentAssistant) return;
    const acc = currentAssistant;
    currentAssistant = null;

    if (!isStillActive) {
      for (const tool of acc.tools) {
        if (tool.status === 'running') {
          tool.status = 'done';
        }
      }
      const spanMs =
        acc.startMs !== undefined && acc.endMs !== undefined && acc.endMs > acc.startMs
          ? acc.endMs - acc.startMs
          : 0;
      const totalMs = Math.max(spanMs, acc.sumDurationMs);
      if (totalMs > 0) {
        acc.turn.durationMs = totalMs;
      }
    }

    acc.turn.text = acc.textParts.filter(Boolean).join('\n\n').trim();
    acc.turn.thinking = acc.thinkingParts.length > 0 ? acc.thinkingParts.join('\n\n') : undefined;
    acc.turn.tools = acc.tools.length > 0 ? acc.tools : undefined;
    acc.turn.toolSummary = acc.tools.length > 0 ? acc.tools.map((tool) => tool.name) : undefined;
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const numericId = typeof item.id === 'number' ? item.id : Number(item.id);
    if (clearedAfterEntryId > 0 && Number.isFinite(numericId) && numericId <= clearedAfterEntryId) {
      continue;
    }
    // raw 条目用 model 块（含工具/思考）；Host live 投影条目有 messages:[{role,text,truncated,toolCalls,timestamp,durationMs}]。
    const model = asArray<unknown>(item.model);
    const blocks = model.length > 0 ? model : asArray<unknown>(item.messages);
    for (let mIdx = 0; mIdx < blocks.length; mIdx++) {
      const raw = blocks[mIdx];
      if (!raw || typeof raw !== 'object') continue;
      const entry = asRecord(raw);
      const role = entry.role;
      const msgTimestamp =
        typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) && entry.timestamp > 0
          ? entry.timestamp
          : undefined;
      const msgDurationMs =
        typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) && entry.durationMs >= 0
          ? entry.durationMs
          : undefined;

      if (role === 'user') {
        const content = entry.content;
        const textParts: string[] = [];
        if (typeof content === 'string') {
          textParts.push(content);
        } else if (typeof entry.text === 'string') {
          textParts.push(entry.text);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'string') {
              textParts.push(block);
              continue;
            }
            const part = asRecord(block);
            if (part.type === 'text' && typeof part.text === 'string') {
              textParts.push(part.text);
            }
          }
        }
        const joinedText = textParts.join('\n').trim();
        if (!joinedText) continue;

        finalizeCurrentAssistant(false);
        activeUserStartMs = msgTimestamp;
        turns.push({
          id: `${String(item.id ?? i)}-${mIdx}`,
          role: 'user',
          entryId: Number.isFinite(numericId) ? numericId : 0,
          text: joinedText,
          startedAt: msgTimestamp,
        });
        continue;
      }

      if (role === 'assistant') {
        const content = entry.content;
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        const extractedTools: Array<{ callId: string; name: string }> = [];

        if (typeof content === 'string') {
          textParts.push(content);
        } else if (typeof entry.text === 'string') {
          textParts.push(entry.text);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'string') {
              textParts.push(block);
              continue;
            }
            const part = asRecord(block);
            if (part.type === 'text' && typeof part.text === 'string') {
              textParts.push(part.text);
            } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
              thinkingParts.push(part.thinking);
            } else if (part.type === 'toolCall' && typeof part.name === 'string' && part.name.trim()) {
              extractedTools.push({
                callId: typeof part.id === 'string' ? part.id : '',
                name: part.name.trim(),
              });
            }
          }
        }

        if (Array.isArray(entry.toolCalls)) {
          for (const tc of entry.toolCalls) {
            const call = asRecord(tc);
            if (typeof call.name === 'string' && call.name.trim()) {
              extractedTools.push({
                callId: typeof call.callId === 'string' ? call.callId : '',
                name: call.name.trim(),
              });
            }
          }
        } else if (extractedTools.length === 0 && typeof entry.toolName === 'string' && entry.toolName.trim()) {
          extractedTools.push({
            callId: typeof entry.toolCallId === 'string' ? entry.toolCallId : '',
            name: entry.toolName.trim(),
          });
        }

        const joinedText = textParts.join('\n').trim();
        const error =
          (typeof entry.errorMessage === 'string' ? entry.errorMessage.trim() : '') ||
          (entry.stopReason === 'error' || entry.isError === true ? 'model_error' : undefined);

        if (!joinedText && extractedTools.length === 0 && !error && thinkingParts.length === 0) {
          continue;
        }

        const acc = ensureAssistant(`${String(item.id ?? i)}-${mIdx}`, numericId, msgTimestamp);
        if (Number.isFinite(numericId) && numericId > acc.turn.entryId) {
          acc.turn.entryId = numericId;
        }
        if (joinedText && acc.textParts.at(-1) !== joinedText) {
          acc.textParts.push(joinedText);
        }
        if (thinkingParts.length > 0) {
          acc.thinkingParts.push(thinkingParts.join('\n'));
        }
        if (error) {
          acc.turn.error = error;
        }
        for (let tIdx = 0; tIdx < extractedTools.length; tIdx++) {
          const tc = extractedTools[tIdx];
          const toolId = tc.callId || `${String(item.id ?? i)}-${mIdx}-tool-${tIdx}`;
          if (!acc.tools.some((existing) => existing.id === toolId)) {
            acc.tools.push({
              id: toolId,
              name: tc.name,
              status: 'running',
            });
          }
        }
        if (acc.startMs === undefined && msgTimestamp !== undefined) {
          acc.startMs = msgTimestamp;
          acc.turn.startedAt = msgTimestamp;
        }
        if (msgTimestamp !== undefined) {
          const stepEnd = msgTimestamp + (msgDurationMs ?? 0);
          acc.endMs = acc.endMs !== undefined ? Math.max(acc.endMs, stepEnd) : stepEnd;
        }
        if (msgDurationMs !== undefined) {
          acc.sumDurationMs += msgDurationMs;
        }
        continue;
      }

      if (role === 'toolResult') {
        const toolCallId = typeof entry.toolCallId === 'string' ? entry.toolCallId : '';
        const toolName = typeof entry.toolName === 'string' ? entry.toolName.trim() : '';
        const isError = entry.isError === true;
        if (!currentAssistant && !toolCallId && !toolName) continue;

        const fallbackStart =
          msgTimestamp !== undefined ? Math.max(0, msgTimestamp - (msgDurationMs ?? 0)) : undefined;
        const acc = ensureAssistant(`${String(item.id ?? i)}-${mIdx}`, numericId, fallbackStart);
        if (Number.isFinite(numericId) && numericId > acc.turn.entryId) {
          acc.turn.entryId = numericId;
        }
        const resolvedStatus: ChatToolCallItem['status'] = isError ? 'error' : 'done';
        let matched = toolCallId ? acc.tools.find((t) => t.id === toolCallId) : undefined;
        if (!matched && toolName) {
          matched = acc.tools.find((t) => t.name === toolName && !acc.settledToolIds.has(t.id));
        }
        if (matched) {
          matched.status = resolvedStatus;
          if (msgDurationMs !== undefined) matched.durationMs = msgDurationMs;
          acc.settledToolIds.add(matched.id);
        } else if (toolName) {
          const id = toolCallId || `${String(item.id ?? i)}-${mIdx}-result`;
          acc.tools.push({
            id,
            name: toolName,
            status: resolvedStatus,
            durationMs: msgDurationMs,
          });
          acc.settledToolIds.add(id);
        }
        if (acc.startMs === undefined && fallbackStart !== undefined) {
          acc.startMs = fallbackStart;
          acc.turn.startedAt = fallbackStart;
        }
        if (msgTimestamp !== undefined) {
          acc.endMs = acc.endMs !== undefined ? Math.max(acc.endMs, msgTimestamp) : msgTimestamp;
        }
        if (msgDurationMs !== undefined) {
          acc.sumDurationMs += msgDurationMs;
        }
      }
    }
  }

  const isBusy = Boolean(options?.isBusy);
  const liveTools = asArray<Record<string, unknown>>(options?.liveTools);
  const streamingText = typeof options?.liveGeneratingText === 'string' ? options.liveGeneratingText.trim() : '';

  let activeAcc: AssistantTurnAccumulator | null = currentAssistant;
  if (isBusy && (liveTools.length > 0 || streamingText !== '') && !activeAcc) {
    const lastEntryId = turns.at(-1)?.entryId ?? 0;
    activeAcc = ensureAssistant('live-assistant', lastEntryId + 0.5, activeUserStartMs);
  }

  if (activeAcc && isBusy) {
    const acc = activeAcc;
    const activeLiveIds = new Set<string>();

    for (let sIdx = 0; sIdx < liveTools.length; sIdx++) {
      const slot = asRecord(liveTools[sIdx]);
      const callId = typeof slot.callId === 'string' ? slot.callId : '';
      const name = typeof slot.name === 'string' ? slot.name.trim() : '';
      if (!name) continue;
      const slotStatus: ChatToolCallItem['status'] = slot.status === 'done' ? 'done' : 'running';
      const existing = callId
        ? acc.tools.find((t) => t.id === callId)
        : acc.tools.find((t) => t.name === name && !acc.settledToolIds.has(t.id));
      if (existing) {
        activeLiveIds.add(existing.id);
        if (!acc.settledToolIds.has(existing.id)) {
          existing.status = slotStatus;
        }
      } else {
        const id = callId || `live-tool-${sIdx}`;
        activeLiveIds.add(id);
        acc.tools.push({
          id,
          name,
          status: slotStatus,
        });
      }
    }

    // Earlier tool rounds in the same turn have already completed once a new round or text stream starts.
    if (liveTools.length > 0 || streamingText !== '') {
      for (const tool of acc.tools) {
        if (tool.status === 'running' && !activeLiveIds.has(tool.id)) {
          tool.status = 'done';
        }
      }
    }

    if (streamingText !== '') {
      acc.turn.isStreaming = true;
      if (acc.textParts.at(-1) !== streamingText) {
        acc.textParts.push(streamingText);
      }
    }
  }

  finalizeCurrentAssistant(isBusy);

  return turns.filter(
    (turn) =>
      turn.role === 'user' ||
      Boolean(turn.text) ||
      Boolean(turn.tools && turn.tools.length > 0) ||
      Boolean(turn.error) ||
      Boolean(turn.thinking),
  );
}

export function resolveActiveTurnStartedAt(
  turns: ChatTurn[],
  pendingSubmittedAt?: number | null,
): number | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === 'user' && typeof turn.startedAt === 'number' && turn.startedAt > 0) {
      return turn.startedAt;
    }
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (typeof turn.startedAt === 'number' && turn.startedAt > 0) {
      return turn.startedAt;
    }
  }
  if (typeof pendingSubmittedAt === 'number' && Number.isFinite(pendingSubmittedAt) && pendingSubmittedAt > 0) {
    return pendingSubmittedAt;
  }
  return null;
}
