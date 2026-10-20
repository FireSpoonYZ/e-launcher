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
  resume(): void;
  close(): Promise<void>;
}

export function openRuntime(options: OpenRuntimeOptions): Promise<Runtime>;

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
