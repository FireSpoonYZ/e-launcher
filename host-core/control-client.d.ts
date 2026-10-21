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
  WorkActivity,
  ControlHostInfo,
  BotLiveFrame,
  ScopeCreateInput,
  ScopeUpdateInput,
  ScopeInfo,
  ScopeListOptions,
  ScopeListPage,
  ReplicaListOptions,
  ReplicaListPage,
  UserMessageInput,
  StoredMessage
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
  /** Cancels only HTTP; does not abort inference or roll back accepted imports/stop/resume operations. */
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

export interface ScopeListClientOptions extends ScopeListOptions {
  signal?: AbortSignal;
}

export interface ReplicaListClientOptions extends ReplicaListOptions {
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
  /** Local-only passive query; an authorized unbound scope returns status:'unbound'. */
  getWorkActivity(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  /** Local-only persistent stop for this work context; does not affect primary/other scopes. */
  stopWork(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  /** Local-only explicit resume for a current member; posts {}, not a global Runtime.resume(). */
  resumeWork(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  /* Module 12: six local-only scope methods; the fixed 10 remote control methods stay unchanged. */
  listScopeStates(options?: ScopeListClientOptions): Promise<ScopeListPage>;
  createScope(input: ScopeCreateInput, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  /** Latest state; a missing scope rejects with ControlApiError (404 SCOPE_NOT_FOUND), never null success. */
  getScopeState(scopeId: string, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  updateScope(scopeId: string, input: ScopeUpdateInput, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  /** Room-public user message ledger receipt; not delivery/inference completion. */
  publishUserMessage(scopeId: string, input: UserMessageInput, options?: ControlClientCallOptions): Promise<StoredMessage>;
  listScopeReplicas(scopeId: string, options?: ReplicaListClientOptions): Promise<ReplicaListPage>;
  /** Consume the authenticated live SSE stream for a bot; ends on an end frame, break/return, or signal abort. */
  live(botId: string, options?: LiveClientOptions): AsyncIterable<BotLiveFrame>;
}

export function createControlClient(options: ControlClientOptions): ControlClient;
