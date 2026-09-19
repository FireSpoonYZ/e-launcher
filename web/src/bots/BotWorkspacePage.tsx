import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { mountBotWorkspace } from './workspace.mjs';
import { NativeBotUiAdapter } from './native-adapter';
import { Chat } from '../native';
import './bots.css';
/** Additive route: leaves the existing full ChatPage/attachments/voice UI untouched. */
export function BotWorkspacePage() {
    const root = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const { sessionId } = useParams<{
        sessionId: string;
    }>();
    useEffect(() => {
        if (!root.current)
            return;
        const ui = mountBotWorkspace(root.current, new NativeBotUiAdapter(), {
            initialSessionId: sessionId,
            onExit: () => navigate('/chat'),
            onOpenChat: async id => {
                await Chat.selectConversation({ conversationId: id });
                navigate(`/chat/${encodeURIComponent(id)}`);
            },
        });
        return () => ui.dispose();
    }, [navigate, sessionId]);
    return <div ref={root} style={{height: '100%'}}/>;
}
