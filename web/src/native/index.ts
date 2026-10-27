import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
// Shared Host DTOs stay single-sourced in host-core; type-only, erased at build.
import type {
  BotExtensionSnapshot,
  BotExtensions,
  BotSoul,
  ExtensionCatalog,
  HindsightOptions as SharedHindsightOptions,
  RuntimeExtensionsConfig,
} from '../../../host-core/index.js';
import { createTauriBotHost } from './tauri-host';

export type ToolCall = { id: string; name: string; arguments: string };
export type Attachment = { id: string; name: string; mimeType: string; kind: 'image'|'file'; size: number; path: string };
export type Message = { id: string; role: 'system'|'user'|'assistant'|'tool'; content: string|null; toolCallId: string|null; toolCalls: ToolCall[]; attachments: Attachment[]; incomplete: boolean };
export type ConversationNode = { id: string; parentId: string|null; message: Message };
export type Conversation = { id: string; leaf: string|null; nodes: ConversationNode[]; draft: string; draftAttachments: Attachment[]; piSelection: Record<string, unknown>; archivedAt?: number };
export type ConversationSummary = { id: string; title: string; updated: number; snippet?: string; archivedAt?: number };
export type ActiveRun = { conversationId: string; requestId: string; status: string; message: string };
export type ExtensionWidget = { key: string; placement: 'aboveEditor'|'belowEditor'; lines: string[] };
export type ExtensionStatus = { key: string; text: string };
export type ExtensionNotification = { id: number; type: string; message: string };
export type TodoTask = { id: number; subject: string; status: 'pending'|'in_progress'|'completed'|'deleted' };
export type TodoSnapshot = { package: '@juicesharp/rpiv-todo'; tasks: TodoTask[]; nextId: number };
export type AskUserOption = { label: string; description: string; preview?: string };
export type AskUserQuestion = { questionIndex: number; question: string; header: string; multiSelect: boolean; options: AskUserOption[] };
export type AskUserQuestionnaire = { id: string; questions: AskUserQuestion[] };
export type AskUserAnswer =
  | { questionIndex: number; kind: 'option'; answer: string; notes?: string }
  | { questionIndex: number; kind: 'custom'; answer: string|null; notes?: string }
  | { questionIndex: number; kind: 'multi'; selected: string[]; notes?: string };
export type AskUserQuestionnaireResult = { answers: AskUserAnswer[]; globalNote?: string };
export type ExtensionUiState = {
  widgets?: ExtensionWidget[];
  statuses?: ExtensionStatus[];
  notifications?: ExtensionNotification[];
  todo?: TodoSnapshot|null;
  askUser?: AskUserQuestionnaire|null;
};
export type ChatSnapshot = { error?: string; status?: string; sequence: number; running: boolean; requestId: string|null; conversationId: string; conversation: Conversation; activeRuns: ActiveRun[]; extensionUi: ExtensionUiState };
export type QuestionnaireReply = { questionnaireId: string; accepted: boolean; message?: string };
export type NativeEvent<T = Record<string, unknown>> = { sequence?: number; type: string; conversationId?: string; requestId?: string|null; nodeId?: string|null; payload?: T; [key: string]: unknown };
export type Listener = (event: NativeEvent) => void;

type ListenerPromise = Promise<PluginListenerHandle>;

export interface ChatPlugin {
  /** Subscribe before snapshot(); retained events cover the listener/snapshot handshake. */
  addListener(event: 'chatEvent'|'catalogEvent', listener: Listener): ListenerPromise;
  snapshot(): Promise<ChatSnapshot>;
  getConversation(): Promise<Conversation>;
  markTaskRead(options: {conversationId: string}): Promise<void>;
  listConversations(options?: {query?: string}): Promise<{conversations: ConversationSummary[]}>;
  listArchivedConversations(options?: {query?: string}): Promise<{conversations: ConversationSummary[]}>;
  newConversation(): Promise<ChatSnapshot>;
  selectConversation(options: {conversationId: string}): Promise<ChatSnapshot>;
  archiveConversation(options: {conversationId: string}): Promise<ChatSnapshot>;
  restoreConversation(options: {conversationId: string}): Promise<ChatSnapshot>;
  deleteConversation(options: {conversationId: string}): Promise<ChatSnapshot>;
  saveDraft(options: {conversationId: string; text: string}): Promise<void>;
  /** UI node taps only preview locally. Call this only for explicit continue/edit. User edit selects its parent and copies text to draft. */
  selectNode(options: {conversationId: string; nodeId: string; edit?: boolean}): Promise<Conversation>;
  send(options: {conversationId: string; text: string; submissionId?: string}): Promise<{accepted: boolean; requestId: string|null}>;
  cancel(options: {conversationId: string}): Promise<void>;
  /** Rejects immediately when the conversation, run, questionnaire, answer kind, or selected option is stale/invalid. */
  submitQuestionnaire(options: {conversationId: string; requestId: string; questionnaireId: string} & AskUserQuestionnaireResult): Promise<void>;
  /** Rejects immediately when the conversation, run, or questionnaire no longer matches the active request. */
  cancelQuestionnaire(options: {conversationId: string; requestId: string; questionnaireId: string}): Promise<void>;
  catalog(options?: {refresh?: boolean}): Promise<{requestId: string}>;
  selectModel(options: {conversationId: string; providerId: string; modelId: string; thinkingLevel?: string; expectedSelection?: string}): Promise<Conversation>;
  selectThinkingLevel(options: {conversationId: string; providerId: string; modelId: string; thinkingLevel?: string; expectedSelection?: string}): Promise<Conversation>;
}

export type ConfigScope = { project?: boolean };
export type QueryOperation = 'catalog'|'test_provider'|'login'|'logout'|'packages'|'install'|'update'|'remove'|'resources'|'resource_paths'|'resource_toggle'|'mcp_file_save'|'mcp_list'|'mcp_edit'|'mcp_save'|'mcp_toggle'|'mcp_remove'|'mcp_check'|'mcp_login'|'mcp_logout';
export interface SettingsPlugin {
  addListener(event: 'settingsEvent', listener: Listener): ListenerPromise;
  /** Credentials are represented only as {configured:boolean}; runtimeEnvironment is omitted. */
  snapshot(): Promise<Record<string, unknown>>;
  schema(): Promise<{fields: Array<Record<string, unknown>>}>;
  files(options?: ConfigScope): Promise<{files: string[]}>;
  /** auth.json requires both allowSecrets and warningAccepted. */
  readFile(options: ConfigScope & {name: string; allowSecrets?: boolean; warningAccepted?: boolean}): Promise<{source: string; containsSecrets: boolean; draft?: string; draftBase?: string}>;
  saveFile(options: ConfigScope & {name: string; source: string; expected?: string}): Promise<{source: string}>;
  /** Formats JSON with native ConfigJson so number representation follows the authoritative parser. */
  formatFile(options: {source: string}): Promise<{source: string}>;
  previous(options: ConfigScope & {name: string; allowSecrets?: boolean; warningAccepted?: boolean}): Promise<{source: string}>;
  saveDraft(options: ConfigScope & {name: string; source: string; base: string}): Promise<void>;
  clearDraft(options: ConfigScope & {name: string}): Promise<void>;
  importFile(): Promise<{source: string}>;
  exportFile(options: {name: string; source: string; json?: boolean}): Promise<void>;
  settings(options?: ConfigScope & {effective?: boolean; conversationId?: string}): Promise<{settings: Record<string, unknown>; sources?: Record<string,string>; revision?: string}>;
  /** value/previous are JSON value source strings, preserving native ConfigJson/CAS behavior. */
  updateSetting(options: ConfigScope & {key: string; value: string; previous: string; field?: Record<string, unknown>}): Promise<void>;
  resetSetting(options: ConfigScope & {key: string; revision: string}): Promise<void>;
  providers(): Promise<{providers: Array<{id: string; definition: Record<string, unknown>; credentialConfigured: boolean}>; modelsRevision: string; authRevision: string}>;
  /** Opaque revisions provide CAS without exposing auth.json. */
  saveProvider(options: {providerId: string; definition: Record<string, unknown>; apiKey?: string; modelsRevision: string; authRevision: string}): Promise<void>;
  updateCredential(options: {providerId: string; apiKey?: string; authRevision: string}): Promise<void>;
  deleteProvider(options: {providerId: string; modelsRevision: string; authRevision: string}): Promise<void>;
  query(options: {operation: QueryOperation; arguments?: Record<string, unknown>}): Promise<{requestId: string; cancellable: boolean}>;
  /** Targets only this request; ended IDs and non-cancellable package mutations are no-ops. */
  cancelQuery(options: {requestId: string}): Promise<void>;
  replyAuth(options: {requestId: string; promptId: string; value?: string; cancelled?: boolean}): Promise<void>;
  publicSearch(options?: {query?: string; kind?: ''|'extension'|'skill'|'theme'|'prompt'; sort?: 'downloads'|'recent'|'name'; offset?: number}): Promise<Record<string, unknown>>;
  latestRelease(): Promise<{release: Record<string, unknown>|null}>;
}

export type DeviceState = { launchRoute: string; language: 'system'|'zh'|'en'; theme: 'system'|'light'|'dark'; background: 'circles'|'solid'|'image'; backgroundMask: number; backgroundPath?: string; canWriteSecureSettings: boolean; legacyNavigationPending: boolean; legacyNavigationStatus: string; shizukuStatus: string };
export type VoiceEngine = 'system'|'remote';
export type VoiceRemote = { baseUrl: string; model: string; voice: string; configured: boolean };
export type VoiceState = { sttEngine: VoiceEngine; ttsEngine: VoiceEngine; speakMode: 'off'|'afterVoice'|'always'; language: string; speechRate: number; stt: VoiceRemote; tts: VoiceRemote; wakeEnabled: boolean; wakeWords: string; wakeWordsDetail: string; wakeSensitivity: 'low'|'medium'|'high'; wakeStatus: string; wakeListening: boolean; assistantDefault: boolean; microphoneGranted: boolean };
export interface DevicePlugin {
  addListener(event: 'deviceEvent', listener: (state: DeviceState) => void): ListenerPromise;
  addListener(event: 'keyboardEvent', listener: (state: {visible:boolean}) => void): ListenerPromise;
  keyboardState(): Promise<{visible:boolean}>;
  state(): Promise<DeviceState>;
  apps(): Promise<{apps: Array<{label: string; packageName: string; className: string; icon: string}>}>;
  launchApp(options: {packageName: string; className: string}): Promise<void>;
  voice(options: {conversationId: string}): Promise<{conversationId: string; text: string}>;
  openVoiceConversation(options?: {conversationId?: string}): Promise<void>;
  /** Dictation for the settings test button; never touches a conversation draft. */
  listenOnce(): Promise<{text: string}>;
  /** Reads Markdown aloud with the configured engine; replaces any reading in progress. */
  speak(options: {text: string}): Promise<void>;
  stopSpeaking(): Promise<void>;
  voiceSettings(): Promise<VoiceState>;
  setVoiceSettings(options: Partial<Pick<VoiceState, 'sttEngine'|'ttsEngine'|'speakMode'|'language'|'speechRate'|'wakeWords'|'wakeSensitivity'>>): Promise<VoiceState>;
  /** Omit apiKey to keep the stored credential; pass an empty string to remove it. */
  setVoiceRemote(options: {kind: 'stt'|'tts'; baseUrl: string; model: string; voice?: string; apiKey?: string}): Promise<VoiceState>;
  /** Requests the microphone permission when enabling. */
  setWakeEnabled(options: {enabled: boolean}): Promise<VoiceState>;
  requestAssistantRole(): Promise<void>;
  chooseAttachment(options: {conversationId: string; kind: 'camera'|'image'|'file'}): Promise<{attachments: Attachment[]}>;
  removeAttachment(options: {conversationId: string; attachmentId: string}): Promise<void>;
  openAttachment(options: {attachmentId: string}): Promise<void>;
  chooseBackground(): Promise<void>;
  clearBackground(): Promise<void>;
  setAppearance(options: Partial<Pick<DeviceState, 'language'|'theme'|'background'|'backgroundMask'>>): Promise<DeviceState>;
  openSystemSettings(options: {target: 'app'|'settings'|'tts'|'assistant'}): Promise<void>;
  repairPermissions(): Promise<void>;
  share(options: {text: string; title?: string}): Promise<void>;
  openUrl(options: {url: string}): Promise<void>;
  hideKeyboard(): Promise<void>;
  close(): Promise<void>;
}

export type ScheduleRule = { repeat: 'once'|'daily'|'weekly'|'monthly'|'statutoryWorkday'|'statutoryHoliday'; time: string; weekday: number; weekdays?: number[]; monthDay: number };
export type ScheduledTaskInput = ScheduleRule & { id?: string; revision?: number; title: string; prompt: string; alarmMode?: 'alarmClock'|'exact'; vibrate?: boolean; deleteAfterRun?: boolean };
export type ScheduleCalendarInfo = { calendarNotice?: string; calendarCoverage?: string; calendarFallback?: string };
export type ScheduleSource = { sourceConversationId: string|null; sourceConversationAvailable: boolean };
export type ScheduledTask = ScheduledTaskInput & ScheduleCalendarInfo & ScheduleSource & { id: string; revision: number; enabled: boolean; createdAt: number; nextRunAt: number };
export type ScheduleRecord = ScheduleSource & { id: string; taskId: string; title: string; scheduledAt: number; startedAt: number; finishedAt: number; status: 'queued'|'starting'|'running'|'completed'|'error'|'aborted'|'skipped'; reason: string; message: string; attempt?: number; nextAttemptAt?: number; conversationId: string|null; conversationAvailable: boolean };
export type ScheduleSnapshot = { tasks: ScheduledTask[]; records: ScheduleRecord[]; exactAlarmGranted: boolean; schedulingError: string; timeZone: string; now: number; localNow: string; calendarVersion?: string };
export type SchedulePreview = ScheduleCalendarInfo & { nextRunAt: number; timeZone: string };
export interface ScheduledTasksPlugin {
  addListener(event: 'scheduleEvent', listener: () => void): ListenerPromise;
  snapshot(): Promise<ScheduleSnapshot>;
  preview(rule: ScheduleRule): Promise<SchedulePreview>;
  save(task: ScheduledTaskInput): Promise<ScheduleSnapshot>;
  setEnabled(options: {id: string; revision: number; enabled: boolean}): Promise<ScheduleSnapshot>;
  delete(options: {id: string; revision: number}): Promise<ScheduleSnapshot>;
  requestExactAlarm(): Promise<void>;
  retryScheduling(): Promise<ScheduleSnapshot>;
}
export const ScheduledTasks = registerPlugin<ScheduledTasksPlugin>('ScheduledTasks');
export const Chat = registerPlugin<ChatPlugin>('Chat');
export const NativeSettings = registerPlugin<SettingsPlugin>('Settings');
export const Device = registerPlugin<DevicePlugin>('Device');

// Module 15 BotHost plugin: native Host control. Shapes mirror the Node remote
// control protocol DTOs; credentials are never returned to the web layer.
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
export type HostBot = { botId: string; deviceId: string; role: string; cwd: string; modelRef: string|null; primaryConversationId: string; createdAt: string };
export type HostSubmission = { botId: string; conversationId: string; requestId: string; submissionId: number; status: 'queued'|'placed'|'done'|'unanswered'; answerText: string|null; reason: string|null };
export type HostHistoryPage = { botId: string; conversationId: string; items: Array<Record<string, unknown>>; nextCursor: Record<string, unknown>|null };
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

// Module 16 legacy migration: shapes mirror the Java exporter and Node core DTOs.
export type LegacyModelSelection = { provider: string | null; model: string | null; thinkingLevel: string | null };
export type LegacySourceMeta = {
  kind: string;
  applicationId: string;
  conversationId: string;
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  archivedAt: number | null;
  draftOnly: boolean;
  modelSelection: LegacyModelSelection | null;
};
export type LegacyListItem = LegacySourceMeta & { snapshotId?: string | null; sourceKey?: string | null };
export type LegacyListResult = { items: LegacyListItem[]; nextCursor: string | null };
export type LegacyTargetDefinition = { role: string; cwd: string; modelRef: string };
export type FrozenInput = { sourceKey: string; snapshotId: string; requestId: string; role: string; cwd: string; modelRef: string };
export type LegacyStatusPhase = 'missing' | 'prepared' | 'completed';
export type LegacyStatus = {
  phase: LegacyStatusPhase;
  sourceKey: string;
  requestId: string | null;
  snapshotId: string | null;
  definition: LegacyTargetDefinition | null;
  bot: HostBot | null;
};
export type LegacyCounts = { nodes: number; selectedNodes: number; sdkEntries: number; contextRecords: number; attachments: number };
// codec analyze warnings: code plus optional count (e.g. no-sdk-lineage has no count).
export type LegacyWarning = { code: string; count?: number };
export type LegacyPreview = {
  sourceKey: string;
  snapshotId: string;
  requestId: string;
  source: LegacySourceMeta;
  selectedLeafId: string | null;
  definition: LegacyTargetDefinition;
  counts: LegacyCounts;
  warnings: LegacyWarning[];
  draft: { bytes: number; attachments: number };
  existing: LegacyStatus;
};
export type LegacyDraftAttachment = { id: string; name: string; mimeType: string; kind: string; size: number; path: string; sourcePath: string; sha256: string };
export type LegacyDraftPage = {
  sourceKey: string;
  requestId: string;
  botId: string;
  snapshotId: string;
  text: string;
  textOffset: number;
  nextTextOffset: number | null;
  totalTextLength: number;
  attachments: LegacyDraftAttachment[];
  attachmentOffset: number;
  nextAttachmentOffset: number | null;
  totalAttachments: number;
};
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
  addListener(event: 'voiceEvent', listener: (event: HostVoiceEvent) => void): ListenerPromise;
  legacyList(options?: {cursor?: string | null; limit?: number}): Promise<LegacyListResult>;
  legacyPreview(options: {conversationId: string; role: string; cwd: string; modelRef: string}): Promise<LegacyPreview>;
  legacyImport(options: {input: FrozenInput}): Promise<LegacyStatus>;
  legacyStatus(options: {sourceKey: string; requestId?: string | null}): Promise<LegacyStatus>;
  legacyDraft(options: {sourceKey: string; requestId: string; textOffset?: number; attachmentOffset?: number}): Promise<LegacyDraftPage>;
  legacyDiscard(options: {sourceKey: string; snapshotId: string}): Promise<Record<string, never>>;
}
// M18: Tauri Android UI 走私有 Binder 适配器；Capacitor WebView（旧入口）行为不变。
const inTauriUi = () => (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
export const BotHost: BotHostPlugin = inTauriUi() ? createTauriBotHost() : registerPlugin<BotHostPlugin>('BotHost');
