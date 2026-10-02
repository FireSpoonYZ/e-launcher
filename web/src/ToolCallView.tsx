import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, FileText, Globe, Search, SlidersHorizontal, Terminal } from 'lucide-react';
import { AttachmentList } from './AttachmentList';
import { Dialog } from './components/ui/dialog';
import type { ConversationNode, ToolCall } from './native';
import { summarizeToolArgs, toolOutputPreview, toolResultAttachments, toolTextOverflows } from './toolResults';
import { ErrorNotice, useAction, useText } from './ui';

function ToolText({label, text}: {label: string; text: string}) {
  const t = useText();
  const action = useAction();
  const body = useRef<HTMLPreElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    let live = true;
    const measure = () => { if (live) setOverflow(toolTextOverflows(el.scrollHeight, el.clientHeight)); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(el);
    const details = el.closest('details');
    details?.addEventListener('toggle', measure);
    void document.fonts?.ready.then(measure);
    return () => { live = false; observer?.disconnect(); details?.removeEventListener('toggle', measure); };
  }, [text]);
  useEffect(() => setCopied(false), [text]);
  const copy = () => action.run(async () => { setCopied(false); await navigator.clipboard.writeText(text); setCopied(true); });
  const copyControl = () => <button className="icon-button" aria-label={t('复制', 'Copy')} onClick={() => void copy()}>{copied ? <Check/> : <Copy/>}</button>;
  return <section className="tool-block" aria-label={label}>
    <div className="tool-block-bar">
      <small>{label}</small>
      <div className="tool-block-actions">
        {overflow && <button ref={fullscreenButton} className="quiet-button tool-fullscreen" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{t('全屏查看', 'Full screen')}</button>}
        {copyControl()}
      </div>
    </div>
    <pre ref={body} className={`tool-block-body${overflow ? ' is-overflow' : ''}`} tabIndex={0}>{text}</pre>
    <ErrorNotice error={action.error}/>
    <Dialog open={open} onOpenChange={setOpen} title={label} className="tool-reader" actions={copyControl()} onCloseAutoFocus={event => { event.preventDefault(); (fullscreenButton.current ?? body.current)?.focus({preventScroll: true}); }}>
      <ErrorNotice error={action.error}/>
      <pre className="tool-reader-text" tabIndex={0}>{text}</pre>
    </Dialog>
  </section>;
}

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
  const attachments = toolResultAttachments(results);
  const attachmentSummary = t(`${attachments.length} 个附件`, `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`);
  const empty = returned ? attachments.length ? attachmentSummary : t('工具未返回文本内容', 'No text in the result') : waiting ? t('结果返回后会显示在这里', 'The result will appear here') : t('本次调用没有结果记录', 'No result was recorded for this call');
  const resultLabel = t('结果', 'Result');
  const resultText = results.map(result => result.message.content ?? '').filter(content => content.length > 0).join('\n\n');

  return <details className={`tool tool-${state}`}>
    <summary>
      <span className="tool-heading"><Icon aria-hidden="true"/><span className="tool-name">{name}</span><span className="tool-status"><span className="tool-status-dot" aria-hidden="true"/>{status}</span></span>
      {args && <code className="tool-argument" title={args}>{args}</code>}
      <span className={`tool-preview${preview ? '' : ' tool-preview-empty'}`}>{preview || empty}</span>
      <span className="tool-disclosure"><span className="tool-expand">{t('展开详情', 'Show details')}</span><span className="tool-collapse">{t('收起详情', 'Hide details')}</span><ChevronDown aria-hidden="true"/></span>
    </summary>
    <div className="tool-details">
      {tool && <ToolText label={t('参数', 'Arguments')} text={tool.arguments || '{}'}/>}
      {resultText ? <ToolText label={resultLabel} text={resultText}/> : (!returned || !attachments.length) && <section aria-label={resultLabel}><small>{resultLabel}</small><p className="tool-empty">{empty}</p></section>}
      {!!attachments.length && <AttachmentList attachments={attachments} sent/>}
    </div>
  </details>;
}
