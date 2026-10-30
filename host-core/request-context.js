import { defineDoc } from '@earendil-works/pi-durable';

// Request budgeting is independent of any context-preparation provider.
export const RequestContext = defineDoc({
  kind: 'host.request-context',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ prepared: null }),
  checkpointWhen: () => true,
});

export function countMessageTokens({ text = '', thinkingTokens = 0 }) {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4) +
    (typeof thinkingTokens === 'number' && Number.isFinite(thinkingTokens) && thinkingTokens > 0 ? thinkingTokens : 0);
}

export function countRequestTokens(request) {
  return request.messages.reduce((sum, message) => {
    const content = message.content;
    const pure = (message.role === 'user' || message.role === 'assistant') &&
      (message.role === 'user' && typeof content === 'string' || Array.isArray(content) && content.every((item) => item.type === 'text'));
    const text = pure ? (typeof content === 'string' ? content : content.map((item) => item.text).join('\n')) : JSON.stringify(message);
    return sum + countMessageTokens({ text });
  }, 0);
}
