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
  watch(botId: string, options?: { signal?: AbortSignal }): Promise<BotWatch>;
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

export interface DeviceLinkStatus {
  deviceId: string;
  phase: DeviceLinkPhase;
  attempt: number;
  lastError: string | null;
  delivery: DeliveryPumpStatus;
}

export interface OpenDeviceLinkOptions {
  dataRoot: string;
  url: string;
  token: string;
  ca?: string;
  /** Optional local loopback Control API pair; when set, hello carries role:'host',controlProtocol:1. */
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
 * tools and history. Module 10/11 work-context and activity/stop/resume
 * operations remain local-only; they do not extend these fixed 10 remote methods.
 */

export type RemoteControlOutcome = 'not-sent' | 'unconfirmed' | 'responded';

/** Fixed 10 JSON methods; params/results reuse the existing DTOs above. */
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
}

export interface OpenRemoteControlOptions {
  deviceId: string;
  url: string;
  token: string;
  ca?: string;
  /** Startup AbortSignal; applies only until open() resolves. */
  signal?: AbortSignal;
}

export interface RemoteControl {
  readonly deviceId: string;
  call<K extends keyof RemoteControlMethodMap>(
    targetDeviceId: string,
    method: K,
    params: RemoteControlMethodMap[K]['params'],
    options?: { signal?: AbortSignal },
  ): Promise<RemoteControlMethodMap[K]['result']>;
  close(): void;
}

export function openRemoteControl(options: OpenRemoteControlOptions): Promise<RemoteControl>;

export class RemoteControlError extends Error {
  constructor(code: string, outcome: RemoteControlOutcome);
  readonly code: string;
  readonly outcome: RemoteControlOutcome;
}
