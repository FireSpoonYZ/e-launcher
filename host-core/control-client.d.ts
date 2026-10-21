import type {
  BotRecord,
  CreateBotInput,
  PrimarySubmission,
  SubmissionInput,
  HistoryOptions,
  HistoryPage,
  ContextStatus,
  WorkContextRecord,
  WorkSyncOptions,
  WorkSyncResult,
  WorkHistoryCursor,
  WorkHistoryPage,
  WorkContextStatus,
  ControlHostInfo,
  BotLiveFrame
} from './index.js';

export class ControlApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, options?: { status?: number; code?: string });
}

export interface ControlClientOptions {
  /** http(s) control server base URL; must not contain userinfo, a fragment, or a token query parameter. */
  url: string;
  /** Opaque URL-safe bearer token. */
  token: string;
  /** Injectable native fetch; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface ControlClientCallOptions {
  /** Cancels only HTTP; does not abort inference or roll back accepted imports. */
  signal?: AbortSignal;
}

export interface HistoryClientOptions extends HistoryOptions {
  signal?: AbortSignal;
}

export interface WorkHistoryClientOptions extends ControlClientCallOptions {
  limit?: number;
  cursor?: WorkHistoryCursor | null;
}

export interface LiveClientOptions {
  signal?: AbortSignal;
}

export interface ControlClient {
  getHostInfo(options?: ControlClientCallOptions): Promise<ControlHostInfo>;
  listBots(options?: ControlClientCallOptions): Promise<BotRecord[]>;
  createBot(input: CreateBotInput, options?: ControlClientCallOptions): Promise<BotRecord>;
  getBot(botId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  findByRequest(requestId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  submit(botId: string, input: SubmissionInput, options?: ControlClientCallOptions): Promise<PrimarySubmission>;
  getSubmission(botId: string, requestId: string, options?: ControlClientCallOptions): Promise<PrimarySubmission>;
  history(botId: string, options?: HistoryClientOptions): Promise<HistoryPage>;
  abort(botId: string, options?: ControlClientCallOptions): Promise<{ botId: string }>;
  contextStatus(botId: string, options?: ControlClientCallOptions): Promise<ContextStatus>;
  getWorkContext(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkContextRecord>;
  syncWorkContext(botId: string, scopeId: string, input?: WorkSyncOptions, options?: ControlClientCallOptions): Promise<WorkSyncResult>;
  workHistory(botId: string, scopeId: string, options?: WorkHistoryClientOptions): Promise<WorkHistoryPage>;
  workContextStatus(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkContextStatus>;
  /** Consume the authenticated live SSE stream for a bot; ends on an end frame, break/return, or signal abort. */
  live(botId: string, options?: LiveClientOptions): AsyncIterable<BotLiveFrame>;
}

export function createControlClient(options: ControlClientOptions): ControlClient;
