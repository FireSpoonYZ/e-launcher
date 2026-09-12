package com.example.launcherprobe;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/** Process-owned chat execution. Activities and Capacitor plugins are disposable observers. */
final class ChatCoordinator {
    interface Listener { void changed(List<AgentLoop.Message> messages, JSONObject event); }

    private static ChatCoordinator instance;
    static synchronized ChatCoordinator get(Context context) {
        if (instance == null) instance = new ChatCoordinator(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final ChatStore store;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<Listener> listeners = new CopyOnWriteArraySet<>();
    private final AtomicLong sequence = new AtomicLong();
    private final Object runLock = new Object();
    private volatile boolean running;
    private volatile String requestId;
    private volatile String conversationId;
    private AgentLoop.CancelToken cancellation;
    private PiAgentBridge piBridge;
    private PiTurnPersistence piPersistence;
    private String piAssistantId;
    private String lastError = "";
    private String lastStatus = "";
    private long lastDeltaFlush;
    private final StringBuilder pendingDelta = new StringBuilder();

    private ChatCoordinator(Context context) {
        this.context = context;
        store = new ChatStore(context);
    }

    ChatStore store() { return store; }
    boolean running() { return running; }
    String requestId() { return requestId; }
    String conversationId() { return conversationId; }
    long sequence() { return sequence.get(); }
    void addListener(Listener listener) { listeners.add(listener); }
    void removeListener(Listener listener) { listeners.remove(listener); }

    String send(String text, String submissionId) throws Exception {
        return send(text, store.draftAttachments(), submissionId);
    }

    String send(String text, List<ChatAttachment> attachments, String submissionId) throws Exception {
        String prompt = text == null ? "" : text.trim();
        if (prompt.isEmpty() && attachments.isEmpty()) throw new IllegalArgumentException("消息不能为空");
        AttachmentStore attachmentStore = new AttachmentStore(context);
        for (ChatAttachment attachment : attachments) attachmentStore.requireFile(attachment);
        synchronized (runLock) {
            if (running) throw new IllegalStateException("请先停止当前生成");
            if (submissionId != null && !submissionId.isEmpty()
                    && context.getSharedPreferences("chat_submissions", Context.MODE_PRIVATE).getBoolean(submissionId, false)) return null;
            running = true;
            requestId = UUID.randomUUID().toString();
            conversationId = store.activeId();
            cancellation = new AgentLoop.CancelToken();
            lastError = "";
            lastStatus = "running";
        }
        try {
            emit("runStatus", null, json("status", "running", "message", "正在启动…"));
            startPi(prompt, attachments);
            if (submissionId != null && !submissionId.isEmpty()) context.getSharedPreferences("chat_submissions", Context.MODE_PRIVATE)
                    .edit().clear().putBoolean(submissionId, true).apply();
            return requestId;
        } catch (Exception exception) {
            finish("error", exception.getMessage());
            throw exception;
        }
    }

    void cancel() {
        synchronized (runLock) {
            if (!running) return;
            cancellation.cancel();
            if (piBridge != null) piBridge.abort(requestId);
        }
        emit("runStatus", null, json("status", "stopping", "message", "正在停止…"));
    }

    private void startPi(String text, List<ChatAttachment> attachments) throws Exception {
        PiConfigStore configStore = new PiConfigStore(context);
        configStore.initialize(context.getSharedPreferences("chat", Context.MODE_PRIVATE));
        String config = new JSONObject(configStore.snapshot()).put("selection", new JSONObject(store.piSelection()))
                .put("chatAttachmentRoot", new java.io.File(context.getFilesDir(), "chat-attachments").getAbsolutePath()).toString();
        List<AgentLoop.Message> full = new ArrayList<>(store.load());
        String sdkHistory = store.piResume(full);
        int start = Math.max(0, full.size() - 49);
        while (start > 0 && !"user".equals(full.get(start).role)) start--;
        List<AgentLoop.Message> prior = new ArrayList<>(full.subList(start, full.size()));
        AgentLoop.Message user = new AgentLoop.Message(UUID.randomUUID().toString(), "user", text, null,
                Collections.emptyList(), false, attachments);
        full.add(user);
        store.save(full);
        store.saveDraft("");
        store.saveDraftAttachments(Collections.emptyList());
        piAssistantId = UUID.randomUUID().toString();
        List<AgentLoop.Message> work = new ArrayList<>(prior);
        work.add(user);
        piPersistence = new PiTurnPersistence(store, conversationId, user.id, piAssistantId, work);
        PiTurnPersistence persistence = piPersistence;
        emit("snapshot", user.id, new JSONObject());
        AgentLoop.CancelToken token = cancellation;
        String id = requestId;
        executor.execute(() -> {
            try {
                PiAgentBridge bridge = PiAgentBridge.get(context);
                synchronized (runLock) {
                    if (!ownsRun(token) || token.cancelled()) throw new InterruptedException("pi 启动已取消");
                    piBridge = bridge;
                }
                bridge.prompt(id, config, text, attachments, sdkHistory, prior, event -> main.post(() -> {
                    if (ownsRun(token)) onPiEvent(event, token, persistence);
                }));
            } catch (Throwable exception) {
                try { persistence.accept(new JSONObject().put("type", "end").put("status", "error")); }
                catch (Exception saving) { exception.addSuppressed(saving); }
                if (ownsRun(token)) finish(token.cancelled() ? "aborted" : "error", detail(exception));
            }
        });
    }

    void onPiEvent(JSONObject event, AgentLoop.CancelToken token, PiTurnPersistence persistence) {
        if (!ownsRun(token)) return;
        String type = event.optString("type");
        JSONObject message = event.optJSONObject("message");
        if ("message".equals(type) && message != null && "assistant".equals(message.optString("role"))) {
            main.removeCallbacksAndMessages(persistence);
            synchronized (pendingDelta) { pendingDelta.setLength(0); }
        }
        try { persistence.accept(event); }
        catch (Exception exception) { emit("error", null, json("message", "Pi 会话未保存：" + detail(exception))); }
        if ("text_delta".equals(type)) {
            synchronized (pendingDelta) { pendingDelta.append(event.optString("delta")); }
            flushPiDelta(false, token, persistence);
        } else if ("message".equals(type)) emit("snapshot", null, event);
        else if ("tool_start".equals(type)) emit("toolStart", null, event);
        else if ("tool_end".equals(type)) emit("toolEnd", null, event);
        else if ("status".equals(type)) emit("runStatus", null, event);
        else if ("error".equals(type)) { lastError = event.optString("message"); emit("error", null, event); }
        else if ("end".equals(type)) {
            flushPiDelta(true, token, persistence);
            finish(event.optString("status", "completed"), "");
        }
    }

    private void flushPiDelta(boolean immediate, AgentLoop.CancelToken token, PiTurnPersistence persistence) {
        long delay = Math.max(0, 40 - (System.currentTimeMillis() - lastDeltaFlush));
        Runnable flush = () -> {
            if (!ownsRun(token)) return;
            final String delta;
            synchronized (pendingDelta) {
                if (pendingDelta.length() == 0) return;
                delta = pendingDelta.toString();
                pendingDelta.setLength(0);
            }
            lastDeltaFlush = System.currentTimeMillis();
            AgentLoop.Message assistant = persistence.savePreview();
            if (assistant != null) emit("textDelta", assistant.id, json("delta", delta));
        };
        if (immediate) { main.removeCallbacksAndMessages(persistence); flush.run(); }
        else main.postAtTime(flush, persistence, android.os.SystemClock.uptimeMillis() + delay);
    }

    private boolean ownsRun(AgentLoop.CancelToken token) { return running && cancellation == token; }

    private void finish(String status, String error) {
        final String finishedId;
        synchronized (runLock) {
            if (!running) return;
            finishedId = requestId;
            if (error != null && !error.isEmpty()) lastError = error;
            lastStatus = status;
            if (piPersistence != null) main.removeCallbacksAndMessages(piPersistence);
            synchronized (pendingDelta) { pendingDelta.setLength(0); }
            running = false;
            cancellation = null;
            piBridge = null;
            piPersistence = null;
            piAssistantId = null;
            if (error != null && !error.isEmpty()) emit("error", null, json("message", error));
            emit("end", null, json("status", status, "finishedRequestId", finishedId));
        }
    }

    JSONObject snapshot() {
        return json("sequence", sequence.get(), "running", running,
                "requestId", requestId == null ? JSONObject.NULL : requestId,
                "conversationId", store.activeId(), "conversation", NativeJson.conversation(store),
                "error", lastError, "status", lastStatus);
    }

    private void emit(String type, String nodeId, JSONObject payload) {
        JSONObject event = json("sequence", sequence.incrementAndGet(), "type", type,
                "conversationId", conversationId == null ? store.activeId() : conversationId,
                "requestId", requestId == null ? JSONObject.NULL : requestId,
                "nodeId", nodeId == null ? JSONObject.NULL : nodeId, "payload", payload);
        List<AgentLoop.Message> messages = Collections.unmodifiableList(new ArrayList<>(store.load()));
        main.post(() -> { for (Listener listener : listeners) listener.changed(messages, event); });
    }

    private static JSONObject json(Object... values) {
        JSONObject result = new JSONObject();
        try { for (int i = 0; i < values.length; i += 2) result.put(String.valueOf(values[i]), values[i + 1]); }
        catch (org.json.JSONException exception) { throw new IllegalStateException(exception); }
        return result;
    }

    private static String detail(Throwable exception) {
        return exception.getMessage() == null ? exception.getClass().getSimpleName() : exception.getMessage();
    }
}
