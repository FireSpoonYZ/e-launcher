// Unified Bot session 消息来源徽标（web 共享，desktop/mobile 复用）。
// 契约：kind/botId/deviceId/channel 为稳定身份，name 仅显示；messageId/replyTo
// 用于稳定 key 与提示，不冒充可见身份。普通用户答案上隐藏 Host 触发器与
// 私聊/内部协作工作文本的来源徽标（由调用方按 channel/category 过滤决定渲染）。
import type { MessageAttribution as MessageAttributionData } from './chatTurnModel';
import { useText } from './ui';
import './MessageAttribution.css';

export interface MessageAttributionProps {
  attribution: MessageAttributionData;
  className?: string;
}

const CHANNEL_LABELS: Record<MessageAttributionData['channel'], { zh: string; en: string }> = {
  primary: { zh: '私聊', en: 'DM' },
  dm: { zh: 'Bot 私聊', en: 'bot DM' },
  room: { zh: '群聊', en: 'room' },
};

const KIND_LABELS: Record<MessageAttributionData['kind'], { zh: string; en: string }> = {
  user: { zh: '用户', en: 'user' },
  bot: { zh: 'Bot', en: 'bot' },
  host: { zh: 'Host', en: 'host' },
};

function channelLabel(channel: MessageAttributionData['channel'], t: (zh: string, en: string) => string): string {
  const l = CHANNEL_LABELS[channel];
  return l ? t(l.zh, l.en) : channel;
}

function kindLabel(kind: MessageAttributionData['kind'], t: (zh: string, en: string) => string): string {
  const l = KIND_LABELS[kind];
  return l ? t(l.zh, l.en) : kind;
}

/** 来源可读名称：name 仅显示，缺省回退 kind 标签；kind=bot 时追加 botId 前 8 字符
 * 作可见区分（同名 Bot / 同设备多 Bot），完整 botId 仍在 title/aria 供核对。 */
function senderLabel(a: MessageAttributionData, t: (zh: string, en: string) => string): string {
  const base = a.name && a.name.trim() ? a.name : kindLabel(a.kind, t);
  if (a.kind === 'bot' && a.botId) return `${base} · ${a.botId.slice(0, 8)}`;
  return base;
}

/**
 * 紧凑来源徽标：「名字 · 设备 · 频道」；Bot 来源可见名含 botId 前缀区分同名实例，
 * 完整 ID 进 title/aria 供核对。direction=outgoing 标记为本端发出；replyTo/category 作小标签。
 */
export function MessageAttribution({ attribution, className }: MessageAttributionProps) {
  const t = useText();
  const a = attribution;
  const sender = senderLabel(a, t);
  const channel = channelLabel(a.channel, t);
  const device = a.deviceId ?? '';
  const directionOutgoing = a.direction === 'outgoing';
  const isUser = a.kind === 'user';

  const idParts: string[] = [];
  if (a.botId) idParts.push(a.botId);
  if (a.scopeId) idParts.push(a.scopeId);
  if (a.messageId) idParts.push(a.messageId);
  if (a.replyTo) idParts.push('reply:' + a.replyTo);
  const ids = idParts.join(' · ');

  const categoryLabel =
    a.category === 'notice'
      ? t('通知', 'notice')
      : a.category === 'request'
        ? t('请求', 'request')
        : a.category === 'reply'
          ? t('回复', 'reply')
          : '';

  const text = [sender, device, channel].filter(Boolean).join(' · ');
  const full = [text, directionOutgoing ? t('发出', 'outgoing') : '', categoryLabel]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      className={`msg-attr msg-attr-${a.kind}${directionOutgoing ? ' msg-attr-out' : ' msg-attr-in'}${className ? ' ' + className : ''}`}
      title={ids ? `${full} · ${ids}` : full}
      aria-label={t(`来源：${full}`, `source: ${full}`) + (ids ? ` · ${ids}` : '')}
      data-channel={a.channel}
      data-kind={a.kind}
      data-user={isUser ? 'true' : undefined}
    >
      <span className="msg-attr-sender">{sender}</span>
      {device ? <span className="msg-attr-device" title={a.deviceId}>{device}</span> : null}
      <span className="msg-attr-channel">{channel}</span>
      {directionOutgoing ? <span className="msg-attr-dir">{t('发出', 'out')}</span> : null}
      {categoryLabel ? <span className="msg-attr-category">{categoryLabel}</span> : null}
    </span>
  );
}

export default MessageAttribution;
