package com.example.launcherprobe;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import org.json.JSONObject;

@CapacitorPlugin(name = "Chat")
public final class ChatPlugin extends Plugin {
    private ChatCoordinator coordinator;
    private final ChatCoordinator.Listener listener = (messages, event) ->
            notifyListeners("chatEvent", js(event), true);

    @Override public void load() {
        coordinator = ChatCoordinator.get(getContext());
        coordinator.addListener(listener);
    }

    @Override protected void handleOnDestroy() {
        if (coordinator != null) coordinator.removeListener(listener);
    }

    @PluginMethod public void markTaskRead(PluginCall call) {
        try {
            String id = required(call, "conversationId");
            getActivity().runOnUiThread(() -> {
                if (getActivity() instanceof MainActivity activity && activity.isTaskConversationVisible(id))
                    coordinator.markTaskRead(id);
                call.resolve();
            });
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void snapshot(PluginCall call) { resolve(call, coordinator.snapshot()); }
    @PluginMethod public void getConversation(PluginCall call) { resolve(call, NativeJson.conversation(coordinator.store())); }
    @PluginMethod public void listConversations(PluginCall call) {
        try { resolve(call, new JSONObject().put("conversations", NativeJson.conversations(
                coordinator.store().conversations(call.getString("query"))))); }
        catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void newConversation(PluginCall call) {
        try {
            ChatStore store = coordinator.store();
            store.newConversation();
            store.saveDraft("");
            store.saveDraftAttachments(java.util.Collections.emptyList());
            store.cleanupAttachments();
            resolve(call, coordinator.snapshot());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void selectConversation(PluginCall call) {
        try {
            coordinator.store().selectConversation(required(call, "conversationId"));
            resolve(call, coordinator.snapshot());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void deleteConversation(PluginCall call) {
        try {
            String id = required(call, "conversationId");
            coordinator.deleteConversation(id);
            resolve(call, coordinator.snapshot());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void archiveConversation(PluginCall call) {
        try {
            coordinator.archiveConversation(required(call, "conversationId"));
            resolve(call, coordinator.snapshot());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void restoreConversation(PluginCall call) {
        try {
            coordinator.restoreConversation(required(call, "conversationId"));
            resolve(call, coordinator.snapshot());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void listArchivedConversations(PluginCall call) {
        try { resolve(call, new JSONObject().put("conversations", NativeJson.conversations(
                coordinator.store().archivedConversations(call.getString("query"))))); }
        catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void saveDraft(PluginCall call) {
        try {
            String id = required(call, "conversationId");
            if (!id.equals(coordinator.store().activeId())) throw new IllegalStateException("会话已切换");
            coordinator.store().saveDraft(id, call.getString("text", ""));
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void selectNode(PluginCall call) {
        try {
            ChatStore store = coordinator.store();
            String conversation = required(call, "conversationId");
            if (!conversation.equals(store.activeId())) throw new IllegalStateException("会话已切换");
            if (coordinator.running(conversation)) throw new IllegalStateException("请先停止此会话的当前生成");
            ConversationTree.Node node = store.tree(conversation).node(required(call, "nodeId"));
            if (node == null) throw new IllegalArgumentException("历史节点不存在");
            boolean edit = call.getBoolean("edit", false);
            if (edit && "user".equals(node.message.role)) {
                store.selectNode(conversation, node.parentId);
                store.saveDraft(conversation, node.message.content == null ? "" : node.message.content);
                store.saveDraftAttachments(conversation, node.message.attachments);
            } else store.selectNode(conversation, node.id);
            resolve(call, NativeJson.conversation(store, conversation));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void send(PluginCall call) {
        try {
            String id = required(call, "conversationId");
            if (!id.equals(coordinator.store().activeId())) throw new IllegalStateException("会话已切换");
            getActivity().runOnUiThread(() -> TaskNotifications.requestPermission(getActivity()));
            String request = coordinator.send(id, call.getString("text", ""), call.getString("submissionId"));
            JSObject result = new JSObject();
            result.put("accepted", request != null);
            result.put("requestId", request == null ? JSONObject.NULL : request);
            call.resolve(result);
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void cancel(PluginCall call) {
        try { coordinator.cancel(required(call, "conversationId")); call.resolve(); }
        catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void submitQuestionnaire(PluginCall call) {
        try {
            JSArray answers = call.getArray("answers");
            if (answers == null) throw new IllegalArgumentException("answers is required");
            coordinator.submitQuestionnaire(required(call, "conversationId"), required(call, "requestId"),
                    required(call, "questionnaireId"), answers, call.getData().opt("globalNote"));
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void cancelQuestionnaire(PluginCall call) {
        try {
            coordinator.cancelQuestionnaire(required(call, "conversationId"), required(call, "requestId"),
                    required(call, "questionnaireId"));
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void catalog(PluginCall call) {
        try {
            PiConfigStore store = new PiConfigStore(getContext());
            store.initialize(getContext().getSharedPreferences("chat", android.content.Context.MODE_PRIVATE));
            String config = store.snapshot();
            JSONObject arguments = new JSONObject().put("refresh", call.getBoolean("refresh", false));
            PiAgentBridge bridge = PiAgentBridge.get(getContext());
            String id = bridge.query("catalog", config, arguments, store, event ->
                    notifyListeners("catalogEvent", js(event), true));
            JSObject result = new JSObject(); result.put("requestId", id); call.resolve(result);
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void selectModel(PluginCall call) { select(call, true); }
    @PluginMethod public void selectThinkingLevel(PluginCall call) { select(call, false); }

    private void select(PluginCall call, boolean modelChange) {
        try {
            ChatStore store = coordinator.store();
            String conversation = required(call, "conversationId");
            if (!conversation.equals(store.activeId())) throw new IllegalStateException("会话已切换");
            if (coordinator.running(conversation)) throw new IllegalStateException("请先停止此会话的当前生成");
            String expected = call.getString("expectedSelection");
            if (expected != null && !new JSONObject(expected).toString().equals(new JSONObject(store.piSelection(conversation)).toString()))
                throw new IllegalStateException("模型或思考强度已更改，请重新选择");
            JSONObject current = new JSONObject(store.piSelection(conversation));
            String provider = modelChange ? required(call, "providerId") : current.optString("provider", required(call, "providerId"));
            String model = modelChange ? required(call, "modelId") : current.optString("model", required(call, "modelId"));
            String thinking = call.getString("thinkingLevel");
            store.setPiSelection(conversation, provider, model, thinking == null || thinking.isEmpty() ? null : thinking);
            resolve(call, NativeJson.conversation(store, conversation));
        } catch (Exception exception) { reject(call, exception); }
    }

    private static String required(PluginCall call, String name) {
        String value = call.getString(name);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(name + " is required");
        return value;
    }
    private static JSObject js(JSONObject value) {
        try { return JSObject.fromJSONObject(value); }
        catch (Exception exception) { throw new IllegalStateException(exception); }
    }
    private static void resolve(PluginCall call, JSONObject value) { call.resolve(js(value)); }
    private static void reject(PluginCall call, Exception exception) { call.reject(exception.getMessage(), exception); }
}
