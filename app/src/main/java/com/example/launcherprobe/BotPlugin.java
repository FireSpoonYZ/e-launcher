package com.example.launcherprobe;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** Trusted app UI only. Model calls use the separate actor-bound bridge, never uiAction. */
@CapacitorPlugin(name = "Bots")
public final class BotPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private ChatCoordinator coordinator;
    private ScheduledTasks schedules;
    private boolean destroyed;
    private final Runnable changed = () -> { if (!destroyed) notifyListeners("botsChanged", new JSObject()); };
    private final ChatCoordinator.Listener chatListener = (messages, event) -> invalidate();
    private final Runnable scheduleListener = this::invalidate;
    private void invalidate() {
        // Stream bursts need one refresh, not a full workspace read per token.
        if (!destroyed && !main.hasCallbacks(changed)) main.postDelayed(changed, 60);
    }
    @Override public void load() {
        coordinator = ChatCoordinator.get(getContext()); schedules = ScheduledTasks.get(getContext());
        coordinator.addListener(chatListener); schedules.addListener(scheduleListener);
        main.post(() -> BotManager.start(getContext()));
    }
    @Override protected void handleOnDestroy() {
        destroyed = true; main.removeCallbacks(changed);
        coordinator.removeListener(chatListener); schedules.removeListener(scheduleListener);
    }
    @PluginMethod public void workspace(PluginCall call) {
        run(call, () -> BotManager.get(getContext()).workspace());
    }
    @PluginMethod public void uiAction(PluginCall call) {
        run(call, () -> BotWorkspace.action(getContext(), required(call, "action"), call.getData().getJSONObject("input")));
    }
    @PluginMethod public void snapshot(PluginCall call) {
        run(call, () -> BotManager.get(getContext()).snapshot(selected(call)));
    }
    @PluginMethod public void action(PluginCall call) {
        run(call, () -> BotManager.get(getContext()).userAction(selected(call),
                required(call, "operationId"), call.getObject("arguments")));
    }
    @PluginMethod public void saveProfile(PluginCall call) {
        run(call, () -> {
            ChatCoordinator coordinator = ChatCoordinator.get(getContext());
            String id = selected(call);
            JSONObject profile = coordinator.store().saveBotProfile(id, required(call, "name"),
                    call.getString("rolePrompt", ""), call.getData().getInt("revision"), "user");
            coordinator.botChanged(id); return profile;
        });
    }
    private String selected(PluginCall call) {
        String id = required(call, "conversationId");
        if (!id.equals(ChatCoordinator.get(getContext()).conversationId())) throw new IllegalStateException("会话已切换，请刷新");
        return id;
    }
    private static String required(PluginCall call, String key) {
        String value = call.getString(key);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(key + " is required");
        return value;
    }
    private interface Operation { JSONObject execute() throws Exception; }
    private void run(PluginCall call, Operation operation) {
        main.post(() -> {
            try { call.resolve(new JSObject(operation.execute().toString())); }
            catch (Exception error) { call.reject(error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(), error); }
        });
    }
}
