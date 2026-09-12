import { memo, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, GitBranch, Menu, Mic, Plus, Search, Settings, Share2, SlidersHorizontal, Square, SquarePen, Trash2 } from 'lucide-react';
import { Chat, Device, NativeSettings, type ChatSnapshot, type Conversation, type ConversationNode, type ConversationSummary, type NativeEvent } from './native';
import { ConfirmDialog, Dialog } from './components/ui/dialog';
import { ThinkingControl } from './ThinkingControl';
import { Empty, Environment, ErrorNotice, Header, Loading, SearchField, errorText, query, useAction, useText } from './ui';

export interface CatalogProvider { id: string; name: string; authMethods: string[]; auth: Record<string, unknown>; models: {id: string; name: string; reasoning: boolean; thinkingLevels: string[]; api: string}[] }
export function useChat() {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(); const [error, setError] = useState(''); const [status, setStatus] = useState('');
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true, reading = false, again = false;
    let current: ChatSnapshot | undefined; let events: NativeEvent[] = [];
    const commit = (next: ChatSnapshot) => { current = next; if (live) setSnapshot(next); };
    const refresh = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        const next = await Chat.snapshot();
        if (!live) return;
        if (!current || next.sequence >= current.sequence) { commit(next); setError(next.error ?? ''); }
      } catch (e) { if (live) setError(errorText(e)); }
      finally { reading = false; }
      const pending = events; events = []; pending.forEach(receive);
      if (again && live) { again = false; void refresh(); }
    };
    const receive = (event: NativeEvent) => {
      if (!live) return;
      if (!current || reading) { events.push(event); return; }
      const sequence = event.sequence ?? 0;
      if (sequence <= current.sequence) return;
      if (sequence !== current.sequence + 1 || event.conversationId !== current.conversationId) { void refresh(); return; }
      if (event.type === 'textDelta' && event.requestId === current.requestId && event.nodeId) {
        const delta = String(event.payload?.delta ?? ''); const id = event.nodeId;
        const nodes = current.conversation.nodes;
        const existing = nodes.find(n => n.id === id);
        const updated: ConversationNode = existing
          ? {...existing, message: {...existing.message, content: (existing.message.content ?? '') + delta}}
          : {id, parentId: current.conversation.leaf, message: {id, role:'assistant', content:delta, incomplete:true, toolCalls:[], toolCallId:null}};
        commit({...current, sequence, conversation: {...current.conversation, leaf:id, nodes: existing ? nodes.map(n => n.id === id ? updated : n) : [...nodes, updated]}});
      } else {
        if (event.type === 'error') setError(String(event.payload?.message ?? ''));
        if (event.type === 'runStatus') setStatus(String(event.payload?.message ?? event.payload?.status ?? ''));
        if (event.type === 'end') setStatus('');
        void refresh();
      }
    };
    refreshRef.current = refresh;
    const listener = Chat.addListener('chatEvent', receive);
    void listener.then(refresh).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; void listener.then(h => h.remove()); };
  }, []);
  return {snapshot, error, status, refresh: () => refreshRef.current()};
}
export function lineage(conversation: Conversation) {
  const nodes = new Map(conversation.nodes.map(n => [n.id, n])); const path: ConversationNode[] = [];
  for (let id = conversation.leaf; id;) { const node = nodes.get(id); if (!node) break; path.unshift(node); id = node.parentId; }
  return path;
}
export const Markdown = memo(function Markdown({text}: {text: string}) {
  const action = useAction();
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
    a: ({href, children}) => <a href={href} onClick={e => { e.preventDefault(); if (href) void action.run(() => Device.openUrl({url: href})); }}>{children}</a>,
    img: ({alt}) => <span className="secondary">{alt}</span>,
    pre: ({children}) => <pre tabIndex={0}>{children}</pre>,
    table: ({children}) => <div className="table-scroll"><table>{children}</table></div>,
  }}>{text}</ReactMarkdown><ErrorNotice error={action.error}/></div>;
});
const MessageView = memo(function MessageView({node}: {node: ConversationNode}) {
  const t = useText(); const action = useAction(); const [copied, setCopied] = useState(false); const message = node.message;
  if (message.role === 'system') return null;
  if (message.role === 'tool') return <details className="tool"><summary><Check/>{t('工具结果','Tool result')}<ChevronDown/></summary><pre>{message.content}</pre></details>;
  return <article className={`message ${message.role}`}>
    {message.content && <Markdown text={message.content}/>}
    {message.toolCalls.map(tool => <details className="tool" key={tool.id}><summary><SlidersHorizontal/><span>{tool.name}</span><ChevronDown/></summary><pre>{tool.arguments}</pre></details>)}
    {message.incomplete && <small className="secondary">{t('尚未完成','Not completed')}</small>}
    {message.content && message.role === 'assistant' && <div className="message-actions"><button className="icon-button" aria-label={t('复制','Copy')} onClick={() => action.run(async () => { await navigator.clipboard.writeText(message.content!); setCopied(true); })}>{copied ? <Check/> : <Copy/>}</button><button className="icon-button" aria-label={t('分享','Share')} onClick={() => action.run(() => Device.share({text:message.content!,title:'Pi'}))}><Share2/></button></div>}
    <ErrorNotice error={action.error}/>
  </article>;
});
export function ChatPage() {
  const chat = useChat(); const action = useAction(); const t = useText(); const nav = useNavigate(); const {device} = useContext(Environment);
  const [params] = useSearchParams();
  const [panel, setPanel] = useState<'conversations'|'models'|'apps'|null>(params.get('panel') === 'models' ? 'models' : null);
  const [draft, setDraft] = useState(''); const [following, setFollowing] = useState(true);
  const [defaults, setDefaults] = useState<Record<string,unknown>>({});
  useEffect(() => { void NativeSettings.settings({effective:true}).then(result => setDefaults(result.settings)).catch(e => action.setError(errorText(e))); }, []);
  const scroll = useRef<HTMLDivElement>(null); const textarea = useRef<HTMLTextAreaElement>(null);
  const conversation = chat.snapshot?.conversation;
  useEffect(() => { if (conversation) setDraft(conversation.draft); }, [conversation?.id]);
  useEffect(() => { if (following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [chat.snapshot?.sequence, conversation?.id, following]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`; } }, [draft]);
  if (!chat.snapshot || !conversation) return <><Loading/><ErrorNotice error={chat.error}/></>;
  const running = chat.snapshot.running;
  const changeDraft = (value: string) => { setDraft(value); void Chat.saveDraft({conversationId:conversation.id,text:value}).catch(e => action.setError(errorText(e))); };
  const send = () => action.run(async () => {
    if (!draft.trim() || running) return;
    await Chat.saveDraft({conversationId:conversation.id,text:draft});
    const accepted = await Chat.send({conversationId:conversation.id,text:draft,submissionId:crypto.randomUUID()});
    if (accepted.accepted) { setDraft(''); setFollowing(true); }
    await chat.refresh();
  });
  const changed = async () => { setPanel(null); await chat.refresh(); };
  const selection = {model: defaults.defaultModel, thinkingLevel: defaults.defaultThinkingLevel, ...conversation.piSelection};
  return <main className="chat-page"><header className="chat-header"><button className="icon-button" aria-label={t('会话列表','Conversations')} onClick={() => setPanel('conversations')}><Menu/></button><button className="model-title" onClick={() => device?.piMode ? setPanel('models') : nav('/settings/general')}><strong>{device?.piMode ? 'Pi' : 'Android Agent'}</strong><span>{String(selection.model || t('选择模型','Choose model'))}<ChevronDown/></span></button><button className="icon-button" aria-label={t('新会话','New conversation')} disabled={running || action.busy} onClick={() => action.run(async () => { await Chat.newConversation(); await chat.refresh(); })}><SquarePen/></button></header>
    <section className="messages" ref={scroll} onScroll={e => { const el = e.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 90); }}>
      {lineage(conversation).filter(n => n.message.role !== 'system').length ? lineage(conversation).map(node => <MessageView node={node} key={node.id}/>) : <div className="chat-empty"><span className="empty-mark">Pi</span><h1>{t('今天想聊些什么？','What’s on your mind?')}</h1><p>{t('从一个问题开始。','Start with a question.')}</p></div>}
    </section>
    <footer className="composer-wrap">{!following && <button className="scroll-latest icon-button" aria-label={t('回到最新消息','Latest message')} onClick={() => setFollowing(true)}><ArrowDown/></button>}
      <ErrorNotice error={action.error || chat.error}/>{running && <div className="run-status" role="status"><span className="pulse-dot"/>{chat.status || t('正在回复…','Working…')}</div>}
      <div className="composer"><textarea ref={textarea} value={draft} rows={1} placeholder={t('发消息…','Message…')} aria-label={t('消息','Message')} onChange={e => changeDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-tools"><button className="icon-button" aria-label={t('选择应用','Choose app')} onClick={() => setPanel('apps')}><Plus/></button><button className="icon-button" aria-label={t('历史分支','History')} onClick={() => nav(`/history/${conversation.id}`)}><GitBranch/></button><span className="composer-spacer"/>{device?.piMode && <ThinkingControl conversation={conversation} level={String(selection.thinkingLevel || '')} disabled={running || action.busy} onChange={chat.refresh}/>}<button className="icon-button" aria-label={t('语音输入','Voice input')} onClick={() => action.run(async () => { await Chat.saveDraft({conversationId:conversation.id,text:draft}); const result = await Device.voice(); setDraft(result.text); })}><Mic/></button>{running ? <button className="send-button" aria-label={t('停止生成','Stop')} onClick={() => action.run(() => Chat.cancel())}><Square/></button> : <button className="send-button" aria-label={t('发送','Send')} disabled={!draft.trim() || action.busy} onClick={send}><ArrowUp/></button>}</div></div>
    </footer>
    <ConversationDrawer open={panel === 'conversations'} close={() => setPanel(null)} conversation={conversation} running={running} onChange={changed}/>
    {panel === 'models' && <ModelSheet conversation={conversation} disabled={running} close={() => setPanel(null)} onChange={chat.refresh}/>}
    {panel === 'apps' && <AppPicker close={() => setPanel(null)}/>}
  </main>;
}
function ConversationDrawer({open, close, conversation, running, onChange}: {open: boolean; close(): void; conversation: Conversation; running: boolean; onChange(): Promise<void>}) {
  const [items, setItems] = useState<ConversationSummary[]>([]); const [search, setSearch] = useState(''); const [remove, setRemove] = useState<ConversationSummary>();
  const action = useAction(); const t = useText(); const nav = useNavigate();
  useEffect(() => { if (open) void action.run(async () => { setItems((await Chat.listConversations()).conversations); }); }, [open]);
  return <><Dialog open={open} onOpenChange={value => !value && close()} title={t('会话','Conversations')} drawer><SearchField value={search} onChange={setSearch} placeholder={t('搜索会话','Search conversations')}/><button className="wide-action" disabled={running} onClick={() => action.run(async () => { await Chat.newConversation(); await onChange(); })}><Plus/>{t('新会话','New conversation')}</button><ErrorNotice error={action.error}/>{running && <p className="secondary">{t('停止生成后可切换会话。','Stop the current response to switch conversations.')}</p>}<div className="conversation-list">{items.filter(item => item.title.toLowerCase().includes(search.toLowerCase())).map(item => <div className={`conversation-row ${item.id === conversation.id ? 'selected' : ''}`} key={item.id}><button disabled={running} onClick={() => action.run(async () => { await Chat.selectConversation({conversationId:item.id}); await onChange(); })}><span>{item.title}</span><small>{new Date(item.updated).toLocaleDateString()}</small></button><button className="icon-button" aria-label={t('删除会话','Delete conversation')} disabled={running} onClick={() => setRemove(item)}><Trash2/></button></div>)}</div><button className="wide-action drawer-settings" onClick={() => { close(); nav('/settings'); }}><Settings/>{t('设置','Settings')}</button></Dialog><ConfirmDialog open={!!remove} title={t('删除会话？','Delete conversation?')} description={t('会话及所有分支将被删除。','This conversation and all its branches will be deleted.')} danger onCancel={() => setRemove(undefined)} onConfirm={() => action.run(async () => { await Chat.deleteConversation({conversationId:remove!.id}); setRemove(undefined); await onChange(); })}/></>;
}
function ModelSheet({conversation, disabled, close, onChange}: {conversation: Conversation; disabled: boolean; close(): void; onChange(): Promise<void>}) {
  const t = useText(); const nav = useNavigate(); const action = useAction();
  const [providers, setProviders] = useState<CatalogProvider[]>([]); const [defaults, setDefaults] = useState<Record<string,unknown>>({}); const [search, setSearch] = useState('');
  useEffect(() => { void action.run(async () => { setDefaults((await NativeSettings.settings({effective:true})).settings); setProviders(await query<CatalogProvider[]>('catalog')); }); }, []);
  const providerId = String(conversation.piSelection.provider || defaults.defaultProvider || '');
  const modelId = String(conversation.piSelection.model || defaults.defaultModel || '');
  const current = providers.find(p => p.id === providerId)?.models.find(m => m.id === modelId);
  const thinking = String(conversation.piSelection.thinkingLevel || defaults.defaultThinkingLevel || '');
  const select = (provider: string, model: string, level?: string) => action.run(async () => {
    await Chat.selectModel({conversationId:conversation.id,providerId:provider,modelId:model,thinkingLevel:level,expectedSelection:JSON.stringify(conversation.piSelection)}); await onChange();
  });
  return <Dialog open onOpenChange={v => !v && close()} title={t('模型与思考','Model & thinking')} sheet><p className="panel-subtitle">{t('仅用于当前会话','Only for this conversation')}</p><SearchField value={search} onChange={setSearch} placeholder={t('搜索模型','Search models')}/><ErrorNotice error={action.error}/>{disabled && <p className="secondary">{t('停止生成后可更换模型。','Stop the response before changing model.')}</p>}
    <div className="model-list">{action.busy && !providers.length && <Loading/>}{providers.map(provider => {
      const models = provider.models.filter(model => `${provider.name} ${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase()));
      return models.length > 0 && <section className="model-group" key={provider.id}><h3>{provider.name || provider.id}</h3>{models.map(model => <button className="model-row" key={model.id} disabled={disabled || action.busy} onClick={() => select(provider.id,model.id,model.thinkingLevels.includes(thinking) ? thinking : undefined)}><span>{model.name || model.id}<small>{model.id}</small></span>{provider.id === providerId && model.id === modelId && <Check className="selected-check"/>}</button>)}</section>;
    })}</div>
    {current && <section className="thinking-section"><h3>{t('思考强度','Thinking level')}</h3><div className="segments thinking">{current.thinkingLevels.map(level => <button key={level} disabled={disabled || action.busy} aria-pressed={thinking === level} onClick={() => select(providerId,modelId,level)}>{level === 'off' ? t('关闭','Off') : level}</button>)}</div></section>}
    <button className="wide-action" onClick={() => { close(); nav('/settings/providers'); }}>{t('管理服务商','Manage providers')}<Settings/></button><button className="button full" onClick={close}>{t('完成','Done')}</button>
  </Dialog>;
}
function AppPicker({close}: {close(): void}) {
  const [apps, setApps] = useState<Awaited<ReturnType<typeof Device.apps>>['apps']>([]); const [search, setSearch] = useState(''); const action = useAction(); const t = useText();
  useEffect(() => { void action.run(async () => setApps((await Device.apps()).apps)); }, []);
  return <Dialog open title={t('选择应用','Choose an app')} onOpenChange={v => !v && close()} sheet><SearchField value={search} onChange={setSearch} placeholder={t('搜索应用','Search apps')}/><ErrorNotice error={action.error}/><div className="app-grid">{apps.filter(a => a.label.toLowerCase().includes(search.toLowerCase())).map(app => <button key={`${app.packageName}/${app.className}`} onClick={() => action.run(async () => { await Device.launchApp(app); close(); })}><img src={app.icon} alt=""/><span>{app.label}</span></button>)}</div></Dialog>;
}
export function HistoryPage() {
  const {snapshot, error} = useChat(); const [previewId, setPreviewId] = useState<string>(); const [search, setSearch] = useState(''); const [searching, setSearching] = useState(false); const action = useAction(); const t = useText(); const nav = useNavigate();
  const conversation = snapshot?.conversation;
  if (!conversation) return <><Loading/><ErrorNotice error={error}/></>;
  const preview = conversation.nodes.find(n => n.id === (previewId ?? conversation.leaf)); const path = new Set(lineage(conversation).map(n => n.id));
  const children = new Map<string|null,ConversationNode[]>();
  conversation.nodes.forEach(node => children.set(node.parentId, [...(children.get(node.parentId) ?? []),node]));
  const tree = (parent: string|null): React.ReactNode => <ul>{(children.get(parent) ?? []).map(node => <li key={node.id}><button aria-pressed={preview?.id === node.id} className={`${path.has(node.id) ? 'on-path' : ''} ${preview?.id === node.id ? 'previewing' : ''}`} onClick={() => setPreviewId(node.id)}><span className="tree-dot"/><span>{(node.message.content || t('工具消息','Tool message')).slice(0,90)}</span></button>{tree(node.id)}</li>)}</ul>;
  return <main className="history-page"><Header title={t('会话历史','Conversation history')} actions={<button className="icon-button" aria-label={t('搜索节点','Search nodes')} onClick={() => setSearching(!searching)}><Search/></button>}/><div className="history-heading"><h2>{conversation.nodes.find(n => n.message.role === 'user')?.message.content?.slice(0,40) || t('历史分支','History')}</h2><p>{t('选择节点查看内容','Select a node to preview')}</p>{searching && <SearchField value={search} onChange={setSearch} placeholder={t('搜索历史','Search history')}/>}</div><section className="tree-scroll"><div className="tree">{search ? conversation.nodes.filter(n => n.message.content?.toLowerCase().includes(search.toLowerCase())).map(n => <button key={n.id} onClick={() => setPreviewId(n.id)}>{n.message.content?.slice(0,90)}</button>) : tree(null)}</div></section><ErrorNotice error={action.error || error}/>{preview && <section className="preview-panel"><div className="sheet-handle"/><h2>{t('节点预览','Node preview')}</h2><small className="secondary">{preview.message.role === 'user' ? t('你','You') : preview.message.role === 'tool' ? t('工具','Tool') : t('助手','Assistant')}</small><div className="preview-content"><Markdown text={preview.message.content || ''}/></div><button className="quiet-button copy-preview" onClick={() => action.run(() => navigator.clipboard.writeText(preview.message.content || ''))}><Copy/>{t('复制','Copy')}</button><button className="button full" disabled={snapshot.running || action.busy} onClick={() => action.run(async () => { await Chat.selectNode({conversationId:conversation.id,nodeId:preview.id,edit:preview.message.role === 'user'}); nav('/chat', {replace:true}); })}><GitBranch/>{preview.message.role === 'user' ? t('编辑并续接','Edit and continue') : t('从这里继续','Continue from here')}</button><button className="quiet-button full" onClick={() => nav('/chat',{replace:true})}>{t('返回对话','Back to chat')}</button>{snapshot.running && <p className="secondary">{t('正在生成，可预览；停止后可续接。','Generation is active. Stop it before continuing a branch.')}</p>}</section>}</main>;
}
