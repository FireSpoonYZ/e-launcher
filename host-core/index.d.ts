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

export interface MessageInboxPage {
  deviceId: string;
  botId: string;
  items: (StoredMessage & { selfEcho: boolean })[];
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
  publish(input: PublishMessageInput): StoredMessage;
  getMessage(messageId: string): StoredMessage | null;
  receive(
    peer: MessagePeer,
    envelope: MessageEnvelope,
  ): { message: StoredMessage; ack: MessageAck; duplicate: boolean };
  acknowledge(peer: MessagePeer, ack: MessageAck): MessageDeliveryStatus;
  history(scopeId: string, options?: MessagePageOptions): MessageHistoryPage;
  inbox(botId: string, options?: MessagePageOptions): MessageInboxPage;
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
  onStatus?: (status: DeviceLinkStatus) => void;
}

export interface DeviceLink {
  readonly deviceId: string;
  getStatus(): DeviceLinkStatus;
  wake(): void;
  close(): Promise<void>;
}

export function openDeviceLink(options: OpenDeviceLinkOptions): Promise<DeviceLink>;
