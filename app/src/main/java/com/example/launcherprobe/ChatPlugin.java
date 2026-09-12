package com.example.launcherprobe;

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

    @PluginMethod public void snapshot(PluginCall call) { resolve(call, coordinator.snapshot()); }
    @PluginMethod public void getConversation(PluginCall call) { resolve(call, NativeJson.conversation(coordinator.store())); }
    @PluginMethod public void listConversations(PluginCall call) {
        try { resolve(call, new JSONObject().put("conversations", NativeJson.conversations(coordinator.store().conversations()))); }
        catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void newConversation(PluginCall call) {
        try {
            requireIdle();
            ChatStore store = coordinator.store();
            if (!store.tree().nodes().isEmpty()) store.newConversation();
            store.saveDraft("");
            resolve(call, coordinator.snapshot());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void selectConversation(PluginCall call) {
        try {
            requireIdle();
            coordinator.store().selectConversation(required(call, "conversationId"));
            resolve(call, coordinator.snapshot());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void deleteConversation(PluginCall call) {
        try {
            requireIdle();
            String id = required(call, "conversationId");
            if (!id.equals(coordinator.store().activeId())) coordinator.store().selectConversation(id);
            coordinator.store().clear();
            resolve(call, coordinator.snapshot());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void saveDraft(PluginCall call) {
        try {
            String id = required(call, "conversationId");
            if (!id.equals(coordinator.store().activeId())) throw new IllegalStateException("会话已切换");
            coordinator.store().saveDraft(call.getString("text", ""));
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void selectNode(PluginCall call) {
        try {
            requireIdle();
            ChatStore store = coordinator.store();
            String conversation = required(call, "conversationId");
            if (!conversation.equals(store.activeId())) throw new IllegalStateException("会话已切换");
            ConversationTree.Node node = store.tree().node(required(call, "nodeId"));
            if (node == null) throw new IllegalArgumentException("历史节点不存在");
            boolean edit = call.getBoolean("edit", false);
            if (edit && "user".equals(node.message.role)) {
                store.selectNode(node.parentId);
                store.saveDraft(node.message.content == null ? "" : node.message.content);
            } else store.selectNode(node.id);
            resolve(call, NativeJson.conversation(store));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void send(PluginCall call) {
        try {
            String id = required(call, "conversationId");
            if (!id.equals(coordinator.store().activeId())) throw new IllegalStateException("会话已切换");
            String request = coordinator.send(required(call, "text"), call.getString("submissionId"));
            JSObject result = new JSObject();
            result.put("accepted", request != null);
            result.put("requestId", request == null ? JSONObject.NULL : request);
            call.resolve(result);
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void cancel(PluginCall call) { coordinator.cancel(); call.resolve(); }

    @PluginMethod public void catalog(PluginCall call) {
        try {
            PiConfigStore store = new PiConfigStore(getContext());
            store.initialize(getContext().getSharedPreferences("chat", android.content.Context.MODE_PRIVATE));
            String config = store.snapshot();
            JSONObject arguments = new JSONObject().put("refresh", call.getBoolean("refresh", false));
            PiAgentBridge bridge = PiAgentBridge.get(getContext());
            String id = bridge.query("catalog", config, arguments, event ->
                    notifyListeners("catalogEvent", js(event), true));
            JSObject result = new JSObject(); result.put("requestId", id); call.resolve(result);
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void selectModel(PluginCall call) { select(call, true); }
    @PluginMethod public void selectThinkingLevel(PluginCall call) { select(call, false); }

    private void select(PluginCall call, boolean modelChange) {
        try {
            requireIdle();
            ChatStore store = coordinator.store();
            String conversation = required(call, "conversationId");
            if (!conversation.equals(store.activeId())) throw new IllegalStateException("会话已切换");
            String expected = call.getString("expectedSelection");
            if (expected != null && !new JSONObject(expected).toString().equals(new JSONObject(store.piSelection()).toString()))
                throw new IllegalStateException("模型或思考强度已更改，请重新选择");
            JSONObject current = new JSONObject(store.piSelection());
            String provider = modelChange ? required(call, "providerId") : current.optString("provider", required(call, "providerId"));
            String model = modelChange ? required(call, "modelId") : current.optString("model", required(call, "modelId"));
            String thinking = call.getString("thinkingLevel");
            store.setPiSelection(conversation, provider, model, thinking == null || thinking.isEmpty() ? null : thinking);
            resolve(call, NativeJson.conversation(store));
        } catch (Exception exception) { reject(call, exception); }
    }

    private void requireIdle() { if (coordinator.running()) throw new IllegalStateException("请先停止当前生成，再切换会话"); }
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
