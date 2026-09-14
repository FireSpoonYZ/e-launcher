import { memo, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Camera, Check, ChevronDown, Copy, GitBranch, Image, LoaderCircle, Menu, Mic, Paperclip, Plus, RotateCcw, Search, Settings, Share2, Square, SquarePen, Trash2 } from 'lucide-react';
import { Chat, Device, NativeSettings, type ChatSnapshot, type Conversation, type ConversationNode, type ConversationSummary, type ExtensionUiState, type NativeEvent } from './native';
import { AttachmentList } from './AttachmentList';
import { LatestRequest } from './latestRequest';
import { pairToolResults, toolCallKey } from './toolResults';
import { ToolCallView } from './ToolCallView';
import { ConfirmDialog, Dialog } from './components/ui/dialog';
import { ThinkingControl } from './ThinkingControl';
import { ComposerPopover } from './ComposerPopover';
import { useKeyboardVisible } from './useKeyboardVisible';
import { ExtensionDock } from './ExtensionDock';
import { Markdown } from './Markdown';
import { Questionnaire, type QuestionnaireReplyEvent } from './Questionnaire';
import { Empty, ErrorNotice, Header, Loading, SearchField, errorText, query, useAction, useText } from './ui';

export interface CatalogProvider { id: string; name: string; authMethods: string[]; auth: Record<string, unknown>; models: {id: string; name: string; reasoning: boolean; thinkingLevels: string[]; api: string}[] }
export function useChat() {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(); const [error, setError] = useState(''); const [status, setStatus] = useState('');
  const [questionnaireReply, setQuestionnaireReply] = useState<QuestionnaireReplyEvent>();
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
        if (!current || next.sequence >= current.sequence) { commit(next); setError(next.error ?? ''); setStatus(next.status ?? ''); }
      } catch (e) { if (live) setError(errorText(e)); }
      finally { reading = false; }
      const pending = events; events = []; pending.forEach(receive);
      if (again && live) { again = false; void refresh(); }
    };
    const receive = (event: NativeEvent) => {
      if (!live) return;
      if (!current || reading) { events.push(event); return; }
      const sequence = event.sequence ?? 0;
      if (event.type === 'questionnaireReply') {
        const payload = event.payload ?? {};
        if (typeof payload.questionnaireId === 'string' && typeof payload.accepted === 'boolean') {
          setQuestionnaireReply({
            questionnaireId: payload.questionnaireId,
            accepted: payload.accepted,
            message: typeof payload.message === 'string' ? payload.message : undefined,
            conversationId: event.conversationId,
            requestId: event.requestId,
            sequence,
          });
        }
      }
      if (sequence <= current.sequence) return;
      if (sequence !== current.sequence + 1 || event.conversationId !== current.conversationId) { void refresh(); return; }
      if (event.type === 'textDelta' && event.requestId === current.requestId && event.nodeId) {
        const delta = String(event.payload?.delta ?? ''); const id = event.nodeId;
        const nodes = current.conversation.nodes;
        const existing = nodes.find(n => n.id === id);
        const updated: ConversationNode = existing
          ? {...existing, message: {...existing.message, content: (existing.message.content ?? '') + delta}}
          : {id, parentId: current.conversation.leaf, message: {id, role:'assistant', content:delta, incomplete:true, toolCalls:[], toolCallId:null, attachments:[]}};
        commit({...current, sequence, conversation: {...current.conversation, leaf:id, nodes: existing ? nodes.map(n => n.id === id ? updated : n) : [...nodes, updated]}});
      } else if (event.type === 'extensionUi' && event.requestId === current.requestId) {
        commit({...current, sequence, extensionUi:event.payload as ExtensionUiState});
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
  return {snapshot, error, status, questionnaireReply, refresh: () => refreshRef.current()};
}
export function lineage(conversation: Conversation) {
  const nodes = new Map(conversation.nodes.map(n => [n.id, n])); const path: ConversationNode[] = [];
  for (let id = conversation.leaf; id;) { const node = nodes.get(id); if (!node) break; path.unshift(node); id = node.parentId; }
  return path;
}
const MessageView = memo(function MessageView({node, toolResults, pending}: {node: ConversationNode; toolResults: Map<string, ConversationNode[]>; pending: boolean}) {
  const t = useText(); const action = useAction(); const [copied, setCopied] = useState(false); const message = node.message;
  if (message.role === 'system') return null;
  if (message.role === 'tool') return <ToolCallView results={[node]}/>;
  return <article className={`message ${message.role}`}>
    {!!message.attachments?.length && <AttachmentList attachments={message.attachments} sent/>}
    {message.content && <Markdown text={message.content}/>}
    {message.toolCalls.map((tool, index) => <ToolCallView key={toolCallKey(node.id, index)} tool={tool} results={toolResults.get(toolCallKey(node.id, index)) ?? []} pending={pending}/>)}
    {message.incomplete && <small className="secondary">{t('尚未完成','Not completed')}</small>}
    {message.content && message.role === 'assistant' && <div className="message-actions"><button className="icon-button" aria-label={t('复制','Copy')} onClick={() => action.run(async () => { await navigator.clipboard.writeText(message.content!); setCopied(true); })}>{copied ? <Check/> : <Copy/>}</button><button className="icon-button" aria-label={t('分享','Share')} onClick={() => action.run(() => Device.share({text:message.content!,title:'Pi'}))}><Share2/></button></div>}
    <ErrorNotice error={action.error}/>
  </article>;
});
function useConversationDefaults(conversation?: Conversation) {
  const [defaults, setDefaults] = useState<Record<string,unknown>>({});
  const [error, setError] = useState('');
  const requestGate = useRef(new LatestRequest()).current;
  useEffect(() => {
    const request = requestGate.begin();
    setDefaults({}); setError('');
    if (!conversation) return () => requestGate.cancel(request);
    void NativeSettings.settings({effective:true, conversationId:conversation.id}).then(result => {
      if (requestGate.current(request)) setDefaults(result.settings);
    }).catch(e => { if (requestGate.current(request)) setError(errorText(e)); });
    return () => requestGate.cancel(request);
  }, [conversation?.id]);
  return {defaults, error};
}

export function ChatPage() {
  const chat = useChat(); const action = useAction(); const t = useText();
  const [params] = useSearchParams(); const keyboardVisible = useKeyboardVisible();
  const [panel, setPanel] = useState<'conversations'|'models'|null>(params.get('panel') === 'models' ? 'models' : null);
  const [following, setFollowing] = useState(true);
  const conversation = chat.snapshot?.conversation;
  const configured = useConversationDefaults(conversation);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { if (following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [chat.snapshot?.sequence, conversation?.id, following]);
  if (!chat.snapshot || !conversation) return <><Loading/><ErrorNotice error={chat.error}/></>;
  const running = chat.snapshot.running;
  const questionnaire = running ? chat.snapshot.extensionUi?.askUser : null;
  const changed = async () => { setPanel(null); await chat.refresh(); };
  const selection = {model: configured.defaults.defaultModel, thinkingLevel: configured.defaults.defaultThinkingLevel, ...conversation.piSelection};
  const path = lineage(conversation); const paired = pairToolResults(path);
  const activeMessage = path.filter(node => node.message.role !== 'tool').at(-1);
  return <main className="chat-page"><header className="chat-header"><button className="icon-button" aria-label={t('会话列表','Conversations')} onClick={() => setPanel('conversations')}><Menu/></button><button className="model-title" onClick={() => setPanel('models')}><strong>Pi</strong><span>{String(selection.model || t('选择模型','Choose model'))}<ChevronDown/></span></button><button className="icon-button" aria-label={t('新会话','New conversation')} disabled={action.busy} onClick={() => action.run(async () => { await Chat.newConversation(); await chat.refresh(); })}><SquarePen/></button></header>
    <section className="messages" ref={scroll} onClick={e => {
      if (keyboardVisible && !document.querySelector('.composer-popover[role="dialog"],.attachment-popover') && !(e.target as HTMLElement).closest('button,a,input,textarea,summary,pre')) {
        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.blur(); void Device.hideKeyboard();
      }
    }} onScroll={e => { const el = e.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 90); }}>
      {path.some(n => n.message.role !== 'system') ? path.filter(node => !paired.embeddedResultIds.has(node.id)).map(node => <MessageView node={node} toolResults={paired.byCall} pending={running && node.id === activeMessage?.id} key={node.id}/>) : <div className="chat-empty"><span className="empty-mark">Pi</span><h1>{t('今天想聊些什么？','What’s on your mind?')}</h1><p>{t('从一个问题开始。','Start with a question.')}</p></div>}
    </section>
    <footer className="composer-wrap">{!following && <button className="scroll-latest icon-button" aria-label={t('回到最新消息','Latest message')} onClick={() => setFollowing(true)}><ArrowDown/></button>}
      <ErrorNotice error={action.error || chat.error || configured.error}/>{questionnaire && chat.snapshot.requestId ? <Questionnaire key={`${conversation.id}:${chat.snapshot.requestId}:${questionnaire.id}`} conversationId={conversation.id} requestId={chat.snapshot.requestId} questionnaire={questionnaire} reply={chat.questionnaireReply}/> : <>{running && <div className="run-status" role="status"><LoaderCircle className="spin" aria-hidden="true"/>Working</div>}
      <ExtensionDock conversationId={conversation.id} state={chat.snapshot.extensionUi} working={chat.snapshot.activeRuns.some(run => run.conversationId === conversation.id && run.status === 'running')}/>
      <ConversationComposer conversation={conversation} running={running} selection={selection} refresh={chat.refresh} showBranch onAccepted={() => setFollowing(true)}/></>}
    </footer>
    <ConversationDrawer open={panel === 'conversations'} close={() => setPanel(null)} conversation={conversation} activeRuns={chat.snapshot.activeRuns} onChange={changed}/>
    {panel === 'models' && <ModelSheet conversation={conversation} disabled={running} close={() => setPanel(null)} onChange={chat.refresh}/>}

  </main>;
}

type ConversationComposerProps = {
  conversation: Conversation;
  running: boolean;
  selection: Record<string, unknown>;
  refresh(): Promise<void>;
  showBranch?: boolean;
  onAccepted?(conversationId: string): void | Promise<void>;
};

function ConversationComposer({conversation, running, selection, refresh, showBranch=false, onAccepted}: ConversationComposerProps) {
  const action = useAction(); const t = useText(); const keyboardVisible = useKeyboardVisible();
  const [composerPanel, setComposerPanel] = useState<'tree'|'thinking'|'attachments'|null>(null);
  const [attachmentError,setAttachmentError]=useState(''); const [retryKind,setRetryKind]=useState<'camera'|'image'|'file'>('file');
  const [preparing,setPreparing]=useState(false); const [draft, setDraft] = useState(conversation.draft);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(conversation.draft); }, [conversation.id]);
  useEffect(() => { if (!keyboardVisible && composerPanel !== 'attachments') setComposerPanel(null); }, [keyboardVisible]);
  useEffect(() => {
    if (composerPanel !== 'attachments') return;
    const dismiss = (event: Event) => { event.preventDefault(); setComposerPanel(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(event); };
    window.addEventListener('composer-back', dismiss); document.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('composer-back', dismiss); document.removeEventListener('keydown', key, true); };
  }, [composerPanel]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`;
  }, [draft]);
  const changeDraft = (value: string) => {
    setDraft(value);
    void Chat.saveDraft({conversationId:conversation.id,text:value}).catch(e => action.setError(errorText(e)));
  };
  const chooseAttachment = async (kind:'camera'|'image'|'file') => {
    setComposerPanel(null); setRetryKind(kind); setAttachmentError(''); setPreparing(true);
    try { await Device.chooseAttachment({conversationId:conversation.id,kind}); await refresh(); }
    catch(e) { const message=errorText(e); if (!message.includes('取消')) setAttachmentError(message); }
    finally { setPreparing(false); }
  };
  const removeAttachment = (id:string) => {
    void action.run(async()=>{await Device.removeAttachment({conversationId:conversation.id,attachmentId:id});await refresh();});
  };
  const send = () => action.run(async () => {
    if ((!draft.trim() && !conversation.draftAttachments.length) || running || preparing) return;
    await Chat.saveDraft({conversationId:conversation.id,text:draft});
    const accepted = await Chat.send({conversationId:conversation.id,text:draft,submissionId:crypto.randomUUID()});
    await refresh();
    if (accepted.accepted) { setDraft(''); await onAccepted?.(conversation.id); }
  });
  return <>
    <ErrorNotice error={action.error}/>
    {attachmentError&&<div className="attachment-error" role="alert"><span>{attachmentError}</span><button onClick={()=>void chooseAttachment(retryKind)}><RotateCcw/>{t('重试','Retry')}</button></div>}
    <div className="composer">{composerPanel === 'attachments'&&<><button className="attachment-popover-backdrop" aria-label={t('关闭附件菜单','Close attachment menu')} onClick={()=>setComposerPanel(null)}/><div className="attachment-popover" role="menu"><button onClick={()=>void chooseAttachment('camera')}><Camera/>{t('拍照','Take photo')}</button><button onClick={()=>void chooseAttachment('image')}><Image/>{t('上传图片','Upload image')}</button><button onClick={()=>void chooseAttachment('file')}><Paperclip/>{t('上传附件','Upload attachment')}</button></div></>}{!!conversation.draftAttachments.length&&<AttachmentList attachments={conversation.draftAttachments} remove={removeAttachment}/>}<textarea ref={textarea} value={draft} rows={1} placeholder={t('发消息…','Message…')} aria-label={t('消息','Message')} onFocus={()=>composerPanel==='attachments'&&setComposerPanel(null)} onChange={e => changeDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-tools"><button className="icon-button" aria-label={t('添加附件','Add attachment')} aria-haspopup="menu" aria-expanded={composerPanel==='attachments'} onClick={() => setComposerPanel(composerPanel==='attachments'?null:'attachments')}><Plus/></button>{showBranch && keyboardVisible && <button className="icon-button" aria-label={t('历史分支','History')} aria-haspopup="dialog" aria-expanded={composerPanel === 'tree'} onPointerDown={e=>e.preventDefault()} onMouseDown={e=>e.preventDefault()} onClick={() => setComposerPanel('tree')}><GitBranch/></button>}<span className="composer-spacer"/><ThinkingControl visible={keyboardVisible} open={composerPanel === 'thinking'} onOpenChange={open=>setComposerPanel(open?'thinking':null)} conversation={conversation} level={String(selection.thinkingLevel || '')} disabled={running || action.busy} onChange={refresh}/><button className="icon-button" aria-label={t('语音输入','Voice input')} onClick={() => action.run(async () => { await Chat.saveDraft({conversationId:conversation.id,text:draft}); const result = await Device.voice(); setDraft(result.text); })}><Mic/></button>{running ? <button className="send-button" aria-label={t('停止生成','Stop')} onClick={() => action.run(() => Chat.cancel({conversationId:conversation.id}))}><Square/></button> : <button className="send-button" aria-label={t('发送','Send')} disabled={(!draft.trim()&&!conversation.draftAttachments.length) || action.busy || preparing} onClick={()=>void send()}><ArrowUp/></button>}</div>{preparing&&<small className="preparing" role="status">{t('正在准备附件…','Preparing attachment…')}</small>}</div>
    {composerPanel === 'tree' && keyboardVisible && <BranchPopover conversation={conversation} disabled={running} close={()=>setComposerPanel(null)} onChange={async next=>{setDraft(next.draft);await refresh();setComposerPanel(null);}}/>}
  </>;
}

function BranchPopover({conversation, disabled, close, onChange}: {conversation:Conversation; disabled:boolean; close():void; onChange(next:Conversation):Promise<void>}) {
  const t=useText(); const action=useAction(); const [preview,setPreview]=useState<ConversationNode>();
  const path=new Set(lineage(conversation).map(n=>n.id));
  const tree=(parent:string|null):React.ReactNode=><ul>{conversation.nodes.filter(n=>n.parentId===parent).map(node=><li key={node.id}><button className={`${path.has(node.id)?'on-path':''} ${preview?.id===node.id?'previewing':''}`} aria-pressed={preview?.id===node.id} onClick={()=>setPreview(node)}><span className="tree-dot"/><span>{(node.message.content || t('工具消息','Tool message')).slice(0,90)}</span></button>{tree(node.id)}</li>)}</ul>;
  return <ComposerPopover title={t('历史分支','History')} close={close}>
    <div className="branch-scroll"><div className="tree">{conversation.nodes.length ? tree(null) : <p className="secondary">{t('还没有对话记录','No conversation history yet')}</p>}</div>
    {preview && <div className="branch-preview"><Markdown text={preview.message.content || ''}/><button className="button full" disabled={disabled || action.busy} onClick={()=>action.run(async()=>{const next=await Chat.selectNode({conversationId:conversation.id,nodeId:preview.id,edit:preview.message.role==='user'});await onChange(next);})}>{preview.message.role==='user'?t('编辑并续接','Edit and continue'):t('从这里继续','Continue from here')}</button></div>}</div>
    <ErrorNotice error={action.error}/>
  </ComposerPopover>;
}
function ConversationDrawer({open, close, conversation, activeRuns, onChange}: {open: boolean; close(): void; conversation: Conversation; activeRuns: ChatSnapshot['activeRuns']; onChange(): Promise<void>}) {
  const [items, setItems] = useState<ConversationSummary[]>([]); const [search, setSearch] = useState(''); const [remove, setRemove] = useState<ConversationSummary>();
  const action = useAction(); const t = useText(); const nav = useNavigate();
  const running = new Map(activeRuns.map(run => [run.conversationId, run]));
  useEffect(() => { if (open) void action.run(async () => { setItems((await Chat.listConversations()).conversations); }); }, [open]);
  return <><Dialog open={open} onOpenChange={value => !value && close()} title={t('会话','Conversations')} drawer><SearchField value={search} onChange={setSearch} placeholder={t('搜索会话','Search conversations')}/><button className="wide-action" onClick={() => action.run(async () => { await Chat.newConversation(); await onChange(); })}><Plus/>{t('新会话','New conversation')}</button><ErrorNotice error={action.error}/><div className="conversation-list">{items.filter(item => item.title.toLowerCase().includes(search.toLowerCase())).map(item => { const run=running.get(item.id); return <div className={`conversation-row ${item.id === conversation.id ? 'selected' : ''}`} key={item.id}><button onClick={() => action.run(async () => { await Chat.selectConversation({conversationId:item.id}); await onChange(); })}><span>{item.title}</span><small>{run ? run.message || t('正在回复…','Working…') : new Date(item.updated).toLocaleDateString()}</small></button><button className="icon-button" aria-label={t('删除会话','Delete conversation')} disabled={!!run} onClick={() => setRemove(item)}><Trash2/></button></div>;})}</div><button className="wide-action drawer-settings" onClick={() => { close(); nav('/settings'); }}><Settings/>{t('设置','Settings')}</button></Dialog><ConfirmDialog open={!!remove} title={t('删除会话？','Delete conversation?')} description={t('会话及所有分支、工作区将被删除。','This conversation, its branches, and workspace will be deleted.')} danger onCancel={() => setRemove(undefined)} onConfirm={() => action.run(async () => { await Chat.deleteConversation({conversationId:remove!.id}); setRemove(undefined); await onChange(); })}/></>;
}
function ModelSheet({conversation, disabled, close, onChange}: {conversation: Conversation; disabled: boolean; close(): void; onChange(): Promise<void>}) {
  const t = useText(); const nav = useNavigate(); const action = useAction();
  const [providers, setProviders] = useState<CatalogProvider[]>([]); const [defaults, setDefaults] = useState<Record<string,unknown>>({}); const [search, setSearch] = useState('');
  useEffect(() => { void action.run(async () => { setDefaults((await NativeSettings.settings({effective:true})).settings); setProviders((await query<CatalogProvider[]>('catalog')).filter(provider => provider.auth.configured === true)); }); }, []);
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
