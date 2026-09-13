package com.example.launcherprobe;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

final class NativeJson {
    private NativeJson() { }

    static JSONObject conversation(ChatStore store) { return conversation(store, store.activeId()); }

    static JSONObject conversation(ChatStore store, String conversationId) {
        ConversationTree tree = store.tree(conversationId);
        JSONArray nodes = new JSONArray();
        for (ConversationTree.Node node : tree.nodes()) nodes.put(object("id", node.id,
                "parentId", node.parentId == null ? JSONObject.NULL : node.parentId, "message", message(node.message)));
        return object("id", conversationId, "leaf", tree.leaf() == null ? JSONObject.NULL : tree.leaf(),
                "nodes", nodes, "draft", store.draft(conversationId),
                "draftAttachments", AttachmentStore.json(store.draftAttachments(conversationId)),
                "piSelection", object(store.piSelection(conversationId)));
    }

    static JSONObject message(AgentLoop.Message message) {
        JSONArray calls = new JSONArray();
        for (AgentLoop.ToolCall call : message.toolCalls) calls.put(object("id", call.id, "name", call.name, "arguments", call.arguments));
        return object("id", message.id, "role", message.role,
                "content", message.content == null ? JSONObject.NULL : message.content,
                "toolCallId", message.toolCallId == null ? JSONObject.NULL : message.toolCallId,
                "toolCalls", calls, "attachments", AttachmentStore.json(message.attachments), "incomplete", message.incomplete);
    }

    static AgentLoop.Message piMessage(JSONObject value, String id, boolean incomplete) throws Exception {
        String role = value.optString("role", "assistant");
        List<AgentLoop.ToolCall> calls = new ArrayList<>();
        JSONArray storedCalls = value.optJSONArray("toolCalls");
        if (storedCalls != null) for (int index = 0; index < storedCalls.length(); index++) {
            JSONObject call = storedCalls.getJSONObject(index);
            Object arguments = call.opt("arguments");
            calls.add(new AgentLoop.ToolCall(call.getString("id"), call.getString("name"),
                    arguments instanceof String ? (String) arguments : String.valueOf(arguments)));
        }
        return new AgentLoop.Message(id, role, value.isNull("content") ? null : value.optString("content", ""),
                value.optString("toolCallId", null), calls.isEmpty() ? Collections.emptyList() : calls, incomplete);
    }

    static JSONArray conversations(List<ChatStore.Conversation> values) {
        JSONArray result = new JSONArray();
        for (ChatStore.Conversation value : values) result.put(object("id", value.id, "title", value.title, "updated", value.updated));
        return result;
    }

    static JSONObject object(String source) {
        try { return new JSONObject(source); }
        catch (Exception exception) { throw new IllegalStateException(exception); }
    }

    static JSONObject object(Object... values) {
        JSONObject result = new JSONObject();
        try { for (int i = 0; i < values.length; i += 2) result.put(String.valueOf(values[i]), values[i + 1]); }
        catch (Exception exception) { throw new IllegalStateException(exception); }
        return result;
    }

    static Object jsonValue(Object value) {
        if (value == null) return JSONObject.NULL;
        if (value instanceof Map) {
            JSONObject result = new JSONObject();
            for (Map.Entry<?, ?> item : ((Map<?, ?>) value).entrySet()) put(result, String.valueOf(item.getKey()), jsonValue(item.getValue()));
            return result;
        }
        if (value instanceof Iterable) {
            JSONArray result = new JSONArray();
            for (Object item : (Iterable<?>) value) result.put(jsonValue(item));
            return result;
        }
        return value;
    }

    private static void put(JSONObject target, String key, Object value) {
        try { target.put(key, value); }
        catch (Exception exception) { throw new IllegalStateException(exception); }
    }
}
