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
    private static final Object STORE_LOCK = new Object();
    private final SharedPreferences preferences;
    private final java.io.File piContexts;

    public ChatStore(Context context) {
        preferences = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
        piContexts = new java.io.File(context.getFilesDir(), "pi-contexts");
        if (!preferences.contains("conversations") && preferences.contains("history")) {
            List<AgentLoop.Message> legacy = load();
            if (!legacy.isEmpty()) save(legacy);
        }
    }

    public String activeId() { return preferences.getString("active_chat", "legacy"); }

    String piSelection() { return preferences.getString("pi_selection_" + activeId(), "{}"); }

    void setPiSelection(String provider, String model, String thinkingLevel) throws org.json.JSONException {
        JSONObject selection = new JSONObject().put("provider", provider).put("model", model);
        if (thinkingLevel != null) selection.put("thinkingLevel", thinkingLevel);
        preferences.edit().putString("pi_selection_" + activeId(), selection.toString()).apply();
    }

    public String draft() { return preferences.getString("draft_" + activeId(), ""); }

    public void saveDraft(String text) {
        preferences.edit().putString("draft_" + activeId(), text).apply();
    }

    private String historyKey() { return historyKey(activeId()); }
    private static String historyKey(String conversation) { return "legacy".equals(conversation) ? "history" : "history_" + conversation; }

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

    public ConversationTree tree() { return tree(activeId()); }

    private ConversationTree tree(String conversation) {
        try {
            Object stored = new org.json.JSONTokener(preferences.getString(historyKey(conversation), "[]")).nextValue();
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
            if (legacy && !nodes.isEmpty()) preferences.edit().putString(historyKey(conversation), encodeTree(tree).toString()).apply();
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
        synchronized (STORE_LOCK) {
            String conversation = activeId();
            ConversationTree tree = tree(conversation);
            tree.select(id);
            writeTree(conversation, tree);
        }
    }

    public void save(List<AgentLoop.Message> messages) {
        synchronized (STORE_LOCK) {
            String conversation = activeId();
            ConversationTree tree = tree(conversation);
            tree.merge(messages);
            writeTree(conversation, tree);
        }
    }

    void savePiPreview(String conversation, String userId, String assistantId, List<AgentLoop.Message> messages) {
        synchronized (STORE_LOCK) {
            if (piPending(conversation, userId)) mergePiMessages(conversation, userId, assistantId, messages);
        }
    }

    private void mergePiMessages(String conversation, String userId, String assistantId, List<AgentLoop.Message> messages) {
        ConversationTree tree = tree(conversation);
        String leaf = tree.leaf();
        tree.merge(messages);
        if (!java.util.Objects.equals(leaf, userId) && !java.util.Objects.equals(leaf, assistantId)) tree.select(leaf);
        writeTree(conversation, tree);
    }

    void savePiTurn(String conversation, String userId, String assistantId, List<AgentLoop.Message> messages,
            String contextNode, JSONArray entries) throws java.io.IOException {
        synchronized (STORE_LOCK) {
            if (!piPending(conversation, userId)) return;
            if (entries != null) PiConfigStore.write(piContextFile(conversation, contextNode), entries.toString());
            mergePiMessages(conversation, userId, assistantId, messages);
            preferences.edit().remove("pi_pending_" + conversation + "_" + userId).apply();
        }
    }

    private void writeTree(String conversation, ConversationTree tree) {
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
            JSONObject previous = index.optJSONObject(conversation);
            if (previous != null) title = previous.optString("title", title);
            index.put(conversation, new JSONObject().put("title", title).put("updated", System.currentTimeMillis()));
            preferences.edit().putString(historyKey(conversation), encodeTree(tree).toString())
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

    private java.io.File piContextDirectory() { return piContextDirectory(activeId()); }
    private java.io.File piContextDirectory(String conversation) {
        return new java.io.File(piContexts, java.util.UUID.nameUUIDFromBytes(
                conversation.getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString());
    }

    private java.io.File piContextFile(String nodeId) { return piContextFile(activeId(), nodeId); }
    private java.io.File piContextFile(String conversation, String nodeId) {
        return new java.io.File(piContextDirectory(conversation), java.util.UUID.nameUUIDFromBytes(
                nodeId.getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString() + ".json");
    }

    String piContext(String nodeId) throws java.io.IOException {
        if (nodeId == null) return null;
        java.io.File file = piContextFile(nodeId);
        if (!file.exists() && !new java.io.File(file.getPath() + ".bak").exists()) return null;
        return new String(new android.util.AtomicFile(file).readFully(), java.nio.charset.StandardCharsets.UTF_8);
    }

    void savePiContext(String nodeId, JSONArray messages) throws java.io.IOException {
        // ponytail: per-turn snapshots duplicate prefixes; use the native session tree if storage becomes material.
        PiConfigStore.write(piContextFile(nodeId), messages.toString());
    }

    void beginPiTurn(String conversation, String userId, String assistantId) {
        synchronized (STORE_LOCK) {
            java.util.Set<String> nodes = new java.util.HashSet<>(preferences.getStringSet("pi_nodes_" + conversation, java.util.Collections.emptySet()));
            nodes.add(assistantId);
            preferences.edit().putStringSet("pi_nodes_" + conversation, nodes)
                    .putBoolean("pi_pending_" + conversation + "_" + userId, true).apply();
        }
    }

    private boolean piPending(String conversation, String userId) {
        return preferences.getBoolean("pi_pending_" + conversation + "_" + userId, false);
    }

    String piResume(List<AgentLoop.Message> path) throws Exception {
        synchronized (STORE_LOCK) {
            String conversation = activeId();
            for (AgentLoop.Message message : path) if (piPending(conversation, message.id)) {
                throw new java.io.IOException("上一轮 Pi 请求尚未保存完成；请稍后重试，或选择之前的历史节点");
            }
            java.util.Set<String> nativeNodes = preferences.getStringSet("pi_nodes_" + conversation, java.util.Collections.emptySet());
            for (int i = path.size() - 1; i >= 0; i--) {
                String context = piContext(path.get(i).id);
                if (context != null) {
                    JSONArray tail = new JSONArray();
                    for (int j = i + 1; j < path.size(); j++) {
                        AgentLoop.Message message = path.get(j);
                        if (!message.toolCalls.isEmpty() || (!message.role.equals("user") && !message.role.equals("assistant"))) {
                            throw new java.io.IOException("Pi 无法续接 Android 工具历史");
                        }
                        tail.put(new JSONObject().put("role", message.role).put("content", message.content));
                    }
                    return new JSONObject().put("entries", new JSONArray(context)).put("tail", tail).toString();
                }
                if (nativeNodes.contains(path.get(i).id)) throw new java.io.IOException("此节点缺少 Pi 原生上下文，请选择之前的历史节点；未改用文本历史");
            }
            return null;
        }
    }

    public void clear() {
        synchronized (STORE_LOCK) {
        SharedPreferences.Editor cleanup = preferences.edit().remove("pi_nodes_" + activeId());
        for (String key : preferences.getAll().keySet()) if (key.startsWith("pi_pending_" + activeId() + "_")) cleanup.remove(key);
        cleanup.apply();
        java.io.File directory = piContextDirectory();
        java.io.File[] contexts = directory.listFiles();
        if (contexts != null) for (java.io.File file : contexts) file.delete();
        directory.delete();
        JSONObject index = conversationIndex();
        index.remove(activeId());
        preferences.edit().remove(historyKey()).remove("draft_" + activeId()).remove("pi_selection_" + activeId())
                .putString("conversations", index.toString())
                .putString("active_chat", java.util.UUID.randomUUID().toString()).apply();
        }
    }

    private static String truncateArguments(String value) {
        return value.length() <= MAX_TOOL_ARGUMENTS ? value : value.substring(0, MAX_TOOL_ARGUMENTS);
    }
}
