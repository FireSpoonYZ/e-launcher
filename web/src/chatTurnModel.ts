export interface ChatToolCallItem {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
  /** 工具调用参数（来自 raw history entry.model 中的 toolCall.arguments）。 */
  args?: Record<string, unknown>;
  /** 语义胶囊单行关键参数摘要（如命令、文件路径、搜索词等）。 */
  argSummary?: string;
  /** 工具执行输出文本（来自 liveTools.output 或 toolResult 文本内容）。 */
  output?: string;
  /** 输出是否因长度预算被截断。 */
  outputTruncated?: boolean;
  /** host 投影的工具交互结构（todo/问卷）；来自 live slot 或历史 toolResult，未验证形状，渲染前需 readToolPresentation。 */
  presentation?: Record<string, unknown>;
  /** presentation 来自仍活跃 live slot 时为 true，历史结果替换后为 false。 */
  presentationLive?: boolean;
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

function compactSingleLine(value: string, maxLen = 56): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function shortenPath(rawPath: string, maxLen = 44): string {
  const clean = rawPath.trim();
  if (!clean || clean.length <= maxLen) return clean;
  const parts = clean.split(/([\\/])/).filter(Boolean);
  if (parts.length >= 3) {
    const tail = parts.slice(-3).join('');
    if (tail.length + 2 <= maxLen) return `…${tail}`;
  }
  return `…${clean.slice(-(maxLen - 1))}`;
}

export function summarizeToolArgs(
  name: string,
  args?: Record<string, unknown>,
): string | undefined {
  if (!args) return undefined;
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;
  const lower = name.toLowerCase();

  const pickStr = (...candidates: string[]): string => {
    for (const key of candidates) {
      const val = args[key];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return '';
  };

  if (lower === 'bash' || lower.endsWith('_bash') || lower === 'shell' || lower === 'exec') {
    const cmd = pickStr('command', 'cmd', 'script');
    if (cmd) return compactSingleLine(cmd, 52);
  }

  if (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'lsp_fix') {
    const p = pickStr('path', 'file_path', 'filePath', 'file');
    if (p) {
      const short = shortenPath(p, 42);
      if (lower === 'read' && (typeof args.offset === 'number' || typeof args.limit === 'number')) {
        const start = typeof args.offset === 'number' ? args.offset : 1;
        const lim = typeof args.limit === 'number' ? `+${args.limit}` : '';
        return `${short} :${start}${lim}`;
      }
      return short;
    }
  }

  if (lower === 'grep' || lower === 'search') {
    const pat = pickStr('pattern', 'query', 'q');
    const p = pickStr('path', 'glob');
    if (pat && p) return `"${compactSingleLine(pat, 26)}" in ${shortenPath(p, 24)}`;
    if (pat) return `"${compactSingleLine(pat, 44)}"`;
  }

  if (lower === 'find' || lower === 'ls' || lower === 'glob') {
    const pat = pickStr('pattern', 'glob');
    const p = pickStr('path', 'dir', 'directory');
    if (pat && p) return `${compactSingleLine(pat, 26)} · ${shortenPath(p, 24)}`;
    if (pat) return compactSingleLine(pat, 44);
    if (p) return shortenPath(p, 44);
  }

  if (lower === 'codemode') {
    const code = pickStr('code');
    if (code) {
      const firstMeaningful =
        code
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('//')) ?? code;
      return compactSingleLine(firstMeaningful, 48);
    }
  }

  if (lower.includes('websearch') || lower.includes('search')) {
    const q = pickStr('query', 'q', 'prompt');
    if (q) return `"${compactSingleLine(q, 44)}"`;
  }

  const primary = pickStr(
    'command',
    'path',
    'file',
    'query',
    'pattern',
    'url',
    'action',
    'prompt',
    'title',
    'name',
    'id',
  );
  if (primary) return compactSingleLine(primary, 46);

  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) {
      return `${key}: ${compactSingleLine(v, 36)}`;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      return `${key}=${String(v)}`;
    }
  }
  return undefined;
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
        const extractedTools: Array<{ callId: string; name: string; args?: Record<string, unknown> }> = [];

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
              const rawArgs = asRecord(part.arguments ?? part.args ?? part.input);
              extractedTools.push({
                callId: typeof part.id === 'string' ? part.id : '',
                name: part.name.trim(),
                ...(Object.keys(rawArgs).length > 0 ? { args: rawArgs } : {}),
              });
            }
          }
        }

        if (Array.isArray(entry.toolCalls)) {
          for (const tc of entry.toolCalls) {
            const call = asRecord(tc);
            if (typeof call.name === 'string' && call.name.trim()) {
              const rawArgs = asRecord(call.arguments ?? call.args ?? call.input);
              extractedTools.push({
                callId: typeof call.callId === 'string' ? call.callId : '',
                name: call.name.trim(),
                ...(Object.keys(rawArgs).length > 0 ? { args: rawArgs } : {}),
              });
            }
          }
        } else if (extractedTools.length === 0 && typeof entry.toolName === 'string' && entry.toolName.trim()) {
          const rawArgs = asRecord(entry.arguments ?? entry.args ?? entry.input);
          extractedTools.push({
            callId: typeof entry.toolCallId === 'string' ? entry.toolCallId : '',
            name: entry.toolName.trim(),
            ...(Object.keys(rawArgs).length > 0 ? { args: rawArgs } : {}),
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
          const summary = summarizeToolArgs(tc.name, tc.args);
          const existing = acc.tools.find((itemTool) => itemTool.id === toolId);
          if (!existing) {
            acc.tools.push({
              id: toolId,
              name: tc.name,
              status: 'running',
              ...(tc.args ? { args: tc.args } : {}),
              ...(summary ? { argSummary: summary } : {}),
            });
          } else {
            if (tc.args && !existing.args) existing.args = tc.args;
            if (summary && !existing.argSummary) existing.argSummary = summary;
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
        const resultTextParts: string[] = [];
        if (typeof entry.content === 'string') {
          resultTextParts.push(entry.content);
        } else if (typeof entry.text === 'string') {
          resultTextParts.push(entry.text);
        } else if (Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (typeof block === 'string') {
              resultTextParts.push(block);
              continue;
            }
            const part = asRecord(block);
            if (part.type === 'text' && typeof part.text === 'string') {
              resultTextParts.push(part.text);
            }
          }
        }
        const resultOutput = resultTextParts.join('\n').trim();
        const resultTruncated = entry.truncated === true;
        // 历史结果上的白名单 presentation 投影（data/details 两种位置都认）。
        const presentation = asRecord(entry.presentation);
        const projectedPresentation = Object.keys(presentation).length > 0
          ? presentation
          : (() => {
              const details = asRecord(entry.details);
              const fromDetails = asRecord(details.presentation);
              if (Object.keys(fromDetails).length > 0) return fromDetails;
              const data = asRecord(entry.data);
              const fromData = asRecord(data.presentation);
              return Object.keys(fromData).length > 0 ? fromData : null;
            })();
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
          if (resultOutput) matched.output = resultOutput;
          if (resultTruncated) matched.outputTruncated = true;
          if (projectedPresentation) {
            matched.presentation = projectedPresentation;
            matched.presentationLive = false;
          }
          acc.settledToolIds.add(matched.id);
        } else if (toolName) {
          const id = toolCallId || `${String(item.id ?? i)}-${mIdx}-result`;
          acc.tools.push({
            id,
            name: toolName,
            status: resolvedStatus,
            durationMs: msgDurationMs,
            ...(resultOutput ? { output: resultOutput } : {}),
            ...(resultTruncated ? { outputTruncated: true } : {}),
            ...(projectedPresentation ? { presentation: projectedPresentation, presentationLive: false } : {}),
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
      const slotOutput = typeof slot.output === 'string' ? slot.output.trim() : '';
      const slotTruncated = slot.truncated === true;
      const slotPresentation = asRecord(slot.presentation);
      const hasPresentation = Object.keys(slotPresentation).length > 0;
      const existing = callId
        ? acc.tools.find((t) => t.id === callId)
        : acc.tools.find((t) => t.name === name && !acc.settledToolIds.has(t.id));
      if (existing) {
        activeLiveIds.add(existing.id);
        if (slotOutput && !existing.output) {
          existing.output = slotOutput;
          if (slotTruncated) existing.outputTruncated = true;
        }
        if (!acc.settledToolIds.has(existing.id)) {
          existing.status = slotStatus;
          if (slotOutput) {
            existing.output = slotOutput;
            if (slotTruncated) existing.outputTruncated = true;
          }
          if (hasPresentation) {
            existing.presentation = slotPresentation;
            existing.presentationLive = true;
          }
        }
      } else {
        const id = callId || `live-tool-${sIdx}`;
        activeLiveIds.add(id);
        acc.tools.push({
          id,
          name,
          status: slotStatus,
          ...(slotOutput ? { output: slotOutput } : {}),
          ...(slotTruncated ? { outputTruncated: true } : {}),
          ...(hasPresentation ? { presentation: slotPresentation, presentationLive: true } : {}),
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
