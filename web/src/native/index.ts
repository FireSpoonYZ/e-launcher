import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type ToolCall = { id: string; name: string; arguments: string };
export type Attachment = { id: string; name: string; mimeType: string; kind: 'image'|'file'; size: number; path: string };
export type Message = { id: string; role: 'system'|'user'|'assistant'|'tool'; content: string|null; toolCallId: string|null; toolCalls: ToolCall[]; attachments: Attachment[]; incomplete: boolean };
export type ConversationNode = { id: string; parentId: string|null; message: Message };
export type Conversation = { id: string; leaf: string|null; nodes: ConversationNode[]; draft: string; draftAttachments: Attachment[]; piSelection: Record<string, unknown> };
export type ConversationSummary = { id: string; title: string; updated: number };
export type ActiveRun = { conversationId: string; requestId: string; status: string; message: string };
export type ChatSnapshot = { error?: string; status?: string; sequence: number; running: boolean; requestId: string|null; conversationId: string; conversation: Conversation; activeRuns: ActiveRun[] };
export type NativeEvent<T = Record<string, unknown>> = { sequence?: number; type: string; conversationId?: string; requestId?: string|null; nodeId?: string|null; payload?: T; [key: string]: unknown };
export type Listener = (event: NativeEvent) => void;

type ListenerPromise = Promise<PluginListenerHandle>;

export interface ChatPlugin {
  /** Subscribe before snapshot(); retained events cover the listener/snapshot handshake. */
  addListener(event: 'chatEvent'|'catalogEvent', listener: Listener): ListenerPromise;
  snapshot(): Promise<ChatSnapshot>;
  getConversation(): Promise<Conversation>;
  listConversations(): Promise<{conversations: ConversationSummary[]}>;
  newConversation(): Promise<ChatSnapshot>;
  selectConversation(options: {conversationId: string}): Promise<ChatSnapshot>;
  deleteConversation(options: {conversationId: string}): Promise<ChatSnapshot>;
  saveDraft(options: {conversationId: string; text: string}): Promise<void>;
  /** UI node taps only preview locally. Call this only for explicit continue/edit. User edit selects its parent and copies text to draft. */
  selectNode(options: {conversationId: string; nodeId: string; edit?: boolean}): Promise<Conversation>;
  send(options: {conversationId: string; text: string; submissionId?: string}): Promise<{accepted: boolean; requestId: string|null}>;
  cancel(options: {conversationId: string}): Promise<void>;
  catalog(options?: {refresh?: boolean}): Promise<{requestId: string}>;
  selectModel(options: {conversationId: string; providerId: string; modelId: string; thinkingLevel?: string; expectedSelection?: string}): Promise<Conversation>;
  selectThinkingLevel(options: {conversationId: string; providerId: string; modelId: string; thinkingLevel?: string; expectedSelection?: string}): Promise<Conversation>;
}

export type ConfigScope = { project?: boolean };
export type QueryOperation = 'catalog'|'test_provider'|'login'|'logout'|'packages'|'install'|'update'|'remove'|'resources'|'resource_paths'|'resource_toggle';
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
  cancelQuery(): Promise<void>;
  replyAuth(options: {requestId: string; promptId: string; value?: string; cancelled?: boolean}): Promise<void>;
  publicSearch(options?: {query?: string; kind?: ''|'extension'|'skill'|'theme'|'prompt'; offset?: number}): Promise<Record<string, unknown>>;
  latestRelease(): Promise<{release: Record<string, unknown>|null}>;
}

export type DeviceState = { launchRoute: string; language: 'system'|'zh'|'en'; theme: 'system'|'light'|'dark'; background: 'circles'|'solid'|'image'; backgroundMask: number; backgroundPath?: string; homeRole: boolean; gestureStatus: string; canWriteSecureSettings: boolean; accessibilityConnected: boolean };
export interface DevicePlugin {
  addListener(event: 'deviceEvent', listener: (state: DeviceState) => void): ListenerPromise;
  addListener(event: 'keyboardEvent', listener: (state: {visible:boolean}) => void): ListenerPromise;
  keyboardState(): Promise<{visible:boolean}>;
  state(): Promise<DeviceState>;
  apps(): Promise<{apps: Array<{label: string; packageName: string; className: string; icon: string}>}>;
  launchApp(options: {packageName: string; className: string}): Promise<void>;
  voice(): Promise<{text: string}>;
  chooseAttachment(options: {conversationId: string; kind: 'camera'|'image'|'file'}): Promise<{attachments: Attachment[]}>;
  removeAttachment(options: {conversationId: string; attachmentId: string}): Promise<void>;
  openAttachment(options: {attachmentId: string}): Promise<void>;
  chooseBackground(): Promise<void>;
  clearBackground(): Promise<void>;
  setAppearance(options: Partial<Pick<DeviceState, 'language'|'theme'|'background'|'backgroundMask'>>): Promise<DeviceState>;
  openSystemSettings(options: {target: 'app'|'home'|'accessibility'|'settings'}): Promise<void>;
  repairPermissions(): Promise<void>;
  requestHome(): Promise<DeviceState|void>;
  enableGestures(): Promise<DeviceState>;
  disableGestures(): Promise<DeviceState>;
  share(options: {text: string; title?: string}): Promise<void>;
  openUrl(options: {url: string}): Promise<void>;
  hideKeyboard(): Promise<void>;
  close(): Promise<void>;
}

export const Chat = registerPlugin<ChatPlugin>('Chat');
export const NativeSettings = registerPlugin<SettingsPlugin>('Settings');
export const Device = registerPlugin<DevicePlugin>('Device');
