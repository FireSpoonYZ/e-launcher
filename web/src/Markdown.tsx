import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Device } from './native';
import { ErrorNotice, useAction } from './ui';

export const Markdown = memo(function Markdown({text}: {text: string}) {
  const action = useAction();
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
    a: ({href, children}) => <a href={href} onClick={event => { event.preventDefault(); if (href) void action.run(() => Device.openUrl({url: href})); }}>{children}</a>,
    img: ({alt}) => <span className="secondary">{alt}</span>,
    pre: ({children}) => <pre tabIndex={0}>{children}</pre>,
    table: ({children}) => <div className="table-scroll"><table>{children}</table></div>,
  }}>{text}</ReactMarkdown><ErrorNotice error={action.error}/></div>;
});
