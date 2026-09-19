import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { mountBotWorkspace, type WorkspaceBot } from './workspace.mjs';
import { NativeBotUiAdapter } from './native-adapter';
import { Chat } from '../native';
import { ModelSheet } from '../Chat';
import { Questionnaire, type QuestionnaireReplyEvent } from '../Questionnaire';
import { useBack } from '../ui';
import { botsSessionFromHash } from './routes.mjs';
import './bots.css';

export function BotWorkspacePage() {
    const root = useRef<HTMLDivElement>(null);
    const workspace = useRef<ReturnType<typeof mountBotWorkspace>>(null);
    const [adapter] = useState(() => new NativeBotUiAdapter());
    const [bot, setBot] = useState<WorkspaceBot>();
    const [modelOpen, setModelOpen] = useState(false);
    const [reply, setReply] = useState<QuestionnaireReplyEvent>();
    const navigate = useNavigate();
    const back = useBack();
    const backRef = useRef(back);
    backRef.current = back;
    const { sessionId } = useParams<{ sessionId: string }>();
    useEffect(() => {
        if (!root.current) return;
        const ui = mountBotWorkspace(root.current, adapter, {
            initialSessionId: botsSessionFromHash() ?? sessionId,
            onExit: () => backRef.current(),
            onBotChange: setBot,
            onOpenModel: () => setModelOpen(true),
            onOpenChat: async id => {
                await Chat.selectConversation({ conversationId: id });
                navigate(`/chat/${encodeURIComponent(id)}`);
            },
        });
        workspace.current = ui;
        const applyNative = () => ui.applySession(botsSessionFromHash());
        window.addEventListener('native-navigation', applyNative);
        let live = true;
        const listener = Chat.addListener('chatEvent', event => {
            const payload = event.payload;
            if (live && event.type === 'questionnaireReply' && typeof payload?.questionnaireId === 'string'
                && typeof payload.accepted === 'boolean') {
                setReply({questionnaireId: payload.questionnaireId, accepted: payload.accepted,
                    message: typeof payload.message === 'string' ? payload.message : undefined,
                    conversationId: event.conversationId, requestId: event.requestId, sequence: event.sequence});
            }
        });
        return () => {
            live = false;
            void listener.then(handle => handle.remove());
            window.removeEventListener('native-navigation', applyNative);
            ui.dispose();
            workspace.current = null;
        };
    }, [navigate, adapter]);
    useEffect(() => { workspace.current?.applySession(sessionId); }, [sessionId]);
    useEffect(() => { setModelOpen(false); setReply(undefined); }, [bot?.id]);
    const host = workspace.current?.questionnaireHost;
    return <><div ref={root} style={{height: '100%'}}/>
        {bot?.askUser && bot.requestId && host && createPortal(
            <Questionnaire key={`${bot.id}:${bot.requestId}:${bot.askUser.id}`} conversationId={bot.id}
                requestId={bot.requestId} questionnaire={bot.askUser} reply={reply}
                initiallyPending={bot.questionnairePending} initialError={bot.questionnaireError}/>, host)}
        {modelOpen && bot && <ModelSheet key={bot.id} conversation={{id: bot.id, piSelection: bot.piSelection}}
            disabled={bot.running || bot.archived} close={() => setModelOpen(false)}
            selectModel={input => adapter.selectModel(input)}
            onChange={async () => { await workspace.current?.refresh(); }}/>}
    </>;
}
