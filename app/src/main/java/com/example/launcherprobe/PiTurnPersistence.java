package com.example.launcherprobe;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Request-owned persistence; it does not depend on an Activity remaining alive. */
final class PiTurnPersistence {
    private final ChatStore store;
    private final String conversation, userId, assistantId;
    private final List<AgentLoop.Message> path;
    private final StringBuilder delta = new StringBuilder();
    private String completed;
    private JSONArray entries;
    private boolean ended, toolStarted;

    PiTurnPersistence(ChatStore store, String conversation, String userId, String assistantId,
            List<AgentLoop.Message> path) {
        this.store = store; this.conversation = conversation; this.userId = userId; this.assistantId = assistantId;
        this.path = new ArrayList<>(path);
        store.beginPiTurn(conversation, userId, assistantId);
    }

    synchronized void savePreview(AgentLoop.Message message) {
        if (ended || !assistantId.equals(message.id) || message.content == null || message.content.isEmpty()) return;
        List<AgentLoop.Message> preview = new ArrayList<>(path);
        preview.add(new AgentLoop.Message(assistantId, "assistant", message.content, null, Collections.emptyList(), true));
        store.savePiPreview(conversation, userId, assistantId, preview);
    }

    synchronized void accept(JSONObject event) throws Exception {
        if (ended) return;
        switch (event.optString("type")) {
            case "text_delta": delta.append(event.optString("delta")); break;
            case "tool_start": toolStarted = true; break;
            case "message": completed = event.getJSONObject("message").optString("content"); break;
            case "context": entries = event.optJSONArray("entries"); break;
            case "end":
                String text = completed == null || completed.isEmpty() ? delta.toString() : completed;
                if (entries == null && toolStarted && text.isEmpty()) text = "Pi 工具已执行，但原生上下文未保存，请选择之前的历史节点。";
                if (!text.isEmpty()) path.add(new AgentLoop.Message(assistantId, "assistant", text, null,
                        Collections.emptyList(), !"completed".equals(event.optString("status"))));
                store.savePiTurn(conversation, userId, assistantId, path, text.isEmpty() ? userId : assistantId, entries);
                ended = true;
                break;
            default: break;
        }
    }
}
