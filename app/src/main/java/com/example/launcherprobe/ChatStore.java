package com.example.launcherprobe;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** App-private conversation trees and provider settings. Backups are disabled in the manifest. */
public final class ChatStore {
    private static final int MAX_TOOL_ARGUMENTS = 50_000;
    private final SharedPreferences preferences;

    public ChatStore(Context context) {
        preferences = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
        if (!preferences.contains("conversations") && preferences.contains("history")) {
            List<AgentLoop.Message> legacy = load();
            if (!legacy.isEmpty()) save(legacy);
        }
    }

    public String activeId() { return preferences.getString("active_chat", "legacy"); }

    public String draft() { return preferences.getString("draft_" + activeId(), ""); }

    public void saveDraft(String text) {
        preferences.edit().putString("draft_" + activeId(), text).apply();
    }

    private String historyKey() {
        return "legacy".equals(activeId()) ? "history" : "history_" + activeId();
    }

    public static final class Conversation {
        public final String id;
        public final String title;
        public final long updated;

        Conversation(String id, String title, long updated) {
            this.id = id;
            this.title = title;
            this.updated = updated;
        }
    }

    public List<Conversation> conversations() {
        List<Conversation> result = new ArrayList<>();
        JSONObject index = conversationIndex();
        java.util.Iterator<String> ids = index.keys();
        while (ids.hasNext()) {
            String id = ids.next();
            JSONObject item = index.optJSONObject(id);
            if (item != null) result.add(new Conversation(id, item.optString("title", "新对话"),
                    item.optLong("updated")));
        }
        result.sort((left, right) -> Long.compare(right.updated, left.updated));
        return result;
    }

    private JSONObject conversationIndex() {
        try { return new JSONObject(preferences.getString("conversations", "{}")); }
        catch (org.json.JSONException exception) {
            throw new IllegalStateException("无法读取会话列表", exception);
        }
    }

    public void newConversation() {
        preferences.edit().putString("active_chat", java.util.UUID.randomUUID().toString()).apply();
    }

    public void selectConversation(String id) {
        if (!conversationIndex().has(id)) throw new IllegalArgumentException("会话不存在");
        preferences.edit().putString("active_chat", id).apply();
    }

    public String baseUrl() { return preferences.getString("base_url", "https://api.openai.com/v1"); }
    public String model() { return preferences.getString("model", "gpt-4o-mini"); }
    public String apiKey() { return preferences.getString("api_key", ""); }
    public String reasoningEffort() {
        return ReasoningEffort.normalize(preferences.getString("reasoning_effort", ""));
    }
    public String searchProvider() {
        return SearchConfig.provider(preferences.getString("search_provider", ""));
    }
    public String searchBaseUrl() { return preferences.getString("search_base_url", ""); }
    public boolean piTextMode() { return preferences.getBoolean("pi_text_mode", false); }

    public void settings(String baseUrl, String model, String apiKey, String reasoningEffort,
            String searchProvider, String searchBaseUrl, boolean piTextMode) {
        preferences.edit().putString("base_url", baseUrl.trim()).putString("model", model.trim())
                .putString("api_key", apiKey.trim())
                .putString("reasoning_effort", ReasoningEffort.normalize(reasoningEffort))
                .putString("search_provider", SearchConfig.provider(searchProvider))
                .putString("search_base_url", searchBaseUrl.trim())
                .putBoolean("pi_text_mode", piTextMode).apply();
    }

    public List<AgentLoop.Message> load() { return tree().path(); }

    public ConversationTree tree() {
        try {
            Object stored = new org.json.JSONTokener(preferences.getString(historyKey(), "[]")).nextValue();
            boolean legacy = stored instanceof JSONArray;
            JSONObject envelope = legacy ? null : (JSONObject) stored;
            if (!legacy && envelope.getInt("version") != 1) throw new IllegalArgumentException("未知历史版本");
            JSONArray values = legacy ? (JSONArray) stored : envelope.getJSONArray("nodes");
            List<ConversationTree.Node> nodes = new ArrayList<>();
            String parent = null;
            for (int i = 0; i < values.length(); i++) {
                JSONObject value = values.getJSONObject(i);
                AgentLoop.Message message = readMessage(value);
                nodes.add(new ConversationTree.Node(legacy ? parent : value.optString("parent_id", null), message));
                parent = message.id;
            }
            ConversationTree tree = new ConversationTree(nodes, legacy ? parent : envelope.optString("leaf", null));
            // Persist generated identities once, before any caller can hold a path containing them.
            if (legacy && !nodes.isEmpty()) preferences.edit().putString(historyKey(), encodeTree(tree).toString()).apply();
            return tree;
        } catch (Exception exception) {
            throw new IllegalStateException("无法读取聊天记录", exception);
        }
    }

    private static AgentLoop.Message readMessage(JSONObject value) throws Exception {
        List<AgentLoop.ToolCall> calls = new ArrayList<>();
        JSONArray storedCalls = value.optJSONArray("tool_calls");
        if (storedCalls != null) for (int i = 0; i < storedCalls.length(); i++) {
            JSONObject call = storedCalls.getJSONObject(i);
            calls.add(new AgentLoop.ToolCall(call.getString("id"), call.getString("name"),
                    call.optString("arguments", "{}")));
        }
        return new AgentLoop.Message(value.optString("id", java.util.UUID.randomUUID().toString()),
                value.getString("role"), value.isNull("content") ? null : value.optString("content", ""),
                value.optString("tool_call_id", null), calls, value.optBoolean("incomplete", false));
    }

    private static JSONObject encodeTree(ConversationTree tree) throws Exception {
        JSONArray values = new JSONArray();
        for (ConversationTree.Node node : tree.nodes()) {
            put(values, node.message);
            values.getJSONObject(values.length() - 1).put("id", node.id).put("parent_id", node.parentId);
        }
        return new JSONObject().put("version", 1).put("nodes", values).put("leaf", tree.leaf());
    }

    public void selectNode(String id) {
        ConversationTree tree = tree();
        tree.select(id);
        writeTree(tree);
    }

    public void save(List<AgentLoop.Message> messages) {
        ConversationTree tree = tree();
        tree.merge(messages);
        writeTree(tree);
    }

    private void writeTree(ConversationTree tree) {
        try {
            JSONObject index = conversationIndex();
            String title = "新对话";
            for (AgentLoop.Message message : tree.path()) {
                if ("user".equals(message.role) && message.content != null) {
                    title = message.content.replace('\n', ' ').trim();
                    title = title.substring(0, Math.min(title.length(), 40));
                    break;
                }
            }
            JSONObject previous = index.optJSONObject(activeId());
            if (previous != null) title = previous.optString("title", title);
            index.put(activeId(), new JSONObject().put("title", title).put("updated", System.currentTimeMillis()));
            preferences.edit().putString(historyKey(), encodeTree(tree).toString())
                    .putString("conversations", index.toString()).apply();
        } catch (Exception exception) {
            throw new IllegalStateException("无法保存聊天记录", exception);
        }
    }

    private static void put(JSONArray values, AgentLoop.Message message) throws Exception {
        JSONObject value = new JSONObject().put("role", message.role)
                .put("content", message.content == null
                        ? JSONObject.NULL : message.content);
        if (message.incomplete) value.put("incomplete", true);
        if (message.toolCallId != null) value.put("tool_call_id", message.toolCallId);
        if (!message.toolCalls.isEmpty()) {
            JSONArray calls = new JSONArray();
            for (AgentLoop.ToolCall call : message.toolCalls) calls.put(new JSONObject()
                    .put("id", call.id).put("name", call.name)
                    .put("arguments", truncateArguments(call.arguments)));
            value.put("tool_calls", calls);
        }
        values.put(value);
    }

    public void clear() {
        JSONObject index = conversationIndex();
        index.remove(activeId());
        preferences.edit().remove(historyKey()).remove("draft_" + activeId())
                .putString("conversations", index.toString())
                .putString("active_chat", java.util.UUID.randomUUID().toString()).apply();
    }

    private static String truncateArguments(String value) {
        return value.length() <= MAX_TOOL_ARGUMENTS ? value : value.substring(0, MAX_TOOL_ARGUMENTS);
    }
}
