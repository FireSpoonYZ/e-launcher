import { ChevronDown, FileText, Globe, Search, SlidersHorizontal, Terminal } from 'lucide-react';
import type { ConversationNode, ToolCall } from './native';
import { summarizeToolArgs, toolOutputPreview } from './toolResults';
import { useText } from './ui';

export function ToolCallView({tool, results, pending = false}: {tool?: ToolCall; results: ConversationNode[]; pending?: boolean}) {
  const t = useText();
  const name = tool?.name ?? t('工具结果', 'Tool result');
  const kind = name.toLowerCase();
  const Icon = /bash|shell|exec/.test(kind) ? Terminal : /read|write|edit|file/.test(kind) ? FileText : /search|grep|find/.test(kind) ? Search : /fetch|browse/.test(kind) ? Globe : SlidersHorizontal;
  const returned = results.length > 0;
  const waiting = !returned && pending;
  const state = returned ? 'returned' : waiting ? 'waiting' : 'missing';
  const status = returned ? t('已返回', 'Returned') : waiting ? t('等待结果', 'Awaiting result') : t('无结果', 'No result');
  const args = tool ? summarizeToolArgs(tool.arguments) : '';
  const preview = toolOutputPreview(results.map(result => result.message.content ?? '').join('\n\n'));
  const empty = returned ? t('工具未返回文本内容', 'No text in the result') : waiting ? t('结果返回后会显示在这里', 'The result will appear here') : t('本次调用没有结果记录', 'No result was recorded for this call');

  return <details className={`tool tool-${state}`}>
    <summary>
      <span className="tool-heading"><Icon aria-hidden="true"/><span className="tool-name">{name}</span><span className="tool-status"><span className="tool-status-dot" aria-hidden="true"/>{status}</span></span>
      {args && <code className="tool-argument" title={args}>{args}</code>}
      <span className={`tool-preview${preview ? '' : ' tool-preview-empty'}`}>{preview || empty}</span>
      <span className="tool-disclosure"><span className="tool-expand">{t('展开详情', 'Show details')}</span><span className="tool-collapse">{t('收起详情', 'Hide details')}</span><ChevronDown aria-hidden="true"/></span>
    </summary>
    <div className="tool-details">
      {tool && <section aria-label={t('参数', 'Arguments')}><small>{t('参数', 'Arguments')}</small><pre tabIndex={0}>{tool.arguments || '{}'}</pre></section>}
      <section aria-label={t('结果', 'Result')}><small>{t('结果', 'Result')}</small>{returned ? results.map(result => <pre key={result.id} tabIndex={0}>{result.message.content || empty}</pre>) : <p className="tool-empty">{empty}</p>}</section>
    </div>
  </details>;
}
