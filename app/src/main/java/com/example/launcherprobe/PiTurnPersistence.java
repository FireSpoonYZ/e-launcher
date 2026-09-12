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
    private JSONArray entries;
    private boolean ended, toolStarted;
    private int assistantCount;

    PiTurnPersistence(ChatStore store, String conversation, String userId, String assistantId,
            List<AgentLoop.Message> path) {
        this.store = store; this.conversation = conversation; this.userId = userId; this.assistantId = assistantId;
        this.path = new ArrayList<>(path);
        store.beginPiTurn(conversation, userId, assistantId);
    }

    synchronized void savePreview(AgentLoop.Message message) {
        if (ended || message.content == null || message.content.isEmpty()) return;
        savePreview(message.content);
    }

    synchronized AgentLoop.Message savePreview() {
        if (ended || delta.length() == 0) return null;
        return savePreview(delta.toString());
    }

    private AgentLoop.Message savePreview(String content) {
        AgentLoop.Message message = new AgentLoop.Message(nextAssistantId(), "assistant", content, null,
                Collections.emptyList(), true);
        List<AgentLoop.Message> preview = new ArrayList<>(path);
        preview.add(message);
        store.savePiPreview(conversation, userId, assistantId, preview);
        return message;
    }

    synchronized void accept(JSONObject event) throws Exception {
        if (ended) return;
        switch (event.optString("type")) {
            case "text_delta": delta.append(event.optString("delta")); break;
            case "tool_start": toolStarted = true; break;
            case "message": append(event.getJSONObject("message")); break;
            case "context": entries = event.optJSONArray("entries"); break;
            case "end":
                boolean incomplete = !"completed".equals(event.optString("status"));
                if (delta.length() > 0) {
                    path.add(new AgentLoop.Message(nextAssistantId(), "assistant", delta.toString(), null,
                            Collections.emptyList(), incomplete));
                    assistantCount++;
                    delta.setLength(0);
                } else if (incomplete && !path.isEmpty() && "assistant".equals(path.get(path.size() - 1).role)) {
                    AgentLoop.Message last = path.remove(path.size() - 1);
                    path.add(new AgentLoop.Message(last.id, last.role, last.content, last.toolCallId,
                            last.toolCalls, true));
                }
                if (entries == null && toolStarted && path.get(path.size() - 1).id.equals(userId)) {
                    path.add(new AgentLoop.Message(nextAssistantId(), "assistant",
                            "Pi 工具已执行，但原生上下文未保存，请选择之前的历史节点。", null,
                            Collections.emptyList(), true));
                }
                String contextNode = path.get(path.size() - 1).id;
                store.savePiTurn(conversation, userId, assistantId, path, contextNode, entries);
                ended = true;
                break;
            default: break;
        }
    }

    private void append(JSONObject value) throws Exception {
        String role = value.optString("role", "assistant");
        String id;
        if ("assistant".equals(role)) {
            id = nextAssistantId();
            assistantCount++;
            delta.setLength(0);
        } else if ("tool".equals(role)) {
            id = assistantId + ":tool:" + value.getString("toolCallId");
        } else {
            throw new IllegalArgumentException("Pi 返回了未知消息角色");
        }
        boolean incomplete = "assistant".equals(role) && (!value.optString("errorMessage", "").isEmpty()
                || "error".equals(value.optString("stopReason"))
                || "aborted".equals(value.optString("stopReason"))
                || "length".equals(value.optString("stopReason")));
        path.add(NativeJson.piMessage(value, id, incomplete));
        store.savePiPreview(conversation, userId, assistantId, new ArrayList<>(path));
    }

    private String nextAssistantId() {
        return assistantCount == 0 ? assistantId : assistantId + ":assistant:" + assistantCount;
    }
}
