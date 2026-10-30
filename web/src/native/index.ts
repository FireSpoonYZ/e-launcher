import type {
  BotExtensionSnapshot,
  BotExtensions,
  BotSoul,
  ExtensionCatalog,
  HindsightOptions as SharedHindsightOptions,
  HistoryEntryChunk,
  RuntimeExtensionsConfig,
} from '../../../host-core/index.js';
import { createTauriBotHost, mobileLocalRequest } from './tauri-host';

export interface PluginListenerHandle { remove(): Promise<void> }
type ListenerPromise = Promise<PluginListenerHandle>;

export type HostPhase = 'stopped'|'starting'|'running'|'stopping'|'failed';
export type HostSnapshot = { phase: HostPhase; deviceId: string|null; lastUpdated: number; errorCode: string|null; restartRequired: boolean; workspace?: string|null };
export type CenterConnectionStatus = { state: 'disconnected' | 'connecting' | 'ready'; centerUrl: string; appliedRevision: number | null; error: {code: string; message: string} | null };
export type CenterSettings = { url: string; ca: string; tokenConfigured: boolean };
export type HostStatus = HostSnapshot & { center?: CenterConnectionStatus };
export type HostSettingsModel = {
  id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number;
  /** Pass-through 字段原样交给 SDK/原生工具，Host 回读时可能已按规范补全默认值。 */
  input?: ('text'|'image')[];
  cost?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string|null>;
  inputLimits?: Record<string, unknown>;
};
export type HostProviderConfig = { id: string; name?: string; api?: string; baseUrl: string; apiKeyEnv?: string; models: HostSettingsModel[] };
export type HostRelayConfig = { url: string; tokenEnv: string; caFile?: string };
// Canonical extension/SOUL DTOs are declared once in host-core/index.d.ts and
// re-exported here for the local Host UI (types only, no runtime import).
export type { BotExtensionSnapshot, BotExtensions, BotSoul, ExtensionCatalog, RuntimeExtensionsConfig };
/** Connection config; unset timeouts keep the Host defaults (30s / reflect 120s). */
export type HostHindsightConfig = SharedHindsightOptions & { timeoutMs?: number; reflectTimeoutMs?: number };
export type HostRuntimeSettings = {
  providers: HostProviderConfig[];
  defaultModel?: string | null;
  /** 默认思考档位；缺省/null 交给 SDK 默认值。 */
  thinkingLevel?: string | null;
  /** Canonical extension config; legacy `hindsight` may still appear on readback. */
  extensions?: RuntimeExtensionsConfig;
  hindsight?: HostHindsightConfig;
  bashPath?: string;
  toolPaths?: {rg?: string; fd?: string};
};
export type HostSettings = { runtime: HostRuntimeSettings; relay: HostRelayConfig|null };
export type HostSettingsPayload = { deviceId: string; revision: number; settings: HostSettings; activeRevision?: number; restartRequired?: boolean };
export interface HostBot {
  botId: string;
  deviceId: string;
  role: string;
  description?: string;
  cwd: string;
  modelRef: string | null;
  primaryConversationId: string;
  createdAt: string;
  isPrimary?: boolean;
  lastActivityAt?: string | null;
  lastPreview?: string | null;
  archivedAt?: string | null;
}
export type HostSubmission = { botId: string; conversationId: string; requestId: string; submissionId: number; status: 'queued'|'placed'|'done'|'unanswered'; answerText: string|null; reason: string|null };
export type HostHistoryPage = { botId: string; conversationId: string; items: Array<Record<string, unknown>>; nextCursor: Record<string, unknown>|null; entryChunk?: HistoryEntryChunk };
export type HostCallResult = { type: 'result'; id: string; result: unknown };
export type HostLiveFrame = {
  type: 'snapshot'|'update'|'end';
  botId: string;
  conversationId?: string|null;
  scopeId?: string;
  sequence: number;
  reason?: string;
  changes?: Record<string, unknown>;
  state?: { history?: unknown[]; historyTruncated?: boolean; lastEntryId?: number|null; generation?: {text:string; truncated:boolean}|null; tools?: unknown[]; toolsTruncated?: boolean; busy?: boolean; queuedCount?: number };
};
export type HostFrameEvent = { observationId: string; frame?: HostLiveFrame; error?: {code:string; outcome:string; message:string} };
export type HostVoiceEngine = 'system'|'remote';
export type HostVoiceRemote = { baseUrl: string; model: string; voice: string; configured: boolean; hasApiKey?: boolean };
export type HostVoiceSettings = { sttEngine: HostVoiceEngine; ttsEngine: HostVoiceEngine; language: string; speechRate: number; stt: HostVoiceRemote; tts: HostVoiceRemote };
/** Write shape: apiKey omitted keeps the stored key, empty string clears it, a value replaces it. */
export type HostVoiceSaveInput = { sttEngine?: HostVoiceEngine; ttsEngine?: HostVoiceEngine; language?: string; speechRate?: number; stt?: HostVoiceRemote & {apiKey?: string}; tts?: HostVoiceRemote & {apiKey?: string} };
export type HostVoiceEvent = { type: 'partial'|'submitted'|'error'; botId: string; requestId: string; text?: string; receipt?: Record<string, unknown>; code?: string; outcome?: string; message?: string };

export interface BotHostPlugin {
  snapshot(): Promise<HostSnapshot>;
  status(): Promise<HostStatus>;
  centerSettings(): Promise<CenterSettings>;
  saveCenterSettings(options: {input: {url: string; deviceToken: string; ca: string}}): Promise<CenterSettings>;
  start(): Promise<{requested: boolean}>;
  stop(): Promise<{requested: boolean}>;
  settingsGet(): Promise<HostSettingsPayload>;
  settingsSet(options: {input: {expectedRevision: number; settings: HostSettings}}): Promise<HostSettingsPayload>;
  saveCredentials(options: {aliases: Record<string, unknown>}): Promise<Record<string, never>>;
  call(options: {method: string; params: Record<string, unknown>}): Promise<HostCallResult>;
  observe(options: {observationId: string; target: {kind:'primary'; botId:string} | {kind:'work'; botId:string; scopeId:string}}): Promise<{observationId: string}>;
  cancelObservation(options: {observationId: string}): Promise<Record<string, never>>;
  addListener(event: 'hostFrame', listener: (event: HostFrameEvent) => void): ListenerPromise;
  voiceSettings(): Promise<HostVoiceSettings>;
  saveVoiceSettings(options: {settings: HostVoiceSaveInput}): Promise<Record<string, never>>;
  startVoice(options: {botId: string; requestId: string}): Promise<Record<string, never>>;
  finishVoice(): Promise<Record<string, never>>;
  cancelVoice(): Promise<Record<string, never>>;
  addListener(event: 'voiceEvent', listener: (event: HostVoiceEvent) => void): ListenerPromise;}
export const BotHost: BotHostPlugin = createTauriBotHost();

export async function openCenterUrl(url: string): Promise<void> {
  if (!url) throw new Error('请先配置中心地址');
  await mobileLocalRequest('openCenter', { url });
}

export async function openCenterManagement(): Promise<void> {
  const { url } = await BotHost.centerSettings();
  await openCenterUrl(localStorage.getItem('active-center-url') ?? url);
}
