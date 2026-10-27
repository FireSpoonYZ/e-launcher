import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Code2,
  Cpu,
  FolderOpen,
  Mic,
  Monitor,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Settings,
  Sparkles,
  Square,
  Star,
  Trash2,
  User,
  X,
} from 'lucide-react';
import {
  BotHost,
  type BotExtensionSnapshot,
  type BotExtensions,
  type BotSoul,
  type HostBot,
  type HostFrameEvent,
  type HostHistoryPage,
  type HostLiveFrame,
  type HostProviderConfig,
  type HostSettings,
  type HostSettingsPayload,
  type HostSnapshot,
  type HostSubmission,
  type HostVoiceEvent,
  type HostVoiceSaveInput,
  type HostVoiceSettings,
} from './native';
import { onMobileStreamFailure } from './native/tauri-host';
import type { DesktopIdentity, DesktopPanelApi } from '../../desktop/web/src/types';
import type { DesktopConnectionInput, DesktopUiProfile } from '../../host-core/desktop-client.js';
import type { DevicesDirectoryItem, ShowerTarget } from '../../host-core/index.js';
import { ShowerPreview, type ShowerCall } from './ShowerPreview';
import { Markdown } from './Markdown';
import {
  GROK_AVATAR_PRESETS,
  GROK_COLOR_PALETTE,
  GROK_EXPRESSION_LIST,
  GROK_SHAPE_ORDER,
  GrokBotAvatar,
  JARVIS_AVATAR_PRESET,
  getDefaultBotAvatarPreset,
  resetBotAvatarConfig,
  resolveBotAvatarPreset,
  saveBotAvatarConfig,
  type GrokAvatarPreset,
} from './GrokBotAvatar';
import { ErrorNotice, array, errorText, record, useAction, useText } from './ui';

const uuid = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const LOCAL_BOTS_CACHE_KEY = 'bot-hub-local-bots-v1';
const BOT_META_CACHE_KEY = 'bot-hub-bot-meta-v2';
const BOT_CLEAR_MAP_KEY = 'bot-hub-cleared-v1';
const REMOTE_PROFILES_FLAG_KEY = 'bot-hub-has-remote-v1';
const PRIMARY_ROLE_OVERRIDE_KEY = 'bot-hub-primary-name-v2';
const DEFAULT_PRIMARY_ROLE = '主助手';

const SOUL_MAX_BYTES = 65536;
const HINDSIGHT_READ_TOOLS = [
  'hindsight_recall',
  'hindsight_reflect',
  'hindsight_get',
  'hindsight_source',
  'hindsight_status',
] as const;
const HINDSIGHT_WRITE_TOOLS = [
  'hindsight_retain',
  'hindsight_correct',
  'hindsight_retry',
] as const;
const SOUL_SNIPPETS: { zh: string; en: string; text: string }[] = [
  {
    zh: '＋ 角色使命',
    en: '+ Mission',
    text: '\n## 核心角色与使命\n你是一个专注、可靠的 AI 工程与知识助手，优先给出可验证的结论与清晰步骤。\n',
  },
  {
    zh: '＋ 沟通风格',
    en: '+ Style',
    text: '\n## 沟通风格\n- 保持极简与直接，拒绝空洞套话\n- 复杂问题先给结论，再展开关键依据\n',
  },
  {
    zh: '＋ 群聊准则',
    en: '+ Room Rules',
    text: '\n## 协作准则\n- 仅在掌握关键上下文时主动给出结构化建议\n',
  },
];

const STARRED_MODELS_CACHE_KEY = 'bot-hub-starred-models-v1';

const PI_PROVIDER_PROTOCOLS = [
  { id: 'openai-completions', label: 'openai-completions (OpenAI / 通用兼容)' },
  { id: 'openai-responses', label: 'openai-responses (OpenAI Responses)' },
  { id: 'pi-messages', label: 'pi-messages (Pi Gateway 协议)' },
  { id: 'anthropic-messages', label: 'anthropic-messages (Anthropic Messages)' },
] as const;

const MODEL_PROVIDER_PRESETS: {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  apiKeyEnv: string;
  defaultModelId: string;
  modelsText: string;
}[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModelId: 'deepseek-chat',
    modelsText: 'deepseek-chat\ndeepseek-reasoner',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModelId: 'gpt-4o',
    modelsText: 'gpt-4o\ngpt-4o-mini\no3-mini',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    api: 'openai-completions',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModelId: 'claude-3-7-sonnet-latest',
    modelsText: 'claude-3-7-sonnet-latest\nclaude-3-5-haiku-latest',
  },
  {
    id: 'google',
    label: 'Gemini',
    api: 'openai-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultModelId: 'gemini-2.5-pro',
    modelsText: 'gemini-2.5-pro\ngemini-2.5-flash',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    api: 'openai-completions',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    defaultModelId: 'deepseek-ai/DeepSeek-V3',
    modelsText: 'deepseek-ai/DeepSeek-V3\ndeepseek-ai/DeepSeek-R1',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModelId: 'anthropic/claude-3.7-sonnet',
    modelsText: 'anthropic/claude-3.7-sonnet\nopenai/gpt-4o\ngoogle/gemini-2.5-pro',
  },
];

export type HubScreen =
  | 'hub'
  | 'chat'
  | 'bot-profile'
  | 'bot-edit'
  | 'bot-avatar'
  | 'bot-soul'
  | 'bot-extensions'
  | 'bot-schedules'
  | 'bot-model'
  | 'settings';

export interface UnifiedBotItem {
  /** Unique composite key: `${hostKind}:${hostId}:${botId}` */
  key: string;
  botId: string;
  primaryConversationId?: string;
  role: string;
  cwd: string;
  modelRef: string | null;
  createdAt: string;
  hostKind: 'local' | 'remote';
  hostId: string;
  hostLabel: string;
  isPrimary?: boolean;
  remoteIdentity?: DesktopIdentity;
}

interface BotPreviewMeta {
  lastText: string;
  updatedAt: number;
  unread: boolean;
  subtitle?: string;
  customName?: string;
  notifyEnabled?: boolean;
  voiceTone?: string;
  voiceSpeed?: string;
  voiceLang?: string;
  hindsightTopic?: string;
  scheduleCount?: number;
  modelOverride?: string;
}

export type BotScheduleRepeat =
  | 'once'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'statutoryWorkday'
  | 'statutoryHoliday';

export interface BotScheduleLatestRun {
  status: string;
  submissionStatus?: string;
  occurrence: number;
  finishedAt?: number;
}

export interface BotScheduleTask {
  id: string;
  revision: number;
  enabled: boolean;
  title: string;
  prompt?: string;
  repeat: BotScheduleRepeat;
  time: string;
  weekday?: number;
  weekdays?: number[];
  monthDay?: number;
  alarmMode?: 'alarmClock' | 'exact';
  vibrate?: boolean;
  deleteAfterRun?: boolean;
  nextRunAt: number;
  latestRun?: BotScheduleLatestRun | null;
}

export interface BotScheduleState {
  tasks: BotScheduleTask[];
  exactAlarmGranted: boolean;
  schedulingError: string;
  timeZone: string;
  now: number;
}

export interface BotScheduleDraft {
  id?: string;
  revision?: number;
  title: string;
  prompt: string;
  repeat: BotScheduleRepeat;
  time: string;
  weekdays: number[];
  monthDay: number;
  alarmMode: 'alarmClock' | 'exact';
  vibrate: boolean;
  deleteAfterRun: boolean;
}

const WEEKDAY_SHORT_ZH = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_SHORT_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatScheduleRepeatLabel(
  task: Pick<BotScheduleTask, 'repeat' | 'weekday' | 'weekdays' | 'monthDay'>,
  t: (zh: string, en: string) => string,
): string {
  if (task.repeat === 'once') return t('单次执行', 'Once');
  if (task.repeat === 'daily') return t('每天', 'Every day');
  if (task.repeat === 'statutoryWorkday') return t('法定工作日', 'Workdays');
  if (task.repeat === 'statutoryHoliday') return t('法定节假日', 'Holidays');
  if (task.repeat === 'monthly') {
    const day = task.monthDay ?? 1;
    return t(`每月 ${day} 日`, `Day ${day} monthly`);
  }
  if (task.repeat === 'weekly') {
    const days = (task.weekdays && task.weekdays.length > 0 ? task.weekdays : [task.weekday ?? 1])
      .slice()
      .sort((a, b) => a - b);
    if (days.join(',') === '1,2,3,4,5') return t('周一至周五', 'Mon–Fri');
    if (days.join(',') === '6,7') return t('周六日', 'Weekends');
    if (days.length === 7) return t('每天', 'Every day');
    return t(
      `每周 ${days.map(d => WEEKDAY_SHORT_ZH[(d - 1) % 7]).join('、')}`,
      `Weekly ${days.map(d => WEEKDAY_SHORT_EN[(d - 1) % 7]).join(', ')}`,
    );
  }
  return t('每天', 'Every day');
}

function formatScheduleNextRun(
  nextRunAt: number,
  timeZone: string,
  t: (zh: string, en: string) => string,
): string {
  if (!nextRunAt || nextRunAt <= 0) return t('未计划', 'Not scheduled');
  try {
    return new Intl.DateTimeFormat(t('zh-CN', 'en-US'), {
      timeZone: timeZone || undefined,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(nextRunAt);
  } catch {
    return new Date(nextRunAt).toLocaleString();
  }
}

function syncTopicIntoSoulText(soulText: string, topic: string): string {
  const cleanTopic = topic.trim();
  const blockRegex = /\n*<!-- hindsight-topic-start -->[\s\S]*?<!-- hindsight-topic-end -->\n*/g;
  const stripped = soulText.replace(blockRegex, '\n').trimEnd();
  if (!cleanTopic) return stripped ? `${stripped}\n` : '';
  const block = `\n\n<!-- hindsight-topic-start -->\n## 记忆主题 (Hindsight Topic)\n- 核心关注主题：${cleanTopic}\n- 调用 Hindsight 检索与留存长期记忆时，优先围绕上述主题组织上下文与标签。\n<!-- hindsight-topic-end -->\n`;
  return stripped ? `${stripped}${block}` : block.trimStart();
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  toolSummary?: string[];
  createdAt?: string;
}

function readLocalBotsCache(): HostBot[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_BOTS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HostBot[]) : [];
  } catch {
    return [];
  }
}

function writeLocalBotsCache(bots: HostBot[]): void {
  try {
    window.localStorage.setItem(LOCAL_BOTS_CACHE_KEY, JSON.stringify(bots));
  } catch {
    // Ignore storage errors
  }
}

function readBotMetaMap(): Record<string, BotPreviewMeta> {
  try {
    const raw = window.localStorage.getItem(BOT_META_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, BotPreviewMeta>) : {};
  } catch {
    return {};
  }
}

function writeBotMetaMap(map: Record<string, BotPreviewMeta>): void {
  try {
    window.localStorage.setItem(BOT_META_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function readClearedMap(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(BOT_CLEAR_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeClearedMap(map: Record<string, number>): void {
  try {
    window.localStorage.setItem(BOT_CLEAR_MAP_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function readHasRemoteFlag(): boolean {
  try {
    return window.localStorage.getItem(REMOTE_PROFILES_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHasRemoteFlag(hasRemote: boolean): void {
  try {
    if (hasRemote) window.localStorage.setItem(REMOTE_PROFILES_FLAG_KEY, '1');
    else window.localStorage.removeItem(REMOTE_PROFILES_FLAG_KEY);
  } catch {
    // Ignore storage errors
  }
}

function readPrimaryRoleOverride(): string {
  try {
    return window.localStorage.getItem(PRIMARY_ROLE_OVERRIDE_KEY) || DEFAULT_PRIMARY_ROLE;
  } catch {
    return DEFAULT_PRIMARY_ROLE;
  }
}

function writePrimaryRoleOverride(name: string): void {
  try {
    window.localStorage.setItem(PRIMARY_ROLE_OVERRIDE_KEY, name);
  } catch {
    // Ignore storage errors
  }
}

const CREDENTIAL_ALIASES_CACHE_KEY = 'elauncher.credential_aliases.v1';

function readCredentialAliases(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(CREDENTIAL_ALIASES_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim() !== '') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeCredentialAliases(aliases: Record<string, string>): void {
  try {
    window.localStorage.setItem(CREDENTIAL_ALIASES_CACHE_KEY, JSON.stringify(aliases));
  } catch {
    // Ignore storage errors
  }
}

const NON_CHAT_MODEL_FILTER_RE =
  /(?:^|[-_/])(embedding|text-embedding|rerank|whisper|tts|dall-e|moderation|omni-moderation|babbage|davinci)(?:$|[-_/.])/i;

async function fetchModelsClientFallback(input: {
  baseUrl: string;
  apiKey?: string;
  api?: string;
}): Promise<{ id: string; name: string; reasoning: boolean; contextWindow: number }[]> {
  const cleanBase = input.baseUrl.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = (input.apiKey ?? '').trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['x-api-key'] = token;
  }
  const urls = [`${cleanBase}/models`];
  if (!/\/v\d+(?:beta\d*)?(?:\/openai)?$/i.test(cleanBase)) {
    urls.push(`${cleanBase}/v1/models`);
  }
  let rows: unknown[] | null = null;
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErr = new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
        if (res.status === 404 && urls.length > 1) continue;
        break;
      }
      const json = (await res.json()) as Record<string, unknown> | unknown[];
      if (Array.isArray(json)) rows = json;
      else if (json && typeof json === 'object') {
        if (Array.isArray(json.data)) rows = json.data;
        else if (Array.isArray(json.models)) rows = json.models;
        else if (Array.isArray(json.result)) rows = json.result;
      }
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (!rows) {
    throw lastErr ?? new Error('无法连接服务商 /models 接口');
  }
  const seen = new Set<string>();
  const out: { id: string; name: string; reasoning: boolean; contextWindow: number }[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    let id =
      typeof item.id === 'string'
        ? item.id.trim()
        : typeof item.name === 'string'
          ? item.name.trim()
          : typeof item.model === 'string'
            ? item.model.trim()
            : '';
    if (id.startsWith('models/')) id = id.slice('models/'.length);
    if (!id || seen.has(id) || NON_CHAT_MODEL_FILTER_RE.test(id)) continue;
    seen.add(id);
    const name =
      typeof item.display_name === 'string' && item.display_name.trim()
        ? item.display_name.trim()
        : typeof item.displayName === 'string' && item.displayName.trim()
          ? item.displayName.trim()
          : id;
    const reasoning = Boolean(
      item.reasoning || /(?:reasoner|[-_/]r1\b|[-_/]o1\b|[-_/]o3\b|[-_/]o4\b|thinking|qwq)/i.test(id),
    );
    const contextWindow =
      typeof item.context_length === 'number' && item.context_length > 0 ? item.context_length : 32768;
    out.push({ id, name, reasoning, contextWindow });
  }
  return out;
}

function readStarredModels(): string[] {
  try {
    const raw = window.localStorage.getItem(STARRED_MODELS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.includes('/')) : [];
  } catch {
    return [];
  }
}

function writeStarredModels(models: string[]): void {
  try {
    window.localStorage.setItem(STARRED_MODELS_CACHE_KEY, JSON.stringify(models));
  } catch {
    // Ignore storage errors
  }
}

function formatBotListTime(
  timestampMs: number | undefined,
  createdAt: string | undefined,
  t: (zh: string, en: string) => string,
): string {
  const ms = timestampMs || (createdAt ? Date.parse(createdAt) : NaN);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 3600 * 24));
  if (diffDays >= 0 && diffDays < 7) {
    const weekdaysZh = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const weekdaysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return t(weekdaysZh[date.getDay()], weekdaysEn[date.getDay()]);
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function parseHistoryEntries(items: Array<Record<string, unknown>>, clearedAfterEntryId = 0): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const numericId = typeof item.id === 'number' ? item.id : Number(item.id);
    if (clearedAfterEntryId > 0 && Number.isFinite(numericId) && numericId <= clearedAfterEntryId) {
      continue;
    }
    // raw 条目用 model 块（含工具/思考）；Host live 投影条目只有 messages:[{role,text,truncated}]。
    const model = array<unknown>(item.model);
    const blocks = model.length > 0 ? model : array<unknown>(item.messages);
    for (let mIdx = 0; mIdx < blocks.length; mIdx++) {
      const raw = blocks[mIdx];
      if (!raw || typeof raw !== 'object') continue;
      const entry = record(raw);
      const role = entry.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = entry.content;
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolParts: string[] = [];
      if (typeof content === 'string') {
        textParts.push(content);
      } else if (typeof entry.text === 'string') {
        textParts.push(entry.text);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'string') {
            textParts.push(block);
            continue;
          }
          const part = record(block);
          if (part.type === 'text' && typeof part.text === 'string') {
            textParts.push(part.text);
          } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
            thinkingParts.push(part.thinking);
          } else if (part.type === 'toolCall' && typeof part.name === 'string') {
            toolParts.push(part.name);
          }
        }
      }
      const joinedText = textParts.join('\n').trim();
      if (!joinedText && toolParts.length === 0) continue;
      turns.push({
        id: `${String(item.id ?? i)}-${mIdx}`,
        role,
        text: joinedText,
        thinking: thinkingParts.length > 0 ? thinkingParts.join('\n') : undefined,
        toolSummary: toolParts.length > 0 ? toolParts : undefined,
      });
    }
  }
  return turns;
}

function maxHistoryEntryId(items: Array<Record<string, unknown>>): number {
  let max = 0;
  for (const item of items) {
    const id = typeof item.id === 'number' ? item.id : Number(item.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

const soulBytes = (text: string): number => {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
};

function parseBotSoul(value: unknown): BotSoul | undefined {
  const raw = record(value);
  return typeof raw.botId === 'string' &&
    typeof raw.path === 'string' &&
    typeof raw.revision === 'string' &&
    typeof raw.text === 'string'
    ? { botId: raw.botId, path: raw.path, revision: raw.revision, text: raw.text }
    : undefined;
}

function parseBotExtensionSnapshot(value: unknown): BotExtensionSnapshot | undefined {
  const raw = record(value);
  const extRaw = record(record(raw.extensions).hindsight);
  const effRaw = record(record(raw.effective).hindsight);
  const mode1 = extRaw.mode === 'read-only' || extRaw.mode === 'read-write' ? extRaw.mode : undefined;
  const mode2 = effRaw.mode === 'read-only' || effRaw.mode === 'read-write' ? effRaw.mode : undefined;
  const reason =
    effRaw.reason === 'bot-disabled' || effRaw.reason === 'host-disabled' || effRaw.reason === 'not-configured'
      ? effRaw.reason
      : null;
  if (
    typeof raw.botId !== 'string' ||
    typeof raw.revision !== 'number' ||
    typeof extRaw.enabled !== 'boolean' ||
    !mode1 ||
    typeof effRaw.enabled !== 'boolean' ||
    !mode2
  ) {
    return undefined;
  }
  return {
    botId: raw.botId,
    revision: raw.revision,
    extensions: { hindsight: { enabled: extRaw.enabled, mode: mode1 } },
    effective: { hindsight: { enabled: effRaw.enabled, mode: mode2, reason } },
  };
}

export interface HostPageProps {
  onBack?(): void;
  persistentPending?: boolean;
  connectionEpoch?: number;
  active?: boolean;
  /** Optional remote client factory injected by Tauri mobile shell. */
  getOrCreateRemoteClient?(): { api: DesktopPanelApi; invalidate(): void; dispose(): void };
  /** Optional callback to open system/legacy settings page when requested. */
  onOpenSystemSettings?(): void;
}

export function HostPage({
  connectionEpoch = 0,
  active = true,
  getOrCreateRemoteClient,
  onOpenSystemSettings,
}: HostPageProps = {}) {
  const t = useText();
  const action = useAction();

  // Screen stack navigation
  const [screen, setScreen] = useState<HubScreen>('hub');
  const [avatarReturnScreen, setAvatarReturnScreen] = useState<HubScreen>('bot-edit');
  const [subPageReturnScreen, setSubPageReturnScreen] = useState<HubScreen>('bot-profile');

  // Hidden drawers (always mounted in DOM for smooth slide-in & slide-out animation)
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);

  // Hub search
  const [searchQuery, setSearchQuery] = useState('');
  const [primaryRoleName, setPrimaryRoleName] = useState<string>(() => readPrimaryRoleOverride());

  // Local Host state (managed transparently in background)
  const [localHost, setLocalHost] = useState<HostSnapshot>();
  const [localBots, setLocalBots] = useState<HostBot[]>(() => readLocalBotsCache());
  const startingLocalRef = useRef<Promise<HostSnapshot | undefined> | null>(null);

  // Remote Host state
  const [hasRemoteConfigured, setHasRemoteConfigured] = useState<boolean>(() => readHasRemoteFlag());
  const [remoteProfiles, setRemoteProfiles] = useState<DesktopUiProfile[]>([]);
  const [remoteIdentity, setRemoteIdentity] = useState<DesktopIdentity | null>(null);
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [remoteBots, setRemoteBots] = useState<HostBot[]>([]);
  const [remoteDevices, setRemoteDevices] = useState<DevicesDirectoryItem[]>([]);
  const remoteClientRef = useRef<{ api: DesktopPanelApi; invalidate(): void; dispose(): void } | null>(null);

  // Bot preview metadata & clear cutoff map
  const [botMetaMap, setBotMetaMap] = useState<Record<string, BotPreviewMeta>>(() => readBotMetaMap());
  const [clearedMap, setClearedMap] = useState<Record<string, number>>(() => readClearedMap());
  const [avatarVersion, setAvatarVersion] = useState(0);

  // Active Bot & Chat state
  const [activeBotKey, setActiveBotKey] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<Array<Record<string, unknown>>>([]);
  const [chatLive, setChatLive] = useState<HostLiveFrame>();
  const [chatReceipt, setChatReceipt] = useState<HostSubmission>();
  const [chatDraft, setChatDraft] = useState('');
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [chatTopMenuOpen, setChatTopMenuOpen] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [clearNotice, setClearNotice] = useState('');
  const [voiceCapturing, setVoiceCapturing] = useState<{ botId: string; requestId: string }>();

  // Bot Edit / Create mode state (15847.jpg)
  const [editMode, setEditMode] = useState<'create' | 'edit'>('edit');
  const [editName, setEditName] = useState('');
  const [editSubtitle, setEditSubtitle] = useState('');
  const [editCwd, setEditCwd] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editTargetHost, setEditTargetHost] = useState<'local' | 'remote'>('local');
  const [editAvatarPreset, setEditAvatarPreset] = useState<GrokAvatarPreset>(GROK_AVATAR_PRESETS[0]);
  const [editInitialSoul, setEditInitialSoul] = useState('');
  const [editVoiceTone, setEditVoiceTone] = useState('未设置');
  const [editVoiceSpeed, setEditVoiceSpeed] = useState('1x');
  const [editVoiceLang, setEditVoiceLang] = useState('自动');

  // Avatar Picker state (15848.jpg)
  const [avatarTab, setAvatarTab] = useState<'shape' | 'expression'>('shape');
  const [draftAvatar, setDraftAvatar] = useState<GrokAvatarPreset>(GROK_AVATAR_PRESETS[0]);

  // Bot Soul & Extensions state
  const [botSoul, setBotSoul] = useState<BotSoul | null>(null);
  const [soulDraft, setSoulDraft] = useState('');
  const [soulDirty, setSoulDirty] = useState(false);
  const [botExtSnap, setBotExtSnap] = useState<BotExtensionSnapshot | null>(null);
  const [extDraft, setExtDraft] = useState<BotExtensions['hindsight']>({ enabled: false, mode: 'read-write' });
  const [extDirty, setExtDirty] = useState(false);

  // Hindsight Topic & Server Host configuration state
  const [hindsightTopicDraft, setHindsightTopicDraft] = useState('');
  const [hindsightHostUrl, setHindsightHostUrl] = useState('');
  const [hindsightApiKeyEnv, setHindsightApiKeyEnv] = useState('HINDSIGHT_API_KEY');
  const [hindsightApiKey, setHindsightApiKey] = useState('');
  const [hindsightSharedMemory, setHindsightSharedMemory] = useState(false);
  const [hindsightSettingsPayload, setHindsightSettingsPayload] = useState<HostSettingsPayload | null>(null);
  const [hindsightBankStatus, setHindsightBankStatus] = useState<{
    bankId: string;
    completed: number;
    pending: number;
    failed: number;
  } | null>(null);

  // Per-Bot Scheduled Tasks state
  const [botScheduleState, setBotScheduleState] = useState<BotScheduleState>({
    tasks: [],
    exactAlarmGranted: true,
    schedulingError: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    now: Date.now(),
  });
  const [scheduleFilter, setScheduleFilter] = useState<'all' | 'enabled' | 'paused'>('all');
  const [scheduleEditing, setScheduleEditing] = useState<'new' | 'edit' | null>(null);
  const [scheduleCustomWeekdays, setScheduleCustomWeekdays] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<BotScheduleDraft>({
    title: '',
    prompt: '',
    repeat: 'daily',
    time: '08:00',
    weekdays: [1, 2, 3, 4, 5],
    monthDay: 1,
    alarmMode: 'alarmClock',
    vibrate: true,
    deleteAfterRun: false,
  });

  // Per-Bot Model & Provider Popup Sheet state
  const [starredModels, setStarredModels] = useState<string[]>(() => readStarredModels());
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [modelSheetTarget, setModelSheetTarget] = useState<'bot-edit' | 'bot-profile'>('bot-edit');
  const [modelSheetView, setModelSheetView] = useState<'list' | 'provider'>('list');
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [providerEditId, setProviderEditId] = useState<string | null>(null);
  const [providerFormId, setProviderFormId] = useState('deepseek');
  const [providerFormName, setProviderFormName] = useState('DeepSeek');
  const [providerFormApi, setProviderFormApi] = useState('openai-completions');
  const [providerFormBaseUrl, setProviderFormBaseUrl] = useState('https://api.deepseek.com/v1');
  const [providerFormModelsText, setProviderFormModelsText] = useState('deepseek-chat\ndeepseek-reasoner');
  const [providerFormApiKey, setProviderFormApiKey] = useState('');
  const [providerFormSetDefault, setProviderFormSetDefault] = useState(true);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<
    { id: string; name: string; reasoning: boolean; contextWindow: number }[]
  >([]);
  const [discoveredSearch, setDiscoveredSearch] = useState('');
  const [discoverHint, setDiscoverHint] = useState('');

  const observeIdRef = useRef<string | undefined>(undefined);
  const remoteObserveRef = useRef<{ close(): Promise<void> } | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const updateBotMeta = useCallback((botKey: string, patch: Partial<BotPreviewMeta>) => {
    setBotMetaMap(prev => {
      const current = prev[botKey] ?? {
        lastText: '',
        updatedAt: Date.now(),
        unread: false,
        notifyEnabled: true,
      };
      const next = { ...prev, [botKey]: { ...current, ...patch } };
      writeBotMetaMap(next);
      return next;
    });
  }, []);

  // Transparently sync local bots
  const syncLocalBots = useCallback(async (snap?: HostSnapshot): Promise<HostBot[]> => {
    try {
      const currentSnap = snap ?? (await BotHost.snapshot());
      setLocalHost(currentSnap);
      if (currentSnap.phase !== 'running') return readLocalBotsCache();
      const envelope = await BotHost.call({ method: 'listBots', params: {} });
      const list = array<HostBot>(envelope.result);
      setLocalBots(list);
      writeLocalBotsCache(list);
      return list;
    } catch {
      return readLocalBotsCache();
    }
  }, []);

  const ensureLocalHostRunning = useCallback(async (): Promise<HostSnapshot | undefined> => {
    if (startingLocalRef.current) return startingLocalRef.current;
    const task = (async () => {
      try {
        let snap = await BotHost.snapshot();
        setLocalHost(snap);
        if (snap.phase === 'running') {
          await syncLocalBots(snap);
          return snap;
        }
        if (snap.phase === 'stopped' || snap.phase === 'failed') {
          await BotHost.start();
        }
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 600));
          snap = await BotHost.snapshot();
          setLocalHost(snap);
          if (snap.phase === 'running') {
            await syncLocalBots(snap);
            return snap;
          }
          if (snap.phase === 'failed') break;
        }
        return snap;
      } catch {
        return undefined;
      } finally {
        startingLocalRef.current = null;
      }
    })();
    startingLocalRef.current = task;
    return task;
  }, [syncLocalBots]);

  // Read-only initial snapshot check on mount (does not auto-spawn Local Host on cold open;
  // cached local bots render immediately and Local Host starts on first bot interaction)
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void (async () => {
      try {
        const snap = await BotHost.snapshot();
        if (!alive) return;
        setLocalHost(snap);
        if (snap.workspace && !editCwd) setEditCwd(snap.workspace);
        if (snap.phase === 'running') {
          await syncLocalBots(snap);
        }
      } catch {
        // Ignore cold read error
      }
    })();
    return () => {
      alive = false;
    };
  }, [active, connectionEpoch, syncLocalBots]);

  // Initialize Remote Client only if user previously configured remote profiles or opens settings
  const ensureRemoteApi = useCallback(async (): Promise<DesktopPanelApi | null> => {
    if (!getOrCreateRemoteClient) return null;
    if (!remoteClientRef.current) {
      remoteClientRef.current = getOrCreateRemoteClient();
      const api = remoteClientRef.current.api;
      api.subscribe(() => {
        const profiles = api.snapshot?.state.profiles ?? [];
        setRemoteProfiles(profiles);
        const hasAny = profiles.length > 0;
        setHasRemoteConfigured(hasAny);
        writeHasRemoteFlag(hasAny);
        setRemoteIdentity(api.identity);
        setRemoteConnected(api.transportConnected);
      });
    }
    try {
      const snap = await remoteClientRef.current.api.init();
      const profiles = snap.state.profiles ?? [];
      setRemoteProfiles(profiles);
      const hasAny = profiles.length > 0;
      setHasRemoteConfigured(hasAny);
      writeHasRemoteFlag(hasAny);
      return remoteClientRef.current.api;
    } catch {
      return remoteClientRef.current?.api ?? null;
    }
  }, [getOrCreateRemoteClient]);

  useEffect(() => {
    if (hasRemoteConfigured && getOrCreateRemoteClient) {
      void ensureRemoteApi();
    }
  }, [hasRemoteConfigured, getOrCreateRemoteClient, ensureRemoteApi]);

  const syncRemoteBots = useCallback(async () => {
    const api = remoteClientRef.current?.api;
    const identity = api?.identity;
    if (!api || !identity || !api.transportConnected || !identity.targetDeviceId) {
      setRemoteBots([]);
      return;
    }
    try {
      const list = await api.call(identity, 'listBots', {});
      setRemoteBots(Array.isArray(list) ? (list as HostBot[]) : []);
    } catch {
      // Keep existing remote bots on transient error
    }
  }, []);

  useEffect(() => {
    if (remoteConnected && remoteIdentity?.targetDeviceId) {
      void syncRemoteBots();
    } else {
      setRemoteBots([]);
    }
  }, [remoteConnected, remoteIdentity?.profileId, remoteIdentity?.targetDeviceId, remoteIdentity?.generation, syncRemoteBots]);

  // Build unified Bot list (Primary Jarvis + Local Bots + Remote Bots)
  const { primaryBot, listBotItems } = useMemo(() => {
    void avatarVersion;
    const remoteProfileTitle =
      remoteProfiles.find(p => p.id === remoteIdentity?.profileId)?.title ||
      remoteIdentity?.targetDeviceId ||
      t('远程节点', 'Remote');

    const allLocal: UnifiedBotItem[] = localBots.map(b => {
      const key = `local:local:${b.botId}`;
      const customName = botMetaMap[key]?.customName;
      const modelOverride = botMetaMap[key]?.modelOverride;
      return {
        key,
        botId: b.botId,
        primaryConversationId: b.primaryConversationId,
        role: customName || b.role,
        cwd: b.cwd,
        modelRef: modelOverride !== undefined ? (modelOverride || null) : b.modelRef,
        createdAt: b.createdAt,
        hostKind: 'local',
        hostId: 'local',
        hostLabel: t('本机', 'Local'),
      };
    });

    const allRemote: UnifiedBotItem[] =
      remoteConnected && remoteIdentity && remoteIdentity.targetDeviceId
        ? remoteBots.map(b => {
            const key = `remote:${remoteIdentity.profileId}:${b.botId}`;
            const customName = botMetaMap[key]?.customName;
            const modelOverride = botMetaMap[key]?.modelOverride;
            return {
              key,
              botId: b.botId,
              primaryConversationId: b.primaryConversationId,
              role: customName || b.role,
              cwd: b.cwd,
              modelRef: modelOverride !== undefined ? (modelOverride || null) : b.modelRef,
              createdAt: b.createdAt,
              hostKind: 'remote',
              hostId: remoteIdentity.profileId,
              hostLabel: remoteProfileTitle,
              remoteIdentity,
            };
          })
        : [];

    const jarvisIdx = allLocal.findIndex(
      b =>
        b.role === primaryRoleName ||
        b.role === DEFAULT_PRIMARY_ROLE ||
        b.role.toLowerCase() === 'jarvis',
    );
    let primary: UnifiedBotItem;
    const restLocal = [...allLocal];

    if (jarvisIdx >= 0) {
      primary = { ...restLocal[jarvisIdx], role: primaryRoleName, isPrimary: true };
      restLocal.splice(jarvisIdx, 1);
    } else {
      const jarvisKey = 'local:local:__jarvis__';
      const jarvisOverride = botMetaMap[jarvisKey]?.modelOverride;
      primary = {
        key: jarvisKey,
        botId: '__jarvis__',
        role: primaryRoleName,
        cwd: localHost?.workspace ?? '',
        modelRef: jarvisOverride ? jarvisOverride : null,
        createdAt: '',
        hostKind: 'local',
        hostId: 'local',
        hostLabel: t('本机', 'Local'),
        isPrimary: true,
      };
    }

    const combined = [...restLocal, ...allRemote];
    return { primaryBot: primary, listBotItems: combined };
  }, [localBots, remoteBots, remoteConnected, remoteIdentity, remoteProfiles, localHost?.workspace, primaryRoleName, botMetaMap, avatarVersion, t]);

  const activeBot = useMemo<UnifiedBotItem | null>(() => {
    if (!activeBotKey) return null;
    if (activeBotKey === primaryBot.key || activeBotKey === 'local:local:__jarvis__') return primaryBot;
    return listBotItems.find(b => b.key === activeBotKey) ?? null;
  }, [activeBotKey, primaryBot, listBotItems]);

  const filteredBotItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return listBotItems;
    return listBotItems.filter(item => {
      const meta = botMetaMap[item.key];
      return (
        item.role.toLowerCase().includes(q) ||
        item.hostLabel.toLowerCase().includes(q) ||
        (meta?.lastText ?? '').toLowerCase().includes(q) ||
        (meta?.subtitle ?? '').toLowerCase().includes(q)
      );
    });
  }, [listBotItems, searchQuery, botMetaMap]);

  const unreadCount = useMemo(() => {
    return listBotItems.filter(item => botMetaMap[item.key]?.unread).length;
  }, [listBotItems, botMetaMap]);

  const cancelActiveObservation = useCallback(() => {
    if (observeIdRef.current) {
      const id = observeIdRef.current;
      observeIdRef.current = undefined;
      void BotHost.cancelObservation({ observationId: id }).catch(() => {});
    }
    if (remoteObserveRef.current) {
      const handle = remoteObserveRef.current;
      remoteObserveRef.current = null;
      void handle.close().catch(() => {});
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const handles: { remove(): void }[] = [];
    Promise.all([
      BotHost.addListener('hostFrame', (ev: HostFrameEvent) => {
        if (!alive || ev.observationId !== observeIdRef.current) return;
        if (ev.error) {
          observeIdRef.current = undefined;
          return;
        }
        const f = ev.frame;
        if (!f) return;
        if (f.type === 'snapshot') setChatLive(f);
        else if (f.type === 'update') {
          setChatLive(prev =>
            prev && prev.type !== 'end'
              ? { ...prev, state: { ...(prev.state ?? {}), ...(f.changes ?? {}) } as HostLiveFrame['state'] }
              : prev,
          );
        } else if (f.type === 'end') {
          observeIdRef.current = undefined;
          setChatLive(f);
        }
      }),
      BotHost.addListener('voiceEvent', (ev: HostVoiceEvent) => {
        if (!alive) return;
        if (ev.type === 'submitted') {
          if (ev.receipt) {
            setChatReceipt(ev.receipt as unknown as HostSubmission);
          }
          setVoiceCapturing(undefined);
        } else if (ev.type === 'error') {
          setVoiceCapturing(undefined);
        }
      }),
    ]).then(list => {
      if (alive) handles.push(...list);
      else list.forEach(h => h.remove());
    }).catch(() => {});

    return () => {
      alive = false;
      handles.forEach(h => h.remove());
    };
  }, [connectionEpoch]);

  useEffect(() => onMobileStreamFailure(() => cancelActiveObservation()), [cancelActiveObservation]);

  // Load per-Bot Scheduled Tasks
  const loadBotSchedules = useCallback(
    async (bot: UnifiedBotItem) => {
      if (bot.hostKind !== 'local') {
        setBotScheduleState({
          tasks: [],
          exactAlarmGranted: true,
          schedulingError: '',
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
          now: Date.now(),
        });
        return;
      }
      if (bot.botId === '__jarvis__') {
        setBotScheduleState({
          tasks: [],
          exactAlarmGranted: true,
          schedulingError: '',
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
          now: Date.now(),
        });
        return;
      }
      const snap = await ensureLocalHostRunning();
      if (!snap || snap.phase !== 'running') return;
      const latestBots = await syncLocalBots(snap);
      const matched = latestBots.find(b => b.botId === bot.botId);
      const convId = bot.primaryConversationId || matched?.primaryConversationId || '';
      if (!convId) return;
      try {
        const env = await BotHost.call({
          method: 'uiScheduleTask',
          params: {
            botId: bot.botId,
            conversationId: convId,
            input: { action: 'list', limit: 50 },
          },
        });
        const raw = record(env.result);
        const tasks = array<BotScheduleTask>(raw.tasks);
        const nextState: BotScheduleState = {
          tasks,
          exactAlarmGranted: raw.exactAlarmGranted !== false,
          schedulingError: typeof raw.schedulingError === 'string' ? raw.schedulingError : '',
          timeZone:
            typeof raw.timeZone === 'string' && raw.timeZone
              ? raw.timeZone
              : Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
          now: typeof raw.now === 'number' ? raw.now : Date.now(),
        };
        setBotScheduleState(nextState);
        const enabledCount = tasks.filter(item => item.enabled !== false).length;
        updateBotMeta(bot.key, { scheduleCount: enabledCount });
      } catch {
        // Ignore transient schedule load error
      }
    },
    [ensureLocalHostRunning, syncLocalBots, updateBotMeta],
  );

  // Load Soul & Extensions (+ Hindsight Server Host & Topic) for activeBot when entering profile / edit / soul / extensions
  const loadBotSoulAndExtensions = useCallback(
    async (bot: UnifiedBotItem) => {
      const savedTopic = botMetaMap[bot.key]?.hindsightTopic ?? '';
      setHindsightTopicDraft(savedTopic);
      setHindsightApiKey('');
      setHindsightBankStatus(null);

      if (bot.hostKind === 'local') {
        try {
          const payload = await BotHost.settingsGet();
          setHindsightSettingsPayload(payload);
          const hs = payload.settings?.runtime?.extensions?.hindsight;
          const legacyCfg = payload.settings?.runtime?.hindsight;
          const cfg = hs?.config ?? legacyCfg;
          setHindsightHostUrl(cfg?.baseUrl ?? '');
          setHindsightApiKeyEnv(cfg?.apiKeyEnv || 'HINDSIGHT_API_KEY');
          setHindsightSharedMemory(Boolean(cfg?.sharedMemory));
        } catch {
          // Ignore cold settings error
        }
      }

      if (bot.botId === '__jarvis__') {
        setBotSoul({
          botId: '__jarvis__',
          path: 'SOUL.md',
          revision: 'initial',
          text: editInitialSoul,
        });
        setSoulDraft(editInitialSoul);
        setSoulDirty(false);
        setBotExtSnap(null);
        return;
      }
      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') return;
        try {
          const soulEnv = await BotHost.call({ method: 'getBotSoul', params: { botId: bot.botId } });
          const parsedSoul = parseBotSoul(soulEnv.result);
          if (parsedSoul) {
            setBotSoul(parsedSoul);
            setSoulDraft(parsedSoul.text);
            setSoulDirty(false);
          }
        } catch {
          // Ignore
        }
        try {
          const extEnv = await BotHost.call({ method: 'getBotExtensions', params: { botId: bot.botId } });
          const parsedExt = parseBotExtensionSnapshot(extEnv.result);
          if (parsedExt) {
            setBotExtSnap(parsedExt);
            setExtDraft(parsedExt.extensions.hindsight);
            setExtDirty(false);
          }
        } catch {
          // Ignore
        }
        try {
          const memEnv = await BotHost.call({
            method: 'memoryStatus',
            params: { botId: bot.botId, input: { target: { kind: 'primary' } } },
          });
          const mem = record(memEnv.result);
          if (typeof mem.bankId === 'string') {
            setHindsightBankStatus({
              bankId: mem.bankId,
              completed: typeof mem.completed === 'number' ? mem.completed : 0,
              pending: typeof mem.pending === 'number' ? mem.pending : 0,
              failed: typeof mem.failed === 'number' ? mem.failed : 0,
            });
          }
        } catch {
          // Hindsight server may not be configured or reachable yet
        }
      } else if (bot.hostKind === 'remote' && bot.remoteIdentity && remoteClientRef.current) {
        const api = remoteClientRef.current.api;
        try {
          const soulRes = await api.call(bot.remoteIdentity, 'getBotSoul', { botId: bot.botId });
          const parsedSoul = parseBotSoul(soulRes);
          if (parsedSoul) {
            setBotSoul(parsedSoul);
            setSoulDraft(parsedSoul.text);
            setSoulDirty(false);
          }
        } catch {
          // Ignore
        }
        try {
          const extRes = await api.call(bot.remoteIdentity, 'getBotExtensions', { botId: bot.botId });
          const parsedExt = parseBotExtensionSnapshot(extRes);
          if (parsedExt) {
            setBotExtSnap(parsedExt);
            setExtDraft(parsedExt.extensions.hindsight);
            setExtDirty(false);
          }
        } catch {
          // Ignore
        }
        try {
          const memRes = await api.call(bot.remoteIdentity, 'memoryStatus', {
            botId: bot.botId,
            input: { target: { kind: 'primary' } },
          });
          const mem = record(memRes);
          if (typeof mem.bankId === 'string') {
            setHindsightBankStatus({
              bankId: mem.bankId,
              completed: typeof mem.completed === 'number' ? mem.completed : 0,
              pending: typeof mem.pending === 'number' ? mem.pending : 0,
              failed: typeof mem.failed === 'number' ? mem.failed : 0,
            });
          }
        } catch {
          // Ignore
        }
      }
    },
    [botMetaMap, ensureLocalHostRunning, editInitialSoul],
  );

  // Load history and observe when entering Chat View
  const loadBotHistoryAndObserve = useCallback(
    async (bot: UnifiedBotItem) => {
      cancelActiveObservation();
      setChatLive(undefined);
      setChatReceipt(undefined);

      if (bot.hostKind === 'local') {
        if (bot.botId === '__jarvis__') {
          setChatHistory([]);
          return;
        }
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') return;
        try {
          const histEnv = await BotHost.call({ method: 'history', params: { botId: bot.botId, limit: 50 } });
          const page = histEnv.result as HostHistoryPage;
          const items = page?.items ?? [];
          setChatHistory(items);
          const turns = parseHistoryEntries(items, clearedMap[bot.key] ?? 0);
          const lastTurn = turns.at(-1);
          if (lastTurn?.text) {
            updateBotMeta(bot.key, { lastText: lastTurn.text, unread: false });
          }
        } catch {
          // Ignore
        }
        try {
          const obsId = uuid();
          observeIdRef.current = obsId;
          await BotHost.observe({ observationId: obsId, target: { kind: 'primary', botId: bot.botId } });
        } catch {
          observeIdRef.current = undefined;
        }
      } else if (bot.hostKind === 'remote' && bot.remoteIdentity && remoteClientRef.current) {
        const api = remoteClientRef.current.api;
        const identity = bot.remoteIdentity;
        try {
          const page = await api.call(identity, 'history', { botId: bot.botId, limit: 50 });
          const items = (page?.items ?? []) as unknown as Array<Record<string, unknown>>;
          setChatHistory(items);
          const turns = parseHistoryEntries(items, clearedMap[bot.key] ?? 0);
          const lastTurn = turns.at(-1);
          if (lastTurn?.text) {
            updateBotMeta(bot.key, { lastText: lastTurn.text, unread: false });
          }
        } catch {
          // Ignore
        }
        try {
          const handle = api.observe(identity, { kind: 'primary', botId: bot.botId }, ev => {
            if ('error' in ev) return;
            const frame = ev.frame as unknown as HostLiveFrame;
            if (frame.type === 'snapshot') setChatLive(frame);
            else if (frame.type === 'update') {
              setChatLive(prev =>
                prev && prev.type !== 'end'
                  ? { ...prev, state: { ...(prev.state ?? {}), ...(frame.changes ?? {}) } as HostLiveFrame['state'] }
                  : prev,
              );
            } else if (frame.type === 'end') {
              setChatLive(frame);
            }
          });
          remoteObserveRef.current = handle;
        } catch {
          remoteObserveRef.current = null;
        }
      }
    },
    [cancelActiveObservation, clearedMap, ensureLocalHostRunning, updateBotMeta],
  );

  // Poll submission receipt until complete（本机 BotHost.call 与远端 api.call 共用同一处理）
  useEffect(() => {
    if (screen !== 'chat' || !activeBot) return;
    if (!chatReceipt || (chatReceipt.status !== 'queued' && chatReceipt.status !== 'placed')) return;
    const bot = activeBot;
    const requestId = chatReceipt.requestId;
    const remoteTarget =
      bot.hostKind === 'remote' && bot.remoteIdentity && remoteClientRef.current
        ? { api: remoteClientRef.current.api, identity: bot.remoteIdentity }
        : null;
    if (bot.hostKind === 'remote' && !remoteTarget) return;
    if (bot.hostKind === 'local' && bot.botId === '__jarvis__') return;

    const readSubmission = async (): Promise<HostSubmission | null> => {
      if (bot.hostKind === 'local') {
        const env = await BotHost.call({ method: 'getSubmission', params: { botId: bot.botId, requestId } });
        return env.result as HostSubmission;
      }
      if (!remoteTarget) return null;
      return (await remoteTarget.api.call(remoteTarget.identity, 'getSubmission', {
        botId: bot.botId,
        requestId,
      })) as unknown as HostSubmission | null;
    };
    const readHistory = async (): Promise<Array<Record<string, unknown>> | null> => {
      if (bot.hostKind === 'local') {
        const env = await BotHost.call({ method: 'history', params: { botId: bot.botId, limit: 50 } });
        return (env.result as HostHistoryPage)?.items ?? null;
      }
      if (!remoteTarget) return null;
      const page = await remoteTarget.api.call(remoteTarget.identity, 'history', { botId: bot.botId, limit: 50 });
      return ((page as unknown as HostHistoryPage)?.items as Array<Record<string, unknown>>) ?? null;
    };

    let alive = true;
    const timer = window.setInterval(async () => {
      if (!alive || document.hidden) return;
      try {
        const next = await readSubmission();
        if (!alive || !next || next.requestId !== requestId) return;
        if (next.status !== 'done' && next.status !== 'unanswered') {
          setChatReceipt(next);
          return;
        }
        // 终态：先回读历史再提交 receipt，避免 receipt 重渲染 cleanup 把 alive 置 false 丢掉后续写入。
        const items = await readHistory().catch(() => null);
        if (!alive) return;
        // 回读失败也要落终态 receipt，不能停在生成中；随后同步提交，无新的异步窗口。
        setChatReceipt(next);
        if (items) setChatHistory(items);
        // 摘要只取真实答案；无答案（unanswered）保留 submit 时写入的用户消息摘要，不被历史旧文本覆盖。
        if (next.answerText) {
          updateBotMeta(bot.key, { lastText: next.answerText, updatedAt: Date.now(), unread: false });
        }
      } catch {
        // Ignore transient poll error
      }
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [screen, activeBot, chatReceipt, updateBotMeta]);

  const openBotChat = (bot: UnifiedBotItem) => {
    setActiveBotKey(bot.key);
    setChatHistory([]);
    setChatLive(undefined);
    setChatReceipt(undefined);
    setComposerMenuOpen(false);
    setChatTopMenuOpen(false);
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setRightDrawerOpen(false);
    setClearNotice('');
    updateBotMeta(bot.key, { unread: false });
    setScreen('chat');
    void loadBotHistoryAndObserve(bot);
  };

  const openBotProfile = (bot: UnifiedBotItem) => {
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setActiveBotKey(bot.key);
    setScreen('bot-profile');
    void loadBotSoulAndExtensions(bot);
    void loadBotSchedules(bot);
  };

  const openBotSchedules = (bot: UnifiedBotItem) => {
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setActiveBotKey(bot.key);
    setScheduleEditing(null);
    setScheduleFilter('all');
    setScreen('bot-schedules');
    void loadBotSchedules(bot);
  };

  const openBotEdit = (bot: UnifiedBotItem) => {
    const meta = botMetaMap[bot.key];
    const preset = resolveBotAvatarPreset(bot.key, bot.role, bot.isPrimary);
    setEditMode('edit');
    setEditName(bot.role);
    setEditSubtitle(meta?.subtitle ?? '');
    setEditCwd(bot.cwd || localHost?.workspace || '');
    setEditModel(bot.modelRef ?? '');
    setEditAvatarPreset(preset);
    setEditVoiceTone(meta?.voiceTone ?? '未设置');
    setEditVoiceSpeed(meta?.voiceSpeed ?? '1x');
    setEditVoiceLang(meta?.voiceLang ?? '自动');
    setScreen('bot-edit');
    void loadBotSoulAndExtensions(bot);
  };

  const openCreateBotPage = () => {
    const nextPreset = GROK_AVATAR_PRESETS[listBotItems.length % GROK_AVATAR_PRESETS.length];
    setEditMode('create');
    setEditName('');
    setEditSubtitle('');
    setEditCwd(localHost?.workspace ?? '');
    setEditModel('');
    setEditTargetHost('local');
    setEditAvatarPreset(nextPreset);
    setEditInitialSoul('');
    setSoulDraft('');
    setSoulDirty(false);
    setEditVoiceTone('未设置');
    setEditVoiceSpeed('1x');
    setEditVoiceLang('自动');
    setScreen('bot-edit');
    void BotHost.settingsGet()
      .then(payload => setHindsightSettingsPayload(payload))
      .catch(() => {});
  };

  const openAvatarPicker = (fromScreen: HubScreen, currentPreset: GrokAvatarPreset) => {
    setAvatarReturnScreen(fromScreen);
    setDraftAvatar({ ...currentPreset });
    setAvatarTab('shape');
    setScreen('bot-avatar');
  };

  const clearCurrentBotHistory = useCallback(() => {
    if (!activeBot) return;
    // 水位同时覆盖 raw 历史与 live 投影（lastEntryId 是最新可显示条目），避免新投影又回来。
    const liveLastEntryId = Number(chatLive?.state?.lastEntryId);
    const maxId = Math.max(
      maxHistoryEntryId(chatHistory),
      Number.isFinite(liveLastEntryId) ? liveLastEntryId : 0,
    );
    const nextCutoff = Math.max(maxId, clearedMap[activeBot.key] ?? 0, 1);
    setClearedMap(prev => {
      const updated = { ...prev, [activeBot.key]: nextCutoff };
      writeClearedMap(updated);
      return updated;
    });
    setChatHistory([]);
    setChatLive(undefined);
    setChatReceipt(undefined);
    setChatDraft('');
    setComposerMenuOpen(false);
    setChatTopMenuOpen(false);
    updateBotMeta(activeBot.key, { lastText: t('对话已清空', 'History cleared'), updatedAt: Date.now(), unread: false });
    setClearNotice(t('已清空当前对话历史', 'Conversation history cleared'));
    window.setTimeout(() => setClearNotice(''), 2500);
  }, [activeBot, chatHistory, chatLive, clearedMap, t, updateBotMeta]);

  // Materialize virtual Jarvis into a real Bot when needed
  const materializeJarvisIfNeeded = async (snap: HostSnapshot): Promise<{ botId: string; key: string }> => {
    const defaultCwd = snap.workspace || '/data/user/0/com.example.launcherprobe/files/bot-host/workspace';
    const jarvisModelRef = primaryBot.modelRef || null;
    const createdEnv = await BotHost.call({
      method: 'createBot',
      params: { requestId: uuid(), role: primaryRoleName, cwd: defaultCwd, modelRef: jarvisModelRef },
    });
    const createdBot = createdEnv.result as HostBot;
    const newKey = `local:local:${createdBot.botId}`;
    const currentAvatar = resolveBotAvatarPreset(primaryBot.key, primaryRoleName, true);
    saveBotAvatarConfig(newKey, currentAvatar);
    if (jarvisModelRef) {
      updateBotMeta(newKey, { modelOverride: jarvisModelRef });
    }
    if (editInitialSoul.trim()) {
      try {
        const soulEnv = await BotHost.call({ method: 'getBotSoul', params: { botId: createdBot.botId } });
        const s = parseBotSoul(soulEnv.result);
        if (s) {
          await BotHost.call({
            method: 'setBotSoul',
            params: { botId: createdBot.botId, input: { expectedRevision: s.revision, text: editInitialSoul } },
          });
        }
      } catch {
        // Ignore initial soul error
      }
    }
    await syncLocalBots(snap);
    setActiveBotKey(newKey);
    return { botId: createdBot.botId, key: newKey };
  };

  const sendMessage = () =>
    action.run(async () => {
      if (!activeBot) return;
      const trimmed = chatDraft.trim();
      if (!trimmed) return;

      if (trimmed === '/clear' || trimmed === '/new') {
        clearCurrentBotHistory();
        return;
      }

      setChatDraft('');
      setComposerMenuOpen(false);
      setChatTopMenuOpen(false);

      if (activeBot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') {
          setChatDraft(trimmed);
          throw new Error(t('本机服务正在启动，请稍后重试', 'Local service is starting, please try again'));
        }
        let targetBotId = activeBot.botId;
        let targetKey = activeBot.key;

        if (targetBotId === '__jarvis__') {
          const mat = await materializeJarvisIfNeeded(snap);
          targetBotId = mat.botId;
          targetKey = mat.key;
        }

        updateBotMeta(targetKey, { lastText: trimmed, updatedAt: Date.now(), unread: false });
        const reqId = uuid();
        const subEnv = await BotHost.call({
          method: 'submit',
          params: { botId: targetBotId, requestId: reqId, text: trimmed },
        });
        const receipt = subEnv.result as HostSubmission;
        setChatReceipt(receipt);

        const histEnv = await BotHost.call({ method: 'history', params: { botId: targetBotId, limit: 50 } });
        const page = histEnv.result as HostHistoryPage;
        if (page?.items) setChatHistory(page.items);
        if (!observeIdRef.current) {
          const obsId = uuid();
          observeIdRef.current = obsId;
          void BotHost.observe({ observationId: obsId, target: { kind: 'primary', botId: targetBotId } }).catch(() => {
            observeIdRef.current = undefined;
          });
        }
      } else if (activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current) {
        const api = remoteClientRef.current.api;
        const identity = activeBot.remoteIdentity;
        updateBotMeta(activeBot.key, { lastText: trimmed, updatedAt: Date.now(), unread: false });
        const receipt = await api.call(identity, 'submit', {
          botId: activeBot.botId,
          requestId: uuid(),
          text: trimmed,
        });
        setChatReceipt(receipt as unknown as HostSubmission);
        const page = await api.call(identity, 'history', { botId: activeBot.botId, limit: 50 });
        if (page?.items) setChatHistory(page.items as unknown as Array<Record<string, unknown>>);
      }
    });

  // Save in Edit Bot / Create Bot (15847.jpg "完成")
  const handleSaveBotEdit = () =>
    action.run(async () => {
      const roleName = editName.trim();
      if (!roleName) return;

      if (editMode === 'create') {
        const targetHost =
          hasRemoteConfigured && remoteConnected && remoteIdentity?.targetDeviceId ? editTargetHost : 'local';

        if (targetHost === 'local') {
          const snap = await ensureLocalHostRunning();
          if (!snap || snap.phase !== 'running') {
            throw new Error(t('正在初始化运行环境，请稍后再试', 'Initializing runtime, please try again shortly'));
          }
          const cwdToUse =
            editCwd.trim() || snap.workspace || '/data/user/0/com.example.launcherprobe/files/bot-host/workspace';
          const env = await BotHost.call({
            method: 'createBot',
            params: {
              requestId: uuid(),
              role: roleName,
              cwd: cwdToUse,
              modelRef: editModel.trim() || null,
            },
          });
          const created = env.result as HostBot;
          const key = `local:local:${created.botId}`;
          saveBotAvatarConfig(key, editAvatarPreset);
          setAvatarVersion(v => v + 1);
          updateBotMeta(key, {
            customName: roleName,
            subtitle: editSubtitle.trim(),
            lastText: editSubtitle.trim() || t('点击开始文字对话…', 'Tap to start chatting…'),
            updatedAt: Date.now(),
            unread: true,
            voiceTone: editVoiceTone,
            voiceSpeed: editVoiceSpeed,
            voiceLang: editVoiceLang,
          });
          if (soulDraft.trim()) {
            try {
              const soulEnv = await BotHost.call({ method: 'getBotSoul', params: { botId: created.botId } });
              const s = parseBotSoul(soulEnv.result);
              if (s) {
                await BotHost.call({
                  method: 'setBotSoul',
                  params: { botId: created.botId, input: { expectedRevision: s.revision, text: soulDraft } },
                });
              }
            } catch {
              // Ignore optional soul init failure
            }
          }
          await syncLocalBots(snap);
          openBotChat({
            key,
            botId: created.botId,
            role: roleName,
            cwd: created.cwd,
            modelRef: created.modelRef,
            createdAt: created.createdAt,
            hostKind: 'local',
            hostId: 'local',
            hostLabel: t('本机', 'Local'),
          });
        } else if (remoteIdentity && remoteClientRef.current) {
          const api = remoteClientRef.current.api;
          const cwdToUse = editCwd.trim() || '/tmp';
          const created = (await api.mutateIntent(remoteIdentity, 'createBot', {
            requestId: uuid(),
            role: roleName,
            cwd: cwdToUse,
            ...(editModel.trim() ? { modelRef: editModel.trim() } : {}),
          })) as unknown as HostBot;
          const key = `remote:${remoteIdentity.profileId}:${created.botId}`;
          saveBotAvatarConfig(key, editAvatarPreset);
          setAvatarVersion(v => v + 1);
          updateBotMeta(key, {
            customName: roleName,
            subtitle: editSubtitle.trim(),
            lastText: editSubtitle.trim() || t('点击开始文字对话…', 'Tap to start chatting…'),
            updatedAt: Date.now(),
            unread: true,
            voiceTone: editVoiceTone,
            voiceSpeed: editVoiceSpeed,
            voiceLang: editVoiceLang,
          });
          await syncRemoteBots();
          setScreen('hub');
        }
      } else if (activeBot) {
        // Editing existing Bot (or Primary Jarvis)
        if (activeBot.isPrimary) {
          setPrimaryRoleName(roleName);
          writePrimaryRoleOverride(roleName);
        }
        const nextModelRef = editModel.trim() || null;
        saveBotAvatarConfig(activeBot.key, editAvatarPreset);
        setAvatarVersion(v => v + 1);
        updateBotMeta(activeBot.key, {
          customName: roleName,
          subtitle: editSubtitle.trim(),
          voiceTone: editVoiceTone,
          voiceSpeed: editVoiceSpeed,
          voiceLang: editVoiceLang,
          modelOverride: nextModelRef ?? '',
        });
        if (activeBot.hostKind === 'local' && activeBot.botId !== '__jarvis__') {
          try {
            const snap = await BotHost.snapshot();
            if (snap.phase === 'running') {
              await BotHost.call({
                method: 'setBotModel',
                params: { botId: activeBot.botId, input: { modelRef: nextModelRef } },
              });
              await syncLocalBots(snap);
            }
          } catch {
            // Keep modelOverride in botMetaMap if Host is offline
          }
        } else if (activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current) {
          try {
            await remoteClientRef.current.api.call(activeBot.remoteIdentity, 'setBotModel', {
              botId: activeBot.botId,
              input: { modelRef: nextModelRef },
            });
            await syncRemoteBots();
          } catch {
            // Ignore transient remote model update failure
          }
        }
        setScreen('bot-profile');
      }
    });

  // Configured providers & models from HostSettings
  const configuredProviders = useMemo<HostProviderConfig[]>(
    () => hindsightSettingsPayload?.settings?.runtime?.providers ?? [],
    [hindsightSettingsPayload],
  );
  const globalDefaultModel = hindsightSettingsPayload?.settings?.runtime?.defaultModel ?? null;

  const allConfiguredModels = useMemo(() => {
    const items: {
      modelRef: string;
      providerId: string;
      providerName: string;
      modelId: string;
      name: string;
      reasoning: boolean;
    }[] = [];
    for (const p of configuredProviders) {
      for (const m of p.models ?? []) {
        items.push({
          modelRef: `${p.id}/${m.id}`,
          providerId: p.id,
          providerName: p.name || p.id,
          modelId: m.id,
          name: m.name || m.id,
          reasoning: Boolean(m.reasoning),
        });
      }
    }
    return items;
  }, [configuredProviders]);

  const quickModelsForBot = useMemo(() => {
    const byRef = new Map(allConfiguredModels.map(m => [m.modelRef, m]));
    const starred = starredModels
      .map(ref => byRef.get(ref) ?? {
        modelRef: ref,
        providerId: ref.split('/')[0] || 'provider',
        providerName: ref.split('/')[0] || 'provider',
        modelId: ref.slice(ref.indexOf('/') + 1) || ref,
        name: ref.slice(ref.indexOf('/') + 1) || ref,
        reasoning: false,
      });
    if (starred.length > 0) return starred.slice(0, 6);
    return allConfiguredModels.slice(0, 3);
  }, [allConfiguredModels, starredModels]);

  const toggleStarModel = useCallback((modelRef: string) => {
    setStarredModels(prev => {
      const next = prev.includes(modelRef) ? prev.filter(x => x !== modelRef) : [...prev, modelRef];
      writeStarredModels(next);
      return next;
    });
  }, []);

  const openModelPickerSheet = useCallback((target: 'bot-edit' | 'bot-profile') => {
    setModelSheetTarget(target);
    setModelSheetView('list');
    setModelSearchQuery('');
    setModelSheetOpen(true);
    void BotHost.settingsGet()
      .then(payload => setHindsightSettingsPayload(payload))
      .catch(() => {});
  }, []);

  const selectModelFromSheet = (nextModelRef: string) =>
    action.run(async () => {
      const cleanRef = nextModelRef.trim();
      if (modelSheetTarget === 'bot-edit') {
        setEditModel(cleanRef);
        setModelSheetOpen(false);
        return;
      }
      if (!activeBot) {
        setModelSheetOpen(false);
        return;
      }
      updateBotMeta(activeBot.key, { modelOverride: cleanRef });
      setEditModel(cleanRef);
      setModelSheetOpen(false);

      if (activeBot.hostKind === 'local') {
        const snap = await BotHost.snapshot();
        if (snap.phase === 'running' && activeBot.botId !== '__jarvis__') {
          await BotHost.call({
            method: 'setBotModel',
            params: { botId: activeBot.botId, input: { modelRef: cleanRef || null } },
          });
          await syncLocalBots(snap);
        }
      } else if (activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current) {
        await remoteClientRef.current.api.call(activeBot.remoteIdentity, 'setBotModel', {
          botId: activeBot.botId,
          input: { modelRef: cleanRef || null },
        });
        await syncRemoteBots();
      }
    });

  const applyProviderPreset = (presetId: string) => {
    const preset = MODEL_PROVIDER_PRESETS.find(p => p.id === presetId);
    setDiscoveredModels([]);
    setDiscoveredSearch('');
    setDiscoverHint('');
    if (!preset) {
      setProviderFormId('');
      setProviderFormName('');
      setProviderFormApi('openai-completions');
      setProviderFormBaseUrl('');
      setProviderFormModelsText('');
      setProviderFormApiKey('');
      return;
    }
    const existing = configuredProviders.find(p => p.id === preset.id);
    setProviderFormId(preset.id);
    setProviderFormName(existing?.name || preset.label);
    setProviderFormApi(existing?.api || preset.api);
    setProviderFormBaseUrl(existing?.baseUrl || preset.baseUrl);
    setProviderFormModelsText(
      existing && existing.models.length > 0
        ? existing.models.map(m => m.id).join('\n')
        : preset.modelsText,
    );
    setProviderFormApiKey('');
  };

  const openProviderFormInSheet = (provider?: HostProviderConfig) => {
    setDiscoveredModels([]);
    setDiscoveredSearch('');
    setDiscoverHint('');
    if (provider) {
      setProviderEditId(provider.id);
      setProviderFormId(provider.id);
      setProviderFormName(provider.name || provider.id);
      setProviderFormApi(provider.api || 'openai-completions');
      setProviderFormBaseUrl(provider.baseUrl);
      setProviderFormModelsText((provider.models ?? []).map(m => m.id).join('\n'));
      setProviderFormApiKey('');
      setProviderFormSetDefault(false);
    } else {
      setProviderEditId(null);
      const firstPreset = MODEL_PROVIDER_PRESETS[0];
      const existing = configuredProviders.find(p => p.id === firstPreset.id);
      setProviderFormId(firstPreset.id);
      setProviderFormName(existing?.name || firstPreset.label);
      setProviderFormApi(existing?.api || firstPreset.api);
      setProviderFormBaseUrl(existing?.baseUrl || firstPreset.baseUrl);
      setProviderFormModelsText(
        existing && existing.models.length > 0
          ? existing.models.map(m => m.id).join('\n')
          : firstPreset.modelsText,
      );
      setProviderFormApiKey('');
      setProviderFormSetDefault(!globalDefaultModel);
    }
    setModelSheetView('provider');
  };

  const toggleDiscoveredModelInForm = (modelId: string) => {
    const currentLines = providerFormModelsText
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    const exists = currentLines.includes(modelId);
    const nextLines = exists ? currentLines.filter(id => id !== modelId) : [...currentLines, modelId];
    setProviderFormModelsText(nextLines.join('\n'));
  };

  const handleDiscoverProviderModels = () =>
    action.run(async () => {
      const baseUrl = providerFormBaseUrl.trim();
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        throw new Error(t('请先填写有效的 Base URL（http:// 或 https://）', 'Please enter a valid Base URL first'));
      }
      const id = providerFormId.trim() || 'custom';
      const prevProvider = configuredProviders.find(p => p.id === id);
      const preset = MODEL_PROVIDER_PRESETS.find(p => p.id === id);
      const apiKeyEnv =
        prevProvider?.apiKeyEnv ||
        preset?.apiKeyEnv ||
        `${id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
      const effectiveApiKey = providerFormApiKey.trim() || readCredentialAliases()[apiKeyEnv] || '';

      setDiscoveringModels(true);
      setDiscoverHint('');
      try {
        let list: { id: string; name: string; reasoning: boolean; contextWindow: number }[] = [];
        let fetchedViaHost = false;
        try {
          const snap = await BotHost.snapshot();
          if (snap.phase === 'running') {
            const res = await BotHost.call({
              method: 'discoverProviderModels',
              params: {
                input: {
                  baseUrl,
                  ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
                  apiKeyEnv,
                  api: providerFormApi,
                },
              },
            });
            const payload = record(res.result);
            if (Array.isArray(payload.models)) {
              list = payload.models as { id: string; name: string; reasoning: boolean; contextWindow: number }[];
              fetchedViaHost = true;
            }
          }
        } catch (err) {
          // If Host is not running or bridge rejected before HTTP, try direct fetch fallback;
          // if Host returned an HTTP/auth error from /models, rethrow it clearly.
          const msg = errorText(err);
          if (msg.includes('拉取模型失败') || msg.includes('HTTP ')) {
            throw err;
          }
        }

        if (!fetchedViaHost) {
          list = await fetchModelsClientFallback({
            baseUrl,
            apiKey: effectiveApiKey,
            api: providerFormApi,
          });
        }

        if (list.length === 0) {
          throw new Error(t('服务商未返回任何可用对话模型', 'No chat models returned by provider'));
        }

        setDiscoveredModels(list);
        setDiscoveredSearch('');
        const currentIds = providerFormModelsText
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean);
        // When <= 12 models returned (or current textarea is empty), auto-populate/merge so it works in 1 tap
        if (currentIds.length === 0 || list.length <= 12) {
          const merged = Array.from(new Set([...currentIds, ...list.map(m => m.id)]));
          setProviderFormModelsText(merged.join('\n'));
          setDiscoverHint(
            t(
              `已自动拉取并填入 ${list.length} 个可用模型（点击下方标签可增删）`,
              `Fetched and populated ${list.length} models (tap chips to toggle)`,
            ),
          );
        } else {
          setDiscoverHint(
            t(
              `已拉取 ${list.length} 个可用模型，点击下方模型即可加入列表`,
              `Fetched ${list.length} models — tap below to add/remove`,
            ),
          );
        }
      } finally {
        setDiscoveringModels(false);
      }
    });

  const handleSaveProviderInSheet = () =>
    action.run(async () => {
      const id = providerFormId.trim();
      const baseUrl = providerFormBaseUrl.trim();
      const modelIds = providerFormModelsText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      if (!id || id.includes('/')) {
        throw new Error(t('请填写有效的服务商 ID（不含斜杠）', 'Please enter a valid Provider ID (no slashes)'));
      }
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        throw new Error(t('Base URL 必须以 http:// 或 https:// 开头', 'Base URL must start with http:// or https://'));
      }
      if (modelIds.length === 0) {
        throw new Error(t('请至少填写一个模型 ID', 'Please enter at least one Model ID'));
      }

      const currentPayload = hindsightSettingsPayload ?? (await BotHost.settingsGet());
      const prevProvider = (currentPayload.settings.runtime.providers ?? []).find(p => p.id === id);
      const preset = MODEL_PROVIDER_PRESETS.find(p => p.id === id);
      const apiKeyEnv =
        prevProvider?.apiKeyEnv ||
        preset?.apiKeyEnv ||
        `${id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;

      if (providerFormApiKey.trim()) {
        const mergedAliases = {
          ...readCredentialAliases(),
          [apiKeyEnv]: providerFormApiKey.trim(),
        };
        writeCredentialAliases(mergedAliases);
        await BotHost.saveCredentials({
          aliases: mergedAliases,
        });
        try {
          const snap = await BotHost.snapshot();
          if (snap.phase === 'running') {
            await BotHost.call({
              method: 'discoverProviderModels',
              params: {
                input: {
                  apiKeyEnv,
                  apiKey: providerFormApiKey.trim(),
                  syncEnvOnly: true,
                },
              },
            });
          }
        } catch {
          // Ignore if Host is not running
        }
      }

      const prevModelsMap = new Map((prevProvider?.models ?? []).map(m => [m.id, m]));
      const discoveredMap = new Map(discoveredModels.map(m => [m.id, m]));
      const uniqueModelIds = Array.from(new Set(modelIds));
      const nextModels = uniqueModelIds.map(mId => {
        const disc = discoveredMap.get(mId);
        const old = prevModelsMap.get(mId);
        if (disc) {
          return {
            ...(old ?? {}),
            id: mId,
            ...(disc.name && disc.name !== mId ? { name: disc.name } : {}),
            ...(disc.reasoning ? { reasoning: true } : {}),
            ...(disc.contextWindow ? { contextWindow: disc.contextWindow } : {}),
          };
        }
        return old ? { ...old, id: mId } : { id: mId };
      });

      const nextProvider: HostProviderConfig = {
        id,
        ...(providerFormName.trim() ? { name: providerFormName.trim() } : {}),
        ...(providerFormApi ? { api: providerFormApi } : {}),
        baseUrl,
        apiKeyEnv,
        models: nextModels,
      };

      const existingProviders = currentPayload.settings.runtime.providers ?? [];
      const nextProviders = existingProviders.some(p => p.id === id)
        ? existingProviders.map(p => (p.id === id ? nextProvider : p))
        : [...existingProviders, nextProvider];

      const firstModelRef = `${id}/${uniqueModelIds[0]}`;
      const nextDefaultModel =
        providerFormSetDefault || !currentPayload.settings.runtime.defaultModel
          ? firstModelRef
          : currentPayload.settings.runtime.defaultModel;

      const nextSettings: HostSettings = {
        ...currentPayload.settings,
        runtime: {
          ...currentPayload.settings.runtime,
          providers: nextProviders,
          defaultModel: nextDefaultModel,
        },
      };

      const savedPayload = await BotHost.settingsSet({
        input: {
          expectedRevision: currentPayload.revision,
          settings: nextSettings,
        },
      });
      setHindsightSettingsPayload(savedPayload);
      setProviderFormApiKey('');

      // Auto-star first models if user hasn't starred any yet
      if (starredModels.length === 0) {
        const autoStar = uniqueModelIds.slice(0, 2).map(mId => `${id}/${mId}`);
        setStarredModels(autoStar);
        writeStarredModels(autoStar);
      }

      setModelSheetView('list');
    });

  const handleDeleteProviderInSheet = (providerId: string) =>
    action.run(async () => {
      const currentPayload = hindsightSettingsPayload ?? (await BotHost.settingsGet());
      const nextProviders = (currentPayload.settings.runtime.providers ?? []).filter(p => p.id !== providerId);
      const currentDefault = currentPayload.settings.runtime.defaultModel ?? null;
      const nextDefault =
        currentDefault && currentDefault.startsWith(`${providerId}/`)
          ? nextProviders[0]?.models[0]
            ? `${nextProviders[0].id}/${nextProviders[0].models[0].id}`
            : null
          : currentDefault;

      const nextSettings: HostSettings = {
        ...currentPayload.settings,
        runtime: {
          ...currentPayload.settings.runtime,
          providers: nextProviders,
          defaultModel: nextDefault,
        },
      };
      const savedPayload = await BotHost.settingsSet({
        input: {
          expectedRevision: currentPayload.revision,
          settings: nextSettings,
        },
      });
      setHindsightSettingsPayload(savedPayload);
      setModelSheetView('list');
    });

  // Save Bot Soul (CAS)
  const handleSaveSoul = () =>
    action.run(async () => {
      if (editMode === 'create' && screen === 'bot-soul') {
        setEditInitialSoul(soulDraft);
        setSoulDirty(false);
        setScreen(subPageReturnScreen);
        return;
      }
      if (!activeBot) return;
      if (soulBytes(soulDraft) > SOUL_MAX_BYTES) {
        throw new Error(t('灵魂文档超出 64 KiB 上限', 'SOUL.md exceeds 64 KiB limit'));
      }
      if (activeBot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') return;
        let targetBotId = activeBot.botId;
        if (targetBotId === '__jarvis__') {
          const mat = await materializeJarvisIfNeeded(snap);
          targetBotId = mat.botId;
        }
        const currentSoul =
          botSoul && botSoul.botId === targetBotId
            ? botSoul
            : parseBotSoul((await BotHost.call({ method: 'getBotSoul', params: { botId: targetBotId } })).result);
        if (!currentSoul) return;
        const savedEnv = await BotHost.call({
          method: 'setBotSoul',
          params: {
            botId: targetBotId,
            input: { expectedRevision: currentSoul.revision, text: soulDraft },
          },
        });
        const saved = parseBotSoul(savedEnv.result);
        if (saved) {
          setBotSoul(saved);
          setSoulDraft(saved.text);
          setSoulDirty(false);
        }
      } else if (activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current && botSoul) {
        const res = await remoteClientRef.current.api.call(activeBot.remoteIdentity, 'setBotSoul', {
          botId: activeBot.botId,
          input: { expectedRevision: botSoul.revision, text: soulDraft },
        });
        const saved = parseBotSoul(res);
        if (saved) {
          setBotSoul(saved);
          setSoulDraft(saved.text);
          setSoulDirty(false);
        }
      }
      setScreen(subPageReturnScreen);
    });

  // Save Bot Extensions + Hindsight Topic & Server Host (CAS)
  const handleSaveExtensions = () =>
    action.run(async () => {
      if (!activeBot) return;
      const trimmedTopic = hindsightTopicDraft.trim();
      const trimmedHostUrl = hindsightHostUrl.trim();
      const trimmedApiKeyEnv = hindsightApiKeyEnv.trim() || 'HINDSIGHT_API_KEY';

      updateBotMeta(activeBot.key, { hindsightTopic: trimmedTopic });

      if (activeBot.hostKind === 'local') {
        if (hindsightApiKey.trim()) {
          await BotHost.saveCredentials({
            aliases: { [trimmedApiKeyEnv]: hindsightApiKey.trim() },
          });
          setHindsightApiKey('');
        }

        const currentPayload = hindsightSettingsPayload ?? (await BotHost.settingsGet());
        if (currentPayload && currentPayload.settings) {
          const prevRuntime = currentPayload.settings.runtime ?? { providers: [] };
          const prevHindsight = prevRuntime.extensions?.hindsight;
          const nextSettings: HostSettings = {
            ...currentPayload.settings,
            runtime: {
              ...prevRuntime,
              extensions: {
                ...(prevRuntime.extensions ?? {}),
                hindsight: {
                  enabled: Boolean(trimmedHostUrl) || extDraft.enabled || Boolean(prevHindsight?.enabled),
                  defaultEnabled: prevHindsight?.defaultEnabled ?? true,
                  ...(trimmedHostUrl
                    ? {
                        config: {
                          baseUrl: trimmedHostUrl,
                          apiKeyEnv: trimmedApiKeyEnv,
                          sharedMemory: hindsightSharedMemory,
                        },
                      }
                    : {}),
                },
              },
            },
          };
          const updatedPayload = await BotHost.settingsSet({
            input: {
              expectedRevision: currentPayload.revision,
              settings: nextSettings,
            },
          });
          setHindsightSettingsPayload(updatedPayload);
        }

        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') return;
        let targetBotId = activeBot.botId;
        if (targetBotId === '__jarvis__') {
          const mat = await materializeJarvisIfNeeded(snap);
          targetBotId = mat.botId;
        }
        const currentSnap =
          botExtSnap && botExtSnap.botId === targetBotId
            ? botExtSnap
            : parseBotExtensionSnapshot(
                (await BotHost.call({ method: 'getBotExtensions', params: { botId: targetBotId } })).result,
              );
        if (currentSnap) {
          const savedEnv = await BotHost.call({
            method: 'setBotExtensions',
            params: {
              botId: targetBotId,
              input: { expectedRevision: currentSnap.revision, extensions: { hindsight: extDraft } },
            },
          });
          const saved = parseBotExtensionSnapshot(savedEnv.result);
          if (saved) {
            setBotExtSnap(saved);
            setExtDraft(saved.extensions.hindsight);
          }
        }

        // Sync Hindsight Topic block into SOUL.md so the Bot focuses recall/retain on this topic
        try {
          const currentSoul =
            botSoul && botSoul.botId === targetBotId
              ? botSoul
              : parseBotSoul((await BotHost.call({ method: 'getBotSoul', params: { botId: targetBotId } })).result);
          if (currentSoul) {
            const nextSoulText = syncTopicIntoSoulText(currentSoul.text, trimmedTopic);
            if (nextSoulText !== currentSoul.text && soulBytes(nextSoulText) <= SOUL_MAX_BYTES) {
              const savedSoulEnv = await BotHost.call({
                method: 'setBotSoul',
                params: {
                  botId: targetBotId,
                  input: { expectedRevision: currentSoul.revision, text: nextSoulText },
                },
              });
              const savedSoul = parseBotSoul(savedSoulEnv.result);
              if (savedSoul) {
                setBotSoul(savedSoul);
                setSoulDraft(savedSoul.text);
              }
            }
          }
        } catch {
          // Ignore optional topic soul sync error
        }
        setExtDirty(false);
      } else if (activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current) {
        const api = remoteClientRef.current.api;
        if (botExtSnap) {
          const res = await api.call(activeBot.remoteIdentity, 'setBotExtensions', {
            botId: activeBot.botId,
            input: { expectedRevision: botExtSnap.revision, extensions: { hindsight: extDraft } },
          });
          const saved = parseBotExtensionSnapshot(res);
          if (saved) {
            setBotExtSnap(saved);
            setExtDraft(saved.extensions.hindsight);
          }
        }
        if (botSoul) {
          try {
            const nextSoulText = syncTopicIntoSoulText(botSoul.text, trimmedTopic);
            if (nextSoulText !== botSoul.text && soulBytes(nextSoulText) <= SOUL_MAX_BYTES) {
              const savedSoulRes = await api.call(activeBot.remoteIdentity, 'setBotSoul', {
                botId: activeBot.botId,
                input: { expectedRevision: botSoul.revision, text: nextSoulText },
              });
              const savedSoul = parseBotSoul(savedSoulRes);
              if (savedSoul) {
                setBotSoul(savedSoul);
                setSoulDraft(savedSoul.text);
              }
            }
          } catch {
            // Ignore optional remote soul sync error
          }
        }
        setExtDirty(false);
      }
      setScreen(subPageReturnScreen);
    });

  // Resolve targetBotId and primaryConversationId for Local Bot Schedule operations
  const resolveLocalBotScheduleOwner = async (): Promise<{
    botId: string;
    conversationId: string;
    botKey: string;
  } | null> => {
    if (!activeBot || activeBot.hostKind !== 'local') return null;
    const snap = await ensureLocalHostRunning();
    if (!snap || snap.phase !== 'running') {
      throw new Error(t('正在启动本机运行环境，请稍后重试', 'Starting local runtime, please try again'));
    }
    let targetBotId = activeBot.botId;
    let targetKey = activeBot.key;
    if (targetBotId === '__jarvis__') {
      const mat = await materializeJarvisIfNeeded(snap);
      targetBotId = mat.botId;
      targetKey = mat.key;
    }
    const latestBots = await syncLocalBots(snap);
    const matched = latestBots.find(b => b.botId === targetBotId);
    const convId = activeBot.primaryConversationId || matched?.primaryConversationId || '';
    if (!convId) {
      throw new Error(t('未找到该 Bot 的主会话标识', 'Primary conversation ID not found for this Bot'));
    }
    return { botId: targetBotId, conversationId: convId, botKey: targetKey };
  };

  const openScheduleCreate = () => {
    setScheduleCustomWeekdays(false);
    setScheduleDraft({
      title: '',
      prompt: '',
      repeat: 'daily',
      time: '08:00',
      weekdays: [1, 2, 3, 4, 5],
      monthDay: 1,
      alarmMode: 'alarmClock',
      vibrate: true,
      deleteAfterRun: false,
    });
    setScheduleEditing('new');
  };

  const openScheduleEdit = (task: BotScheduleTask) => {
    const days =
      task.weekdays && task.weekdays.length > 0
        ? task.weekdays.slice().sort((a, b) => a - b)
        : [task.weekday ?? 1];
    const isCustomWeekly =
      task.repeat === 'weekly' && days.join(',') !== '1,2,3,4,5' && days.join(',') !== '6,7';
    setScheduleCustomWeekdays(isCustomWeekly);
    setScheduleDraft({
      id: task.id,
      revision: task.revision,
      title: task.title,
      prompt: task.prompt ?? '',
      repeat: task.repeat,
      time: task.time || '08:00',
      weekdays: days,
      monthDay: task.monthDay ?? 1,
      alarmMode: task.alarmMode === 'exact' ? 'exact' : 'alarmClock',
      vibrate: Boolean(task.vibrate),
      deleteAfterRun: Boolean(task.deleteAfterRun),
    });
    setScheduleEditing('edit');
  };

  const handleToggleSchedule = (task: BotScheduleTask, nextEnabled: boolean) =>
    action.run(async () => {
      const owner = await resolveLocalBotScheduleOwner();
      if (!owner) return;
      await BotHost.call({
        method: 'uiScheduleTask',
        params: {
          botId: owner.botId,
          conversationId: owner.conversationId,
          input: {
            action: 'setEnabled',
            id: task.id,
            revision: task.revision,
            enabled: nextEnabled,
          },
        },
      });
      if (activeBot) {
        await loadBotSchedules({
          ...activeBot,
          botId: owner.botId,
          key: owner.botKey,
          primaryConversationId: owner.conversationId,
        });
      }
    });

  const handleDeleteSchedule = (task: BotScheduleTask) =>
    action.run(async () => {
      const owner = await resolveLocalBotScheduleOwner();
      if (!owner) return;
      await BotHost.call({
        method: 'uiScheduleTask',
        params: {
          botId: owner.botId,
          conversationId: owner.conversationId,
          input: {
            action: 'delete',
            id: task.id,
            revision: task.revision,
          },
        },
      });
      setScheduleEditing(null);
      if (activeBot) {
        await loadBotSchedules({
          ...activeBot,
          botId: owner.botId,
          key: owner.botKey,
          primaryConversationId: owner.conversationId,
        });
      }
    });

  const handleSaveSchedule = () =>
    action.run(async () => {
      const title = scheduleDraft.title.trim();
      const prompt = scheduleDraft.prompt.trim();
      if (!title || !prompt) {
        throw new Error(t('请填写任务名称与执行指令', 'Please enter task title and prompt instructions'));
      }
      if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(scheduleDraft.time)) {
        throw new Error(t('时间格式无效，请使用 HH:mm', 'Invalid time format (HH:mm)'));
      }
      if (scheduleDraft.repeat === 'weekly' && scheduleDraft.weekdays.length === 0) {
        throw new Error(t('请至少选择一个执行星期', 'Please select at least one weekday'));
      }
      const owner = await resolveLocalBotScheduleOwner();
      if (!owner) return;

      const basePayload: Record<string, unknown> = {
        title,
        prompt,
        repeat: scheduleDraft.repeat,
        time: scheduleDraft.time,
        alarmMode: scheduleDraft.alarmMode,
        vibrate: scheduleDraft.vibrate,
        deleteAfterRun: scheduleDraft.deleteAfterRun,
      };
      if (scheduleDraft.repeat === 'weekly') {
        basePayload.weekdays = scheduleDraft.weekdays.slice().sort((a, b) => a - b);
      } else if (scheduleDraft.repeat === 'monthly') {
        basePayload.monthDay = Math.min(31, Math.max(1, Math.round(scheduleDraft.monthDay)));
      }

      if (scheduleEditing === 'edit' && scheduleDraft.id && scheduleDraft.revision) {
        await BotHost.call({
          method: 'uiScheduleTask',
          params: {
            botId: owner.botId,
            conversationId: owner.conversationId,
            input: {
              action: 'update',
              id: scheduleDraft.id,
              revision: scheduleDraft.revision,
              ...basePayload,
            },
          },
        });
      } else {
        await BotHost.call({
          method: 'uiScheduleTask',
          params: {
            botId: owner.botId,
            conversationId: owner.conversationId,
            input: {
              action: 'create',
              ...basePayload,
            },
          },
        });
      }
      setScheduleEditing(null);
      if (activeBot) {
        await loadBotSchedules({
          ...activeBot,
          botId: owner.botId,
          key: owner.botKey,
          primaryConversationId: owner.conversationId,
        });
      }
    });

  const handleRequestExactAlarm = () =>
    action.run(async () => {
      await BotHost.call({
        method: 'uiScheduleTask',
        params: {
          botId: activeBot?.botId ?? '',
          conversationId: activeBot?.primaryConversationId ?? '',
          input: { action: 'requestExactAlarm' },
        },
      });
      if (activeBot) await loadBotSchedules(activeBot);
    });

  const visibleTurns = useMemo(() => {
    if (!activeBot) return [];
    const clearedAfter = clearedMap[activeBot.key] ?? 0;
    // raw history 是旧页，live 投影是新窗口：按 entry id 去重排序；同 id 保留 raw（工具/思考细节更全）。
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of array<Record<string, unknown>>(chatLive?.state?.history)) {
      byId.set(String(item.id), item);
    }
    for (const item of chatHistory) byId.set(String(item.id), item);
    const numericId = (item: Record<string, unknown>) => {
      const id = Number(item.id);
      return Number.isFinite(id) ? id : 0;
    };
    const all = parseHistoryEntries(
      [...byId.values()].sort((a, b) => numericId(a) - numericId(b)),
      clearedAfter,
    );
    const q = chatSearchQuery.trim().toLowerCase();
    if (!chatSearchOpen || !q) return all;
    return all.filter(turn => turn.text.toLowerCase().includes(q));
  }, [chatHistory, chatLive, activeBot, clearedMap, chatSearchOpen, chatSearchQuery]);

  const liveGeneratingText = chatLive?.state?.generation?.text ?? '';

  const isBotBusy = Boolean(
    chatLive?.state?.busy ||
      (chatLive?.state?.queuedCount ?? 0) > 0 ||
      (chatReceipt && (chatReceipt.status === 'queued' || chatReceipt.status === 'placed')),
  );

  useEffect(() => {
    if (screen === 'chat' && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [screen, visibleTurns.length, liveGeneratingText]);

  // Edge swipe gesture support for Left & Right Hidden Sidebars
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const touch = e.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (dy > 60) return;
    if (screen === 'hub' && start.x < 36 && dx > 65) {
      setLeftDrawerOpen(true);
    } else if (leftDrawerOpen && dx < -65) {
      setLeftDrawerOpen(false);
    } else if (screen === 'chat' && start.x > window.innerWidth - 36 && dx < -65) {
      setRightDrawerOpen(true);
    } else if (rightDrawerOpen && dx > 65) {
      setRightDrawerOpen(false);
    }
  };

  const showSlashHints = chatDraft.startsWith('/') && chatDraft.length <= 8;
  const anyDrawerOpen = leftDrawerOpen || rightDrawerOpen;
  const primaryPreset = resolveBotAvatarPreset(primaryBot.key, primaryBot.role, true);

  // 工作环境预览：本机与远程 Bot 共用同一右侧面板与同一共享组件，只换 call 桥。
  // target 是当前已选真实 Bot 的主会话（无 scopeId）；合成主助手 __jarvis__ 没有环境。
  const showerBotId = activeBot && activeBot.botId !== '__jarvis__' ? activeBot.botId : null;
  const showerHostKind = activeBot?.hostKind;
  const showerIdentity = activeBot?.remoteIdentity;
  const showerTarget = useMemo<ShowerTarget | null>(
    () => (showerBotId ? { botId: showerBotId } : null),
    [showerBotId],
  );
  // 远程 Bot 必须与当前连接档案/设备/代一致，否则不把旧设备的帧当当前画面。
  const showerRemoteReady = Boolean(
    showerHostKind === 'remote' &&
      remoteConnected &&
      showerIdentity &&
      remoteIdentity &&
      showerIdentity.profileId === remoteIdentity.profileId &&
      showerIdentity.targetDeviceId === remoteIdentity.targetDeviceId &&
      showerIdentity.generation === remoteIdentity.generation,
  );
  // 复用既有 remote 面板 call（与 Host 其它调用同源），绝不发给本机 BotHost；
  // 本机 Bot 不传 call，由 adapter 默认走 BotHost.call。
  const showerCall = useMemo<ShowerCall | undefined>(() => {
    if (showerHostKind !== 'remote' || !showerRemoteReady || !showerIdentity) return undefined;
    const api = remoteClientRef.current?.api;
    if (!api) return undefined;
    const call = api.call.bind(api) as (
      identity: DesktopIdentity,
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    return (method, params) => call(showerIdentity, method, params);
  }, [showerHostKind, showerRemoteReady, showerIdentity]);
  const showerConnected =
    showerHostKind === 'local' ? localHost?.phase === 'running' : showerRemoteReady;
  // 换主机/档案/设备/代/Bot 就换 key：旧画面与旧会话随卸载丢弃，不跨设备复用帧。
  const showerPreviewKey = `${showerHostKind ?? '-'}:${showerIdentity?.profileId ?? '-'}:${showerIdentity?.generation ?? '-'}:${showerIdentity?.targetDeviceId ?? '-'}:${showerBotId ?? '-'}`;
  const closeShowerPreview = useCallback(() => setRightDrawerOpen(false), []);

  return (
    <div
      className={`bot-hub-shell${leftDrawerOpen ? ' drawer-left-active' : ''}${rightDrawerOpen ? ' drawer-right-active' : ''}`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* ==================== SCREEN 1: MAIN HUB (15844.jpg + PanelLeft icon) ==================== */}
      {screen === 'hub' && (
        <main className={`hub-main grok-page-enter${anyDrawerOpen ? ' is-scaled' : ''}`} aria-label={t('智能体主页', 'Bot Hub')}>
          <header className="hub-top-bar">
            <button
              type="button"
              className="hub-circle-btn hub-left-trigger"
              aria-label={t('打开左侧边栏', 'Open left sidebar')}
              onClick={() => setLeftDrawerOpen(true)}
            >
              <PanelLeft size={20} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="hub-circle-btn hub-add-btn"
              aria-label={t('新建 Bot', 'New Bot')}
              onClick={openCreateBotPage}
            >
              <Plus size={22} strokeWidth={2.2} />
            </button>
          </header>

          <div className="hub-scroll-area">
            {/* Hero Spotlight: Primary Assistant */}
            <section className="hub-hero-section">
              <button
                type="button"
                className="hub-hero-button"
                onClick={() => openBotChat(primaryBot)}
                aria-label={`${primaryBot.role} - ${t('点击进入文字对话', 'Tap to chat')}`}
              >
                <GrokBotAvatar preset={primaryPreset} isPrimary starBadge size={88} />
                <span className="hub-hero-name">{primaryBot.role}</span>
              </button>
            </section>

            {/* Unified Bot List (Local + Remote) */}
            <section className="hub-bot-list" aria-label={t('智能体列表', 'Bots')}>
              {filteredBotItems.length === 0 ? (
                <div className="hub-empty-list">
                  <p>
                    {searchQuery.trim()
                      ? t('没有匹配的智能体', 'No matching bots')
                      : t('点击上方主助手直接开始对话，或点右上角 + 创建新的智能体', 'Tap the primary assistant above to chat, or + to create a new bot')}
                  </p>
                </div>
              ) : (
                filteredBotItems.map(item => {
                  const meta = botMetaMap[item.key];
                  const snippet =
                    meta?.lastText ||
                    meta?.subtitle ||
                    t('点击开始文字对话…', 'Tap to start chatting…');
                  const timeLabel = formatBotListTime(meta?.updatedAt, item.createdAt, t);
                  const preset = resolveBotAvatarPreset(item.key, item.role);
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className="hub-bot-row"
                      onClick={() => openBotChat(item)}
                    >
                      <div className="hub-bot-avatar-col">
                        <GrokBotAvatar preset={preset} size={52} />
                      </div>
                      <div className="hub-bot-content-col">
                        <div className="hub-bot-title-line">
                          <span className="hub-bot-title">{item.role}</span>
                          {hasRemoteConfigured && (
                            <span className={`hub-bot-host-badge ${item.hostKind}`}>
                              {item.hostLabel}
                            </span>
                          )}
                          <span className="hub-bot-time">{timeLabel}</span>
                        </div>
                        <div className="hub-bot-subtitle-line">
                          <span className="hub-bot-snippet">{snippet}</span>
                          <span className="hub-bot-unread-dot" aria-hidden="true" />
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </section>
          </div>

          <footer className="hub-bottom-bar">
            {unreadCount > 0 && (
              <button
                type="button"
                className="hub-unread-pill"
                onClick={() => {
                  const container = document.querySelector('.hub-scroll-area');
                  container?.scrollBy({ top: 220, behavior: 'smooth' });
                }}
              >
                <ChevronDown size={16} />
                <span>{t(`${unreadCount} 个未读`, `${unreadCount} unread`)}</span>
              </button>
            )}
            <label className="hub-search-box">
              <Search size={18} className="hub-search-icon" />
              <input
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t('搜索', 'Search')}
                aria-label={t('搜索智能体', 'Search bots')}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="hub-search-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label={t('清除搜索', 'Clear search')}
                >
                  <X size={16} />
                </button>
              )}
            </label>
          </footer>
        </main>
      )}

      {/* ==================== SCREEN 2: BOT CHAT VIEW (15845.jpg) ==================== */}
      {screen === 'chat' && activeBot && (
        <main className={`bot-chat-view grok-page-enter${anyDrawerOpen ? ' is-scaled' : ''}`}>
          {/* Floating Top Header Bar (15845.jpg) */}
          <header className="grok-chat-floating-header">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回主页', 'Back')}
              onClick={() => {
                cancelActiveObservation();
                setRightDrawerOpen(false);
                setChatTopMenuOpen(false);
                setScreen('hub');
              }}
            >
              <ArrowLeft size={20} />
            </button>

            {/* Center Bot Pill: tapping opens Bot Profile (15846.jpg) */}
            <button
              type="button"
              className="grok-chat-center-pill"
              onClick={() => openBotProfile(activeBot)}
              aria-label={t('查看 Bot 资料与设定', 'View Bot profile & settings')}
            >
              <GrokBotAvatar
                preset={resolveBotAvatarPreset(activeBot.key, activeBot.role, activeBot.isPrimary)}
                isPrimary={activeBot.isPrimary}
                busy={isBotBusy}
                size={28}
              />
              <span className="grok-chat-pill-name">{activeBot.role}</span>
              {hasRemoteConfigured && (
                <span className={`hub-bot-host-badge ${activeBot.hostKind}`}>
                  {activeBot.hostLabel}
                </span>
              )}
            </button>

            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('更多选项', 'More options')}
              aria-expanded={chatTopMenuOpen}
              onClick={() => setChatTopMenuOpen(v => !v)}
            >
              <MoreHorizontal size={20} />
            </button>

            {/* 15845.jpg Dropdown Menu Card */}
            {chatTopMenuOpen && (
              <>
                <div className="grok-menu-backdrop" onClick={() => setChatTopMenuOpen(false)} />
                <div className="grok-floating-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => openBotProfile(activeBot)}
                  >
                    <User size={19} />
                    <span>{t('查看资料', 'View Profile')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setChatTopMenuOpen(false);
                      setChatSearchOpen(v => !v);
                    }}
                  >
                    <Search size={19} />
                    <span>{t('在聊天中查找', 'Search in Chat')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setChatTopMenuOpen(false);
                      setRightDrawerOpen(true);
                    }}
                  >
                    <PanelRight size={19} />
                    <span>{t('工作环境预览', 'Work environment preview')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => clearCurrentBotHistory()}
                  >
                    <Trash2 size={19} />
                    <span>{t('清空当前对话', 'Clear History')}</span>
                  </button>
                </div>
              </>
            )}
          </header>

          {chatSearchOpen && (
            <div className="grok-chat-search-strip">
              <Search size={16} />
              <input
                type="search"
                value={chatSearchQuery}
                onChange={e => setChatSearchQuery(e.target.value)}
                placeholder={t('查找聊天内容…', 'Search messages…')}
                autoFocus
              />
              <button
                type="button"
                onClick={() => {
                  setChatSearchOpen(false);
                  setChatSearchQuery('');
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}

          <section
            className="bot-chat-messages"
            ref={chatScrollRef}
            onClick={() => {
              if (composerMenuOpen) setComposerMenuOpen(false);
              if (chatTopMenuOpen) setChatTopMenuOpen(false);
            }}
          >
            {visibleTurns.length === 0 && !liveGeneratingText ? (
              <div className="bot-chat-empty">
                <button
                  type="button"
                  className="bot-chat-empty-avatar-btn"
                  onClick={() => openBotProfile(activeBot)}
                >
                  <GrokBotAvatar
                    preset={resolveBotAvatarPreset(activeBot.key, activeBot.role, activeBot.isPrimary)}
                    isPrimary={activeBot.isPrimary}
                    starBadge={activeBot.isPrimary}
                    size={76}
                  />
                </button>
                <h2>{activeBot.role}</h2>
                <p>
                  {botMetaMap[activeBot.key]?.subtitle ||
                    t(
                      '点击顶部胶囊可进入 Bot 资料页配置头像、灵魂文档 (SOUL.md) 与扩展权限。',
                      'Tap the top pill to customize avatar, SOUL.md, and extensions.',
                    )}
                </p>
              </div>
            ) : (
              visibleTurns.map(turn => (
                <article key={turn.id} className={`bot-chat-bubble ${turn.role}`}>
                  {turn.thinking && (
                    <details className="bot-chat-thinking">
                      <summary>{t('思考过程', 'Thinking')}</summary>
                      <pre>{turn.thinking}</pre>
                    </details>
                  )}
                  {turn.toolSummary && turn.toolSummary.length > 0 && (
                    <div className="bot-chat-tools">
                      {turn.toolSummary.map((toolName, i) => (
                        <span key={i} className="bot-chat-tool-chip">
                          🔧 {toolName}
                        </span>
                      ))}
                    </div>
                  )}
                  {turn.text && <Markdown text={turn.text} />}
                </article>
              ))
            )}
            {liveGeneratingText && (
              <article className="bot-chat-bubble assistant streaming">
                <Markdown text={liveGeneratingText} />
              </article>
            )}
            {clearNotice && (
              <div className="bot-chat-system-notice" role="status">
                {clearNotice}
              </div>
            )}
          </section>

          {/* 15845.jpg Bottom Composer Bar */}
          <footer className="grok-chat-composer-area">
            <ErrorNotice error={action.error} />

            {showSlashHints && (
              <div className="bot-slash-popover" role="listbox" aria-label={t('斜杠命令', 'Slash commands')}>
                <button type="button" className="bot-slash-item" onClick={() => clearCurrentBotHistory()}>
                  <code>/clear</code>
                  <span>{t('清空当前对话历史', 'Clear current conversation history')}</span>
                </button>
                <button type="button" className="bot-slash-item" onClick={() => clearCurrentBotHistory()}>
                  <code>/new</code>
                  <span>{t('清空历史并开启新话题', 'Reset and start fresh')}</span>
                </button>
              </div>
            )}

            {composerMenuOpen && (
              <div className="bot-plus-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setComposerMenuOpen(false);
                    openBotProfile(activeBot);
                  }}
                >
                  <User size={18} />
                  <span>{t('查看 Bot 资料与设定', 'View Bot Profile & Settings')}</span>
                </button>
                <button type="button" role="menuitem" className="danger" onClick={() => clearCurrentBotHistory()}>
                  <Trash2 size={18} />
                  <span>{t('清空当前对话历史 (/clear)', 'Clear conversation history (/clear)')}</span>
                </button>
              </div>
            )}

            <div className="grok-composer-row">
              <button
                type="button"
                className={`grok-composer-plus-circle${composerMenuOpen ? ' active' : ''}`}
                aria-label={t('更多操作', 'More actions')}
                aria-expanded={composerMenuOpen}
                onClick={() => setComposerMenuOpen(v => !v)}
              >
                <Plus size={22} />
              </button>

              <div className="grok-composer-pill">
                <textarea
                  rows={1}
                  value={chatDraft}
                  onChange={e => setChatDraft(e.target.value)}
                  placeholder={t(`向 ${activeBot.role} 发消息…`, `Message ${activeBot.role}…`)}
                  aria-label={t('消息', 'Message')}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                />

                {activeBot.hostKind === 'local' && (
                  <button
                    type="button"
                    className={`grok-composer-mic-inline${voiceCapturing ? ' recording' : ''}`}
                    aria-label={voiceCapturing ? t('完成语音', 'Finish voice') : t('语音输入', 'Voice input')}
                    onClick={() =>
                      action.run(async () => {
                        if (voiceCapturing) {
                          await BotHost.finishVoice();
                          setVoiceCapturing(undefined);
                        } else {
                          const snap = await ensureLocalHostRunning();
                          if (!snap || snap.phase !== 'running') return;
                          let targetBotId = activeBot.botId;
                          if (targetBotId === '__jarvis__') {
                            const mat = await materializeJarvisIfNeeded(snap);
                            targetBotId = mat.botId;
                          }
                          const cap = { botId: targetBotId, requestId: uuid() };
                          setVoiceCapturing(cap);
                          await BotHost.startVoice(cap);
                        }
                      })
                    }
                  >
                    <Mic size={19} />
                  </button>
                )}

                {isBotBusy && !chatDraft.trim() ? (
                  <button
                    type="button"
                    className="grok-composer-action-pill stop"
                    aria-label={t('停止生成', 'Stop')}
                    onClick={() =>
                      action.run(async () => {
                        if (activeBot.hostKind === 'local' && activeBot.botId !== '__jarvis__') {
                          await BotHost.call({ method: 'abort', params: { botId: activeBot.botId } });
                        } else if (activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current) {
                          await remoteClientRef.current.api.call(activeBot.remoteIdentity, 'abort', {
                            botId: activeBot.botId,
                          });
                        }
                      })
                    }
                  >
                    <Square size={15} />
                  </button>
                ) : chatDraft.trim() ? (
                  <button
                    type="button"
                    className="grok-composer-action-pill send"
                    aria-label={t('发送', 'Send')}
                    disabled={action.busy}
                    onClick={() => void sendMessage()}
                  >
                    <ArrowUp size={18} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="grok-composer-action-pill voice"
                    aria-label={t('语音对话', 'Voice mode')}
                    onClick={() => openBotProfile(activeBot)}
                  >
                    <AudioLines size={18} />
                  </button>
                )}
              </div>
            </div>
          </footer>
        </main>
      )}

      {/* ==================== SCREEN 3: BOT PROFILE VIEW (15846.jpg + Soul & Extensions) ==================== */}
      {screen === 'bot-profile' && activeBot && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回对话', 'Back to chat')}
              onClick={() => setScreen('chat')}
            >
              <ArrowLeft size={20} />
            </button>
            <div className="grok-subpage-actions">
              <button
                type="button"
                className="grok-floating-circle-btn"
                aria-label={t('编辑 Bot', 'Edit Bot')}
                onClick={() => openBotEdit(activeBot)}
              >
                <MoreHorizontal size={20} />
              </button>
            </div>
          </header>

          <div className="grok-subpage-scroll">
            <section className="grok-profile-hero">
              <button
                type="button"
                className="grok-profile-avatar-btn"
                onClick={() =>
                  openAvatarPicker(
                    'bot-profile',
                    resolveBotAvatarPreset(activeBot.key, activeBot.role, activeBot.isPrimary),
                  )
                }
                aria-label={t('更换头像', 'Change avatar')}
              >
                <GrokBotAvatar
                  preset={resolveBotAvatarPreset(activeBot.key, activeBot.role, activeBot.isPrimary)}
                  isPrimary={activeBot.isPrimary}
                  starBadge={activeBot.isPrimary}
                  size={104}
                />
              </button>
              <h1 className="grok-profile-title">{activeBot.role}</h1>
              {botMetaMap[activeBot.key]?.subtitle && (
                <p className="grok-profile-subtitle">{botMetaMap[activeBot.key]?.subtitle}</p>
              )}
              <button
                type="button"
                className="grok-profile-edit-pill"
                onClick={() => openBotEdit(activeBot)}
              >
                {t('编辑', 'Edit')}
              </button>
            </section>

            {/* Grouped Card 1: Capabilities + Soul Document + Extensions (15846.jpg style) */}
            <section className="grok-card-group">
              <button
                type="button"
                className="grok-card-row"
                onClick={() => openModelPickerSheet('bot-profile')}
              >
                <Cpu size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('模型', 'Model')}</span>
                <span className="grok-row-value grok-row-value-path">
                  {activeBot.modelRef
                    ? activeBot.modelRef
                    : globalDefaultModel
                      ? `${t('默认 · ', 'Default · ')}${globalDefaultModel}`
                      : t('跟随默认', 'Default')}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => {
                  setSubPageReturnScreen('bot-profile');
                  setScreen('bot-soul');
                }}
              >
                <Sparkles size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('灵魂文档 (SOUL.md)', 'Soul Document')}</span>
                <span className="grok-row-value">
                  {soulDraft.trim()
                    ? `${soulBytes(soulDraft)} B`
                    : t('编写人设', 'Configure')}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => {
                  setSubPageReturnScreen('bot-profile');
                  setScreen('bot-extensions');
                }}
              >
                <Puzzle size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('扩展与记忆 (Hindsight)', 'Extensions')}</span>
                <span className="grok-row-value">
                  {extDraft.enabled
                    ? `${extDraft.mode === 'read-only' ? t('只读', 'Read-only') : t('已开启', 'Enabled')}${
                        hindsightTopicDraft.trim() ? ` · ${hindsightTopicDraft.trim()}` : ''
                      }`
                    : t('未开启', 'Off')}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => openBotSchedules(activeBot)}
              >
                <Clock size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('定时任务', 'Schedules')}</span>
                <span className="grok-row-value">
                  {t(
                    `${botMetaMap[activeBot.key]?.scheduleCount ?? botScheduleState.tasks.filter(x => x.enabled !== false).length} 已开启`,
                    `${botMetaMap[activeBot.key]?.scheduleCount ?? botScheduleState.tasks.filter(x => x.enabled !== false).length} enabled`,
                  )}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <div className="grok-card-row no-active">
                <FolderOpen size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('资料库', 'Knowledge Base')}</span>
                <span className="grok-row-value grok-row-value-path">
                  {activeBot.cwd || localHost?.workspace || '/workspace'}
                </span>
              </div>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => {
                  setScreen('chat');
                  setRightDrawerOpen(true);
                }}
              >
                <Monitor size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('电脑 / 屏幕控制', 'Screen Control')}</span>
                <span className="grok-row-value">{t('空闲', 'Idle')}</span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>
            </section>

            {/* Grouped Card 2: Notification Toggle (15846.jpg) */}
            <section className="grok-card-group">
              <div className="grok-card-row no-active">
                <span className="grok-row-label">{t('通知', 'Notifications')}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={botMetaMap[activeBot.key]?.notifyEnabled !== false}
                  className={`grok-toggle-switch${botMetaMap[activeBot.key]?.notifyEnabled !== false ? ' checked' : ''}`}
                  style={
                    botMetaMap[activeBot.key]?.notifyEnabled !== false
                      ? { backgroundColor: resolveBotAvatarPreset(activeBot.key, activeBot.role, activeBot.isPrimary).color }
                      : undefined
                  }
                  onClick={() =>
                    updateBotMeta(activeBot.key, {
                      notifyEnabled: botMetaMap[activeBot.key]?.notifyEnabled === false,
                    })
                  }
                >
                  <span className="grok-toggle-knob" />
                </button>
              </div>
            </section>
            <p className="grok-card-footnote">
              {t('Bot 完成任务或等你处理时通知你', 'Notify you when the Bot finishes work or needs your input')}
            </p>
          </div>
        </main>
      )}

      {/* ==================== SCREEN 4: EDIT / CREATE BOT VIEW (15847.jpg) ==================== */}
      {screen === 'bot-edit' && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => setScreen(editMode === 'create' ? 'hub' : 'bot-profile')}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">
              {editMode === 'create' ? t('新建 Bot', 'New Bot') : t('编辑 Bot', 'Edit Bot')}
            </h2>
            <button
              type="button"
              className="grok-done-pill-btn"
              disabled={action.busy || !editName.trim()}
              onClick={() => void handleSaveBotEdit()}
            >
              {action.busy ? t('保存中', 'Saving') : t('完成', 'Done')}
            </button>
          </header>

          <div className="grok-subpage-scroll">
            {/* Hero Avatar with Pencil Badge (15847.jpg) */}
            <section className="grok-profile-hero compact">
              <button
                type="button"
                className="grok-edit-avatar-wrap"
                onClick={() => openAvatarPicker('bot-edit', editAvatarPreset)}
                aria-label={t('选择头像', 'Choose avatar')}
              >
                <GrokBotAvatar preset={editAvatarPreset} size={104} />
                <span className="grok-avatar-pencil-badge">
                  <Pencil size={16} />
                </span>
              </button>
            </section>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('名称', 'Name')}</label>
              <div className="grok-card-group">
                <input
                  className="grok-card-input"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  placeholder={t('输入 Bot 名称', 'Enter Bot name')}
                />
              </div>
            </div>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('标题', 'Subtitle')}</label>
              <div className="grok-card-group">
                <input
                  className="grok-card-input"
                  value={editSubtitle}
                  onChange={e => setEditSubtitle(e.target.value)}
                  placeholder={t('描述 Bot 的用途（可选）', 'Describe what this Bot does (optional)')}
                />
              </div>
            </div>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('外观', 'Appearance')}</label>
              <div className="grok-card-group">
                <button
                  type="button"
                  className="grok-card-row"
                  onClick={() => openAvatarPicker('bot-edit', editAvatarPreset)}
                >
                  <span className="grok-row-label">{t('头像', 'Avatar')}</span>
                  <span className="grok-row-value" />
                  <ChevronRight size={18} className="grok-row-chevron" />
                </button>
              </div>
            </div>

            {editMode === 'create' && hasRemoteConfigured && (
              <div className="grok-field-section">
                <label className="grok-section-label">{t('所属节点 (Host)', 'Target Host')}</label>
                <div className="grok-card-group">
                  <div className="grok-card-row no-active">
                    <span className="grok-row-label">{t('运行节点', 'Host')}</span>
                    <select
                      className="grok-inline-select"
                      value={editTargetHost}
                      onChange={e => setEditTargetHost(e.target.value as 'local' | 'remote')}
                    >
                      <option value="local">{t('本机', 'Local')}</option>
                      {remoteConnected && remoteIdentity?.targetDeviceId && (
                        <option value="remote">
                          {remoteProfiles.find(p => p.id === remoteIdentity.profileId)?.title ||
                            remoteIdentity.targetDeviceId}
                        </option>
                      )}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Per-Bot Model Section: Quick Starred Models + More Models Popup */}
            <div className="grok-field-section">
              <label className="grok-section-label">{t('模型 (常用模型优先)', 'Model')}</label>
              <div className="grok-card-group">
                <div className="grok-model-quick-chips">
                  <button
                    type="button"
                    className={`grok-model-quick-chip${!editModel.trim() ? ' active' : ''}`}
                    onClick={() => setEditModel('')}
                  >
                    <span>
                      {globalDefaultModel
                        ? `${t('默认 · ', 'Default · ')}${globalDefaultModel.split('/').pop()}`
                        : t('跟随默认', 'Follow Default')}
                    </span>
                  </button>
                  {quickModelsForBot.map(item => {
                    const isSelected = editModel.trim() === item.modelRef;
                    const isStarred = starredModels.includes(item.modelRef);
                    return (
                      <button
                        key={item.modelRef}
                        type="button"
                        className={`grok-model-quick-chip${isSelected ? ' active' : ''}`}
                        onClick={() => setEditModel(item.modelRef)}
                      >
                        {isStarred && <Star size={12} className="grok-chip-star" />}
                        <span>{item.modelId}</span>
                      </button>
                    );
                  })}
                  {editModel.trim() &&
                    !quickModelsForBot.some(x => x.modelRef === editModel.trim()) && (
                      <button
                        type="button"
                        className="grok-model-quick-chip active"
                        onClick={() => openModelPickerSheet('bot-edit')}
                      >
                        <span>{editModel.trim()}</span>
                      </button>
                    )}
                </div>

                <button
                  type="button"
                  className="grok-card-row"
                  onClick={() => openModelPickerSheet('bot-edit')}
                >
                  <Cpu size={18} className="grok-row-icon" />
                  <span className="grok-row-label">{t('更多模型与服务商配置…', 'More Models & Providers…')}</span>
                  <span className="grok-row-value">
                    {allConfiguredModels.length > 0
                      ? t(`共 ${allConfiguredModels.length} 个`, `${allConfiguredModels.length} total`)
                      : t('去配置', 'Configure')}
                  </span>
                  <ChevronRight size={18} className="grok-row-chevron" />
                </button>
              </div>
            </div>

            {/* Voice Call Section (15847.jpg) */}
            <div className="grok-field-section">
              <label className="grok-section-label">{t('语音通话', 'Voice Call')}</label>
              <div className="grok-card-group">
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('语音', 'Voice')}</span>
                  <label className="grok-select-wrap">
                    <select value={editVoiceTone} onChange={e => setEditVoiceTone(e.target.value)}>
                      <option value="未设置">{t('未设置', 'Default')}</option>
                      <option value="清朗男声">{t('清朗男声', 'Clear Male')}</option>
                      <option value="温和女声">{t('温和女声', 'Warm Female')}</option>
                    </select>
                    <ChevronsUpDown size={15} />
                  </label>
                </div>
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('速度', 'Speed')}</span>
                  <label className="grok-select-wrap">
                    <select value={editVoiceSpeed} onChange={e => setEditVoiceSpeed(e.target.value)}>
                      <option value="0.75x">0.75x</option>
                      <option value="1x">1x</option>
                      <option value="1.25x">1.25x</option>
                      <option value="1.5x">1.5x</option>
                      <option value="2x">2x</option>
                    </select>
                    <ChevronsUpDown size={15} />
                  </label>
                </div>
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('语言', 'Language')}</span>
                  <label className="grok-select-wrap">
                    <select value={editVoiceLang} onChange={e => setEditVoiceLang(e.target.value)}>
                      <option value="自动">{t('自动', 'Auto')}</option>
                      <option value="中文">中文</option>
                      <option value="English">English</option>
                    </select>
                    <ChevronsUpDown size={15} />
                  </label>
                </div>
              </div>
            </div>

            <ErrorNotice error={action.error} />
          </div>
        </main>
      )}

      {/* ==================== SCREEN 5: AVATAR PICKER VIEW (15848.jpg) ==================== */}
      {screen === 'bot-avatar' && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => setScreen(avatarReturnScreen)}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">{t('头像', 'Avatar')}</h2>
            <button
              type="button"
              className="grok-done-pill-btn"
              onClick={() => {
                setEditAvatarPreset(draftAvatar);
                if (avatarReturnScreen === 'bot-profile' && activeBot) {
                  saveBotAvatarConfig(activeBot.key, draftAvatar);
                  setAvatarVersion(v => v + 1);
                }
                setScreen(avatarReturnScreen);
              }}
            >
              {t('完成', 'Done')}
            </button>
          </header>

          <div className="grok-subpage-scroll">
            {/* Top Segmented Tabs (15848.jpg) */}
            <div className="grok-segmented-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={avatarTab === 'shape'}
                className={avatarTab === 'shape' ? 'active' : ''}
                onClick={() => setAvatarTab('shape')}
              >
                {t('形状', 'Shape')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={avatarTab === 'expression'}
                className={avatarTab === 'expression' ? 'active' : ''}
                onClick={() => setAvatarTab('expression')}
              >
                {t('表情', 'Expression')}
              </button>
            </div>

            {/* Large Centered Live Preview (15848.jpg) */}
            <div className="grok-avatar-big-preview">
              <GrokBotAvatar preset={draftAvatar} size={118} />
            </div>

            {/* White Rounded Card with Shapes/Expressions + 11 Color Swatches + Reset (15848.jpg) */}
            <section className="grok-avatar-card">
              {avatarTab === 'shape' ? (
                <div className="grok-shapes-grid">
                  {GROK_SHAPE_ORDER.map(item => {
                    const selected = draftAvatar.shape === item.shape;
                    const itemPreset: GrokAvatarPreset = {
                      ...draftAvatar,
                      id: `${item.shape}-${draftAvatar.color}`,
                      shape: item.shape,
                      rotation: item.rotation,
                    };
                    return (
                      <button
                        key={item.shape}
                        type="button"
                        className={`grok-shape-cell${selected ? ' selected' : ''}`}
                        onClick={() =>
                          setDraftAvatar(prev => ({
                            ...prev,
                            id: `${item.shape}-${prev.color}`,
                            shape: item.shape,
                            rotation: item.rotation,
                          }))
                        }
                        aria-label={t(item.labelZh, item.labelEn)}
                        aria-pressed={selected}
                      >
                        <GrokBotAvatar preset={itemPreset} size={46} />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grok-expressions-grid">
                  {GROK_EXPRESSION_LIST.map(expr => {
                    const selected = draftAvatar.expressionIndex === expr.index;
                    const exprPreset: GrokAvatarPreset = {
                      ...draftAvatar,
                      expressionIndex: expr.index,
                    };
                    return (
                      <button
                        key={expr.index}
                        type="button"
                        className={`grok-expression-cell${selected ? ' selected' : ''}`}
                        onClick={() =>
                          setDraftAvatar(prev => ({
                            ...prev,
                            expressionIndex: expr.index,
                          }))
                        }
                        aria-pressed={selected}
                      >
                        <GrokBotAvatar preset={exprPreset} size={52} />
                        <span>{t(expr.labelZh, expr.labelEn)}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* 11 Color Swatches (15848.jpg) */}
              <div className="grok-colors-grid">
                {GROK_COLOR_PALETTE.map(c => {
                  const selected = draftAvatar.color.toLowerCase() === c.hex.toLowerCase();
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`grok-color-swatch${selected ? ' selected' : ''}`}
                      onClick={() =>
                        setDraftAvatar(prev => ({
                          ...prev,
                          id: `${prev.shape}-${c.id}`,
                          color: c.hex,
                        }))
                      }
                      aria-label={t(c.labelZh, c.labelEn)}
                      aria-pressed={selected}
                    >
                      <span style={{ backgroundColor: c.hex }} />
                    </button>
                  );
                })}
              </div>

              <div className="grok-avatar-card-footer">
                <button
                  type="button"
                  className="grok-reset-link"
                  onClick={() => {
                    const def = activeBot
                      ? getDefaultBotAvatarPreset(activeBot.key, activeBot.role, activeBot.isPrimary)
                      : JARVIS_AVATAR_PRESET;
                    setDraftAvatar({ ...def });
                    if (activeBot) {
                      resetBotAvatarConfig(activeBot.key);
                      setAvatarVersion(v => v + 1);
                    }
                  }}
                >
                  {t('重置为默认', 'Reset to default')}
                </button>
              </div>
            </section>
          </div>
        </main>
      )}

      {/* ==================== SCREEN 6: SOUL DOCUMENT EDITOR (SOUL.md) ==================== */}
      {screen === 'bot-soul' && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => setScreen(subPageReturnScreen)}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">{t('灵魂文档 (SOUL.md)', 'Soul Document')}</h2>
            <button
              type="button"
              className="grok-done-pill-btn"
              disabled={action.busy || soulBytes(soulDraft) > SOUL_MAX_BYTES}
              onClick={() => void handleSaveSoul()}
            >
              {action.busy ? t('保存中', 'Saving') : t('保存', 'Save')}
            </button>
          </header>

          <div className="grok-subpage-scroll">
            <p className="grok-card-footnote" style={{ marginTop: 0 }}>
              {t(
                '灵魂文档 (SOUL.md) 定义该 Bot 的核心人设、语气风格与行动准则，在每次对话与任务执行时自动注入系统上下文。',
                'SOUL.md defines the core persona, tone, and operating principles injected into every conversation with this Bot.',
              )}
            </p>

            <div className="soul-snippet-bar" style={{ margin: '10px 4px' }}>
              {SOUL_SNIPPETS.map(item => (
                <button
                  key={item.zh}
                  type="button"
                  className="snippet-chip"
                  onClick={() => {
                    setSoulDraft(prev => (prev ? prev.trimEnd() + '\n' : '') + item.text.trimStart());
                    setSoulDirty(true);
                  }}
                >
                  {t(item.zh, item.en)}
                </button>
              ))}
              {soulDraft.length > 0 && (
                <button
                  type="button"
                  className="snippet-chip danger"
                  onClick={() => {
                    setSoulDraft('');
                    setSoulDirty(true);
                  }}
                >
                  {t('清空', 'Clear')}
                </button>
              )}
            </div>

            <section className="grok-card-group" style={{ padding: 14 }}>
              <textarea
                className="grok-soul-textarea"
                rows={14}
                spellCheck={false}
                value={soulDraft}
                onChange={e => {
                  setSoulDraft(e.target.value);
                  setSoulDirty(true);
                }}
                placeholder={t(
                  '# 核心人设\n在这里编写 Bot 的身份、说话语气、专业领域和行为边界…',
                  '# Core Persona\nWrite the Bot identity, tone, expertise, and boundaries here…',
                )}
              />
              <div className="soul-byte-progress" style={{ marginTop: 10 }}>
                <div className="soul-byte-bar">
                  <div
                    className={`soul-byte-fill ${soulBytes(soulDraft) > SOUL_MAX_BYTES ? 'over' : ''}`}
                    style={{ width: `${Math.min(100, Math.round((soulBytes(soulDraft) / SOUL_MAX_BYTES) * 100))}%` }}
                  />
                </div>
                <div className="soul-byte-meta">
                  <span>
                    {botSoul?.revision ? `Rev: ${botSoul.revision.slice(0, 10)}` : t('新草稿', 'Draft')}
                  </span>
                  <span>
                    {`${soulBytes(soulDraft).toLocaleString()} / ${SOUL_MAX_BYTES.toLocaleString()} B`}
                  </span>
                </div>
              </div>
            </section>

            {soulDirty && activeBot && activeBot.botId !== '__jarvis__' && (
              <div className="action-row" style={{ paddingInline: 4 }}>
                <button
                  type="button"
                  className="hub-outline-btn"
                  onClick={() => void loadBotSoulAndExtensions(activeBot)}
                >
                  {t('放弃未保存修改并重新读取', 'Discard changes & reload')}
                </button>
              </div>
            )}

            <ErrorNotice error={action.error} />
          </div>
        </main>
      )}

      {/* ==================== SCREEN 7: BOT EXTENSIONS & TOOL GATING ==================== */}
      {screen === 'bot-extensions' && activeBot && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => setScreen(subPageReturnScreen)}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">{t('扩展与记忆 (Hindsight)', 'Hindsight Memory')}</h2>
            <button
              type="button"
              className="grok-done-pill-btn"
              disabled={action.busy || !extDirty}
              onClick={() => void handleSaveExtensions()}
            >
              {action.busy ? t('保存中', 'Saving') : t('保存', 'Save')}
            </button>
          </header>

          <div className="grok-subpage-scroll">
            <div className="grok-field-section">
              <label className="grok-section-label">{t('记忆策略与主题 (Per-Bot)', 'Memory Strategy & Topic')}</label>
              <section className="grok-card-group">
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('启用 Hindsight 长期记忆', 'Enable Hindsight Memory')}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={extDraft.enabled}
                    className={`grok-toggle-switch${extDraft.enabled ? ' checked' : ''}`}
                    onClick={() => {
                      setExtDraft(prev => ({ ...prev, enabled: !prev.enabled }));
                      setExtDirty(true);
                    }}
                  >
                    <span className="grok-toggle-knob" />
                  </button>
                </div>

                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('访问权限模式', 'Access Mode')}</span>
                  <label className="grok-select-wrap">
                    <select
                      value={extDraft.mode}
                      onChange={e => {
                        setExtDraft(prev => ({
                          ...prev,
                          mode: e.target.value === 'read-only' ? 'read-only' : 'read-write',
                        }));
                        setExtDirty(true);
                      }}
                    >
                      <option value="read-write">{t('读写 (Read-Write)', 'Read-Write')}</option>
                      <option value="read-only">{t('只读 (Read-Only)', 'Read-Only')}</option>
                    </select>
                    <ChevronsUpDown size={15} />
                  </label>
                </div>

                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('记忆主题 (Topic)', 'Memory Topic')}</span>
                  <input
                    className="grok-inline-input"
                    value={hindsightTopicDraft}
                    onChange={e => {
                      setHindsightTopicDraft(e.target.value);
                      setExtDirty(true);
                    }}
                    placeholder={t('例如：个人日程偏好、项目架构决策、客户跟进记录', 'e.g. Personal preferences, project architecture')}
                  />
                </label>

                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('跨 Bot 共享记忆库', 'Shared Memory Bank')}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={hindsightSharedMemory}
                    className={`grok-toggle-switch${hindsightSharedMemory ? ' checked' : ''}`}
                    onClick={() => {
                      setHindsightSharedMemory(prev => !prev);
                      setExtDirty(true);
                    }}
                  >
                    <span className="grok-toggle-knob" />
                  </button>
                </div>
              </section>
              <p className="grok-card-footnote">
                {t(
                  '指定记忆主题后，该 Bot 在自动检索与写入 Hindsight 记忆时会优先聚焦该主题领域，并同步写入灵魂文档。',
                  'Setting a Memory Topic focuses this Bot recall and retention around that domain.',
                )}
              </p>
            </div>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('Hindsight 服务器配置 (Server Host)', 'Hindsight Server Host')}</label>
              <section className="grok-card-group">
                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('服务器地址 (Host)', 'Server Host')}</span>
                  <input
                    className="grok-inline-input"
                    value={hindsightHostUrl}
                    onChange={e => {
                      setHindsightHostUrl(e.target.value);
                      setExtDirty(true);
                    }}
                    placeholder="http://127.0.0.1:8888"
                  />
                </label>

                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('密钥环境变量', 'Key Env')}</span>
                  <input
                    className="grok-inline-input"
                    value={hindsightApiKeyEnv}
                    onChange={e => {
                      setHindsightApiKeyEnv(e.target.value);
                      setExtDirty(true);
                    }}
                    placeholder="HINDSIGHT_API_KEY"
                  />
                </label>

                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('API Key 密钥', 'API Key')}</span>
                  <input
                    type="password"
                    className="grok-inline-input"
                    value={hindsightApiKey}
                    onChange={e => {
                      setHindsightApiKey(e.target.value);
                      setExtDirty(true);
                    }}
                    placeholder={
                      (hindsightSettingsPayload as { credentialStatus?: Record<string, boolean> } | null)
                        ?.credentialStatus?.[hindsightApiKeyEnv.trim() || 'HINDSIGHT_API_KEY']
                        ? t('已保存密钥（留空保持不变）', 'Saved (leave blank to keep)')
                        : t('选填：输入服务端鉴权密钥', 'Optional: enter server API key')
                    }
                  />
                </label>

                {hindsightBankStatus && (
                  <div className="grok-card-row no-active">
                    <span className="grok-row-label">{t('当前记忆库状态', 'Memory Bank Status')}</span>
                    <span className="grok-row-value grok-row-value-path">
                      {`${hindsightBankStatus.bankId || 'default'} · ${t('已完成', 'Done')} ${hindsightBankStatus.completed ?? 0} / ${t('队列', 'Pending')} ${hindsightBankStatus.pending ?? 0}`}
                    </span>
                  </div>
                )}
              </section>
              <p className="grok-card-footnote">
                {t(
                  '填写自建或局域网 Hindsight 服务地址（如 http://192.168.1.10:8888）；留空则使用默认本机端口 http://127.0.0.1:8888。',
                  'Specify your self-hosted or LAN Hindsight server URL (defaults to http://127.0.0.1:8888 when empty).',
                )}
              </p>
            </div>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('工具门控预览 (Tool Gating)', 'Tool Gating')}</label>
              <section className="grok-card-group" style={{ padding: 14 }}>
                <div className="tool-gating-row" style={{ marginBottom: 10 }}>
                  <span className="tool-gating-label">
                    {t(`读取工具 (${HINDSIGHT_READ_TOOLS.length})`, `Read tools (${HINDSIGHT_READ_TOOLS.length})`)}
                  </span>
                  <div className="tool-gating-chips">
                    {HINDSIGHT_READ_TOOLS.map(name => (
                      <code key={name} className={`gating-chip ${extDraft.enabled ? 'allowed' : 'gated'}`}>
                        {`${extDraft.enabled ? '✓' : '🚫'} ${name}`}
                      </code>
                    ))}
                  </div>
                </div>
                <div className="tool-gating-row">
                  <span className="tool-gating-label">
                    {t(`写入工具 (${HINDSIGHT_WRITE_TOOLS.length})`, `Write tools (${HINDSIGHT_WRITE_TOOLS.length})`)}
                  </span>
                  <div className="tool-gating-chips">
                    {HINDSIGHT_WRITE_TOOLS.map(name => {
                      const allowed = extDraft.enabled && extDraft.mode === 'read-write';
                      return (
                        <code key={name} className={`gating-chip ${allowed ? 'allowed' : 'gated'}`}>
                          {`${allowed ? '✓' : '🚫'} ${name}`}
                        </code>
                      );
                    })}
                  </div>
                </div>
              </section>
            </div>

            <ErrorNotice error={action.error} />
          </div>
        </main>
      )}

      {/* ==================== SCREEN 7B: BOT SCHEDULED TASKS ==================== */}
      {screen === 'bot-schedules' && activeBot && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => {
                if (scheduleEditing) {
                  setScheduleEditing(null);
                } else {
                  setScreen(subPageReturnScreen);
                }
              }}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">
              {scheduleEditing
                ? scheduleDraft.id
                  ? t('编辑定时任务', 'Edit Schedule')
                  : t('新建定时任务', 'New Schedule')
                : t(
                    `定时任务 · ${botMetaMap[activeBot.key]?.customName || activeBot.role}`,
                    `Schedules · ${botMetaMap[activeBot.key]?.customName || activeBot.role}`,
                  )}
            </h2>
            {scheduleEditing ? (
              <button
                type="button"
                className="grok-done-pill-btn"
                disabled={action.busy || !scheduleDraft.prompt.trim()}
                onClick={() => void handleSaveSchedule()}
              >
                {action.busy ? t('保存中', 'Saving') : t('保存', 'Save')}
              </button>
            ) : (
              <button
                type="button"
                className="grok-done-pill-btn"
                onClick={() => openScheduleCreate()}
              >
                <Plus size={16} style={{ marginRight: 4 }} />
                {t('新建', 'New')}
              </button>
            )}
          </header>

          {!scheduleEditing ? (
            <div className="grok-subpage-scroll">
              {/* Filter Tabs */}
              <div className="grok-schedule-filter-bar" role="tablist">
                {(
                  [
                    {
                      id: 'all' as const,
                      label: t(`全部 (${botScheduleState.tasks.length})`, `All (${botScheduleState.tasks.length})`),
                    },
                    {
                      id: 'enabled' as const,
                      label: t(
                        `已开启 (${botScheduleState.tasks.filter(x => x.enabled !== false).length})`,
                        `Active (${botScheduleState.tasks.filter(x => x.enabled !== false).length})`,
                      ),
                    },
                    {
                      id: 'paused' as const,
                      label: t(
                        `已暂停 (${botScheduleState.tasks.filter(x => x.enabled === false).length})`,
                        `Paused (${botScheduleState.tasks.filter(x => x.enabled === false).length})`,
                      ),
                    },
                  ]
                ).map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={scheduleFilter === tab.id}
                    className={`grok-schedule-filter-tab${scheduleFilter === tab.id ? ' active' : ''}`}
                    onClick={() => setScheduleFilter(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {!botScheduleState.exactAlarmGranted && (
                <section className="grok-card-group grok-schedule-permission-banner">
                  <div className="grok-schedule-permission-text">
                    <strong>{t('精确闹钟权限未开启', 'Exact Alarm Permission Needed')}</strong>
                    <span>
                      {t(
                        '开启后可保证定时任务在锁屏与后台状态下准点唤醒该 Bot 执行。',
                        'Grant exact alarm permission for punctual background execution.',
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="grok-done-pill-btn"
                    onClick={() => void handleRequestExactAlarm()}
                  >
                    {t('去授权', 'Grant')}
                  </button>
                </section>
              )}

              {(() => {
                const filteredTasks = botScheduleState.tasks.filter(task => {
                  if (scheduleFilter === 'enabled') return task.enabled !== false;
                  if (scheduleFilter === 'paused') return task.enabled === false;
                  return true;
                });

                const botDisplayName = botMetaMap[activeBot.key]?.customName || activeBot.role;

                if (filteredTasks.length === 0) {
                  return (
                    <section className="grok-card-group grok-schedule-empty">
                      <Clock size={32} className="grok-row-icon" />
                      <h4>
                        {scheduleFilter === 'all'
                          ? t(`还没有为「${botDisplayName}」设置定时任务`, `No schedules for ${botDisplayName}`)
                          : scheduleFilter === 'enabled'
                            ? t('暂无已开启的定时任务', 'No active schedules')
                            : t('暂无已暂停的定时任务', 'No paused schedules')}
                      </h4>
                      <p>
                        {t(
                          '定时任务到点后会自动唤醒该 Bot 执行指令（例如：每日早报汇总、待办提醒、定时巡检）。',
                          'Scheduled tasks wake this Bot at the specified time to run your prompt automatically.',
                        )}
                      </p>
                      <button
                        type="button"
                        className="grok-done-pill-btn"
                        style={{ marginTop: 8 }}
                        onClick={() => openScheduleCreate()}
                      >
                        <Plus size={16} style={{ marginRight: 4 }} />
                        {t('新建定时任务', 'Create Schedule')}
                      </button>
                    </section>
                  );
                }

                return (
                  <div className="grok-schedule-list">
                    {filteredTasks.map(task => {
                      const isEnabled = task.enabled !== false;
                      const accentColor = resolveBotAvatarPreset(
                        activeBot.key,
                        activeBot.role,
                        activeBot.isPrimary,
                      ).color;
                      return (
                        <section
                          key={task.id}
                          className={`grok-card-group grok-schedule-card${isEnabled ? '' : ' paused'}`}
                        >
                          <div className="grok-schedule-card-top">
                            <div
                              className="grok-schedule-card-time-wrap"
                              role="button"
                              tabIndex={0}
                              onClick={() => openScheduleEdit(task)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  openScheduleEdit(task);
                                }
                              }}
                            >
                              <span className="grok-schedule-time">{task.time || '09:00'}</span>
                              <div className="grok-schedule-badges">
                                <span className="grok-schedule-badge">
                                  {formatScheduleRepeatLabel(task, t)}
                                </span>
                                <span className={`grok-schedule-badge ${task.alarmMode === 'alarmClock' ? 'alarm' : 'silent'}`}>
                                  {task.alarmMode === 'alarmClock'
                                    ? t('🔔 强提醒', '🔔 Alarm')
                                    : t('⚡ 后台执行', '⚡ Silent')}
                                </span>
                              </div>
                            </div>

                            <button
                              type="button"
                              role="switch"
                              aria-checked={isEnabled}
                              className={`grok-toggle-switch${isEnabled ? ' checked' : ''}`}
                              style={isEnabled ? { backgroundColor: accentColor } : undefined}
                              onClick={() => void handleToggleSchedule(task, !isEnabled)}
                            >
                              <span className="grok-toggle-knob" />
                            </button>
                          </div>

                          <div
                            className="grok-schedule-card-body"
                            role="button"
                            tabIndex={0}
                            onClick={() => openScheduleEdit(task)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                openScheduleEdit(task);
                              }
                            }}
                          >
                            <div className="grok-schedule-title">
                              {task.title || t('未命名定时任务', 'Untitled Task')}
                            </div>
                            <div className="grok-schedule-prompt">
                              {task.prompt || t('点击编辑任务指令…', 'Tap to edit prompt…')}
                            </div>
                          </div>

                          <div className="grok-schedule-card-footer">
                            <span className="grok-schedule-next">
                              {isEnabled
                                ? `${t('下次执行：', 'Next: ')}${formatScheduleNextRun(
                                    task.nextRunAt,
                                    botScheduleState.timeZone,
                                    t,
                                  )}`
                                : t('已暂停', 'Paused')}
                            </span>
                            <div className="grok-schedule-actions">
                              <button
                                type="button"
                                className="grok-schedule-icon-btn"
                                aria-label={t('编辑', 'Edit')}
                                onClick={() => openScheduleEdit(task)}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                type="button"
                                className="grok-schedule-icon-btn danger"
                                aria-label={t('删除', 'Delete')}
                                onClick={() => void handleDeleteSchedule(task)}
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </div>
                        </section>
                      );
                    })}
                  </div>
                );
              })()}

              <ErrorNotice error={action.error || botScheduleState.schedulingError} />
            </div>
          ) : (
            <div className="grok-subpage-scroll">
              {/* Time & Repeat Section */}
              <div className="grok-field-section">
                <label className="grok-section-label">{t('执行时间与周期', 'Time & Recurrence')}</label>
                <section className="grok-card-group">
                  <label className="grok-card-row grok-input-row">
                    <span className="grok-input-label">{t('触发时间', 'Time')}</span>
                    <input
                      type="time"
                      className="grok-inline-input grok-time-input"
                      value={scheduleDraft.time}
                      onChange={e => setScheduleDraft(prev => ({ ...prev, time: e.target.value || '09:00' }))}
                    />
                  </label>

                  <div className="grok-card-row no-active">
                    <span className="grok-row-label">{t('重复周期', 'Repeat')}</span>
                    <label className="grok-select-wrap">
                      <select
                        value={
                          scheduleDraft.repeat === 'weekly' && !scheduleCustomWeekdays
                            ? scheduleDraft.weekdays.length === 5 &&
                              [1, 2, 3, 4, 5].every(d => scheduleDraft.weekdays.includes(d))
                              ? 'weekdays-mon-fri'
                              : scheduleDraft.weekdays.length === 2 &&
                                  [6, 7].every(d => scheduleDraft.weekdays.includes(d))
                                ? 'weekends-sat-sun'
                                : 'weekly'
                            : scheduleDraft.repeat
                        }
                        onChange={e => {
                          const val = e.target.value;
                          if (val === 'weekdays-mon-fri') {
                            setScheduleCustomWeekdays(false);
                            setScheduleDraft(prev => ({
                              ...prev,
                              repeat: 'weekly',
                              weekdays: [1, 2, 3, 4, 5],
                              deleteAfterRun: false,
                            }));
                          } else if (val === 'weekends-sat-sun') {
                            setScheduleCustomWeekdays(false);
                            setScheduleDraft(prev => ({
                              ...prev,
                              repeat: 'weekly',
                              weekdays: [6, 7],
                              deleteAfterRun: false,
                            }));
                          } else if (val === 'weekly') {
                            setScheduleCustomWeekdays(true);
                            setScheduleDraft(prev => ({
                              ...prev,
                              repeat: 'weekly',
                              weekdays: prev.weekdays.length > 0 ? prev.weekdays : [1],
                              deleteAfterRun: false,
                            }));
                          } else {
                            setScheduleCustomWeekdays(false);
                            const mode = val as BotScheduleDraft['repeat'];
                            setScheduleDraft(prev => ({
                              ...prev,
                              repeat: mode,
                              deleteAfterRun: mode === 'once' ? prev.deleteAfterRun : false,
                            }));
                          }
                        }}
                      >
                        <option value="daily">{t('每天', 'Daily')}</option>
                        <option value="statutoryWorkday">{t('法定工作日（智能跳过节假日）', 'Statutory Workdays')}</option>
                        <option value="statutoryHoliday">{t('法定节假日', 'Statutory Holidays')}</option>
                        <option value="weekdays-mon-fri">{t('每周一至周五', 'Mon–Fri')}</option>
                        <option value="weekends-sat-sun">{t('每个周末（周六、周日）', 'Weekends')}</option>
                        <option value="weekly">{t('自定义每周几…', 'Custom Weekdays…')}</option>
                        <option value="monthly">{t('每月固定日期', 'Monthly')}</option>
                        <option value="once">{t('单次执行（最近一次到点）', 'One-time (Next occurrence)')}</option>
                      </select>
                      <ChevronsUpDown size={15} />
                    </label>
                  </div>

                  {scheduleDraft.repeat === 'weekly' && scheduleCustomWeekdays && (
                    <div className="grok-card-row grok-weekday-row">
                      {[
                        { day: 1, zh: '一', en: 'M' },
                        { day: 2, zh: '二', en: 'T' },
                        { day: 3, zh: '三', en: 'W' },
                        { day: 4, zh: '四', en: 'T' },
                        { day: 5, zh: '五', en: 'F' },
                        { day: 6, zh: '六', en: 'S' },
                        { day: 7, zh: '日', en: 'S' },
                      ].map(item => {
                        const active = scheduleDraft.weekdays.includes(item.day);
                        return (
                          <button
                            key={item.day}
                            type="button"
                            className={`grok-weekday-chip${active ? ' active' : ''}`}
                            onClick={() => {
                              setScheduleDraft(prev => {
                                const exists = prev.weekdays.includes(item.day);
                                const next = exists
                                  ? prev.weekdays.filter(d => d !== item.day)
                                  : [...prev.weekdays, item.day].sort((a, b) => a - b);
                                return { ...prev, weekdays: next.length > 0 ? next : [item.day] };
                              });
                            }}
                          >
                            {t(item.zh, item.en)}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {scheduleDraft.repeat === 'monthly' && (
                    <label className="grok-card-row grok-input-row">
                      <span className="grok-input-label">{t('每月几号', 'Day of Month')}</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        className="grok-inline-input"
                        value={scheduleDraft.monthDay}
                        onChange={e => {
                          const d = Math.max(1, Math.min(31, Number(e.target.value) || 1));
                          setScheduleDraft(prev => ({ ...prev, monthDay: d }));
                        }}
                      />
                    </label>
                  )}
                </section>
              </div>

              {/* Task Content Section */}
              <div className="grok-field-section">
                <label className="grok-section-label">{t('任务标题与执行指令', 'Task Title & Prompt')}</label>
                <section className="grok-card-group">
                  <label className="grok-card-row grok-input-row">
                    <span className="grok-input-label">{t('任务名称', 'Title')}</span>
                    <input
                      className="grok-inline-input"
                      value={scheduleDraft.title}
                      onChange={e => setScheduleDraft(prev => ({ ...prev, title: e.target.value }))}
                      placeholder={t('例如：每日科技早报、下班打卡提醒', 'e.g. Daily briefing, Standup reminder')}
                    />
                  </label>
                  <div className="grok-card-textarea-wrap">
                    <textarea
                      rows={4}
                      value={scheduleDraft.prompt}
                      onChange={e => setScheduleDraft(prev => ({ ...prev, prompt: e.target.value }))}
                      placeholder={t(
                        '到点后发送给该 Bot 执行的指令内容，例如：汇总今天的日程与待办事项，并生成简短提醒。',
                        'Prompt sent to this Bot when triggered, e.g. Summarize my agenda and key tasks for today.',
                      )}
                    />
                  </div>
                </section>
              </div>

              {/* Reminder & Lifecycle Section */}
              <div className="grok-field-section">
                <label className="grok-section-label">{t('提醒方式与状态', 'Notification & Status')}</label>
                <section className="grok-card-group">
                  <div className="grok-card-row no-active">
                    <span className="grok-row-label">{t('强提醒模式（响铃与弹窗）', 'Alarm Mode (Ring & Alert)')}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={scheduleDraft.alarmMode === 'alarmClock'}
                      className={`grok-toggle-switch${scheduleDraft.alarmMode === 'alarmClock' ? ' checked' : ''}`}
                      onClick={() =>
                        setScheduleDraft(prev => ({
                          ...prev,
                          alarmMode: prev.alarmMode === 'alarmClock' ? 'exact' : 'alarmClock',
                        }))
                      }
                    >
                      <span className="grok-toggle-knob" />
                    </button>
                  </div>

                  {scheduleDraft.alarmMode === 'alarmClock' && (
                    <div className="grok-card-row no-active">
                      <span className="grok-row-label">{t('震动提醒', 'Vibrate')}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={scheduleDraft.vibrate}
                        className={`grok-toggle-switch${scheduleDraft.vibrate ? ' checked' : ''}`}
                        onClick={() => setScheduleDraft(prev => ({ ...prev, vibrate: !prev.vibrate }))}
                      >
                        <span className="grok-toggle-knob" />
                      </button>
                    </div>
                  )}

                  {scheduleDraft.repeat === 'once' && (
                    <div className="grok-card-row no-active">
                      <span className="grok-row-label">{t('触发后自动删除任务', 'Delete After Run')}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={scheduleDraft.deleteAfterRun}
                        className={`grok-toggle-switch${scheduleDraft.deleteAfterRun ? ' checked' : ''}`}
                        onClick={() => setScheduleDraft(prev => ({ ...prev, deleteAfterRun: !prev.deleteAfterRun }))}
                      >
                        <span className="grok-toggle-knob" />
                      </button>
                    </div>
                  )}
                </section>
              </div>

              {scheduleDraft.id && (
                <section className="grok-card-group">
                  <button
                    type="button"
                    className="grok-card-row danger-text"
                    onClick={() => {
                      const existing = botScheduleState.tasks.find(x => x.id === scheduleDraft.id);
                      if (existing) {
                        void handleDeleteSchedule(existing);
                        setScheduleEditing(null);
                      }
                    }}
                  >
                    <Trash2 size={18} />
                    <span className="grok-row-label">{t('删除该定时任务', 'Delete Schedule')}</span>
                  </button>
                </section>
              )}

              <ErrorNotice error={action.error || botScheduleState.schedulingError} />
            </div>
          )}
        </main>
      )}

      {/* ==================== SCREEN 8: SETTINGS VIEW ==================== */}
      {screen === 'settings' && (
        <HubSettingsView
          onBack={() => setScreen('hub')}
          ensureRemoteApi={ensureRemoteApi}
          remoteProfiles={remoteProfiles}
          remoteIdentity={remoteIdentity}
          remoteConnected={remoteConnected}
          remoteDevices={remoteDevices}
          setRemoteDevices={setRemoteDevices}
          onRemoteUpdated={() => {
            void syncRemoteBots();
          }}
          onOpenModelSheet={() => openModelPickerSheet('bot-edit')}
          onOpenSystemSettings={onOpenSystemSettings}
        />
      )}

      {/* ==================== MODEL PICKER & CUSTOM PROVIDER BOTTOM SHEET ==================== */}
      {modelSheetOpen && (
        <div
          className="grok-sheet-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t('选择模型与配置服务商', 'Select Model & Configure Providers')}
          onClick={() => setModelSheetOpen(false)}
        >
          <section className="grok-model-sheet" onClick={e => e.stopPropagation()}>
            {modelSheetView === 'list' ? (
              <>
                <header className="grok-model-sheet-header">
                  <div className="grok-model-sheet-title-wrap">
                    <h3>{t('选择模型', 'Select Model')}</h3>
                    <span className="grok-model-sheet-sub">
                      {t('点击 ★ 收藏常用模型，优先显示在创建/编辑页', 'Tap ★ to pin favorite models for quick access')}
                    </span>
                  </div>
                  <div className="grok-model-sheet-actions">
                    <button
                      type="button"
                      className="grok-done-pill-btn"
                      onClick={() => openProviderFormInSheet()}
                    >
                      <Plus size={15} style={{ marginRight: 3 }} />
                      {t('服务商', 'Provider')}
                    </button>
                    <button
                      type="button"
                      className="grok-floating-circle-btn"
                      aria-label={t('关闭', 'Close')}
                      onClick={() => setModelSheetOpen(false)}
                    >
                      <X size={18} />
                    </button>
                  </div>
                </header>

                {allConfiguredModels.length > 3 && (
                  <div className="grok-model-sheet-search">
                    <Search size={16} />
                    <input
                      type="search"
                      value={modelSearchQuery}
                      onChange={e => setModelSearchQuery(e.target.value)}
                      placeholder={t('搜索模型或服务商…', 'Search models or providers…')}
                    />
                    {modelSearchQuery && (
                      <button type="button" onClick={() => setModelSearchQuery('')} aria-label={t('清除', 'Clear')}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )}

                <div className="grok-model-sheet-body">
                  {(() => {
                    const currentSelectedRef =
                      modelSheetTarget === 'bot-profile'
                        ? activeBot?.modelRef ?? ''
                        : editModel.trim();
                    const q = modelSearchQuery.trim().toLowerCase();
                    const starredItems = allConfiguredModels.filter(
                      m =>
                        starredModels.includes(m.modelRef) &&
                        (!q || m.modelRef.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
                    );

                    return (
                      <>
                        {/* Follow Global Default Option */}
                        {!q && (
                          <div className="grok-field-section" style={{ marginBottom: 12 }}>
                            <section className="grok-card-group">
                              <button
                                type="button"
                                className="grok-card-row"
                                onClick={() => void selectModelFromSheet('')}
                              >
                                <Cpu size={18} className="grok-row-icon" />
                                <div className="grok-model-row-main">
                                  <span className="grok-row-label">{t('跟随全局默认模型', 'Follow Global Default')}</span>
                                  <small className="grok-model-row-sub">
                                    {globalDefaultModel
                                      ? `${t('当前默认：', 'Default: ')}${globalDefaultModel}`
                                      : t('未指定专属模型时使用 Host 默认设置', 'Uses Host default model')}
                                  </small>
                                </div>
                                {!currentSelectedRef && <Check size={18} className="grok-model-check" />}
                              </button>
                            </section>
                          </div>
                        )}

                        {/* Starred Models Group */}
                        {starredItems.length > 0 && (
                          <div className="grok-field-section" style={{ marginBottom: 14 }}>
                            <label className="grok-section-label">{t('★ 常用模型', '★ Starred Models')}</label>
                            <section className="grok-card-group">
                              {starredItems.map(item => {
                                const selected = currentSelectedRef === item.modelRef;
                                return (
                                  <div key={`star-${item.modelRef}`} className="grok-card-row grok-model-item-row">
                                    <button
                                      type="button"
                                      className="grok-model-item-select"
                                      onClick={() => void selectModelFromSheet(item.modelRef)}
                                    >
                                      <div className="grok-model-row-main">
                                        <span className="grok-row-label">{item.name}</span>
                                        <small className="grok-model-row-sub">{item.modelRef}</small>
                                      </div>
                                    </button>
                                    <div className="grok-model-item-right">
                                      <button
                                        type="button"
                                        className="grok-model-star-btn starred"
                                        aria-label={t('取消常用', 'Unstar')}
                                        onClick={e => {
                                          e.stopPropagation();
                                          toggleStarModel(item.modelRef);
                                        }}
                                      >
                                        <Star size={16} />
                                      </button>
                                      {selected && <Check size={18} className="grok-model-check" />}
                                    </div>
                                  </div>
                                );
                              })}
                            </section>
                          </div>
                        )}

                        {/* All Configured Models Grouped by Provider */}
                        {configuredProviders.length === 0 ? (
                          <section className="grok-card-group grok-schedule-empty" style={{ marginTop: 8 }}>
                            <Cpu size={28} className="grok-row-icon" />
                            <h4>{t('尚未配置模型服务商', 'No Model Providers Configured')}</h4>
                            <p>
                              {t(
                                '支持一键添加 DeepSeek、OpenAI、Anthropic、Gemini 或任意 Custom Provider（兼容 pi-ai 多协议）。',
                                'Add DeepSeek, OpenAI, Anthropic, Gemini, or any custom provider.',
                              )}
                            </p>
                            <button
                              type="button"
                              className="grok-done-pill-btn"
                              style={{ marginTop: 8 }}
                              onClick={() => openProviderFormInSheet()}
                            >
                              <Plus size={15} style={{ marginRight: 4 }} />
                              {t('添加服务商 / Custom Provider', 'Add Provider')}
                            </button>
                          </section>
                        ) : (
                          configuredProviders.map(provider => {
                            const models = (provider.models ?? []).filter(
                              m =>
                                !q ||
                                `${provider.id}/${m.id}`.toLowerCase().includes(q) ||
                                (m.name || m.id).toLowerCase().includes(q) ||
                                (provider.name || provider.id).toLowerCase().includes(q),
                            );
                            if (models.length === 0 && q) return null;
                            return (
                              <div key={provider.id} className="grok-field-section" style={{ marginBottom: 14 }}>
                                <div className="grok-provider-group-head">
                                  <label className="grok-section-label">
                                    {`${provider.name || provider.id} (${provider.id})`}
                                  </label>
                                  <button
                                    type="button"
                                    className="grok-provider-edit-link"
                                    onClick={() => openProviderFormInSheet(provider)}
                                  >
                                    {t('编辑服务商', 'Edit')}
                                  </button>
                                </div>
                                <section className="grok-card-group">
                                  {models.map(m => {
                                    const ref = `${provider.id}/${m.id}`;
                                    const selected = currentSelectedRef === ref;
                                    const isStar = starredModels.includes(ref);
                                    return (
                                      <div key={ref} className="grok-card-row grok-model-item-row">
                                        <button
                                          type="button"
                                          className="grok-model-item-select"
                                          onClick={() => void selectModelFromSheet(ref)}
                                        >
                                          <div className="grok-model-row-main">
                                            <span className="grok-row-label">{m.name || m.id}</span>
                                            <small className="grok-model-row-sub">{ref}</small>
                                          </div>
                                        </button>
                                        <div className="grok-model-item-right">
                                          <button
                                            type="button"
                                            className={`grok-model-star-btn${isStar ? ' starred' : ''}`}
                                            aria-label={isStar ? t('取消常用', 'Unstar') : t('设为常用', 'Star')}
                                            onClick={e => {
                                              e.stopPropagation();
                                              toggleStarModel(ref);
                                            }}
                                          >
                                            <Star size={16} />
                                          </button>
                                          {selected && <Check size={18} className="grok-model-check" />}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </section>
                              </div>
                            );
                          })
                        )}
                      </>
                    );
                  })()}
                  <ErrorNotice error={action.error} />
                </div>
              </>
            ) : (
              <>
                <header className="grok-model-sheet-header">
                  <button
                    type="button"
                    className="grok-floating-circle-btn"
                    aria-label={t('返回模型列表', 'Back to model list')}
                    onClick={() => setModelSheetView('list')}
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <div className="grok-model-sheet-title-wrap">
                    <h3>
                      {providerEditId
                        ? t(`编辑服务商 · ${providerEditId}`, `Edit Provider · ${providerEditId}`)
                        : t('配置服务商 / Custom Provider', 'Configure Provider')}
                    </h3>
                  </div>
                  <button
                    type="button"
                    className="grok-done-pill-btn"
                    disabled={action.busy || !providerFormId.trim() || !providerFormBaseUrl.trim()}
                    onClick={() => void handleSaveProviderInSheet()}
                  >
                    {action.busy ? t('保存中', 'Saving') : t('保存', 'Save')}
                  </button>
                </header>

                <div className="grok-model-sheet-body">
                  {!providerEditId && (
                    <div className="grok-field-section" style={{ marginBottom: 12 }}>
                      <label className="grok-section-label">{t('快速预设 (点击自动填入)', 'Quick Presets')}</label>
                      <div className="grok-model-quick-chips">
                        {MODEL_PROVIDER_PRESETS.map(preset => (
                          <button
                            key={preset.id}
                            type="button"
                            className={`grok-model-quick-chip${providerFormId === preset.id ? ' active' : ''}`}
                            onClick={() => applyProviderPreset(preset.id)}
                          >
                            <span>{preset.label}</span>
                          </button>
                        ))}
                        <button
                          type="button"
                          className={`grok-model-quick-chip${
                            !MODEL_PROVIDER_PRESETS.some(p => p.id === providerFormId) ? ' active' : ''
                          }`}
                          onClick={() => applyProviderPreset('__custom__')}
                        >
                          <span>{t('Custom 自定义', 'Custom')}</span>
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="grok-field-section" style={{ marginBottom: 12 }}>
                    <label className="grok-section-label">{t('服务商与协议 (pi-ai)', 'Provider & Protocol')}</label>
                    <section className="grok-card-group">
                      <label className="grok-card-row grok-input-row">
                        <span className="grok-input-label">{t('服务商 ID', 'Provider ID')}</span>
                        <input
                          className="grok-inline-input"
                          disabled={Boolean(providerEditId)}
                          value={providerFormId}
                          onChange={e => setProviderFormId(e.target.value)}
                          placeholder={t('如 deepseek、openai、my-api', 'e.g. deepseek, openai, custom-api')}
                        />
                      </label>
                      <label className="grok-card-row grok-input-row">
                        <span className="grok-input-label">{t('显示名称', 'Display Name')}</span>
                        <input
                          className="grok-inline-input"
                          value={providerFormName}
                          onChange={e => setProviderFormName(e.target.value)}
                          placeholder={t('选填，如 DeepSeek / 自建节点', 'Optional display name')}
                        />
                      </label>
                      <div className="grok-card-row no-active">
                        <span className="grok-row-label">{t('API 协议', 'API Protocol')}</span>
                        <label className="grok-select-wrap">
                          <select value={providerFormApi} onChange={e => setProviderFormApi(e.target.value)}>
                            {PI_PROVIDER_PROTOCOLS.map(proto => (
                              <option key={proto.id} value={proto.id}>
                                {proto.id}
                              </option>
                            ))}
                          </select>
                          <ChevronsUpDown size={15} />
                        </label>
                      </div>
                      <label className="grok-card-row grok-input-row">
                        <span className="grok-input-label">Base URL</span>
                        <input
                          className="grok-inline-input"
                          inputMode="url"
                          value={providerFormBaseUrl}
                          onChange={e => setProviderFormBaseUrl(e.target.value)}
                          placeholder="https://api.example.com/v1"
                        />
                      </label>
                      <label className="grok-card-row grok-input-row">
                        <span className="grok-input-label">API Key</span>
                        <input
                          type="password"
                          autoComplete="new-password"
                          className="grok-inline-input"
                          value={providerFormApiKey}
                          onChange={e => setProviderFormApiKey(e.target.value)}
                          placeholder={t('输入密钥（留空保持不变）', 'Enter API Key (blank to keep)')}
                        />
                      </label>
                    </section>
                  </div>

                  <div className="grok-field-section" style={{ marginBottom: 12 }}>
                    <div className="grok-provider-group-head">
                      <label className="grok-section-label">
                        {t('模型 ID 列表（每行一个）', 'Model IDs (one per line)')}
                      </label>
                      <button
                        type="button"
                        className="grok-discover-btn"
                        disabled={action.busy || discoveringModels || !providerFormBaseUrl.trim()}
                        onClick={() => void handleDiscoverProviderModels()}
                      >
                        <RefreshCw size={13} className={discoveringModels ? 'grok-spin' : ''} />
                        <span>
                          {discoveringModels
                            ? t('正在拉取…', 'Fetching…')
                            : t('自动拉取可用模型', 'Fetch Available Models')}
                        </span>
                      </button>
                    </div>
                    <section className="grok-card-group">
                      {discoveredModels.length > 0 && (() => {
                        const selectedSet = new Set(
                          providerFormModelsText
                            .split('\n')
                            .map(s => s.trim())
                            .filter(Boolean),
                        );
                        const dq = discoveredSearch.trim().toLowerCase();
                        const filteredDiscovered = discoveredModels.filter(
                          m => !dq || m.id.toLowerCase().includes(dq) || m.name.toLowerCase().includes(dq),
                        );
                        return (
                          <div className="grok-discovered-box">
                            <div className="grok-discovered-head">
                              <span className="grok-discovered-hint">
                                {discoverHint ||
                                  t(
                                    `已拉取 ${discoveredModels.length} 个模型（点击标签勾选）`,
                                    `Fetched ${discoveredModels.length} models (tap to toggle)`,
                                  )}
                              </span>
                              <div className="grok-discovered-actions">
                                <button
                                  type="button"
                                  className="grok-provider-edit-link"
                                  onClick={() => {
                                    const merged = Array.from(
                                      new Set([...selectedSet, ...filteredDiscovered.map(m => m.id)]),
                                    );
                                    setProviderFormModelsText(merged.join('\n'));
                                  }}
                                >
                                  {t('全选', 'Select All')}
                                </button>
                                <button
                                  type="button"
                                  className="grok-provider-edit-link"
                                  onClick={() => setProviderFormModelsText('')}
                                >
                                  {t('清空', 'Clear')}
                                </button>
                              </div>
                            </div>
                            {discoveredModels.length > 6 && (
                              <div className="grok-discovered-search">
                                <Search size={14} />
                                <input
                                  type="search"
                                  value={discoveredSearch}
                                  onChange={e => setDiscoveredSearch(e.target.value)}
                                  placeholder={t('筛选拉取到的模型…', 'Filter fetched models…')}
                                />
                              </div>
                            )}
                            <div className="grok-discovered-chips">
                              {filteredDiscovered.slice(0, 60).map(m => {
                                const activeChip = selectedSet.has(m.id);
                                return (
                                  <button
                                    key={m.id}
                                    type="button"
                                    className={`grok-model-quick-chip${activeChip ? ' active' : ''}`}
                                    onClick={() => toggleDiscoveredModelInForm(m.id)}
                                  >
                                    {activeChip && <Check size={13} />}
                                    <span>{m.id}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                      <div className="grok-card-textarea-wrap">
                        <textarea
                          rows={4}
                          value={providerFormModelsText}
                          onChange={e => setProviderFormModelsText(e.target.value)}
                          placeholder={'deepseek-chat\ndeepseek-reasoner'}
                          spellCheck={false}
                        />
                      </div>
                      <div className="grok-card-row no-active">
                        <span className="grok-row-label">{t('将首个模型设为全局默认', 'Set first model as default')}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={providerFormSetDefault}
                          className={`grok-toggle-switch${providerFormSetDefault ? ' checked' : ''}`}
                          onClick={() => setProviderFormSetDefault(v => !v)}
                        >
                          <span className="grok-toggle-knob" />
                        </button>
                      </div>
                    </section>
                  </div>

                  {providerEditId && (
                    <section className="grok-card-group">
                      <button
                        type="button"
                        className="grok-card-row danger-text"
                        onClick={() => void handleDeleteProviderInSheet(providerEditId)}
                      >
                        <Trash2 size={18} />
                        <span className="grok-row-label">{t('删除该服务商', 'Delete Provider')}</span>
                      </button>
                    </section>
                  )}

                  <ErrorNotice error={action.error} />
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* ==================== LEFT HIDDEN SIDEBAR DRAWER (Persistent for smooth slide animation) ==================== */}
      <div
        className={`grok-drawer-layer left${leftDrawerOpen ? ' open' : ''}`}
        aria-hidden={!leftDrawerOpen}
        onClick={() => setLeftDrawerOpen(false)}
      >
        <aside
          className="grok-left-drawer"
          role="dialog"
          aria-label={t('左侧边栏', 'Left sidebar')}
          onClick={e => e.stopPropagation()}
        >
          <div className="hub-left-drawer-spacer" />
          <footer className="hub-left-drawer-footer">
            <button
              type="button"
              className="hub-left-settings-btn"
              onClick={() => {
                setLeftDrawerOpen(false);
                setScreen('settings');
              }}
            >
              <Settings size={20} />
              <span>{t('设置', 'Settings')}</span>
            </button>
          </footer>
        </aside>
      </div>

      {/* ==================== RIGHT HIDDEN SIDEBAR DRAWER (Persistent for smooth slide animation) ==================== */}
      <div
        className={`grok-drawer-layer right${rightDrawerOpen ? ' open' : ''}`}
        aria-hidden={!rightDrawerOpen}
        onClick={() => setRightDrawerOpen(false)}
      >
        <aside
          className="grok-right-drawer"
          role="dialog"
          aria-label={t('右侧边栏', 'Right sidebar')}
          onClick={e => e.stopPropagation()}
        >
          <header className="hub-right-drawer-header">
            <span>{activeBot?.role ?? 'Bot'}</span>
            <button
              type="button"
              className="bot-chat-icon-btn"
              aria-label={t('关闭侧边栏', 'Close sidebar')}
              onClick={() => setRightDrawerOpen(false)}
            >
              <X size={20} />
            </button>
          </header>
          {showerTarget && (showerHostKind === 'local' || showerCall) ? (
            rightDrawerOpen && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <ShowerPreview
                  key={showerPreviewKey}
                  call={showerCall}
                  target={showerTarget}
                  connected={showerConnected}
                  onClose={closeShowerPreview}
                />
              </div>
            )
          ) : (
            <div className="hub-right-drawer-empty">
              <Monitor size={30} />
              <p>{t('该 Bot 还没有可预览的工作环境', 'No work environment for this Bot yet')}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function HubSettingsView({
  onBack,
  ensureRemoteApi,
  remoteProfiles,
  remoteIdentity,
  remoteConnected,
  remoteDevices,
  setRemoteDevices,
  onRemoteUpdated,
  onOpenModelSheet,
  onOpenSystemSettings,
}: {
  onBack(): void;
  ensureRemoteApi(): Promise<DesktopPanelApi | null>;
  remoteProfiles: DesktopUiProfile[];
  remoteIdentity: DesktopIdentity | null;
  remoteConnected: boolean;
  remoteDevices: DevicesDirectoryItem[];
  setRemoteDevices(items: DevicesDirectoryItem[]): void;
  onRemoteUpdated(): void;
  onOpenModelSheet?(): void;
  onOpenSystemSettings?(): void;
}) {
  const t = useText();
  const action = useAction();

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [ca, setCa] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formKind, setFormKind] = useState<'local' | 'relay'>('relay');
  const [formUrl, setFormUrl] = useState('');
  const [formDeviceId, setFormDeviceId] = useState('');

  const [hostSettings, setHostSettings] = useState<HostSettingsPayload>();
  const [settingsJson, setSettingsJson] = useState('');
  const [credJson, setCredJson] = useState('');
  const [voice, setVoice] = useState<HostVoiceSettings>();
  const [showLocalConfig, setShowLocalConfig] = useState(false);

  useEffect(() => {
    void ensureRemoteApi();
  }, [ensureRemoteApi]);

  const saveRemoteProfile = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api) throw new Error(t('当前环境不支持远程连接组件', 'Remote client unavailable'));
      const id = `p-${Date.now().toString(36)}-${uuid().slice(0, 6)}`;
      const next: DesktopUiProfile =
        formKind === 'local'
          ? {
              id,
              title: formTitle.trim() || formUrl.trim(),
              kind: 'local',
              url: formUrl.trim(),
              ...(formDeviceId.trim() ? { expectedDeviceId: formDeviceId.trim() } : {}),
            }
          : {
              id,
              title: formTitle.trim() || formUrl.trim(),
              kind: 'relay',
              url: formUrl.trim(),
              deviceId: formDeviceId.trim(),
            };
      await (api as DesktopPanelApi & { queueWrite(fn: (s: any) => any): Promise<any> }).queueWrite(s => ({
        ...s,
        profiles: [...s.profiles, next],
      }));
      setFormTitle('');
      setFormUrl('');
      setFormDeviceId('');
      setAddingRemote(false);
      setSelectedProfileId(next.id);
    });
  };

  const deleteRemoteProfile = (profileId: string) =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api) return;
      await (api as DesktopPanelApi & { queueWrite(fn: (s: any) => any): Promise<any> }).queueWrite(s => ({
        ...s,
        profiles: s.profiles.filter((p: DesktopUiProfile) => p.id !== profileId),
      }));
      if (selectedProfileId === profileId) setSelectedProfileId(null);
    });

  const connectRemoteProfile = () =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      const profile = remoteProfiles.find(p => p.id === (selectedProfileId ?? remoteProfiles[0]?.id));
      if (!api || !profile || !token.trim()) return;
      const input: DesktopConnectionInput =
        profile.kind === 'local'
          ? {
              kind: 'local',
              url: profile.url,
              token: token.trim(),
              ...(profile.expectedDeviceId ? { expectedDeviceId: profile.expectedDeviceId } : {}),
            }
          : {
              kind: 'relay',
              url: profile.url,
              deviceId: profile.deviceId,
              token: token.trim(),
              ...(ca.trim() ? { ca: ca.trim() } : {}),
            };
      api.setTransportConnected(false);
      api.setIdentity(null);
      try {
        const status = await api.broker(
          { profileId: profile.id, targetDeviceId: '', generation: 0, kind: profile.kind },
          'connect',
          { connection: input },
        );
        let targetDeviceId = '';
        if (status.connection && status.connection.kind === 'local') {
          targetDeviceId = status.connection.deviceId ?? '';
        }
        const newIdentity = api.setIdentity({
          profileId: profile.id,
          targetDeviceId,
          kind: profile.kind,
        });
        const isConn = status.phase === 'connected';
        api.setTransportConnected(isConn);
        if (isConn && newIdentity) {
          const page = await api.broker(newIdentity, 'devices', { limit: 20, cursor: null });
          setRemoteDevices(page.items);
          if (profile.kind === 'relay' && page.items.length === 1) {
            api.setIdentity({
              profileId: profile.id,
              targetDeviceId: page.items[0].deviceId,
              kind: 'relay',
            });
          }
          onRemoteUpdated();
        }
      } finally {
        setToken('');
        setCa('');
      }
    });

  const disconnectRemote = () =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api || !remoteIdentity) return;
      api.setTransportConnected(false);
      await api.broker(remoteIdentity, 'disconnect', {});
      onRemoteUpdated();
    });

  const loadLocalSettings = () =>
    action.run(async () => {
      const payload = await BotHost.settingsGet();
      setHostSettings(payload);
      setSettingsJson(JSON.stringify(payload.settings, null, 2));
      const v = await BotHost.voiceSettings();
      setVoice(v);
      setShowLocalConfig(true);
    });

  const saveLocalSettings = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      if (!hostSettings) return;
      const parsed = JSON.parse(settingsJson) as HostSettings;
      const updated = await BotHost.settingsSet({
        input: { expectedRevision: hostSettings.revision, settings: parsed },
      });
      setHostSettings(updated);
      setSettingsJson(JSON.stringify(updated.settings, null, 2));
    });
  };

  const saveLocalCredentials = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const aliases = credJson.trim() ? (JSON.parse(credJson) as Record<string, unknown>) : {};
      await BotHost.saveCredentials({ aliases });
      setCredJson('');
    });
  };

  return (
    <main className="grok-subpage grok-page-enter">
      <header className="grok-subpage-topbar">
        <button type="button" className="grok-floating-circle-btn" onClick={onBack} aria-label={t('返回', 'Back')}>
          <ArrowLeft size={20} />
        </button>
        <h2 className="grok-subpage-header-title">{t('设置', 'Settings')}</h2>
        <span style={{ width: 42 }} />
      </header>

      <div className="grok-subpage-scroll">
        <section className="hub-settings-card">
          <div className="hub-settings-card-head">
            <div>
              <h3>{t('远程连接 (Remote Host)', 'Remote Connections')}</h3>
              <p className="secondary">
                {t(
                  '配置远程连接后，远程节点上的 Bot 会直接显示在主页列表中，并在 Bot 旁标明所属节点。',
                  'Once configured, remote bots appear directly on your home screen with a host badge.',
                )}
              </p>
            </div>
            <button
              type="button"
              className="hub-outline-btn"
              onClick={() => setAddingRemote(v => !v)}
            >
              {addingRemote ? t('取消', 'Cancel') : t('+ 添加节点', '+ Add Host')}
            </button>
          </div>

          {addingRemote && (
            <form className="hub-create-form" onSubmit={saveRemoteProfile}>
              <label className="hub-field">
                <span>{t('节点名称', 'Host Name')}</span>
                <input
                  required
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  placeholder={t('输入远程节点名称', 'Enter remote host name')}
                />
              </label>
              <label className="hub-field">
                <span>{t('连接方式', 'Connection Type')}</span>
                <select value={formKind} onChange={e => setFormKind(e.target.value as 'local' | 'relay')}>
                  <option value="relay">{t('中继服务 (Relay)', 'Relay Server')}</option>
                  <option value="local">{t('直连地址 (Direct WebSocket)', 'Direct WebSocket')}</option>
                </select>
              </label>
              <label className="hub-field">
                <span>{t('连接地址 (URL)', 'Server URL')}</span>
                <input
                  required
                  value={formUrl}
                  onChange={e => setFormUrl(e.target.value)}
                  placeholder={t('输入 wss:// 或 ws:// 地址', 'Enter wss:// or ws:// URL')}
                />
              </label>
              <label className="hub-field">
                <span>
                  {formKind === 'relay'
                    ? t('客户端设备标识', 'Client Device ID')
                    : t('期望目标设备 ID (可选)', 'Expected Device ID (optional)')}
                </span>
                <input
                  required={formKind === 'relay'}
                  value={formDeviceId}
                  onChange={e => setFormDeviceId(e.target.value)}
                  placeholder={formKind === 'relay' ? t('输入设备标识', 'Enter device ID') : t('可选', 'Optional')}
                />
              </label>
              <button type="submit" className="hub-primary-submit" disabled={action.busy}>
                {t('保存远程节点', 'Save Remote Host')}
              </button>
            </form>
          )}

          {remoteProfiles.length === 0 ? (
            <p className="secondary">
              {t('当前未配置远程连接，所有智能体默认运行在本机。', 'No remote connections configured. All bots run locally by default.')}
            </p>
          ) : (
            <div className="hub-remote-profiles">
              {remoteProfiles.map(p => {
                const active = (selectedProfileId ?? remoteProfiles[0]?.id) === p.id;
                const isConnectedProfile = remoteConnected && remoteIdentity?.profileId === p.id;
                return (
                  <div key={p.id} className={`hub-remote-profile-item${active ? ' selected' : ''}`}>
                    <button
                      type="button"
                      className="hub-remote-profile-main"
                      onClick={() => setSelectedProfileId(p.id)}
                    >
                      <Server size={18} />
                      <div>
                        <strong>{p.title}</strong>
                        <small>{`${p.kind} · ${p.url}`}</small>
                      </div>
                      {isConnectedProfile && <span className="hub-online-pill">{t('已连接', 'Connected')}</span>}
                    </button>
                    <button
                      type="button"
                      className="bot-chat-icon-btn"
                      aria-label={t('删除节点', 'Remove host')}
                      onClick={() => void deleteRemoteProfile(p.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}

              <div className="hub-remote-connect-box">
                <label className="hub-field">
                  <span>{t('访问令牌 (Token)', 'Access Token')}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    placeholder={t('输入连接 Token（仅本次会话内存使用）', 'Enter connection token')}
                  />
                </label>
                {remoteProfiles.find(p => p.id === (selectedProfileId ?? remoteProfiles[0]?.id))?.kind === 'relay' && (
                  <label className="hub-field">
                    <span>{t('CA 证书 PEM (可选)', 'CA Certificate PEM (optional)')}</span>
                    <textarea
                      rows={2}
                      value={ca}
                      onChange={e => setCa(e.target.value)}
                      placeholder="-----BEGIN CERTIFICATE-----"
                    />
                  </label>
                )}
                <div className="action-row">
                  <button
                    type="button"
                    className="hub-primary-submit"
                    disabled={action.busy || !token.trim()}
                    onClick={() => void connectRemoteProfile()}
                  >
                    {t('连接远程节点', 'Connect')}
                  </button>
                  {remoteConnected && (
                    <button
                      type="button"
                      className="hub-outline-btn"
                      disabled={action.busy}
                      onClick={() => void disconnectRemote()}
                    >
                      {t('断开连接', 'Disconnect')}
                    </button>
                  )}
                </div>

                {remoteConnected && remoteIdentity?.kind === 'relay' && remoteDevices.length > 0 && (
                  <div className="hub-field" style={{ marginTop: 12 }}>
                    <span>{t('选择目标主机设备', 'Select Target Host Device')}</span>
                    <div className="hub-host-Segmented">
                      {remoteDevices.map(dev => (
                        <button
                          key={dev.deviceId}
                          type="button"
                          className={remoteIdentity.targetDeviceId === dev.deviceId ? 'active' : ''}
                          onClick={async () => {
                            const api = await ensureRemoteApi();
                            if (!api) return;
                            api.setIdentity({
                              profileId: remoteIdentity.profileId,
                              targetDeviceId: dev.deviceId,
                              kind: 'relay',
                            });
                            onRemoteUpdated();
                          }}
                        >
                          {dev.deviceId} {dev.online ? '🟢' : '⚪'}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="hub-settings-card">
          <div className="hub-settings-card-head">
            <div>
              <h3>{t('模型服务商与常用模型', 'Model Providers & Starred Models')}</h3>
              <p className="secondary">
                {t(
                  '管理内置或 Custom 服务商、API Key 凭据，并收藏 ★ 常用模型供各个 Bot 独立选用。',
                  'Configure built-in or custom providers, API keys, and ★ starred models for bots.',
                )}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {onOpenModelSheet && (
                <button type="button" className="hub-outline-btn" onClick={onOpenModelSheet}>
                  {t('服务商与模型', 'Providers & Models')}
                </button>
              )}
              {!showLocalConfig && (
                <button type="button" className="hub-outline-btn" onClick={() => void loadLocalSettings()}>
                  {t('高级 JSON', 'Advanced')}
                </button>
              )}
            </div>
          </div>

          {showLocalConfig && (
            <div className="hub-create-form">
              <form onSubmit={saveLocalCredentials} className="hub-create-form">
                <label className="hub-field">
                  <span>{t('API Key 凭据映射 (JSON)', 'API Key Credentials (JSON)')}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={credJson}
                    onChange={e => setCredJson(e.target.value)}
                    placeholder='{"OPENAI_API_KEY": "sk-..."}'
                  />
                </label>
                <button type="submit" className="hub-outline-btn" disabled={action.busy}>
                  {t('保存 API Key 凭据', 'Save Credentials')}
                </button>
              </form>

              {hostSettings && (
                <form onSubmit={saveLocalSettings} className="hub-create-form">
                  <label className="hub-field">
                    <span>{t('服务商与模型配置 (JSON)', 'Providers & Runtime JSON')}</span>
                    <textarea
                      rows={6}
                      value={settingsJson}
                      onChange={e => setSettingsJson(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <button type="submit" className="hub-outline-btn" disabled={action.busy}>
                    {t('保存模型配置', 'Save Model Config')}
                  </button>
                </form>
              )}

              {voice && (
                <label className="hub-field">
                  <span>{t('语音朗读倍速', 'Speech Rate')}</span>
                  <select
                    value={String(voice.speechRate)}
                    onChange={e =>
                      void action.run(async () => {
                        const next = { ...voice, speechRate: Number(e.target.value) };
                        await BotHost.saveVoiceSettings({ settings: next as HostVoiceSaveInput });
                        setVoice(await BotHost.voiceSettings());
                      })
                    }
                  >
                    {[0.75, 1, 1.25, 1.5, 2].map(r => (
                      <option key={r} value={String(r)}>
                        {r}×
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </section>

        {onOpenSystemSettings && (
          <section className="hub-settings-card">
            <div className="hub-settings-card-head">
              <div>
                <h3>{t('系统权限与旧版会话归档', 'System Permissions & Legacy Archive')}</h3>
                <p className="secondary">
                  {t('管理 Shizuku 权限、语音唤醒词、主题外观或查看旧版会话。', 'Manage Shizuku permissions, wake words, appearance, or legacy sessions.')}
                </p>
              </div>
              <button type="button" className="hub-outline-btn" onClick={onOpenSystemSettings}>
                {t('打开', 'Open')}
              </button>
            </div>
          </section>
        )}

        <ErrorNotice error={action.error} />
      </div>
    </main>
  );
}
