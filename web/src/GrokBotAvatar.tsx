import { useEffect, useId, useRef, useState } from 'react';
import {
  GROK_EXPRESSIONS,
  GROK_HEAD_CENTER,
  GROK_SHAPES,
  GROK_STAR_GOLD,
  GROK_STAR_PATH,
} from './grokBotData';
import {
  GROK_POKE_TYPES,
  createGrokAppearance,
  createGrokMascotController,
  normalizeGrokBodyShape,
  resolveGrokMascotState,
  type GrokMascotState,
} from './grokMascotEngine';

export interface GrokAvatarPreset {
  id: string;
  shape: string;
  color: string;
  rotation: number;
  expressionIndex: number;
  labelZh: string;
  labelEn: string;
}

export const GROK_COLOR_PALETTE: ReadonlyArray<{ id: string; hex: string; labelZh: string; labelEn: string }> = [
  { id: 'black', hex: '#080808', labelZh: '曜石黑', labelEn: 'Obsidian' },
  { id: 'brown', hex: '#7E5738', labelZh: '摩卡棕', labelEn: 'Mocha' },
  { id: 'red', hex: '#EA403C', labelZh: '珊瑚红', labelEn: 'Coral Red' },
  { id: 'orange', hex: '#E86B26', labelZh: '活力橙', labelEn: 'Tangerine' },
  { id: 'amber', hex: '#F09E2B', labelZh: '暖阳黄', labelEn: 'Amber' },
  { id: 'green', hex: '#4EBD64', labelZh: '翠竹绿', labelEn: 'Emerald' },
  { id: 'teal', hex: '#48AB94', labelZh: '松石青', labelEn: 'Teal' },
  { id: 'blue', hex: '#2B70F6', labelZh: '经典蓝', labelEn: 'Classic Blue' },
  { id: 'purple', hex: '#795BF2', labelZh: '星云紫', labelEn: 'Violet' },
  { id: 'pink', hex: '#DF4191', labelZh: '多巴胺粉', labelEn: 'Magenta' },
  { id: 'gray', hex: '#6F7072', labelZh: '岩石灰', labelEn: 'Slate Gray' },
];

export const GROK_SHAPE_ORDER: ReadonlyArray<{ shape: string; rotation: number; labelZh: string; labelEn: string }> = [
  // Row 1 (4 shapes in 15848.jpg)
  { shape: 'blob', rotation: 0, labelZh: '经典圆', labelEn: 'Circle' },
  { shape: 'cloud', rotation: -6, labelZh: '云朵', labelEn: 'Cloud' },
  { shape: 'squircle', rotation: -18, labelZh: '方糖', labelEn: 'Squircle' },
  { shape: 'gem', rotation: 0, labelZh: '四芒星', labelEn: 'Star' },
  // Row 2 (5 shapes in 15848.jpg)
  { shape: 'bean', rotation: -12, labelZh: '四叶草', labelEn: 'Clover' },
  { shape: 'arch', rotation: -10, labelZh: '爱心', labelEn: 'Heart' },
  { shape: 'crystal', rotation: 0, labelZh: '花朵', labelEn: 'Blossom' },
  { shape: 'teardrop', rotation: 10, labelZh: '水滴', labelEn: 'Droplet' },
  { shape: 'pebble', rotation: -14, labelZh: '胶囊豆', labelEn: 'Pebble' },
  // Row 3 (5 shapes in 15848.jpg)
  { shape: 'wedge', rotation: 14, labelZh: '三角', labelEn: 'Wedge' },
  { shape: 'shield', rotation: -12, labelZh: '五边形', labelEn: 'Shield' },
  { shape: 'dome', rotation: 0, labelZh: '星芒', labelEn: 'Burst' },
  { shape: 'hex', rotation: 10, labelZh: '六边形', labelEn: 'Hexagon' },
  { shape: 'leaf', rotation: -8, labelZh: '果实', labelEn: 'Fruit' },
  // Extra 4 shapes from GROK_SHAPES
  { shape: 'egg', rotation: -8, labelZh: '卵石', labelEn: 'Egg' },
  { shape: 'tablet', rotation: 12, labelZh: '方片', labelEn: 'Tablet' },
  { shape: 'capsule', rotation: -15, labelZh: '长胶囊', labelEn: 'Capsule' },
  { shape: 'cylinder', rotation: 8, labelZh: '圆柱', labelEn: 'Cylinder' },
];

export const GROK_EXPRESSION_LIST: ReadonlyArray<{ index: number; labelZh: string; labelEn: string }> = [
  { index: 0, labelZh: '专注仰视', labelEn: 'Focused' },
  { index: 1, labelZh: '灵动平视', labelEn: 'Bright' },
  { index: 2, labelZh: '好奇大眼', labelEn: 'Curious' },
  { index: 3, labelZh: '俏皮眨眼', labelEn: 'Wink' },
  { index: 4, labelZh: '向左张望', labelEn: 'Glance' },
  { index: 5, labelZh: '圆润微笑', labelEn: 'Happy' },
];

export const JARVIS_AVATAR_PRESET: GrokAvatarPreset = {
  id: 'jarvis-blue',
  shape: 'blob',
  color: '#2B70F6',
  rotation: 0,
  expressionIndex: 0,
  labelZh: '经典蓝',
  labelEn: 'Classic Blue',
};

export const GROK_AVATAR_PRESETS: ReadonlyArray<GrokAvatarPreset> = [
  { id: 'pink-wedge', shape: 'wedge', color: '#DF4191', rotation: 14, expressionIndex: 0, labelZh: '玫红三角', labelEn: 'Pink Wedge' },
  { id: 'slate-cloud', shape: 'cloud', color: '#6F7072', rotation: -6, expressionIndex: 1, labelZh: '深灰云朵', labelEn: 'Slate Cloud' },
  { id: 'pink-pebble', shape: 'pebble', color: '#DF4191', rotation: -14, expressionIndex: 1, labelZh: '粉红胶囊', labelEn: 'Pink Pebble' },
  { id: 'coral-wedge', shape: 'wedge', color: '#EA403C', rotation: 32, expressionIndex: 0, labelZh: '珊瑚三角', labelEn: 'Coral Wedge' },
  { id: 'coral-pebble', shape: 'pebble', color: '#EA403C', rotation: -14, expressionIndex: 1, labelZh: '珊瑚胶囊', labelEn: 'Coral Pebble' },
  { id: 'mint-gem', shape: 'gem', color: '#48AB94', rotation: 0, expressionIndex: 1, labelZh: '松石四芒星', labelEn: 'Teal Star' },
  { id: 'violet-bean', shape: 'bean', color: '#795BF2', rotation: -12, expressionIndex: 3, labelZh: '星云四叶草', labelEn: 'Violet Clover' },
  { id: 'solar-teardrop', shape: 'teardrop', color: '#F09E2B', rotation: 12, expressionIndex: 2, labelZh: '暖阳水滴', labelEn: 'Amber Drop' },
  { id: 'sky-hex', shape: 'hex', color: '#2B70F6', rotation: 10, expressionIndex: 4, labelZh: '天蓝六边', labelEn: 'Blue Hex' },
  { id: 'emerald-leaf', shape: 'leaf', color: '#4EBD64', rotation: -10, expressionIndex: 5, labelZh: '翠绿果实', labelEn: 'Green Fruit' },
];

const AVATAR_CONFIG_STORE_KEY = 'bot-hub-avatar-config-v2';

export function getSavedAvatarConfigMap(): Record<string, GrokAvatarPreset> {
  try {
    const raw = window.localStorage.getItem(AVATAR_CONFIG_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, GrokAvatarPreset>) : {};
  } catch {
    return {};
  }
}

export function saveBotAvatarConfig(botKey: string, config: GrokAvatarPreset): void {
  try {
    const map = getSavedAvatarConfigMap();
    map[botKey] = config;
    window.localStorage.setItem(AVATAR_CONFIG_STORE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write errors
  }
}

export function resetBotAvatarConfig(botKey: string): void {
  try {
    const map = getSavedAvatarConfigMap();
    delete map[botKey];
    window.localStorage.setItem(AVATAR_CONFIG_STORE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write errors
  }
}

export function saveBotAvatarPreset(botKey: string, presetOrId: string | GrokAvatarPreset): void {
  if (typeof presetOrId === 'object') {
    saveBotAvatarConfig(botKey, presetOrId);
    return;
  }
  const found =
    presetOrId === JARVIS_AVATAR_PRESET.id
      ? JARVIS_AVATAR_PRESET
      : GROK_AVATAR_PRESETS.find(p => p.id === presetOrId);
  if (found) {
    saveBotAvatarConfig(botKey, found);
  }
}

export function getDefaultBotAvatarPreset(botKey: string, roleName?: string, isPrimary?: boolean): GrokAvatarPreset {
  if (isPrimary) return JARVIS_AVATAR_PRESET;
  const seed = `${roleName || ''}:${botKey}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % GROK_AVATAR_PRESETS.length;
  return GROK_AVATAR_PRESETS[index];
}

export function resolveBotAvatarPreset(botKey: string, roleName?: string, isPrimary?: boolean): GrokAvatarPreset {
  const saved = getSavedAvatarConfigMap()[botKey];
  if (saved && saved.shape && saved.color) {
    return saved;
  }
  return getDefaultBotAvatarPreset(botKey, roleName, isPrimary);
}

export function GrokBotAvatar({
  preset,
  botKey,
  roleName,
  isPrimary = false,
  starBadge = false,
  busy = false,
  size = 52,
  className = '',
}: {
  preset?: GrokAvatarPreset;
  botKey?: string;
  roleName?: string;
  isPrimary?: boolean;
  starBadge?: boolean;
  busy?: boolean;
  size?: number;
  className?: string;
}) {
  const clipId = useId().replace(/:/g, '_');
  const resolved = preset ?? resolveBotAvatarPreset(botKey || roleName || 'bot', roleName, isPrimary);
  const shape = GROK_SHAPES[resolved.shape] ?? GROK_SHAPES.blob;
  const exprIdx = Math.min(Math.max(0, resolved.expressionIndex), GROK_EXPRESSIONS.length - 1);
  const [leftPath, rightPath] = GROK_EXPRESSIONS[exprIdx];
  const [leftEye, rightEye] = shape.eyes[exprIdx] ?? shape.eyes[0];
  const c = GROK_HEAD_CENTER;
  const headTransform = resolved.rotation
    ? `translate(${c} ${c}) rotate(${resolved.rotation}) translate(${-c} ${-c})`
    : undefined;
  const leftTransform = `translate(${leftEye.x} ${leftEye.y}) scale(${leftEye.scale} ${leftEye.scale}) translate(${-leftEye.cx} ${-leftEye.cy})`;
  const rightTransform = `translate(${rightEye.x} ${rightEye.y}) scale(${rightEye.scale} ${rightEye.scale}) translate(${-rightEye.cx} ${-rightEye.cy})`;

  return (
    <span
      className={`grok-bot-avatar${busy ? ' is-busy' : ''}${isPrimary ? ' is-primary' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    >
      <svg
        viewBox="-14 -14 256.54 256.54"
        width={size}
        height={size}
        xmlns="http://www.w3.org/2000/svg"
        className="grok-bot-svg"
      >
        <defs>
          <clipPath id={clipId}>
            <path d={shape.path} transform={headTransform} />
          </clipPath>
        </defs>
        <g className="grok-bot-body-group">
          <path d={shape.path} fill={resolved.color} transform={headTransform} />
          <g clipPath={`url(#${clipId})`} className="grok-bot-eyes-group">
            <path d={leftPath} fill="#ffffff" transform={leftTransform} />
            <path d={rightPath} fill="#ffffff" transform={rightTransform} />
          </g>
        </g>
        {starBadge && (
          <g transform="translate(184 184)">
            <circle cx="0" cy="0" r="34" fill="#ffffff" />
            <circle cx="0" cy="0" r="28" fill={GROK_STAR_GOLD} />
            <path d={GROK_STAR_PATH} fill="#ffffff" transform="scale(15)" />
          </g>
        )}
      </svg>
    </span>
  );
}

export function GrokBotAnimatedMark({
  seedId,
  shape = 'cloud',
  color = '#2B70F6',
  eyeColor = '#FAF8F5',
  state = 'working',
  size = 36,
  isPlaying = true,
  isEmphasized = false,
  interactivePoke = false,
  className = '',
}: {
  seedId?: string;
  shape?: string;
  color?: string;
  eyeColor?: string;
  state?: GrokMascotState;
  size?: number;
  isPlaying?: boolean;
  isEmphasized?: boolean;
  interactivePoke?: boolean;
  className?: string;
}) {
  const reactId = useId().replace(/:/g, '_');
  const markId = seedId ? `grok_mark_${seedId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${reactId}` : `grok_mark_${reactId}`;
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLSpanElement | null>(null);
  const controllerRef = useRef<ReturnType<typeof createGrokMascotController> | null>(null);
  const pokeIndexRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctrl = createGrokMascotController({
      id: markId,
      body: normalizeGrokBodyShape(shape),
      inkColor: color,
      eyeColor,
      state,
      size,
      isPlaying,
      isEmphasized,
      seed: seedId || markId,
    });
    controllerRef.current = ctrl;
    const detach = ctrl.attach({ host, canvas });
    return () => {
      detach();
      controllerRef.current = null;
    };
  }, [markId, seedId]);

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.update({
      body: normalizeGrokBodyShape(shape),
      appearance: createGrokAppearance(color, eyeColor),
      state,
      size,
      isPlaying,
      isEmphasized,
    });
  }, [shape, color, eyeColor, state, size, isPlaying, isEmphasized]);

  const handlePoke = () => {
    if (!interactivePoke || !controllerRef.current) return;
    const kind = GROK_POKE_TYPES[pokeIndexRef.current % GROK_POKE_TYPES.length] ?? 'spin';
    pokeIndexRef.current += 1;
    controllerRef.current.poke(kind, undefined);
  };

  return (
    <span
      ref={hostRef}
      className={`sand-grok-bot-mark${interactivePoke ? ' is-interactive' : ''}${className ? ` ${className}` : ''}`}
      data-grok-state={state}
      style={{ width: `${size}px`, height: `${size}px` }}
      onClick={interactivePoke ? handlePoke : undefined}
      role={interactivePoke ? 'button' : undefined}
      tabIndex={interactivePoke ? 0 : undefined}
      aria-hidden={interactivePoke ? undefined : 'true'}
      aria-label={interactivePoke ? 'Bot working indicator' : undefined}
    >
      <span ref={canvasRef} className="sand-grok-bot-mark-canvas" />
    </span>
  );
}

export function GrokBotWorkingSlot({
  botKey,
  preset,
  isBusy,
  isStreaming,
  activeToolName,
  hasThinking,
  queuedCount = 0,
  hasError = false,
  t,
}: {
  botKey: string;
  preset: GrokAvatarPreset;
  isBusy: boolean;
  isStreaming: boolean;
  activeToolName?: string | null;
  hasThinking?: boolean;
  queuedCount?: number;
  hasError?: boolean;
  t: (zh: string, en: string) => string;
}) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [settlementOutcome, setSettlementOutcome] = useState<'success' | 'error' | null>(null);
  const [emphasized, setEmphasized] = useState(false);
  const [pulseThinkingMorph, setPulseThinkingMorph] = useState(false);
  const wasBusyRef = useRef(false);

  useEffect(() => {
    if (isBusy) {
      wasBusyRef.current = true;
      setSettlementOutcome(null);
      const startMs = Date.now();
      setElapsedSec(0);
      const timer = window.setInterval(() => {
        setElapsedSec(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
      }, 1000);
      return () => window.clearInterval(timer);
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false;
      setSettlementOutcome(hasError ? 'error' : 'success');
      const settleTimer = window.setTimeout(() => {
        setSettlementOutcome(null);
        setElapsedSec(0);
      }, 1450);
      return () => window.clearTimeout(settleTimer);
    }
    return undefined;
  }, [isBusy, hasError]);

  useEffect(() => {
    if (!isBusy || isStreaming || activeToolName) {
      setPulseThinkingMorph(false);
      return undefined;
    }
    // Primarily play the 2.5D Cloud Working_A..F clips so the cloud eyes & expressions are visible,
    // and periodically pulse the Grok 'thinking' dots morph during long reasoning pauses.
    const cycle = window.setInterval(() => {
      setPulseThinkingMorph(prev => !prev);
    }, 4200);
    return () => window.clearInterval(cycle);
  }, [isBusy, isStreaming, activeToolName]);

  if (!isBusy && !settlementOutcome) return null;

  const baseState = resolveGrokMascotState({
    isBusy,
    isStreaming,
    activeToolName,
    hasThinking,
    settlementOutcome,
  });

  const mascotState: GrokMascotState =
    baseState === 'working' && pulseThinkingMorph && !activeToolName && !isStreaming ? 'thinking' : baseState;

  const statusText = (() => {
    if (!isBusy) {
      return settlementOutcome === 'error'
        ? t('执行中断', 'Interrupted')
        : t('已完成', 'Done');
    }
    if (isStreaming) {
      return t('正在回复…', 'Replying…');
    }
    const tool = (activeToolName || '').trim();
    if (tool) {
      const lower = tool.toLowerCase();
      if (/search|grep|glob|find|web_search|query|recall/.test(lower)) {
        return `${t('正在搜索', 'Searching')} · ${tool}`;
      }
      if (/write|edit|patch|create|save/.test(lower)) {
        return `${t('正在编写', 'Writing')} · ${tool}`;
      }
      if (/read|view|cat|fetch|browse|open|ls/.test(lower)) {
        return `${t('正在读取', 'Reading')} · ${tool}`;
      }
      if (/shower|android_apps/.test(lower)) {
        return `${t('正在操作屏幕', 'Controlling screen')} · ${tool}`;
      }
      if (/bash|exec|shell|cmd|run|terminal/.test(lower)) {
        return `${t('正在执行命令', 'Running command')} · ${tool}`;
      }
      return `${t('正在调用工具', 'Using tool')} · ${tool}`;
    }
    if (hasThinking) {
      return t('正在深入思考…', 'Thinking…');
    }
    if (queuedCount > 0) {
      return t('正在处理消息…', 'Processing…');
    }
    return t('正在思考…', 'Working…');
  })();

  return (
    <div
      className={`sand-activity-slot${!isBusy && settlementOutcome ? ' is-settling' : ''}`}
      data-role="assistant"
      data-grok-state={mascotState}
      aria-live="polite"
      onPointerEnter={() => setEmphasized(true)}
      onPointerLeave={() => setEmphasized(false)}
    >
      <div className="sand-activity-mark">
        <GrokBotAnimatedMark
          seedId={botKey}
          shape="cloud"
          color={preset.color}
          eyeColor="#FAF8F5"
          state={mascotState}
          size={36}
          isPlaying={true}
          isEmphasized={emphasized}
          interactivePoke={true}
        />
        <span className="sand-activity-mark-label">
          <span className={`sand-activity-label-text${isBusy ? ' is-shimmering' : ''}`}>
            {statusText}
          </span>
          {isBusy && elapsedSec >= 1 && (
            <span className="sand-activity-elapsed">{elapsedSec}s</span>
          )}
        </span>
      </div>
    </div>
  );
}
