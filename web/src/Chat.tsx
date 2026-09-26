import { memo, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, AudioLines, Camera, Check, ChevronDown, ChevronRight, Clock3, Copy, GitBranch, Image, LoaderCircle, Menu, Mic, Paperclip, Plus, RotateCcw, Search, Settings, Share2, Square, SquarePen, Trash2, Undo2, Volume2 } from 'lucide-react';
import { Chat, Device, NativeSettings, ScheduledTasks, type ChatSnapshot, type Conversation, type ConversationNode, type ConversationSummary, type ExtensionUiState, type NativeEvent } from './native';
import { archiveRemainingParts, isArchived } from './archive';
import { AttachmentList } from './AttachmentList';
import { LatestRequest } from './latestRequest';
import { pairToolResults, toolCallKey, type ToolResultPairs } from './toolResults';
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
export function createChatStream(readSnapshot: () => Promise<ChatSnapshot>, update: {
  snapshot(next: ChatSnapshot): void;
  error(message: string): void;
  status(message: string): void;
  questionnaireReply(reply: QuestionnaireReplyEvent): void;
}) {
  let live = true, reading = false, again = false;
  let current: ChatSnapshot | undefined; let events: NativeEvent[] = [];
  const commit = (next: ChatSnapshot) => { current = next; if (live) update.snapshot(next); };
  const refresh = async () => {
    if (!live) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      const next = await readSnapshot();
      if (!live) return;
      if (!current || next.sequence >= current.sequence) { commit(next); update.error(next.error ?? ''); update.status(next.status ?? ''); }
    } catch (e) { if (live) update.error(errorText(e)); }
    finally { reading = false; }
    const pending = events; events = []; pending.forEach(receive);
    if (again && live) { again = false; void refresh(); }
  };
  const receive = (event: NativeEvent) => {
    if (!live) return;
    if (!current || reading) { events.push(event); return; }
    const sequence = event.sequence ?? 0;
    // A snapshot can cover this sequence without carrying a rejected reply; preserve its identity for Questionnaire.
    if (event.type === 'questionnaireReply') {
      const payload = event.payload ?? {};
      if (typeof payload.questionnaireId === 'string' && typeof payload.accepted === 'boolean') {
        update.questionnaireReply({
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
    if (sequence !== current.sequence + 1) { void refresh(); return; }
    if (event.conversationId !== current.conversationId) {
      if (event.type === 'textDelta' && current.activeRuns.some(run => run.conversationId === event.conversationId && run.requestId === event.requestId)) {
        // Advance the global cursor without publishing an unchanged visible conversation.
        current = {...current, sequence};
      } else void refresh();
      return;
    }
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
      if (event.type === 'error') update.error(String(event.payload?.message ?? ''));
      if (event.type === 'runStatus') update.status(String(event.payload?.message ?? event.payload?.status ?? ''));
      if (event.type === 'end') update.status('');
      void refresh();
    }
  };
  return {refresh, receive, dispose: () => { live = false; events = []; }};
}
export function useChat() {
  const {pathname} = useLocation();
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(); const [error, setError] = useState(''); const [status, setStatus] = useState('');
  const [questionnaireReply, setQuestionnaireReply] = useState<QuestionnaireReplyEvent>();
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true;
    const stream = createChatStream(() => Chat.snapshot(), {snapshot:setSnapshot, error:setError, status:setStatus, questionnaireReply:setQuestionnaireReply});
    refreshRef.current = stream.refresh;
    const listener = Chat.addListener('chatEvent', stream.receive);
    window.addEventListener('native-navigation', stream.refresh);
    void listener.then(stream.refresh).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; stream.dispose(); window.removeEventListener('native-navigation', stream.refresh); void listener.then(h => h.remove()); };
  }, []);
  useEffect(() => {
    const id = snapshot?.conversationId;
    if (!id) return;
    const markRead = () => {
      if (document.visibilityState === 'visible'
          && /^#\/chat(?:\/|\?|$)/.test(location.hash))
        void Chat.markTaskRead({conversationId: id}).catch(() => {});
    };
    markRead();
    window.addEventListener('focus', markRead);
    window.addEventListener('native-navigation', markRead);
    document.addEventListener('visibilitychange', markRead);
    return () => {
      window.removeEventListener('focus', markRead);
      window.removeEventListener('native-navigation', markRead);
      document.removeEventListener('visibilitychange', markRead);
    };
  }, [pathname, snapshot?.conversationId, snapshot?.running, snapshot?.running ? undefined : snapshot?.sequence]);
  return {snapshot, error, status, questionnaireReply, refresh: () => refreshRef.current()};
}
export function lineage(conversation: Conversation) {
  const nodes = new Map(conversation.nodes.map(n => [n.id, n])); const path: ConversationNode[] = [];
  for (let id = conversation.leaf; id;) { const node = nodes.get(id); if (!node) break; path.unshift(node); id = node.parentId; }
  return path;
}
function remainingLabel(archivedAt: number, t: (zh: string, en: string) => string, now = Date.now()) {
  const {ms, days, hours} = archiveRemainingParts(archivedAt, now);
  if (ms <= 0) return t('即将删除', 'Expiring soon');
  if (days > 0) return t(`剩余 ${days} 天 ${hours} 小时`, `${days}d ${hours}h left`);
  if (hours > 0) return t(`剩余 ${hours} 小时`, `${hours}h left`);
  return t('剩余不足 1 小时', 'Less than 1h left');
}
function archiveTimeLabel(archivedAt: number, t: (zh: string, en: string) => string) {
  return t('归档于 ', 'Archived ') + new Date(archivedAt).toLocaleString();
}
const archiveEvent = (event: NativeEvent) => event.type === 'conversationArchived' || event.type === 'conversationRestored' || event.type === 'conversationDeleted';
const MessageView = memo(function MessageView({node, toolResults, pending}: {node: ConversationNode; toolResults?: ConversationNode[][]; pending: boolean}) {
  const t = useText(); const action = useAction(); const [copied, setCopied] = useState(false); const message = node.message;
  if (message.role === 'system') return null;
  if (message.role === 'tool') return <ToolCallView results={[node]}/>;
  return <article className={`message ${message.role}`}>
    {!!message.attachments?.length && <AttachmentList attachments={message.attachments} sent/>}
    {message.content && <Markdown text={message.content}/>}
    {message.toolCalls.map((tool, index) => <ToolCallView key={toolCallKey(node.id, index)} tool={tool} results={toolResults?.[index] ?? []} pending={pending}/>)}
    {message.incomplete && <small className="secondary">{t('尚未完成','Not completed')}</small>}
    {message.content && message.role === 'assistant' && <div className="message-actions"><button className="icon-button" aria-label={t('复制','Copy')} onClick={() => action.run(async () => { await navigator.clipboard.writeText(message.content!); setCopied(true); })}>{copied ? <Check/> : <Copy/>}</button><button className="icon-button" aria-label={t('分享','Share')} onClick={() => action.run(() => Device.share({text:message.content!,title:'Pi'}))}><Share2/></button><button className="icon-button" aria-label={t('朗读','Read aloud')} onClick={() => action.run(() => Device.speak({text:message.content!}))}><Volume2/></button></div>}
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
  const navigate = useNavigate(); const location = useLocation();
  const [params] = useSearchParams(); const keyboardVisible = useKeyboardVisible();
  const [panel, setPanel] = useState<'conversations'|'models'|null>(params.get('panel') === 'models' ? 'models' : null);
  const [following, setFollowing] = useState(true);
  const [undo, setUndo] = useState<{id: string; title: string; reopen: boolean}|null>(null);
  const [removeCurrent, setRemoveCurrent] = useState(false);
  const conversation = chat.snapshot?.conversation;
  useEffect(() => {
    if (!conversation) return;
    const pathname = `/chat/${encodeURIComponent(conversation.id)}`;
    if (location.pathname !== pathname) navigate({pathname, search:location.search}, {replace:true});
  }, [conversation?.id, location.pathname, location.search, navigate]);
  const configured = useConversationDefaults(conversation);
  const scroll = useRef<HTMLDivElement>(null);
  const pairedRef = useRef<ToolResultPairs | undefined>(undefined);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { if (following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [chat.snapshot?.sequence, conversation?.id, following]);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  if (!chat.snapshot || !conversation) return <><Loading/><ErrorNotice error={chat.error}/></>;
  const running = chat.snapshot.running;
  const archived = isArchived(conversation.archivedAt);
  const questionnaire = running ? chat.snapshot.extensionUi?.askUser : null;
  const changed = async () => { setPanel(null); await chat.refresh(); };
  const offerUndo = (item: ConversationSummary) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({id: item.id, title: item.title, reopen: item.id === conversation.id});
    undoTimer.current = setTimeout(() => setUndo(null), 8000);
  };
  const restore = (id: string, reopen = false) => action.run(async () => {
    await Chat.restoreConversation({conversationId: id});
    if (reopen) await Chat.selectConversation({conversationId: id});
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null); setPanel(null); await chat.refresh();
  });
  const selection = {model: configured.defaults.defaultModel, thinkingLevel: configured.defaults.defaultThinkingLevel, ...conversation.piSelection};
  const path = lineage(conversation); const paired = pairToolResults(path, pairedRef.current);
  pairedRef.current = paired;
  const activeMessage = path.filter(node => node.message.role !== 'tool').at(-1);
  return <main className="chat-page"><header className="chat-header"><button className="icon-button" aria-label={t('会话列表','Conversations')} onClick={() => setPanel('conversations')}><Menu/></button><button className="model-title" onClick={() => setPanel('models')}><strong>Pi</strong><span>{String(selection.model || t('选择模型','Choose model'))}<ChevronDown/></span></button><button className="icon-button" aria-label={t('新会话','New conversation')} disabled={action.busy} onClick={() => action.run(async () => { await Chat.newConversation(); await chat.refresh(); })}><SquarePen/></button></header>
    <section className="messages" ref={scroll} onClick={e => {
      if (keyboardVisible && !document.querySelector('.composer-popover[role="dialog"],.attachment-popover') && !(e.target as HTMLElement).closest('button,a,input,textarea,summary,pre')) {
        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.blur(); void Device.hideKeyboard();
      }
    }} onScroll={e => { const el = e.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 90); }}>
      {path.some(n => n.message.role !== 'system') ? path.filter(node => !paired.embeddedResultIds.has(node.id)).map(node => <MessageView node={node} toolResults={paired.byMessage.get(node.id)} pending={running && node.id === activeMessage?.id} key={node.id}/>) : <div className="chat-empty"><span className="empty-mark">Pi</span><h1>{t('今天想聊些什么？','What’s on your mind?')}</h1><p>{t('从一个问题开始。','Start with a question.')}</p></div>}
    </section>
    <footer className="composer-wrap">{!following && <button className="scroll-latest icon-button" aria-label={t('回到最新消息','Latest message')} onClick={() => setFollowing(true)}><ArrowDown/></button>}
      <ErrorNotice error={action.error || chat.error || configured.error}/>
      {archived && <ArchiveNotice archivedAt={conversation.archivedAt!} restoring={action.busy} onRestore={() => void restore(conversation.id)} onDelete={() => setRemoveCurrent(true)}/>}
      {questionnaire && chat.snapshot.requestId ? <Questionnaire key={`${conversation.id}:${chat.snapshot.requestId}:${questionnaire.id}`} conversationId={conversation.id} requestId={chat.snapshot.requestId} questionnaire={questionnaire} reply={chat.questionnaireReply}/> : <>{running && <div className="run-status" role="status"><LoaderCircle className="spin" aria-hidden="true"/>Working</div>}
      <ExtensionDock conversationId={conversation.id} state={chat.snapshot.extensionUi} working={chat.snapshot.activeRuns.some(run => run.conversationId === conversation.id && run.status === 'running')}/>
      <ConversationComposer conversation={conversation} running={running} archived={archived} selection={selection} refresh={chat.refresh} showBranch onAccepted={() => setFollowing(true)}/></>}
      {undo && <div className="archive-undo" role="status"><span>{t(`“${undo.title}”已归档` , `“${undo.title}” archived`)}</span><button disabled={action.busy} onClick={() => void restore(undo.id, undo.reopen)}><Undo2/>{t('撤销','Undo')}</button></div>}
    </footer>
    <ConversationDrawer open={panel === 'conversations'} close={() => setPanel(null)} conversation={conversation} activeRuns={chat.snapshot.activeRuns} onChange={changed} onArchived={item => { offerUndo(item); void chat.refresh(); }}/>
    {panel === 'models' && <ModelSheet conversation={conversation} disabled={running} close={() => setPanel(null)} onChange={chat.refresh}/>}
    <ConfirmDialog open={removeCurrent} title={t('永久删除会话？','Delete conversation forever?')} description={t('会话及所有分支、工作区将被删除，无法恢复。','This conversation, its branches, and workspace will be permanently deleted.')} danger onCancel={() => setRemoveCurrent(false)} onConfirm={() => action.run(async () => { await Chat.deleteConversation({conversationId:conversation.id}); setRemoveCurrent(false); await chat.refresh(); })}/>
  </main>;
}
function ArchiveNotice({archivedAt, restoring, onRestore, onDelete}: {archivedAt: number; restoring: boolean; onRestore(): void; onDelete(): void}) {
  const t = useText();
  return <div className="archive-banner" role="status"><p>{t('此会话已归档，可查看记录。发送前须先恢复。','This conversation is archived. You can read it, but restore it before sending.')}</p><small>{archiveTimeLabel(archivedAt, t)} · {remainingLabel(archivedAt, t)} · {t('14 天后自动删除','Deleted automatically after 14 days')}</small><div className="archive-banner-actions"><button className="button" disabled={restoring} onClick={onRestore}><ArchiveRestore/>{t('恢复会话','Restore')}</button><button className="quiet-button danger" disabled={restoring} onClick={onDelete}><Trash2/>{t('永久删除','Delete forever')}</button></div></div>;
}

type ConversationComposerProps = {
  conversation: Conversation;
  running: boolean;
  archived?: boolean;
  selection: Record<string, unknown>;
  refresh(): Promise<void>;
  showBranch?: boolean;
  onAccepted?(conversationId: string): void | Promise<void>;
};

export function ConversationComposer({conversation, running, archived=false, selection, refresh, showBranch=false, onAccepted}: ConversationComposerProps) {
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
    if (archived) return;
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
  const empty = !draft.trim() && !conversation.draftAttachments.length;
  const openVoice = () => action.run(async () => {
    textarea.current?.blur();
    setComposerPanel(null);
    await Device.hideKeyboard();
    await Chat.saveDraft({conversationId:conversation.id,text:draft});
    await Device.openVoiceConversation({conversationId:conversation.id});
  });
  const send = () => action.run(async () => {
    if (archived || (!draft.trim() && !conversation.draftAttachments.length) || running || preparing) return;
    await Chat.saveDraft({conversationId:conversation.id,text:draft});
    const accepted = await Chat.send({conversationId:conversation.id,text:draft,submissionId:crypto.randomUUID()});
    await refresh();
    if (accepted.accepted) { setDraft(''); await onAccepted?.(conversation.id); }
  });
  return <>
    <ErrorNotice error={action.error}/>
    {attachmentError&&<div className="attachment-error" role="alert"><span>{attachmentError}</span><button onClick={()=>void chooseAttachment(retryKind)}><RotateCcw/>{t('重试','Retry')}</button></div>}
    <div className="composer">{composerPanel === 'attachments'&&<><button className="attachment-popover-backdrop" aria-label={t('关闭附件菜单','Close attachment menu')} onClick={()=>setComposerPanel(null)}/><div className="attachment-popover" role="menu"><button onClick={()=>void chooseAttachment('camera')}><Camera/>{t('拍照','Take photo')}</button><button onClick={()=>void chooseAttachment('image')}><Image/>{t('上传图片','Upload image')}</button><button onClick={()=>void chooseAttachment('file')}><Paperclip/>{t('上传附件','Upload attachment')}</button></div></>}{!!conversation.draftAttachments.length&&<AttachmentList attachments={conversation.draftAttachments} remove={removeAttachment}/>}<textarea ref={textarea} value={draft} rows={1} placeholder={archived ? t('恢复后可发送','Restore to send') : t('发消息…','Message…')} aria-label={t('消息','Message')} disabled={archived} onFocus={()=>composerPanel==='attachments'&&setComposerPanel(null)} onChange={e => changeDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-tools"><button className="icon-button" aria-label={t('添加附件','Add attachment')} aria-haspopup="menu" aria-expanded={composerPanel==='attachments'} disabled={archived} onClick={() => setComposerPanel(composerPanel==='attachments'?null:'attachments')}><Plus/></button>{showBranch && keyboardVisible && <button className="icon-button" aria-label={t('历史分支','History')} aria-haspopup="dialog" aria-expanded={composerPanel === 'tree'} onPointerDown={e=>e.preventDefault()} onMouseDown={e=>e.preventDefault()} onClick={() => setComposerPanel('tree')}><GitBranch/></button>}<span className="composer-spacer"/><ThinkingControl visible={keyboardVisible} open={composerPanel === 'thinking'} onOpenChange={open=>setComposerPanel(open?'thinking':null)} conversation={conversation} level={String(selection.thinkingLevel || '')} disabled={archived || running || action.busy} onChange={refresh}/><button className="icon-button" aria-label={t('语音输入','Voice input')} disabled={archived} onClick={() => action.run(async () => { await Chat.saveDraft({conversationId:conversation.id,text:draft}); const result = await Device.voice(); setDraft(result.text); })}><Mic/></button>{running ? <button className="send-button" aria-label={t('停止生成','Stop')} onClick={() => action.run(() => Chat.cancel({conversationId:conversation.id}))}><Square/></button> : empty && !archived && !preparing ? <button className="send-button" aria-label={t('打开实时语音对话','Open live voice conversation')} title={t('实时语音对话','Live voice conversation')} disabled={action.busy} onClick={()=>void openVoice()}><AudioLines/></button> : <button className="send-button" aria-label={t('发送','Send')} disabled={archived || empty || action.busy || preparing} onClick={()=>void send()}><ArrowUp/></button>}</div>{preparing&&<small className="preparing" role="status">{t('正在准备附件…','Preparing attachment…')}</small>}</div>
    {composerPanel === 'tree' && keyboardVisible && <BranchPopover conversation={conversation} disabled={archived || running} close={()=>setComposerPanel(null)} onChange={async next=>{setDraft(next.draft);await refresh();setComposerPanel(null);}}/>}
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
function useConversationSearch(search: string, archived: boolean, open = true) {
  const [result, setResult] = useState<{query: string; items: ConversationSummary[]}>({query: '', items: []});
  const [error, setError] = useState('');
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!open) return;
    let live = true;
    const gate = new LatestRequest();
    const load = async () => {
      const request = gate.begin();
      try {
        const value = await (archived ? Chat.listArchivedConversations({query: search}) : Chat.listConversations({query: search}));
        if (live && gate.current(request)) { setResult({query: search, items: value.conversations}); setError(''); }
      } catch (e) { if (live && gate.current(request)) setError(errorText(e)); }
    };
    refresh.current = load;
    const listener = Chat.addListener('chatEvent', event => { if (live && archiveEvent(event)) void load(); });
    void load();
    return () => { live = false; refresh.current = async () => {}; void listener.then(handle => handle.remove()); };
  }, [search, archived, open]);
  return {items: result.query === search && open ? result.items : [], error, load: () => refresh.current()};
}
function ConversationDrawer({open, close, conversation, activeRuns, onChange, onArchived}: {open: boolean; close(): void; conversation: Conversation; activeRuns: ChatSnapshot['activeRuns']; onChange(): Promise<void>; onArchived(item: ConversationSummary): void}) {
  const [search, setSearch] = useState(''); const [remove, setRemove] = useState<ConversationSummary>();
  const {items, error: searchError, load} = useConversationSearch(search, false, open);
  const [scheduleCount, setScheduleCount] = useState<number>();
  const action = useAction(); const t = useText(); const nav = useNavigate();
  const running = new Map(activeRuns.map(run => [run.conversationId, run]));
  useEffect(() => {
    if (!open) return;
    let live = true;
    void ScheduledTasks.snapshot().then(value => { if (live) setScheduleCount(value.tasks.length); })
      .catch(() => { if (live) setScheduleCount(undefined); });
    return () => { live = false; };
  }, [open]);
  const archive = (item: ConversationSummary) => action.run(async () => {
    await Chat.archiveConversation({conversationId: item.id});
    onArchived(item);
    if (item.id === conversation.id) await onChange();
    else await load();
  });
  return <><Dialog open={open} onOpenChange={value => !value && close()} title={t('会话','Conversations')} drawer><SearchField value={search} onChange={setSearch} placeholder={t('搜索会话','Search conversations')}/><button className="wide-action" onClick={() => action.run(async () => { await Chat.newConversation(); await onChange(); })}><Plus/>{t('新会话','New conversation')}</button><button className="wide-action drawer-schedules" onClick={() => { close(); nav('/schedules'); }}><Clock3/><span>{t('定时任务','Scheduled tasks')}</span><span className="drawer-schedule-count">{scheduleCount ?? ''}<ChevronRight/></span></button><button className="wide-action drawer-archived" onClick={() => { close(); nav('/archived'); }}><Archive/><span>{t('已归档','Archived')}</span><ChevronRight/></button><ErrorNotice error={action.error || searchError}/><div className="conversation-list">{items.map(item => { const run=running.get(item.id); const current = item.id === conversation.id; return <div className={`conversation-row ${current ? 'selected' : ''}`} key={item.id}><button onClick={() => action.run(async () => { await Chat.selectConversation({conversationId:item.id}); await onChange(); })}><span>{item.title}</span>{item.snippet && <small>{item.snippet}</small>}<small>{run ? run.message || t('正在回复…','Working…') : new Date(item.updated).toLocaleDateString()}</small></button><button className="icon-button" aria-label={t('归档会话','Archive conversation')} onClick={() => void archive(item)}><Archive/></button>{current && <button className="icon-button" aria-label={t('永久删除','Delete forever')} disabled={!!run} onClick={() => setRemove(item)}><Trash2/></button>}</div>;})}</div><button className="wide-action drawer-settings" onClick={() => { close(); nav('/settings'); }}><Settings/>{t('设置','Settings')}</button></Dialog><ConfirmDialog open={!!remove} title={t('永久删除会话？','Delete conversation forever?')} description={t('会话及所有分支、工作区将被删除，无法恢复。','This conversation, its branches, and workspace will be permanently deleted.')} danger onCancel={() => setRemove(undefined)} onConfirm={() => action.run(async () => { await Chat.deleteConversation({conversationId:remove!.id}); setRemove(undefined); await onChange(); })}/></>;
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
  return <main className="history-page"><Header title={t('会话历史','Conversation history')} actions={<button className="icon-button" aria-label={t('搜索节点','Search nodes')} onClick={() => setSearching(!searching)}><Search/></button>}/><div className="history-heading"><h2>{conversation.nodes.find(n => n.message.role === 'user')?.message.content?.slice(0,40) || t('历史分支','History')}</h2><p>{t('选择节点查看内容','Select a node to preview')}</p>{searching && <SearchField value={search} onChange={setSearch} placeholder={t('搜索历史','Search history')}/>}</div><section className="tree-scroll"><div className="tree">{search ? conversation.nodes.filter(n => n.message.content?.toLowerCase().includes(search.toLowerCase())).map(n => <button key={n.id} onClick={() => setPreviewId(n.id)}>{n.message.content?.slice(0,90)}</button>) : tree(null)}</div></section><ErrorNotice error={action.error || error}/>{preview && <section className="preview-panel"><div className="sheet-handle"/><h2>{t('节点预览','Node preview')}</h2><small className="secondary">{preview.message.role === 'user' ? t('你','You') : preview.message.role === 'tool' ? t('工具','Tool') : t('助手','Assistant')}</small><div className="preview-content"><Markdown text={preview.message.content || ''}/></div><button className="quiet-button copy-preview" onClick={() => action.run(() => navigator.clipboard.writeText(preview.message.content || ''))}><Copy/>{t('复制','Copy')}</button><button className="button full" disabled={isArchived(conversation.archivedAt) || snapshot.running || action.busy} onClick={() => action.run(async () => { await Chat.selectNode({conversationId:conversation.id,nodeId:preview.id,edit:preview.message.role === 'user'}); nav('/chat', {replace:true}); })}><GitBranch/>{preview.message.role === 'user' ? t('编辑并续接','Edit and continue') : t('从这里继续','Continue from here')}</button><button className="quiet-button full" onClick={() => nav('/chat',{replace:true})}>{t('返回对话','Back to chat')}</button>{snapshot.running && <p className="secondary">{t('正在生成，可预览；停止后可续接。','Generation is active. Stop it before continuing a branch.')}</p>}</section>}</main>;
}
export function ArchivedPage() {
  const t = useText(); const nav = useNavigate(); const action = useAction();
  const [search, setSearch] = useState(''); const [remove, setRemove] = useState<ConversationSummary>();
  const [now, setNow] = useState(Date.now());
  const {items: visible, error: searchError, load} = useConversationSearch(search, true);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  return <main className="page archived-page"><Header title={t('已归档','Archived')}/><p className="archive-ttl">{t('归档会话会在 14 天后自动删除。恢复不会改动更新时间；再次归档会重新计时。','Archived conversations are deleted 14 days after this archive. Restore does not change last-updated time; archiving again restarts the timer.')}</p><SearchField value={search} onChange={setSearch} placeholder={t('搜索已归档会话','Search archived')}/><ErrorNotice error={action.error || searchError}/>{!visible.length ? <Empty>{t('没有已归档会话','No archived conversations')}</Empty> : <div className="conversation-list archived-list">{visible.map(item => {
    const archivedAt = item.archivedAt ?? 0;
    return <div className="conversation-row" key={item.id}><button onClick={() => action.run(async () => { await Chat.selectConversation({conversationId: item.id}); nav(`/chat/${item.id}`); })}><span>{item.title}</span>{item.snippet && <small>{item.snippet}</small>}<small>{archiveTimeLabel(archivedAt, t)}</small><small>{remainingLabel(archivedAt, t, now)}</small></button><button className="icon-button" aria-label={t('恢复','Restore')} onClick={() => action.run(async () => { await Chat.restoreConversation({conversationId: item.id}); await load(); })}><ArchiveRestore/></button><button className="icon-button" aria-label={t('永久删除','Delete forever')} onClick={() => setRemove(item)}><Trash2/></button></div>;
  })}</div>}<ConfirmDialog open={!!remove} title={t('永久删除会话？','Delete conversation forever?')} description={t('会话及所有分支、工作区将被删除，无法恢复。','This conversation, its branches, and workspace will be permanently deleted.')} danger onCancel={() => setRemove(undefined)} onConfirm={() => action.run(async () => { await Chat.deleteConversation({conversationId: remove!.id}); setRemove(undefined); await load(); })}/></main>;
}
