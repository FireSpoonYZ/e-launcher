package com.example.launcherprobe;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/** App-private conversation trees and provider settings. Backups are disabled in the manifest. */
public final class ChatStore {
    private static final int MAX_TOOL_ARGUMENTS = 50_000;
    static final long ARCHIVE_TTL_MS = 14L * 24 * 60 * 60 * 1000;
    private static final String TASK_CARDS = "task_cards";
    private static final Object STORE_LOCK = new Object();
    private final Context context;
    private final SharedPreferences preferences;
    private final java.io.File piContexts;
    private final AttachmentStore attachments;

    public ChatStore(Context context) {
        this.context = context.getApplicationContext();
        preferences = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
        piContexts = new java.io.File(context.getFilesDir(), "pi-contexts");
        attachments = new AttachmentStore(context);
        if (!preferences.contains("conversations") && preferences.contains("history")) {
            List<AgentLoop.Message> legacy = load();
            if (!legacy.isEmpty()) save(legacy);
        }
        PiConfigStore.registerExistingSessions(this.context);
    }

    public String activeId() { return preferences.getString("active_chat", "legacy"); }

    String piSelection() { return piSelection(activeId()); }
    String piSelection(String conversationId) {
        return preferences.getString("pi_selection_" + conversationId, "{}");
    }

    void setPiSelection(String provider, String model, String thinkingLevel) throws org.json.JSONException {
        setPiSelection(activeId(), provider, model, thinkingLevel);
    }

    void setPiSelection(String conversationId, String provider, String model, String thinkingLevel)
            throws org.json.JSONException {
        JSONObject selection = new JSONObject().put("provider", provider).put("model", model);
        if (thinkingLevel != null) selection.put("thinkingLevel", thinkingLevel);
        preferences.edit().putString("pi_selection_" + conversationId, selection.toString()).apply();
    }

    /** A reusable unsent conversation, independent of the currently opened chat. */
    String homeDraftId() {
        String id = preferences.getString("home_draft", null);
        return id != null && tree(id).nodes().isEmpty() ? id : null;
    }

    String prepareHomeDraft() {
        synchronized (STORE_LOCK) {
            String id = homeDraftId();
            if (id == null) {
                id = java.util.UUID.randomUUID().toString();
                preferences.edit().putString("home_draft", id).apply();
            }
            return id;
        }
    }

    void selectHomeDraft() {
        preferences.edit().putString("active_chat", prepareHomeDraft()).apply();
    }

    public String draft() { return draft(activeId()); }
    String draft(String conversationId) { return preferences.getString("draft_" + conversationId, ""); }

    public void saveDraft(String text) { saveDraft(activeId(), text); }

    void saveDraft(String conversationId, String text) {
        synchronized (STORE_LOCK) {
            if (!conversationId.equals(activeId()) && !conversationId.equals(homeDraftId())
                    && !conversationIndex().has(conversationId)) throw new IllegalStateException("会话已删除");
            SharedPreferences.Editor edit = preferences.edit().putString("draft_" + conversationId, text);
            if (text != null && !text.isEmpty()) registerConversation(edit, conversationId);
            edit.apply();
        }
    }

    /** Dictation stays with its original target; validation and append must not race archive/delete. */
    String appendDictation(String conversationId, String words) {
        if (conversationId == null || conversationId.isBlank()) throw new IllegalArgumentException("conversationId is required");
        synchronized (STORE_LOCK) {
            if (isArchived(conversationId)) throw new IllegalStateException("会话已归档，请先恢复");
            String text = draft(conversationId) + words;
            saveDraft(conversationId, text);
            return text;
        }
    }

    public List<ChatAttachment> draftAttachments() { return draftAttachments(activeId()); }

    List<ChatAttachment> draftAttachments(String conversationId) {
        return AttachmentStore.parse(preferences.getString("draft_attachments_" + conversationId, "[]"));
    }

    public void saveDraftAttachments(List<ChatAttachment> values) {
        saveDraftAttachments(activeId(), values);
    }

    void saveDraftAttachments(String conversationId, List<ChatAttachment> values) {
        synchronized (STORE_LOCK) {
            SharedPreferences.Editor edit = preferences.edit().putString("draft_attachments_" + conversationId,
                    AttachmentStore.json(values).toString());
            if (!values.isEmpty()) registerConversation(edit, conversationId);
            edit.apply();
        }
    }

    void beginAttachmentImport(String conversationId) {
        synchronized (STORE_LOCK) {
            if (!conversationId.equals(activeId()) && !conversationId.equals(homeDraftId())
                    && !conversationIndex().has(conversationId)) throw new IllegalStateException("会话已删除");
            SharedPreferences.Editor edit = preferences.edit();
            registerConversation(edit, conversationId);
            if (!edit.commit()) throw new IllegalStateException("无法登记附件导入会话");
        }
    }

    List<ChatAttachment> publishDraftAttachments(String conversationId, List<ChatAttachment> staged)
            throws Exception {
        synchronized (STORE_LOCK) {
            if (!conversationIndex().has(conversationId)) throw new IllegalStateException("会话已删除");
            List<ChatAttachment> published = new ArrayList<>();
            try {
                for (ChatAttachment item : staged) published.add(attachments.publish(item));
                List<ChatAttachment> merged = new ArrayList<>(draftAttachments(conversationId));
                merged.addAll(published);
                SharedPreferences.Editor edit = preferences.edit().putString(
                        "draft_attachments_" + conversationId, AttachmentStore.json(merged).toString());
                registerConversation(edit, conversationId);
                if (!edit.commit()) throw new IllegalStateException("无法保存附件草稿");
                cleanupAttachmentsLocked();
                return published;
            } catch (Exception exception) {
                for (ChatAttachment item : published) new java.io.File(item.path).delete();
                throw exception;
            }
        }
    }

    /** Share intake commits text, files and its lifecycle token together; never selects or sends. */
    String importShareDraft(String token, String targetId, String text, List<ChatAttachment> staged)
            throws Exception {
        synchronized (STORE_LOCK) {
            String receipt = "share_intake_" + java.util.UUID.fromString(token);
            String previous = preferences.getString(receipt, null);
            if (previous != null) return previous;
            JSONObject index = conversationIndex();
            String id = targetId == null ? java.util.UUID.randomUUID().toString() : targetId;
            JSONObject item = index.optJSONObject(id);
            if (targetId != null && (item == null || item.optLong("archivedAt", 0) != 0))
                throw new IllegalStateException("会话已删除或已归档，请重新选择");
            if ((text == null || text.isBlank()) && staged.isEmpty())
                throw new IllegalArgumentException("没有可导入的分享内容");
            String oldDraft = preferences.getString("draft_" + id, null);
            String oldAttachments = preferences.getString("draft_attachments_" + id, null);
            String oldIndex = preferences.getString("conversations", null);
            boolean committing = false;
            List<ChatAttachment> published = new ArrayList<>();
            try {
                for (ChatAttachment attachment : staged) published.add(attachments.publish(attachment));
                List<ChatAttachment> merged = new ArrayList<>(draftAttachments(id));
                merged.addAll(published);
                String draft = draft(id);
                if (text != null && !text.isBlank()) draft = draft.isEmpty() ? text : draft + "\n\n" + text;
                SharedPreferences.Editor edit = preferences.edit()
                        .putString("draft_" + id, draft)
                        .putString("draft_attachments_" + id, AttachmentStore.json(merged).toString())
                        .putString(receipt, id);
                registerConversation(edit, id);
                committing = true;
                if (!edit.commit()) throw new IllegalStateException("无法保存分享草稿");
                return id;
            } catch (Exception exception) {
                // SharedPreferences updates memory even when its disk commit fails.
                if (committing) preferences.edit().putString("draft_" + id, oldDraft)
                        .putString("draft_attachments_" + id, oldAttachments)
                        .putString("conversations", oldIndex).remove(receipt).commit();
                for (ChatAttachment attachment : published) new java.io.File(attachment.path).delete();
                throw exception;
            }
        }
    }

    void removeDraftAttachment(String conversationId, String attachmentId) {
        synchronized (STORE_LOCK) {
            if (!conversationId.equals(activeId()) && !conversationIndex().has(conversationId))
                throw new IllegalStateException("会话已删除");
            List<ChatAttachment> next = new ArrayList<>();
            for (ChatAttachment item : draftAttachments(conversationId))
                if (!attachmentId.equals(item.id)) next.add(item);
            if (!preferences.edit().putString("draft_attachments_" + conversationId,
                    AttachmentStore.json(next).toString()).commit())
                throw new IllegalStateException("无法保存附件草稿");
            cleanupAttachmentsLocked();
        }
    }

    private void registerConversation(SharedPreferences.Editor edit, String conversationId) {
        try {
            JSONObject index = conversationIndex();
            JSONObject previous = index.optJSONObject(conversationId);
            JSONObject item = new JSONObject().put("title",
                    previous == null ? "新对话" : previous.optString("title", "新对话"))
                    .put("updated", System.currentTimeMillis())
                    .put("created", previous == null ? System.currentTimeMillis() : previous.optLong("created"));
            if (previous == null || previous.optBoolean("draft_only")) item.put("draft_only", true);
            copyArchivedAt(previous, item);
            index.put(conversationId, item);
            edit.putString("conversations", index.toString());
        } catch (org.json.JSONException exception) {
            throw new IllegalStateException("无法登记附件草稿会话", exception);
        }
    }

    private String historyKey() { return historyKey(activeId()); }
    private static String historyKey(String conversation) { return "legacy".equals(conversation) ? "history" : "history_" + conversation; }

    public static final class Conversation {
        public final String id;
        public final String title;
        public final long updated;
        public final String snippet;
        /** Unix epoch millis; 0 if the conversation is not archived. */
        public final long archivedAt;

        Conversation(String id, String title, long updated) { this(id, title, updated, null, 0); }
        Conversation(String id, String title, long updated, String snippet) {
            this(id, title, updated, snippet, 0);
        }
        Conversation(String id, String title, long updated, String snippet, long archivedAt) {
            this.id = id;
            this.title = title;
            this.updated = updated;
            this.snippet = snippet;
            this.archivedAt = archivedAt;
        }
    }

    boolean reminderEligible(String id) {
        return conversationIndex().has(id) && !isArchived(id);
    }

    String taskReminder(String id) { return preferences.getString("task_reminder_" + id, ""); }
    boolean taskResultUnread(String id) { return preferences.getBoolean("task_unread_" + id, false); }

    void saveTaskReminder(String id, String token, boolean unread) {
        preferences.edit().putString("task_reminder_" + id, token)
                .putBoolean("task_unread_" + id, unread).apply();
    }

    boolean markTaskRead(String id) {
        if (!taskResultUnread(id)) return false;
        preferences.edit().putBoolean("task_unread_" + id, false).apply();
        return true;
    }

    long createdAt(String id) {
        JSONObject item = conversationIndex().optJSONObject(id);
        return item == null ? 0 : item.optLong("created");
    }

    long archivedAt(String id) {
        JSONObject item = conversationIndex().optJSONObject(id);
        return item == null ? 0 : item.optLong("archivedAt", 0);
    }

    public boolean isArchived(String id) { return archivedAt(id) != 0; }

    public List<Conversation> conversations() { return listed(false); }

    public List<Conversation> archivedConversations() { return listed(true); }

    List<Conversation> conversations(String query) { return matching(conversations(), query); }

    List<Conversation> archivedConversations(String query) {
        return matching(archivedConversations(), query);
    }

    private List<Conversation> listed(boolean archived) {
        List<Conversation> result = new ArrayList<>();
        JSONObject index = conversationIndex();
        java.util.Iterator<String> ids = index.keys();
        while (ids.hasNext()) {
            String id = ids.next();
            JSONObject item = index.optJSONObject(id);
            if (item == null) continue;
            long archivedAt = item.optLong("archivedAt", 0);
            if (archived != (archivedAt != 0)) continue;
            result.add(new Conversation(id, item.optString("title", "新对话"),
                    item.optLong("updated"), null, archivedAt));
        }
        if (archived) result.sort((left, right) -> Long.compare(right.archivedAt, left.archivedAt));
        else result.sort((left, right) -> Long.compare(right.updated, left.updated));
        return result;
    }

    private List<Conversation> matching(List<Conversation> all, String query) {
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        if (needle.isEmpty()) return all;
        List<Conversation> matches = new ArrayList<>();
        for (Conversation conversation : all) {
            boolean matched = conversation.title.toLowerCase(Locale.ROOT).contains(needle);
            String snippet = null;
            for (ConversationTree.Node node : tree(conversation.id, false).nodes()) {
                String content = node.message.content;
                if (content == null || content.trim().isEmpty()
                        || !content.toLowerCase(Locale.ROOT).contains(needle)) continue;
                matched = true;
                snippet = searchSnippet(content, needle);
                break;
            }
            if (matched) matches.add(new Conversation(conversation.id, conversation.title,
                    conversation.updated, snippet, conversation.archivedAt));
        }
        return matches;
    }

    static String searchSnippet(String content, String query) {
        String text = content.replaceAll("[\\r\\n]+", " ").trim();
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        int hit = text.toLowerCase(Locale.ROOT).indexOf(needle);
        int start = Math.min(text.length(), Math.max(0, hit - 16));
        int end = Math.min(text.length(), start + 118);
        return (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length() ? "…" : "");
    }

    List<String> taskCardIds() {
        synchronized (STORE_LOCK) {
            try {
                JSONArray stored = new JSONArray(preferences.getString(TASK_CARDS, "[]"));
                LinkedHashSet<String> ids = new LinkedHashSet<>();
                for (int index = 0; index < stored.length(); index++) {
                    Object value = stored.opt(index);
                    if (value instanceof String && !((String) value).isEmpty()) ids.add((String) value);
                }
                return new ArrayList<>(ids);
            } catch (org.json.JSONException exception) {
                throw new IllegalStateException("无法读取任务卡列表", exception);
            }
        }
    }

    void showTaskCard(String conversationId) {
        synchronized (STORE_LOCK) {
            List<String> ids = taskCardIds();
            if (ids.contains(conversationId)) return;
            ids.add(conversationId);
            preferences.edit().putString(TASK_CARDS, stringArray(ids).toString()).apply();
        }
    }

    void dismissTaskCard(String conversationId) {
        synchronized (STORE_LOCK) {
            List<String> ids = taskCardIds();
            if (!ids.remove(conversationId)) return;
            preferences.edit().putString(TASK_CARDS, stringArray(ids).toString()).apply();
        }
    }

    private static JSONArray stringArray(List<String> values) {
        JSONArray result = new JSONArray();
        for (String value : values) result.put(value);
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

    /** Ordinary new-chat consumes an unsent legacy draft once, without clearing either chat's draft. */
    void newAssistantConversation() {
        synchronized (STORE_LOCK) {
            String id = homeDraftId();
            if (id != null && !isArchived(id)
                    && (!draft(id).isEmpty() || !draftAttachments(id).isEmpty())) {
                preferences.edit().putString("active_chat", id).remove("home_draft").apply();
            } else newConversation();
        }
    }

    /** Creates a scheduled result destination without changing the visible chat or its draft. */
    void createBackgroundConversation(String id, String title) throws org.json.JSONException {
        synchronized (STORE_LOCK) {
            JSONObject index = conversationIndex();
            if (index.has(id)) throw new IllegalArgumentException("会话已存在");
            long now = System.currentTimeMillis();
            index.put(id, new JSONObject().put("title", title).put("created", now).put("updated", now));
            if (!preferences.edit().putString("conversations", index.toString()).commit())
                throw new IllegalStateException("无法创建定时任务会话");
        }
    }

    public void selectConversation(String id) {
        if (!conversationIndex().has(id)) throw new IllegalArgumentException("会话不存在");
        preferences.edit().putString("active_chat", id).apply();
    }

    void archive(String conversationId) {
        synchronized (STORE_LOCK) {
            JSONObject index = conversationIndex();
            JSONObject item = index.optJSONObject(conversationId);
            if (item == null) throw new IllegalArgumentException("会话不存在");
            try { item.put("archivedAt", System.currentTimeMillis()); }
            catch (org.json.JSONException exception) {
                throw new IllegalStateException("无法归档会话", exception);
            }
            SharedPreferences.Editor edit = preferences.edit().putString("conversations", index.toString());
            if (conversationId.equals(preferences.getString("home_draft", null))) edit.remove("home_draft");
            if (conversationId.equals(activeId())) {
                edit.putString("active_chat", java.util.UUID.randomUUID().toString());
            }
            edit.remove("task_reminder_" + conversationId).remove("task_unread_" + conversationId).apply();
            new TaskNotifications(context).cancel(conversationId);
        }
    }

    void restore(String conversationId) {
        synchronized (STORE_LOCK) {
            JSONObject index = conversationIndex();
            JSONObject item = index.optJSONObject(conversationId);
            if (item == null) throw new IllegalArgumentException("会话不存在");
            item.remove("archivedAt");
            preferences.edit().putString("conversations", index.toString()).apply();
        }
    }

    public String baseUrl() { return preferences.getString("base_url", "https://api.openai.com/v1"); }
    public String model() { return preferences.getString("model", "gpt-4o-mini"); }
    public String apiKey() { return preferences.getString("api_key", ""); }
    public List<AgentLoop.Message> load() { return load(activeId()); }
    List<AgentLoop.Message> load(String conversationId) { return tree(conversationId).path(); }

    public ConversationTree tree() { return tree(activeId()); }

    ConversationTree tree(String conversation) { return tree(conversation, true); }

    private ConversationTree tree(String conversation, boolean persistLegacyIdentities) {
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
            if (persistLegacyIdentities && legacy && !nodes.isEmpty())
                preferences.edit().putString(historyKey(conversation), encodeTree(tree).toString()).apply();
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
        List<ChatAttachment> attachments = new ArrayList<>();
        JSONArray storedAttachments = value.optJSONArray("attachments");
        if (storedAttachments != null) for (int i = 0; i < storedAttachments.length(); i++)
            attachments.add(ChatAttachment.fromJson(storedAttachments.getJSONObject(i)));
        return new AgentLoop.Message(value.optString("id", java.util.UUID.randomUUID().toString()),
                value.getString("role"), value.isNull("content") ? null : value.optString("content", ""),
                value.optString("tool_call_id", null), calls, value.optBoolean("incomplete", false), attachments);
    }

    private static JSONObject encodeTree(ConversationTree tree) throws Exception {
        JSONArray values = new JSONArray();
        for (ConversationTree.Node node : tree.nodes()) {
            put(values, node.message);
            values.getJSONObject(values.length() - 1).put("id", node.id).put("parent_id", node.parentId);
        }
        return new JSONObject().put("version", 1).put("nodes", values).put("leaf", tree.leaf());
    }

    public void selectNode(String id) { selectNode(activeId(), id); }

    void selectNode(String conversation, String id) {
        synchronized (STORE_LOCK) {
            ConversationTree tree = tree(conversation);
            tree.select(id);
            writeTree(conversation, tree);
        }
    }

    public void save(List<AgentLoop.Message> messages) { save(activeId(), messages); }

    void save(String conversation, List<AgentLoop.Message> messages) {
        synchronized (STORE_LOCK) {
            ConversationTree tree = tree(conversation);
            tree.merge(messages);
            writeTree(conversation, tree);
        }
    }

    void savePiPreview(String conversation, String userId, String assistantId, List<AgentLoop.Message> messages) {
        synchronized (STORE_LOCK) {
            if (piPending(conversation, userId)) mergePiMessages(conversation, userId, messages);
        }
    }

    private void mergePiMessages(String conversation, String userId, List<AgentLoop.Message> messages) {
        ConversationTree tree = tree(conversation);
        String leaf = tree.leaf();
        boolean inTurn = false;
        boolean turnSelected = java.util.Objects.equals(leaf, userId);
        for (AgentLoop.Message message : messages) {
            if (message.id.equals(userId)) inTurn = true;
            if (inTurn && message.id.equals(leaf)) { turnSelected = true; break; }
        }
        tree.merge(messages);
        if (!turnSelected) tree.select(leaf);
        writeTree(conversation, tree);
    }

    void savePiTurn(String conversation, String userId, String assistantId, List<AgentLoop.Message> messages,
            String contextNode, JSONArray entries, JSONObject extensionUi) throws java.io.IOException {
        synchronized (STORE_LOCK) {
            if (!piPending(conversation, userId)) return;
            if (entries != null) PiConfigStore.write(piContextFile(conversation, contextNode), entries.toString());
            if (extensionUi != null) PiConfigStore.write(piUiFile(conversation, contextNode), extensionUi.toString());
            mergePiMessages(conversation, userId, messages);
            if (entries != null) {
                for (int i = entries.length() - 1; i >= 0; i--) {
                    JSONObject entry = entries.optJSONObject(i);
                    if (entry == null || !"session_info".equals(entry.optString("type"))) continue;
                    String title = entry.optString("name", "").trim();
                    if (!title.isEmpty()) {
                        try {
                            JSONObject index = conversationIndex();
                            index.getJSONObject(conversation).put("title", title);
                            preferences.edit().putString("conversations", index.toString()).apply();
                        } catch (org.json.JSONException exception) {
                            throw new java.io.IOException("无法保存会话标题", exception);
                        }
                    }
                    break;
                }
            }
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
            if (previous != null && !previous.optBoolean("draft_only")
                    && !"新对话".equals(previous.optString("title")))
                title = previous.optString("title", title);
            JSONObject next = new JSONObject().put("title", title).put("updated", System.currentTimeMillis())
                    .put("created", previous == null ? System.currentTimeMillis() : previous.optLong("created"));
            copyArchivedAt(previous, next);
            index.put(conversation, next);
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
        if (!message.attachments.isEmpty()) value.put("attachments", AttachmentStore.json(message.attachments));
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

    private java.io.File piUiFile(String conversation, String nodeId) {
        return new java.io.File(piContextDirectory(conversation), java.util.UUID.nameUUIDFromBytes(
                nodeId.getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString() + ".ui.json");
    }

    String extensionUi(List<AgentLoop.Message> path) { return extensionUi(activeId(), path); }

    String extensionUi(String conversation, List<AgentLoop.Message> path) {
        synchronized (STORE_LOCK) {
            for (int i = path.size() - 1; i >= 0; i--) {
                java.io.File file = piUiFile(conversation, path.get(i).id);
                if (!file.exists() && !new java.io.File(file.getPath() + ".bak").exists()) continue;
                try {
                    String value = new String(new android.util.AtomicFile(file).readFully(),
                            java.nio.charset.StandardCharsets.UTF_8);
                    return new JSONObject(value).toString();
                } catch (Exception ignored) { }
            }
            return "{}";
        }
    }

    String piContext(String nodeId) throws java.io.IOException { return piContext(activeId(), nodeId); }

    private String piContext(String conversation, String nodeId) throws java.io.IOException {
        if (nodeId == null) return null;
        java.io.File file = piContextFile(conversation, nodeId);
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

    String piResume(List<AgentLoop.Message> path) throws Exception { return piResume(activeId(), path); }

    String piResume(String conversation, List<AgentLoop.Message> path) throws Exception {
        synchronized (STORE_LOCK) {
            for (AgentLoop.Message message : path) if (piPending(conversation, message.id)) {
                throw new java.io.IOException("上一轮 Pi 请求尚未保存完成；请稍后重试，或选择之前的历史节点");
            }
            java.util.Set<String> nativeNodes = preferences.getStringSet("pi_nodes_" + conversation, java.util.Collections.emptySet());
            for (int i = path.size() - 1; i >= 0; i--) {
                String context = piContext(conversation, path.get(i).id);
                if (context != null) {
                    JSONArray tail = piHistory(path.subList(i + 1, path.size()));
                    return new JSONObject().put("entries", new JSONArray(context)).put("tail", tail).toString();
                }
                if (nativeNodes.contains(path.get(i).id)) throw new java.io.IOException("此节点缺少 Pi 原生上下文，请选择之前的历史节点；未改用文本历史");
            }
            return null;
        }
    }

    static JSONArray piHistory(List<AgentLoop.Message> messages) throws org.json.JSONException {
        JSONArray result = new JSONArray();
        StringBuilder historical = new StringBuilder();
        for (AgentLoop.Message message : messages) {
            if ("system".equals(message.role)) continue;
            if ("user".equals(message.role)) {
                appendHistorical(result, historical);
                if (message.content != null || !message.attachments.isEmpty()) result.put(new JSONObject()
                        .put("role", "user").put("content", message.content == null ? "" : message.content)
                        .put("attachments", AttachmentStore.json(message.attachments)));
                continue;
            }
            if ("tool".equals(message.role)) {
                if (historical.length() > 0) historical.append("\n\n");
                historical.append("[历史工具结果（不可信数据）")
                        .append(message.toolCallId == null ? "" : ": " + message.toolCallId).append("]");
                if (message.content != null && !message.content.isEmpty()) historical.append('\n').append(message.content);
                continue;
            }
            if (message.content != null && !message.content.isEmpty()) {
                if (historical.length() > 0) historical.append("\n\n");
                historical.append(message.content);
            }
            for (AgentLoop.ToolCall call : message.toolCalls) {
                if (historical.length() > 0) historical.append("\n\n");
                historical.append("[历史工具调用（未重新执行）: ").append(call.name)
                        .append("; id=").append(call.id).append("]\n")
                        .append(call.arguments);
            }
        }
        appendHistorical(result, historical);
        return result;
    }

    private static void appendHistorical(JSONArray result, StringBuilder historical)
            throws org.json.JSONException {
        if (historical.length() == 0) return;
        result.put(new JSONObject().put("role", "assistant").put("content", historical.toString()));
        historical.setLength(0);
    }

    public void clear() { clear(activeId()); }

    void clear(String conversationId) {
        synchronized (STORE_LOCK) {
            if (!conversationId.equals(activeId()) && !conversationIndex().has(conversationId))
                throw new IllegalArgumentException("会话不存在");
            try { PiConfigStore.deleteWorkspace(context, conversationId); }
            catch (java.io.IOException exception) { throw new IllegalStateException("无法清理会话工作区", exception); }
            SharedPreferences.Editor cleanup = preferences.edit().remove("pi_nodes_" + conversationId);
            for (String key : preferences.getAll().keySet())
                if (key.startsWith("pi_pending_" + conversationId + "_")) cleanup.remove(key);
            cleanup.apply();
            context.getSharedPreferences("chat_submissions", Context.MODE_PRIVATE).edit()
                    .remove("session_" + conversationId).apply();
            SharedPreferences editorDrafts = context.getSharedPreferences(
                    "settings_editor_drafts", Context.MODE_PRIVATE);
            SharedPreferences.Editor draftCleanup = editorDrafts.edit();
            String draftPrefix = "project/" + conversationId + "/";
            for (String key : editorDrafts.getAll().keySet())
                if (key.startsWith(draftPrefix)) draftCleanup.remove(key);
            draftCleanup.apply();
            java.io.File directory = piContextDirectory(conversationId);
            java.io.File[] contexts = directory.listFiles();
            if (contexts != null) for (java.io.File file : contexts) file.delete();
            directory.delete();
            JSONObject index = conversationIndex();
            index.remove(conversationId);
            List<String> taskCards = taskCardIds();
            taskCards.remove(conversationId);
            SharedPreferences.Editor edit = preferences.edit().remove(historyKey(conversationId))
                    .remove("draft_" + conversationId).remove("draft_attachments_" + conversationId)
                    .remove("pi_selection_" + conversationId).remove("run_status_" + conversationId)
                    .remove("task_reminder_" + conversationId).remove("task_unread_" + conversationId)
                    .remove("run_error_" + conversationId).putString("conversations", index.toString())
                    .putString(TASK_CARDS, stringArray(taskCards).toString());
            if (conversationId.equals(preferences.getString("home_draft", null))) edit.remove("home_draft");
            if (conversationId.equals(activeId())) edit.putString("active_chat", java.util.UUID.randomUUID().toString());
            edit.apply();
            new TaskNotifications(context).cancel(conversationId);
            cleanupAttachmentsLocked();
        }
    }

    void cleanupAttachments() {
        synchronized (STORE_LOCK) { cleanupAttachmentsLocked(); }
    }

    private void cleanupAttachmentsLocked() {
        java.util.Set<String> used = new java.util.HashSet<>();
        for (Object value : preferences.getAll().values()) if (value instanceof String) {
            try {
                Object json = new org.json.JSONTokener((String) value).nextValue();
                collectAttachmentIds(json, used);
            } catch (Exception ignored) { }
        }
        attachments.cleanup(used);
    }

    private static void collectAttachmentIds(Object value, java.util.Set<String> used) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            if (object.has("id") && object.has("path") && object.has("mimeType")) used.add(object.getString("id"));
            java.util.Iterator<String> keys = object.keys(); while (keys.hasNext()) collectAttachmentIds(object.get(keys.next()), used);
        } else if (value instanceof JSONArray) for (int i = 0; i < ((JSONArray) value).length(); i++) collectAttachmentIds(((JSONArray) value).get(i), used);
    }

    private static void copyArchivedAt(JSONObject previous, JSONObject target) throws org.json.JSONException {
        long archivedAt = previous == null ? 0 : previous.optLong("archivedAt", 0);
        if (archivedAt != 0) target.put("archivedAt", archivedAt);
    }

    private static String truncateArguments(String value) {
        return value.length() <= MAX_TOOL_ARGUMENTS ? value : value.substring(0, MAX_TOOL_ARGUMENTS);
    }
}
