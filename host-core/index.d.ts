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

/** Module 10: passive, isolated room/DM contexts; importing never starts inference. */
export interface WorkContextRecord {
  deviceId: string;
  botId: string;
  scopeId: string;
  kind: 'room' | 'dm';
  /** Public UUID, distinct from the Bot's primary conversation and SDK numeric ID. */
  conversationId: string;
  createdAt: string;
  lastImportedLocalId: number;
  importedCount: number;
}

export interface WorkSyncOptions {
  /** One page per explicit sync; default 50, maximum 200, positive safe integer. */
  limit?: number;
}

export interface WorkSyncResult {
  context: WorkContextRecord;
  imported: number;
  hasMore: boolean;
}

/** Exact wrapper bound to one public work-context UUID; never a raw/primary cursor. */
export interface WorkHistoryCursor {
  conversationId: string;
  position: Record<string, unknown>;
}

export interface WorkHistoryPage {
  botId: string;
  scopeId: string;
  conversationId: string | null;
  items: readonly EntryRecord[];
  nextCursor: WorkHistoryCursor | null;
}

export interface WorkContextStatus extends Omit<ContextStatus, 'conversationId'> {
  scopeId: string;
  conversationId: string | null;
}

/** Module 11: passive activity DTO for one local Bot/scope; no native task IDs. */
export interface WorkActivity {
  botId: string;
  scopeId: string;
  /** Public work-context UUID; null when authorized but not yet bound. */
  conversationId: string | null;
  isMember: boolean;
  /** Priority: unbound, stopped, error, inactive (nonmember), thinking, idle. */
  status: 'unbound' | 'idle' | 'thinking' | 'stopped' | 'inactive' | 'error';
  /** Owner stop persists across restart; only explicit resumeWork clears it. */
  stopped: boolean;
  lastImportedLocalId: number;
  /** Policy-consumed source watermark, including ignored echoes/notices/replies; not an ACK. */
  handledLocalId: number;
  pending: {
    requestId: string;
    submissionId: number | null;
    startedAt: string;
    /** Source watermark in the actual frozen model request, not the latest imported watermark. */
    preparedThroughLocalId: number | null;
  } | null;
  /** Model-decision outcome, not delivery confirmation or proof of no earlier side effects. */
  lastDecision: {
    requestId: string;
    outcome: 'silent' | 'published' | 'replan' | 'aborted' | 'failed';
    throughLocalId: number | null;
    completedAt: string;
  } | null;
  error: { code: string; message: string } | null;
}

/**
 * Module 13: Hindsight long-term memory (Pi Durable adapter). Fact storage,
 * extraction, recall and curation live on the configured Hindsight service;
 * the local adapter only tracks inputs, outbox, recall cache, provenance and
 * correction audit. Automatic extraction follows completed inference only;
 * explicit tool/control notes are durable tool history and never auto-source.
 */

/** Selected memory bank target; scope requires read authorization via work context. */
export type MemoryTarget =
  | { kind: 'primary' }
  | { kind: 'scope'; scopeId: string }
  | { kind: 'shared' };

/** Host config; apiKeyEnv names an environment variable, never an inline value. */
export interface HindsightOptions {
  baseUrl: string;
  apiKeyEnv?: string;
  /** Opt-in shared bank; accepts explicit notes only, never automatic transcripts. */
  sharedMemory?: boolean;
}

export type MemoryJobState = 'pending' | 'accepted' | 'completed' | 'failed';

/** Job receipt; never exposes token or raw backend error bodies. */
export interface MemoryReceipt {
  operationId: string;
  documentId: string;
  botId: string;
  target: MemoryTarget;
  bankId: string;
  state: MemoryJobState;
  createdAt: string;
  updatedAt: string;
  lastErrorCode: string | null;
}

export interface MemoryRetainReceipt {
  botId: string;
  target: MemoryTarget;
  bankId: string;
  jobs: MemoryReceipt[];
}

export type MemoryCorrectionState = 'pending' | 'applied' | 'rejected' | 'unconfirmed';
export type MemoryCorrectionOutcome = 'not-sent' | 'responded' | 'unconfirmed';

export interface MemoryCorrectionReceipt {
  requestId: string;
  botId: string;
  target: MemoryTarget;
  bankId: string;
  memoryId: string;
  state: MemoryCorrectionState;
  outcome: MemoryCorrectionOutcome;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
}

export type MemoryRecallOutcome = 'injected' | 'empty' | 'budget' | 'unavailable';

export interface MemoryLastRecall {
  at: string;
  outcome: MemoryRecallOutcome;
}

/** Paged job-list continuation; bound to the derived bank/filter, never selects a target. */
export interface MemoryCursor {
  bankId: string;
  state: MemoryJobState | null;
  afterOperationId: string;
}

export interface MemoryStatusInput {
  target?: MemoryTarget;
  state?: MemoryJobState;
  /** 1..200, default 20. */
  limit?: number;
  cursor?: MemoryCursor | null;
}

/**
 * Memory status. Counts always cover the whole context; only jobs obey the
 * state filter. jobs/nextCursor are null when disabled (unknown); a configured
 * empty store returns [] with nextCursor null.
 */
export interface MemoryStatus {
  botId: string;
  target: MemoryTarget;
  enabled: boolean;
  sharedMemory: boolean;
  bankId: string | null;
  pending: number | null;
  accepted: number | null;
  completed: number | null;
  failed: number | null;
  lastErrorCode: string | null;
  lastRecall: MemoryLastRecall | null;
  jobs: MemoryReceipt[] | null;
  nextCursor: MemoryCursor | null;
}

export interface MemoryQueryInput {
  target?: MemoryTarget;
  query: string;
  maxTokens?: number;
}

export interface MemoryRetainInput {
  requestId: string;
  target?: MemoryTarget;
  text: string;
}

export interface MemoryLookupInput {
  target?: MemoryTarget;
  memoryId: string;
}

export interface MemorySourceInput {
  target?: MemoryTarget;
  documentId: string;
}

export interface MemoryCorrectionInput {
  requestId: string;
  target?: MemoryTarget;
  memoryId: string;
  text?: string;
  state?: 'valid' | 'invalidated';
  reason?: string;
}

export interface MemoryRetryInput {
  target?: MemoryTarget;
  operationId: string;
}

/** Backend recall/reflect/get result; opaque unknown shape, no invented DTO. */
export interface MemoryBankResult {
  botId: string;
  target: MemoryTarget;
  bankId: string;
  result: Record<string, unknown>;
}

export type MemoryRecallResult = MemoryBankResult;
export type MemoryReflectResult = MemoryBankResult;
export type MemoryGetResult = MemoryBankResult;

/** Source fetch result; externally created documents may have no local provenance/receipt. */
export interface MemorySourceResult {
  botId: string;
  target: MemoryTarget;
  bankId: string;
  document: Record<string, unknown>;
  source: Record<string, unknown> | null;
  receipt: MemoryReceipt | null;
}

/** Raw runtime JSON configuration (module 14); strict fields, credentials only as env names. */
export interface ModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKeyEnv?: string;
  models: ModelConfig[];
}

export interface RuntimeConfig {
  providers: ProviderConfig[];
  defaultModel?: string | null;
  hindsight?: HindsightOptions;
  bashPath?: string;
  toolPaths?: { rg?: string; fd?: string };
}

export interface OpenRuntimeOptions {
  dataRoot: string;
  models?: Models;
  defaultModel?: string | null;
  /** Optional explicit bash (Git Bash on Windows) executable; when omitted, HostEnv probes fixed Git install directories (Windows) or /bin/bash and /usr/bin/bash (Linux), never PATH. */
  bashPath?: string;
  /** Optional explicit search binaries for grep (rg) and find (fd); existence is checked at use. */
  toolPaths?: { rg?: string; fd?: string };
  /** Optional Hindsight memory config; absent leaves memory disabled. */
  hindsight?: HindsightOptions;
}

export interface Runtime {
  submit(botId: string, input: SubmissionInput): Promise<PrimarySubmission>;
  wait(botId: string, requestId: string): Promise<PrimarySubmission>;
  getSubmission(botId: string, requestId: string): Promise<PrimarySubmission | null>;
  history(botId: string, options?: HistoryOptions): Promise<HistoryPage>;
  /** Abort only the primary conversation; does not stop room/DM work contexts. */
  abort(botId: string): Promise<void>;
  contextStatus(botId: string): Promise<ContextStatus>;
  getWorkContext(botId: string, scopeId: string): Promise<WorkContextRecord | null>;
  syncWorkContext(botId: string, scopeId: string, options?: WorkSyncOptions): Promise<WorkSyncResult>;
  workHistory(botId: string, scopeId: string, options?: { limit?: number; cursor?: WorkHistoryCursor | null }): Promise<WorkHistoryPage>;
  workContextStatus(botId: string, scopeId: string): Promise<WorkContextStatus>;
  /** Passive, authorized query; creates neither a binding nor model work. */
  getWorkActivity(botId: string, scopeId: string): Promise<WorkActivity>;
  /** Persist stop, abort only this work conversation and await quiescence; committed effects remain. */
  stopWork(botId: string, scopeId: string): Promise<WorkActivity>;
  /** Current member only; clear stop/error without consuming input. Does not activate a passive Runtime's scheduler. */
  resumeWork(botId: string, scopeId: string): Promise<WorkActivity>;
  /** Module 12: six managed-scope methods; exposed locally and via the module 14 remote v2 table. */
  createScope(input: ScopeCreateInput): Promise<ScopeInfo>;
  updateScope(scopeId: string, input: ScopeUpdateInput): Promise<ScopeInfo>;
  /** Latest state; rejects SCOPE_NOT_FOUND when the scope is missing, never resolves null. */
  getScopeState(scopeId: string): Promise<ScopeInfo>;
  listScopeStates(options?: ScopeListOptions): Promise<ScopeListPage>;
  /** Room-public user message; returns the stored ledger receipt, not a delivery/inference completion. */
  publishUserMessage(scopeId: string, input: UserMessageInput): Promise<StoredMessage>;
  listScopeReplicas(scopeId: string, options?: ReplicaListOptions): Promise<ReplicaListPage>;
  /** Module 13: eight Hindsight memory methods; exposed locally and via the module 14 remote v2 table. */
  memoryStatus(botId: string, input?: MemoryStatusInput): Promise<MemoryStatus>;
  recallMemory(botId: string, input: MemoryQueryInput): Promise<MemoryRecallResult>;
  reflectMemory(botId: string, input: MemoryQueryInput): Promise<MemoryReflectResult>;
  retainMemory(botId: string, input: MemoryRetainInput): Promise<MemoryRetainReceipt>;
  getMemory(botId: string, input: MemoryLookupInput): Promise<MemoryGetResult>;
  getMemorySource(botId: string, input: MemorySourceInput): Promise<MemorySourceResult>;
  correctMemory(botId: string, input: MemoryCorrectionInput): Promise<MemoryCorrectionReceipt>;
  retryMemory(botId: string, input: MemoryRetryInput): Promise<MemoryReceipt>;
  watch(botId: string, options?: { signal?: AbortSignal }): Promise<BotWatch>;
  /** Module 14: work-context live preview; same handle shape as primary watch, full snapshots only. */
  watchWork(botId: string, scopeId: string, options?: { signal?: AbortSignal }): Promise<WorkWatch>;
  /** Passive, authorized scope history; strict paging with the shared message cursor. */
  scopeHistory(scopeId: string, options?: MessagePageOptions): Promise<MessageHistoryPage>;
  /** Exact stored message; foreign-scope IDs reject MESSAGE_NOT_FOUND. */
  getScopeMessage(scopeId: string, messageId: string): Promise<StoredMessage>;
  getScopeMessageDelivery(scopeId: string, messageId: string): Promise<MessageDeliveryStatus>;
  /** Read-only chat model whitelist; no credentials/base URLs/env names. */
  getModelCatalog(): Promise<ModelCatalog>;
  /** Idempotently resume native tasks AND activate automatic room/DM processing; may submit new work. */
  resume(): void;
  close(): Promise<void>;
}

/** Opens passively; automatic room/DM processing starts only through Runtime.resume(). */
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

/** Module 14: work-context live preview; full snapshots only, never deltas. */
export interface WorkLiveSnapshot {
  type: 'snapshot';
  botId: string;
  scopeId: string;
  conversationId: string | null;
  sequence: number;
  state: BotLiveState;
}

/** Transport-only end frame carried on the work live SSE stream. */
export interface WorkLiveEnd {
  type: 'end';
  botId: string;
  scopeId: string;
  conversationId: string | null;
  sequence: number;
  reason: BotWatchEndReason;
}

export type WorkLiveFrame = WorkLiveSnapshot | WorkLiveEnd;

export interface WorkWatch {
  readonly value: WorkLiveSnapshot;
  start(listener: (frame: WorkLiveSnapshot) => void | Promise<void>): void;
  stop(): Promise<BotWatchEnd>;
  readonly closed: Promise<BotWatchEnd>;
}

/** Chat model catalog projection; ordered by modelRef UTF-8 bytes. */
export interface ModelCatalogEntry {
  modelRef: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface ModelCatalog {
  defaultModel: string | null;
  models: ModelCatalogEntry[];
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
  /** Optional local settings store backing /v1/settings; when absent those routes return CONTROL_UNAVAILABLE. */
  settings?: { store: HostSettingsStore; activeRevision: number };
  getServiceStatus?: () => HostServiceStatus;
}

export interface ControlServer {
  deviceId: string;
  url: string;
  close(): Promise<void>;
}

export function openControlServer(options: OpenControlServerOptions): Promise<ControlServer>;

/**
 * Module 14 types: host settings store, unified local service and runtime config helpers.
 */

export interface HostRelayConfig {
  url: string;
  tokenEnv: string;
  caFile?: string;
}

export interface HostSettings {
  runtime: RuntimeConfig;
  relay: HostRelayConfig | null;
}

export interface SettingsSnapshot {
  deviceId: string;
  revision: number;
  settings: HostSettings;
}

export interface SettingsUpdate {
  expectedRevision: number;
  settings: HostSettings;
}

/** Synchronous persistent settings facade; replace() is CAS on expectedRevision. */
export interface HostSettingsStore {
  readonly deviceId: string;
  get(): SettingsSnapshot;
  replace(update: SettingsUpdate): SettingsSnapshot;
  close(): void;
}

export function openHostSettings(options: { dataRoot: string; deviceId: string; initialSettings?: HostSettings }): HostSettingsStore;
export function normalizeHostSettings(value: unknown): HostSettings;

/** Local HTTP /v1/settings DTO; restartRequired compares the persisted vs active revision. */
export interface LocalSettingsSnapshot extends SettingsSnapshot {
  activeRevision: number;
  restartRequired: boolean;
}

export interface HostServiceOptions {
  dataRoot: string;
  token: string;
  port?: number;
  initialSettings?: HostSettings;
}

export interface HostServiceStatus {
  deviceId: string;
  phase: 'starting' | 'running' | 'closing' | 'closed';
  control: { url: string; listening: boolean };
  relay: DeviceLinkStatus | null;
  activeSettingsRevision: number;
  settingsRevision: number;
  restartRequired: boolean;
}

export interface HostService {
  readonly deviceId: string;
  readonly url: string;
  getStatus(): HostServiceStatus;
  close(): Promise<void>;
}

export function openHostService(options: HostServiceOptions): Promise<HostService>;

export interface ParsedRuntimeConfig {
  models: Models;
  defaultModel: string | null;
  bashPath?: string;
  toolPaths?: { rg?: string; fd?: string };
  hindsight?: HindsightOptions;
}

export function normalizeRuntimeConfig(raw: unknown): RuntimeConfig;
export function parseRuntimeConfig(raw: unknown): ParsedRuntimeConfig;
export function describeModelCatalog(models: Models, defaultModel?: string | null): ModelCatalog;
export function loadRuntimeConfig(file: string): Promise<ParsedRuntimeConfig>;

/**
 * Module 7 types: host-owned persistent message ledger (messages.sqlite) on
 * this Host. Local-only storage plus a privileged offline CLI; no network
 * authentication, tunnel, center, LLM call, inference, or wakeup.
 */

/** A Bot member of a scope; members are always Bots, never the human owner. */
export interface MessageMember {
  deviceId: string;
  botId: string;
}

/** Message author: a Bot, or the single human owner (room public messages only). */
export type MessageAuthor =
  | { kind: 'bot'; botId: string }
  | { kind: 'user' };

export interface MessageScope {
  scopeId: string;
  kind: 'dm' | 'room';
  revision: number;
  members: MessageMember[];
}

export interface PublishMessageInput {
  messageId: string;
  scopeId: string;
  author: MessageAuthor;
  category: 'public' | 'notice' | 'request' | 'reply';
  text: string;
  replyTo?: string | null;
}

/** Optional local publication fence; not part of the message envelope or fingerprint. */
export interface MessagePublishGuard {
  /** Origin work scope whose input was observed; may differ from the publication target. */
  scopeId: string;
  /** Non-negative safe integer source localId watermark, not a token count or native EntryId. */
  afterLocalId: number;
}

export interface MessageEnvelope {
  protocolVersion: 1;
  messageId: string;
  sourceDeviceId: string;
  streamId: string;
  sequence: number;
  scopeId: string;
  revision: number;
  author: MessageAuthor;
  category: 'public' | 'notice' | 'request' | 'reply';
  rootId: string;
  replyTo: string | null;
  text: string;
  /** Whole canonical scope-revision member list, frozen with the message; not caller-chosen. */
  targets: MessageMember[];
  createdAt: string;
}

export interface MessagePeer {
  deviceId: string;
}

export interface MessageAck {
  protocolVersion: 1;
  messageId: string;
  sourceDeviceId: string;
  recipientDeviceId: string;
  digest: string;
  storedAt: string;
}

export interface StoredMessage {
  localId: number;
  message: MessageEnvelope;
  digest: string;
  storedAt: string;
  /** Unique rootId/replyTo IDs (excluding own root) not yet stored in the same scope, computed at read time. */
  missingRefs: string[];
}

export interface MessageCursor {
  deviceId: string;
  kind: 'history' | 'inbox' | 'outbox';
  key: string;
  afterLocalId: number;
  afterTargetDeviceId?: string;
}

export interface MessagePageOptions {
  limit?: number;
  cursor?: MessageCursor | null;
}

export interface MessageInboxOptions extends MessagePageOptions {
  /** Filter frozen Bot targets by scope before paging; omission preserves the legacy inbox. */
  scopeId?: string;
}

export interface MessageOutboxOptions extends MessagePageOptions {
  scopeId?: string;
  targetDeviceId?: string;
}

export interface MessageStreamStatus {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  streamId: string;
  contiguous: number;
  highest: number;
  gaps: { from: number; to: number }[];
  gapsTruncated: boolean;
}

export interface MessageHistoryPage {
  deviceId: string;
  scopeId: string;
  items: StoredMessage[];
  nextCursor: MessageCursor | null;
  /** Only streams represented by items on this page. */
  streams: MessageStreamStatus[];
}

export interface MessageInboxItem extends StoredMessage {
  selfEcho: boolean;
}

export interface MessageInboxPage {
  deviceId: string;
  botId: string;
  items: MessageInboxItem[];
  nextCursor: MessageCursor | null;
}

/** Direct counterpart replies to this local Bot's DM request; full immutable messages, not previews. */
export interface MessageRepliesPage {
  botId: string;
  requestMessageId: string;
  scopeId: string;
  items: MessageInboxItem[];
  /** kind:'inbox', key bound to this Bot/request and device; not a normal inbox cursor. */
  nextCursor: MessageCursor | null;
}

export interface MessageOutboxPage {
  deviceId: string;
  items: { targetDeviceId: string; message: MessageEnvelope }[];
  nextCursor: MessageCursor | null;
}

export interface MessageDeliveryStatus {
  messageId: string;
  targets: {
    deviceId: string;
    state: 'stored' | 'pending' | 'acked';
    acknowledgedAt: string | null;
  }[];
}

/**
 * Module 12 types: managed scope metadata (one authority Host creates/updates
 * the membership revision), metadata deliveries, and authenticated replica
 * repair. History is served only to known scope peers at a frozen revision;
 * peer stream observations never imply global completeness or online liveness.
 */

/** Managed scope create input; the store generates the scopeId inside its transaction. */
export interface ScopeCreateInput {
  requestId: string;
  kind: 'room' | 'dm';
  members: MessageMember[];
}

/** Managed scope update input; scopeId is a separate argument. */
export interface ScopeUpdateInput {
  requestId: string;
  expectedRevision: number;
  members: MessageMember[];
}

/** Canonical fixed-order record; authorityDeviceId is null only for legacy unmanaged scopes. */
export interface ScopeRecord {
  scope: MessageScope;
  authorityDeviceId: string | null;
}

/**
 * Managed scope state. delivery is present only when this Host is the authority
 * for the current/requested revision AND a local create/update operation exists
 * for that revision; a peer-recovered authority revision has no original
 * operation/delivery rows, so delivery is null even though isAuthority remains
 * true (no receipts are inferred or rebuilt). fullyAcknowledged is metadata
 * receipt only, not model/message completion.
 */
export interface ScopeInfo {
  scope: MessageScope;
  authorityDeviceId: string | null;
  isAuthority: boolean;
  delivery: {
    fullyAcknowledged: boolean;
    targets: {
      deviceId: string;
      state: 'pending' | 'acked';
      acknowledgedAt: string | null;
      lastErrorCode: string | null;
    }[];
  } | null;
}

export interface ScopeListCursor {
  deviceId: string;
  afterScopeId: string;
}

export interface ScopeListOptions {
  limit?: number;
  cursor?: ScopeListCursor | null;
}

export interface ScopeListPage {
  deviceId: string;
  items: ScopeInfo[];
  nextCursor: ScopeListCursor | null;
}

/** Scope revision acknowledgement; lowercase SHA-256 hex digest, peer identity supplied separately. */
export interface ScopeAck {
  scopeId: string;
  revision: number;
  digest: string;
}

export interface ScopeOfferCursor {
  scopeId: string;
  revision: number;
  targetDeviceId: string;
}

export interface ScopeOfferOptions {
  limit?: number;
  cursor?: ScopeOfferCursor | null;
}

export interface ScopeOfferPage {
  items: { targetDeviceId: string; record: ScopeRecord; digest: string }[];
  nextCursor: ScopeOfferCursor | null;
}

export interface InventoryCursor {
  deviceId: string;
  requesterDeviceId: string;
  scopeId: string;
  afterSourceDeviceId: string;
  afterStreamId: string;
}

export interface InventoryQuery {
  scopeId: string;
  limit?: number;
  cursor?: InventoryCursor | null;
}

/** Peer-observed stream holdings; contiguous <= count <= highest, never a global completeness guarantee. */
export interface ReplicaStream {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  streamId: string;
  contiguous: number;
  highest: number;
  count: number;
}

export interface InventoryPage {
  scopeId: string;
  items: ReplicaStream[];
  nextCursor: InventoryCursor | null;
}

/** Replica history query; pagination is by source sequence, not localId. */
export interface ReplicaHistoryQuery {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  afterSequence?: number;
  throughSequence: number;
  limit?: number;
}

/**
 * Authenticated known-peer history page for one frozen revision. Envelopes are
 * canonical and strict-ascending by source sequence; nextAfterSequence is null
 * on empty or exhausted pages and otherwise equals the last returned envelope.
 */
export interface ReplicaHistoryPage {
  record: ScopeRecord;
  sourceDeviceId: string;
  afterSequence: number;
  throughSequence: number;
  items: MessageEnvelope[];
  nextAfterSequence: number | null;
}

/** Missing-range query; no limit field. */
export interface MissingRangeQuery {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  afterSequence: number;
  throughSequence: number;
}

export interface MissingRange {
  from: number;
  to: number;
}

export interface ReplicaListCursor {
  deviceId: string;
  scopeId: string;
  afterPeerDeviceId: string;
  afterSourceDeviceId: string;
  afterStreamId: string;
}

export interface ReplicaListOptions {
  limit?: number;
  cursor?: ReplicaListCursor | null;
}

/**
 * Observed peer replica rows; no row means unknown, never inferred complete/offline.
 */
export interface ReplicaListPage {
  deviceId: string;
  scopeId: string;
  items: {
    peerDeviceId: string;
    stream: ReplicaStream;
    observedAt: string;
    lastScannedAt: string | null;
    lastErrorCode: string | null;
  }[];
  nextCursor: ReplicaListCursor | null;
}

/** Atomic replica history import result; nextAfterSequence echoes the imported page. */
export interface ImportReplicaHistoryResult {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  imported: number;
  duplicates: number;
  nextAfterSequence: number | null;
}

/** Room-public user message input; author/category/source are injected by the normalizer. */
export interface UserMessageInput {
  messageId: string;
  text: string;
  replyTo?: string | null;
}

export interface MessageLog {
  readonly deviceId: string;
  readonly dataRoot: string;
  installScope(input: MessageScope): MessageScope;
  getScope(scopeId: string, revision?: number): MessageScope | null;
  listScopes(): MessageScope[];
  /**
   * Bot-only guard: atomically check origin membership; newer targeted non-self events cause STALE_INPUT.
   * Same-ID/fingerprint retries return the stored receipt before DB guard checks.
   * Omit guard for legacy behavior; null is invalid.
   */
  publish(input: PublishMessageInput, guard?: MessagePublishGuard): StoredMessage;
  getMessage(messageId: string): StoredMessage | null;
  receive(
    peer: MessagePeer,
    envelope: MessageEnvelope,
  ): { message: StoredMessage; ack: MessageAck; duplicate: boolean };
  acknowledge(peer: MessagePeer, ack: MessageAck): MessageDeliveryStatus;
  history(scopeId: string, options?: MessagePageOptions): MessageHistoryPage;
  inbox(botId: string, options?: MessageInboxOptions): MessageInboxPage;
  /** Passive, authorized direct replyTo query; default limit 50, maximum 200. */
  replies(botId: string, requestMessageId: string, options?: MessagePageOptions): MessageRepliesPage;
  outbox(options?: MessageOutboxOptions): MessageOutboxPage;
  deliveryStatus(messageId: string): MessageDeliveryStatus;
  streamStatus(scopeId: string, revision: number, sourceDeviceId: string): MessageStreamStatus | null;
  /* Module 12: managed scope and replica facade methods. */
  createScope(input: ScopeCreateInput): ScopeInfo;
  updateScope(scopeId: string, input: ScopeUpdateInput): ScopeInfo;
  /** Latest/requested state; rejects SCOPE_NOT_FOUND when missing, never returns null. */
  getScopeState(scopeId: string, revision?: number): ScopeInfo;
  listScopeStates(options?: ScopeListOptions): ScopeListPage;
  getScopeRecord(scopeId: string, revision?: number): ScopeRecord | null;
  /** Commits the offer and returns the ScopeAck to send back to the peer. */
  acceptScopeOffer(peer: MessagePeer, record: ScopeRecord): ScopeAck;
  acknowledgeScope(peer: MessagePeer, ack: ScopeAck): void;
  recordScopeError(peer: MessagePeer, ack: ScopeAck, code: string): void;
  scopeOffers(options?: ScopeOfferOptions): ScopeOfferPage;
  replicaInventory(peer: MessagePeer, query: InventoryQuery): InventoryPage;
  /** Authenticated known-peer, frozen-revision history page. */
  replicaHistory(peer: MessagePeer, query: ReplicaHistoryQuery): ReplicaHistoryPage;
  nextMissingRange(query: MissingRangeQuery): MissingRange | null;
  listScopeReplicas(scopeId: string, options?: ReplicaListOptions): ReplicaListPage;
  listReplicaPeers(scopeId: string): string[];
  recordReplicaInventory(peer: MessagePeer, query: InventoryQuery, page: InventoryPage): void;
  importReplicaHistory(peer: MessagePeer, query: ReplicaHistoryQuery, page: ReplicaHistoryPage): ImportReplicaHistoryResult;
  /** code null or a stable uppercase/underscore code; records a requested-interval scan only. */
  recordReplicaScan(peer: MessagePeer, query: ReplicaHistoryQuery, code?: string | null): void;
  close(): void;
}

export function openMessageLog(options: { dataRoot: string }): MessageLog;

/**
 * Module 8 types: authenticated device relay + Host message delivery. The
 * centre stores device registration only (relay.sqlite); delivery reuses the
 * module 7 durable outbox. MessageDeliveryStatus above remains the module 7
 * ledger DTO; DeliveryPumpStatus is separate volatile diagnostics.
 */

export interface RelayDevice {
  deviceId: string;
  credentialVersion: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface RelayListActiveOptions {
  limit?: number;
  cursor?: { afterDeviceId: string } | null;
}

export interface RelayListActivePage {
  items: RelayDevice[];
  nextCursor: { afterDeviceId: string } | null;
}

export interface RelayRegistryInput {
  deviceId: string;
  token: string;
}

export interface RelayRegistry {
  readonly dataRoot: string;
  register(input: RelayRegistryInput): RelayDevice;
  rotate(input: RelayRegistryInput): RelayDevice;
  revoke(deviceId: string): RelayDevice;
  get(deviceId: string): RelayDevice | null;
  list(): RelayDevice[];
  /** Active registrations only, keyset-paged by UTF-8 BINARY deviceId. */
  listActive(options?: RelayListActiveOptions): RelayListActivePage;
  authenticate(deviceId: string, token: string): RelayDevice | null;
  close(): void;
}

export function openRelayRegistry(options: { dataRoot: string }): RelayRegistry;

export interface RelayServerStatus {
  onlineDeviceIds: string[];
  pendingConnections: number;
}

export interface OpenRelayServerOptions {
  dataRoot: string;
  port?: number;
  listenHost?: string;
  tls?: { cert: string; key: string };
}

export interface RelayServer {
  readonly url: string;
  getStatus(): RelayServerStatus;
  close(): Promise<void>;
}

export function openRelayServer(options: OpenRelayServerOptions): Promise<RelayServer>;

export interface DeliveryPumpProblem {
  code: string;
  targetDeviceId: string | null;
  messageId: string | null;
  at: string;
}

export interface DeliveryPumpStatus {
  inFlight: number;
  lastProblem: DeliveryPumpProblem | null;
}

export type DeviceLinkPhase = 'connecting' | 'online' | 'backoff' | 'blocked' | 'closed';

export interface ScopeDeliveryStatus {
  online: boolean;
  inFlight: number;
  /** Transient diagnostics; scopeId/targetDeviceId are null on general storage failure; no timestamp field. */
  lastProblem: { scopeId: string | null; targetDeviceId: string | null; code: string } | null;
}

export interface ReplicaSyncStatus {
  online: boolean;
  inFlight: number;
  activePairs: number;
  /** Transient diagnostics; scopeId/peerDeviceId are null on general storage failure; no timestamp field. */
  lastProblem: { scopeId: string | null; peerDeviceId: string | null; code: string } | null;
}

export interface DeviceLinkStatus {
  deviceId: string;
  phase: DeviceLinkPhase;
  attempt: number;
  lastError: string | null;
  delivery: DeliveryPumpStatus;
  scopeDelivery: ScopeDeliveryStatus;
  replicaSync: ReplicaSyncStatus;
}

export interface OpenDeviceLinkOptions {
  dataRoot: string;
  url: string;
  token: string;
  ca?: string;
  /** Optional local loopback Control API pair; when set, hello carries role:'host',controlProtocol:2 and the ready echo must carry controlProtocol:2. */
  control?: { url: string; token: string };
  onStatus?: (status: DeviceLinkStatus) => void;
}

export interface DeviceLink {
  readonly deviceId: string;
  getStatus(): DeviceLinkStatus;
  wake(): void;
  close(): Promise<void>;
}

export function openDeviceLink(options: OpenDeviceLinkOptions): Promise<DeviceLink>;

/**
 * Module 9 types: authenticated remote Host JSON control over the module 8
 * relay. The Node client opens an explicit 'client' role connection; the
 * target Host remains the sole authority for Bot cwd/create, inference,
 * tools and history. Module 14 extends the fixed v1 ten with 25 v2 methods
 * (work-context, scope, memory, model catalog).
 */

export type RemoteControlOutcome = 'not-sent' | 'unconfirmed' | 'responded';

/** Fixed 35 JSON methods (10 legacy v1 + 25 v2 additions); params/results reuse the existing DTOs above. */
export interface RemoteControlMethodMap {
  getHostInfo: { params: Record<string, never>; result: ControlHostInfo };
  listBots: { params: Record<string, never>; result: BotRecord[] };
  createBot: { params: CreateBotInput; result: BotRecord };
  getBot: { params: { botId: string }; result: BotRecord };
  findByRequest: { params: { requestId: string }; result: BotRecord };
  submit: { params: { botId: string; requestId: string; text: string }; result: PrimarySubmission };
  getSubmission: { params: { botId: string; requestId: string }; result: PrimarySubmission };
  history: { params: { botId: string; limit?: number; cursor?: Record<string, unknown> | null }; result: HistoryPage };
  abort: { params: { botId: string }; result: { botId: string } };
  contextStatus: { params: { botId: string }; result: ContextStatus };
  /* Module 14 v2 additions; memory wire params are always {botId,input}. */
  getModelCatalog: { params: Record<string, never>; result: ModelCatalog };
  getWorkContext: { params: { botId: string; scopeId: string }; result: WorkContextRecord };
  syncWorkContext: { params: { botId: string; scopeId: string; input?: WorkSyncOptions }; result: WorkSyncResult };
  workHistory: { params: { botId: string; scopeId: string; limit?: number; cursor?: WorkHistoryCursor | null }; result: WorkHistoryPage };
  workContextStatus: { params: { botId: string; scopeId: string }; result: WorkContextStatus };
  getWorkActivity: { params: { botId: string; scopeId: string }; result: WorkActivity };
  stopWork: { params: { botId: string; scopeId: string }; result: WorkActivity };
  resumeWork: { params: { botId: string; scopeId: string }; result: WorkActivity };
  listScopeStates: { params: { limit?: number; cursor?: ScopeListCursor | null }; result: ScopeListPage };
  createScope: { params: { input: ScopeCreateInput }; result: ScopeInfo };
  getScopeState: { params: { scopeId: string }; result: ScopeInfo };
  updateScope: { params: { scopeId: string; input: ScopeUpdateInput }; result: ScopeInfo };
  publishUserMessage: { params: { scopeId: string; input: UserMessageInput }; result: StoredMessage };
  listScopeReplicas: { params: { scopeId: string; limit?: number; cursor?: ReplicaListCursor | null }; result: ReplicaListPage };
  scopeHistory: { params: { scopeId: string; limit?: number; cursor?: MessageCursor | null }; result: MessageHistoryPage };
  getScopeMessage: { params: { scopeId: string; messageId: string }; result: StoredMessage };
  getScopeMessageDelivery: { params: { scopeId: string; messageId: string }; result: MessageDeliveryStatus };
  memoryStatus: { params: { botId: string; input?: MemoryStatusInput }; result: MemoryStatus };
  recallMemory: { params: { botId: string; input: MemoryQueryInput }; result: MemoryRecallResult };
  reflectMemory: { params: { botId: string; input: MemoryQueryInput }; result: MemoryReflectResult };
  retainMemory: { params: { botId: string; input: MemoryRetainInput }; result: MemoryRetainReceipt };
  getMemory: { params: { botId: string; input: MemoryLookupInput }; result: MemoryGetResult };
  getMemorySource: { params: { botId: string; input: MemorySourceInput }; result: MemorySourceResult };
  correctMemory: { params: { botId: string; input: MemoryCorrectionInput }; result: MemoryCorrectionReceipt };
  retryMemory: { params: { botId: string; input: MemoryRetryInput }; result: MemoryReceipt };
}

export interface OpenRemoteControlOptions {
  deviceId: string;
  url: string;
  token: string;
  ca?: string;
  /** Startup AbortSignal; applies only until open() resolves. */
  signal?: AbortSignal;
}

export interface DevicesDirectoryItem {
  deviceId: string;
  online: boolean;
  controlProtocol: 0 | 1 | 2;
  scopeProtocol: 0 | 1;
}

export interface DevicesDirectoryPage {
  items: DevicesDirectoryItem[];
  nextCursor: { afterDeviceId: string } | null;
}

export type LiveTarget =
  | { kind: 'primary'; botId: string }
  | { kind: 'work'; botId: string; scopeId: string };

/**
 * Remote live snapshot: strictly a primary snapshot (no scopeId, non-null
 * conversationId) or a work snapshot; an illegal primary-null blend is never
 * representable. The primary arm is discriminated by the absence of scopeId
 * (scopeId?: never), so consumers can branch on the presence of scopeId.
 */
export type RemoteLiveSnapshot = (BotLiveSnapshot & { scopeId?: never }) | WorkLiveSnapshot;

export interface RemoteLiveEnd {
  type: 'end';
  reason: BotWatchEndReason;
}

export interface RemoteControl {
  readonly deviceId: string;
  call<K extends keyof RemoteControlMethodMap>(
    targetDeviceId: string,
    method: K,
    params: RemoteControlMethodMap[K]['params'],
    options?: { signal?: AbortSignal },
  ): Promise<RemoteControlMethodMap[K]['result']>;
  /** Active device directory over the same authenticated relay connection; reads only. */
  listDevices(options?: { limit?: number; cursor?: { afterDeviceId: string } | null; signal?: AbortSignal }): Promise<DevicesDirectoryPage>;
  /** Live preview subscription; error ends throw RemoteControlError instead of being yielded. */
  live(targetDeviceId: string, target: LiveTarget, options?: { signal?: AbortSignal }): AsyncIterable<RemoteLiveSnapshot | RemoteLiveEnd>;
  close(): void;
}

export function openRemoteControl(options: OpenRemoteControlOptions): Promise<RemoteControl>;

export class RemoteControlError extends Error {
  constructor(code: string, outcome: RemoteControlOutcome);
  readonly code: string;
  readonly outcome: RemoteControlOutcome;
}

/**
 * Module 14 types: client-side pending outbox for fixed business operations.
 */

export type PendingState = 'pending' | 'sending' | 'unconfirmed' | 'accepted' | 'rejected';

export type PendingEnqueueInput =
  | { kind: 'primary'; targetDeviceId: string; botId: string; requestId: string; text: string }
  | { kind: 'room'; targetDeviceId: string; scopeId: string; messageId: string; text: string; replyTo?: string | null };

export interface PendingRecordBase {
  id: string;
  deviceId: string;
  targetDeviceId: string;
  text: string;
  state: PendingState;
  receipt: Record<string, unknown> | null;
  lastError: { code: string; outcome: RemoteControlOutcome } | null;
  createdAt: string;
  updatedAt: string;
}

export type PendingRecord =
  | (PendingRecordBase & { kind: 'primary'; botId: string; requestId: string })
  | (PendingRecordBase & { kind: 'room'; scopeId: string; messageId: string; replyTo: string | null });

export interface PendingCursor {
  deviceId: string;
  state: PendingState | null;
  afterId: string;
}

export interface PendingListOptions {
  state?: PendingState | null;
  limit?: number;
  cursor?: PendingCursor | null;
}

export interface PendingListPage {
  items: PendingRecord[];
  nextCursor: PendingCursor | null;
}

/** Fixed injected transport: four business operations only, never an arbitrary proxy. */
export interface PendingCall {
  (targetDeviceId: string, method: 'submit', params: { botId: string; requestId: string; text: string }, options?: { signal?: AbortSignal }): Promise<PrimarySubmission>;
  (targetDeviceId: string, method: 'getSubmission', params: { botId: string; requestId: string }, options?: { signal?: AbortSignal }): Promise<PrimarySubmission | null>;
  (targetDeviceId: string, method: 'publishUserMessage', params: { scopeId: string; input: UserMessageInput }, options?: { signal?: AbortSignal }): Promise<StoredMessage>;
  (targetDeviceId: string, method: 'getScopeMessage', params: { scopeId: string; messageId: string }, options?: { signal?: AbortSignal }): Promise<StoredMessage | null>;
}

export interface PendingClient {
  enqueue(input: PendingEnqueueInput): Promise<PendingRecord>;
  get(id: string): Promise<PendingRecord | null>;
  list(options?: PendingListOptions): Promise<PendingListPage>;
  send(id: string, options?: { signal?: AbortSignal }): Promise<PendingRecord>;
  reconcile(id: string, options?: { signal?: AbortSignal }): Promise<PendingRecord>;
  close(): Promise<void>;
}

export function openPendingClient(options: { dataRoot: string; deviceId: string; call: PendingCall }): PendingClient;
