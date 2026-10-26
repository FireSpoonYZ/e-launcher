// Bot 屏幕面板（右抽屉）：预览该 Bot 的工作屏幕，右下角唯一的「接管操作」按钮。
// 接管 = 先 interrupt 当前对话，再让执行器停止在途动作并接受人工操作；没有「交还」，
// 之后 Bot 与用户可同时操作。画面本身由平台客户端负责（本机 Android 为原生覆盖层）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hand, Maximize2, Minimize2, Monitor } from 'lucide-react';
import { resolveScreenClient, type ScreenViewState, type ScreenViewer } from './screen';
import { errorText, useText } from './ui';

/** 抽屉滑入/全屏切换动画时长之后才把原生画面贴上去，避免画面跟不上动画。 */
const SETTLE_MS = 360;
const POLL_MS = 800;
const STAGE_RADIUS = 14;

export type BotScreenPanelProps = {
  botId: string;
  hostKind: 'local' | 'remote';
  open: boolean;
  fullscreen: boolean;
  onFullscreenChange(next: boolean): void;
  /** 中断该 Bot 当前对话（已有 interrupt/abort）；失败不阻止执行器侧接管。 */
  onInterrupt(): Promise<void>;
};

export function BotScreenPanel({ botId, hostKind, open, fullscreen, onFullscreenChange, onInterrupt }: BotScreenPanelProps) {
  const t = useText();
  const resolution = useMemo(() => resolveScreenClient({ botId, hostKind }), [botId, hostKind]);
  const [state, setState] = useState<ScreenViewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ScreenViewer | null>(null);
  const settledRef = useRef(false);

  const pushLayout = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const rect = stageRef.current?.getBoundingClientRect();
    const visible = settledRef.current && !!rect && rect.width > 0 && rect.height > 0;
    const viewport = visible && rect
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height, radius: STAGE_RADIUS }
      : null;
    viewer.layout(viewport).then(next => {
      if (viewerRef.current === viewer) setState(next);
    }).catch(() => {});
  }, []);

  // 打开/关闭观看：只在抽屉打开且有可用客户端时连接；关闭预览不销毁工作屏幕。
  useEffect(() => {
    setState(null);
    setError('');
    if (!open || resolution.kind !== 'client') return;
    let alive = true;
    let opened: ScreenViewer | null = null;
    resolution.client.open(botId).then(viewer => {
      if (!alive) {
        void viewer.close().catch(() => {});
        return;
      }
      opened = viewer;
      viewerRef.current = viewer;
      pushLayout();
    }).catch(failure => {
      if (alive) setError(errorText(failure));
    });
    const poll = window.setInterval(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.status().then(next => {
        if (alive && viewerRef.current === viewer) setState(next);
      }).catch(() => {});
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(poll);
      viewerRef.current = null;
      if (opened) void opened.close().catch(() => {});
    };
  }, [open, botId, resolution, pushLayout]);

  // 动画期间隐藏原生画面，稳定后再按占位元素位置贴上。
  useEffect(() => {
    settledRef.current = false;
    pushLayout();
    if (!open) return;
    const timer = window.setTimeout(() => {
      settledRef.current = true;
      pushLayout();
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open, fullscreen, pushLayout]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !open) return;
    const observer = new ResizeObserver(() => pushLayout());
    observer.observe(stage);
    window.addEventListener('resize', pushLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', pushLayout);
    };
  }, [open, pushLayout]);

  const takeover = async () => {
    const viewer = viewerRef.current;
    if (!viewer || busy) return;
    setBusy(true);
    setError('');
    try {
      try {
        await onInterrupt();
      } catch (failure) {
        setError(t('中断对话失败：', 'Interrupt failed: ') + errorText(failure));
      }
      const next = await viewer.takeover();
      if (viewerRef.current === viewer) setState(next);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const supported = resolution.kind === 'client';
  const phase = supported ? state?.phase ?? 'connecting' : 'unsupported';
  const live = supported && phase === 'live' && state?.live === true;
  const userControl = live && state?.userControl === true;

  let statusText = '';
  if (resolution.kind === 'unsupported') {
    statusText = resolution.reason === 'remote'
      ? t('远端 Bot 的屏幕预览将在后续版本支持', 'Screen preview for remote Bots is coming later')
      : resolution.reason === 'not-created'
        ? t('这个 Bot 还没有屏幕', 'This Bot has no screen yet')
        : t('当前界面不支持屏幕预览', 'Screen preview is not available in this interface');
  } else if (phase === 'none') {
    statusText = t('这个 Bot 还没有屏幕，它用到屏幕时会自动创建', 'This Bot has no screen yet. It is created when the Bot needs one');
  } else if (phase === 'ended') {
    statusText = t('屏幕已关闭（已释放或空闲回收），Bot 下次用到时会重新创建', 'The screen was closed (released or idle). The Bot will create a new one when needed');
  } else if (phase === 'error' || phase === 'unavailable') {
    statusText = state?.message || t('画面连接失败，正在重试', 'Connection failed, retrying');
  } else if (!live) {
    statusText = t('正在连接画面…', 'Connecting…');
  }

  const metaText = !live
    ? ''
    : userControl
      ? t('你可以直接操作，Bot 也可能同时操作', 'You can operate now; the Bot may act at the same time')
      : t(`实时 · ${state?.width ?? 0}×${state?.height ?? 0}`, `Live · ${state?.width ?? 0}×${state?.height ?? 0}`);

  return (
    <section className={`bot-screen-panel${fullscreen ? ' fullscreen' : ''}`}>
      <div className="bot-screen-stage" ref={stageRef}>
        {!live && (
          <div className="bot-screen-status" role="status">
            <Monitor size={28} />
            <p>{statusText}</p>
          </div>
        )}
      </div>
      {error && <p className="bot-screen-error" role="alert">{error}</p>}
      <footer className="bot-screen-toolbar">
        <span className="bot-screen-meta">{metaText}</span>
        <button
          type="button"
          className="bot-chat-icon-btn"
          aria-label={fullscreen ? t('退出全屏', 'Exit full screen') : t('全屏', 'Full screen')}
          disabled={!supported}
          onClick={() => onFullscreenChange(!fullscreen)}
        >
          {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
        <button
          type="button"
          className={`bot-screen-takeover${userControl ? ' active' : ''}`}
          disabled={!live || userControl || busy}
          onClick={() => void takeover()}
        >
          <Hand size={16} />
          <span>
            {userControl ? t('操作中', 'In control') : busy ? t('正在接管…', 'Taking over…') : t('接管操作', 'Take over')}
          </span>
        </button>
      </footer>
    </section>
  );
}
