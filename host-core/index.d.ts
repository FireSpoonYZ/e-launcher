import type { Models } from '@earendil-works/pi-ai';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { CompressionBlock, StatusReport } from 'acp-kernel';

export interface BotRecord {
  botId: string;
  deviceId: string;
  role: string;
  cwd: string;
  modelRef: string | null;
  primaryConversationId: string;
  createdAt: string;
}

export interface CreateBotInput {
  requestId: string;
  role: string;
  cwd: string;
  modelRef?: string | null;
}

export interface Host {
  readonly deviceId: string;
  readonly dataRoot: string;
  createBot(input: CreateBotInput): BotRecord;
  getBot(botId: string): BotRecord | null;
  findByRequest(requestId: string): BotRecord | null;
  listBots(): BotRecord[];
  close(): void;
}

export function openHost(options: { dataRoot: string }): Host;

export interface PrimarySubmission {
  botId: string;
  conversationId: string;
  requestId: string;
  submissionId: number;
  status: 'queued' | 'placed' | 'done' | 'unanswered';
  answerText: string | null;
  reason: string | null;
}

export interface SubmissionInput {
  requestId: string;
  text: string;
}

export interface HistoryOptions {
  limit?: number;
  cursor?: Record<string, unknown> | null;
}

export interface HistoryPage {
  botId: string;
  conversationId: string;
  items: readonly EntryRecord[];
  nextCursor: Record<string, unknown> | null;
}

export interface ContextStatus {
  botId: string;
  conversationId: string;
  kernelVersion: string;
  status: StatusReport | null;
  blocks: readonly CompressionBlock[];
  messageRefs: {
    byRaw: Record<string, string>;
    byRef: Record<string, string>;
  };
  prepared: {
    key: string;
    taskId: string;
    cutoff: number;
    contextWindow: number;
    tokenCount: number;
  } | null;
}

export interface OpenRuntimeOptions {
  dataRoot: string;
  models?: Models;
  defaultModel?: string | null;
  /** Optional explicit bash (Git Bash on Windows) executable; when omitted, HostEnv probes fixed Git install directories (Windows) or /bin/bash and /usr/bin/bash (Linux), never PATH. */
  bashPath?: string;
  /** Optional explicit search binaries for grep (rg) and find (fd); existence is checked at use. */
  toolPaths?: { rg?: string; fd?: string };
}

export interface Runtime {
  submit(botId: string, input: SubmissionInput): Promise<PrimarySubmission>;
  wait(botId: string, requestId: string): Promise<PrimarySubmission>;
  getSubmission(botId: string, requestId: string): Promise<PrimarySubmission | null>;
  history(botId: string, options?: HistoryOptions): Promise<HistoryPage>;
  abort(botId: string): Promise<void>;
  contextStatus(botId: string): Promise<ContextStatus>;
  watch(botId: string, options?: { signal?: AbortSignal }): Promise<BotWatch>;
  resume(): void;
  close(): Promise<void>;
}

export function openRuntime(options: OpenRuntimeOptions): Promise<Runtime>;

/**
 * Live preview types (module 6): bounded, non-durable projection frames for a
 * Bot's primary conversation over authenticated local SSE. Previews are
 * transient progress; the raw history API remains the full source of truth.
 */

export interface LiveMessage {
  role: 'user' | 'assistant' | 'toolResult';
  text: string;
  truncated: boolean;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface LiveHistoryItem {
  id: number;
  kind: string;
  messages: LiveMessage[];
}

export interface LiveTool {
  callId: string;
  name: string;
  status: 'pending' | 'running' | 'done';
  output: string;
  truncated: boolean;
  droppedBytes: number;
  droppedLines: number;
  entryId?: number;
  parentCallId?: string;
}

export interface LiveGeneration {
  text: string;
  truncated: boolean;
}

export interface BotLiveState {
  history: LiveHistoryItem[];
  historyTruncated: boolean;
  lastEntryId: number | null;
  generation: LiveGeneration | null;
  tools: LiveTool[];
  toolsTruncated: boolean;
  busy: boolean;
  queuedCount: number;
}

/** Whole-field replacement of selected BotLiveState fields; never append/delta. */
export type BotLiveChanges = Partial<BotLiveState>;

export interface BotLiveSnapshot {
  type: 'snapshot';
  botId: string;
  conversationId: string;
  sequence: number;
  state: BotLiveState;
}

export interface BotLiveUpdate {
  type: 'update';
  botId: string;
  conversationId: string;
  sequence: number;
  changes: BotLiveChanges;
}

type BotWatchEndReason =
  | 'stopped'
  | 'cancelled'
  | 'session_closed'
  | 'retired'
  | 'listener_error'
  | 'session_failed';

export interface BotLiveEnd {
  type: 'end';
  botId: string;
  conversationId: string;
  sequence: number;
  reason: BotWatchEndReason;
}

/** Frames delivered to Runtime.watch listeners (snapshot first, then updates). */
export type BotLiveDataFrame = BotLiveSnapshot | BotLiveUpdate;

/** All wire frames including the transport-only end frame. */
export type BotLiveFrame = BotLiveDataFrame | BotLiveEnd;

export interface BotWatchEnd {
  reason: BotWatchEndReason;
}

export interface BotWatch {
  readonly value: BotLiveSnapshot;
  start(listener: (frame: BotLiveDataFrame) => void | Promise<void>): void;
  stop(): Promise<BotWatchEnd>;
  readonly closed: Promise<BotWatchEnd>;
}

export interface ControlHostInfo {
  protocolVersion: 1;
  deviceId: string;
  platform: string;
  arch: string;
}

export interface OpenControlServerOptions extends OpenRuntimeOptions {
  token: string;
  port?: number;
}

export interface ControlServer {
  deviceId: string;
  url: string;
  close(): Promise<void>;
}

export function openControlServer(options: OpenControlServerOptions): Promise<ControlServer>;
