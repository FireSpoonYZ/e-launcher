package com.example.launcherprobe;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/** Process-owned chat execution. Activities and Capacitor plugins are disposable observers. */
final class ChatCoordinator {
    interface Listener { void changed(List<AgentLoop.Message> messages, JSONObject event); }

    private static final String RPIV_TODO_PACKAGE = "@juicesharp/rpiv-todo";
    private static ChatCoordinator instance;
    static synchronized ChatCoordinator get(Context context) {
        if (instance == null) instance = new ChatCoordinator(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final ChatStore store;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<Listener> listeners = new CopyOnWriteArraySet<>();
    private final AtomicLong sequence = new AtomicLong();
    private final Object runLock = new Object();
    private final Map<String, SessionRun> activeRuns = new ConcurrentHashMap<>();
    private final Map<String, SessionRun> terminatingRuns = new ConcurrentHashMap<>();
    private final Map<String, RunResult> recentResults = new ConcurrentHashMap<>();

    private ChatCoordinator(Context context) {
        this.context = context;
        store = new ChatStore(context);
        // Persistent bots are never deleted merely because an archive expires.
        main.post(() -> BotManager.start(context));
    }

    ChatStore store() { return store; }
    boolean running() { return !activeRuns.isEmpty(); }
    boolean running(String conversationId) { return activeRuns.containsKey(conversationId); }
    boolean botBusy(String id) { return activeRuns.containsKey(id) || terminatingRuns.containsKey(id); }
    boolean acceptsBotCall(String id, String requestId) {
        SessionRun run = id == null ? null : activeRuns.get(id);
        return run != null && run.requestId.equals(requestId) && !run.cancellation.cancelled();
    }
    void botChanged(String id) { emit(id, null, "botChanged", null, new JSONObject()); }
    String sendBotInput(String id, String text, JSONObject origin, String requestId) throws Exception {
        if (!store.hasConversation(id)) throw new IllegalArgumentException("目标 Bot 已删除");
        return send(id, text, Collections.emptyList(), null, true, origin, requestId);
    }
    String requestId() {
        SessionRun run = activeRuns.get(store.activeId());
        return run == null ? null : run.requestId;
    }
    String conversationId() { return store.activeId(); }
    long sequence() { return sequence.get(); }
    void addListener(Listener listener) { listeners.add(listener); }
    void removeListener(Listener listener) { listeners.remove(listener); }

    String send(String text, String submissionId) throws Exception {
        String conversationId = store.activeId();
        return send(conversationId, text, store.draftAttachments(conversationId), submissionId);
    }

    String send(String conversationId, String text, String submissionId) throws Exception {
        return send(conversationId, text, store.draftAttachments(conversationId), submissionId);
    }

    /** A spoken request: never picks up the typed draft's attachments. */
    String sendVoice(String conversationId, String text) throws Exception {
        return send(conversationId, text, Collections.emptyList(), null, false);
    }

    /** Starts the fresh chat a spoken conversation gets, and tells every open UI to follow it. Any thread. */
    String startVoiceConversation() {
        store.newConversation();
        store.saveDraft("");
        store.saveDraftAttachments(Collections.emptyList());
        String id = store.activeId();
        emit(id, null, "conversationSwitched", null, new JSONObject());
        return id;
    }

    String sendScheduled(String conversationId, String title, String prompt) throws Exception {
        store.createBackgroundConversation(conversationId, title);
        return send(conversationId, prompt, Collections.emptyList(), null, true);
    }

    private String send(String conversationId, String text, List<ChatAttachment> attachments,
            String submissionId) throws Exception {
        return send(conversationId, text, attachments, submissionId, false);
    }

    private String send(String conversationId, String text, List<ChatAttachment> attachments,
            String submissionId, boolean background) throws Exception {
        return send(conversationId, text, attachments, submissionId, background, null, UUID.randomUUID().toString());
    }

    private String send(String conversationId, String text, List<ChatAttachment> attachments,
            String submissionId, boolean background, JSONObject origin, String plannedRequestId) throws Exception {
        String prompt = text == null ? "" : text.trim();
        if (prompt.isEmpty() && attachments.isEmpty()) throw new IllegalArgumentException("消息不能为空");
        AttachmentStore attachmentStore = new AttachmentStore(context);
        for (ChatAttachment attachment : attachments) attachmentStore.requireFile(attachment);
        SessionRun run = registerRun(conversationId, submissionId, background, plannedRequestId);
        if (run == null) return null;
        run.origin = origin;
        try {
            emit(run, "runStatus", null, json("status", "running", "message", run.message));
            startPi(run, prompt, new ArrayList<>(attachments));
            if (submissionId != null && !submissionId.isEmpty()) {
                context.getSharedPreferences("chat_submissions", Context.MODE_PRIVATE)
                        .edit().putString("session_" + conversationId, submissionId).apply();
            }
            return run.requestId;
        } catch (Exception exception) {
            endPersistence(run, "error", exception);
            finish(run, "error", detail(exception));
            throw exception;
        }
    }

    SessionRun registerRun(String conversationId, String submissionId) {
        return registerRun(conversationId, submissionId, false);
    }

    private SessionRun registerRun(String conversationId, String submissionId, boolean background) {
        return registerRun(conversationId, submissionId, background, UUID.randomUUID().toString());
    }

    private SessionRun registerRun(String conversationId, String submissionId, boolean background, String requestId) {
        SessionRun run = new SessionRun(conversationId, requestId);
        run.background = background;
        run.extensionUi = parseObject(store.extensionUi(conversationId, store.load(conversationId)));
        // Questions belong to one live request, unlike durable todo snapshots.
        run.extensionUi.remove("askUser");
        synchronized (runLock) {
            if (store.isArchived(conversationId)) throw new IllegalStateException("请先恢复此会话再发送");
            if (!background && !conversationId.equals(store.activeId())) throw new IllegalStateException("会话已切换");
            if (activeRuns.containsKey(conversationId)) throw new IllegalStateException("此会话已有一轮正在运行，请先停止");
            if (terminatingRuns.containsKey(conversationId)) throw new IllegalStateException("此会话的后台任务正在结束，请稍后重试");
            if (submissionId != null && !submissionId.isEmpty()) {
                android.content.SharedPreferences submissions = context.getSharedPreferences(
                        "chat_submissions", Context.MODE_PRIVATE);
                if (submissions.getBoolean(submissionId, false)
                        || submissionId.equals(submissions.getString("session_" + conversationId, null))) return null;
            }
            activeRuns.put(conversationId, run);
            try {
                ChatExecutionService.setActiveCount(context, activeRuns.size());
                store.showTaskCard(conversationId);
            } catch (RuntimeException failure) {
                activeRuns.remove(conversationId, run);
                try { ChatExecutionService.setActiveCount(context, activeRuns.size()); }
                catch (RuntimeException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
                throw failure;
            }
            recentResults.remove(conversationId);
            return run;
        }
    }

    void deleteConversation(String conversationId) {
        synchronized (runLock) {
            if (activeRuns.containsKey(conversationId) || terminatingRuns.containsKey(conversationId)) {
                throw new IllegalStateException("此会话正在运行或结束中，请稍后再删除");
            }
            try { BotManager.get(context).beforeDelete(conversationId); }
            catch (Exception error) { throw new IllegalStateException("无法取消此 Bot 的任务", error); }
            forgetConversationLocked(conversationId);
        }
        emit(conversationId, null, "conversationDeleted", null, new JSONObject());
    }

    public void archiveConversation(String id) {
        synchronized (runLock) {
            store.archive(id);
        }
        emit(id, null, "conversationArchived", null, new JSONObject());
    }

    public void restoreConversation(String id) {
        boolean restored;
        synchronized (runLock) {
            restored = store.isArchived(id);
            store.restore(id);
        }
        if (restored) emit(id, null, "conversationRestored", null, new JSONObject());
    }

    public void purgeExpiredArchives() {
        // Persistent bot identities never expire. Deletion is a manual user action.
    }

    private void forgetConversationLocked(String conversationId) {
        store.clear(conversationId);
        PiAgentBridge.forgetConversation(conversationId);
        recentResults.remove(conversationId);
    }

    void cancel(String conversationId) {
        SessionRun run;
        synchronized (runLock) {
            run = activeRuns.get(conversationId);
            if (run == null) return;
            run.cancellation.cancel();
            if (run.bridge != null) run.bridge.abort(run.requestId);
            run.status = "stopping";
            run.message = "正在停止…";
        }
        emit(run, "runStatus", null, json("status", run.status, "message", run.message));
    }

    void submitQuestionnaire(String conversationId, String requestId, String questionnaireId,
            JSONArray answers, Object globalNote) throws Exception {
        replyQuestionnaire(conversationId, requestId, questionnaireId,
                questionnaireResult(questionnaireState(conversationId, requestId, questionnaireId), answers, globalNote), false);
    }

    void cancelQuestionnaire(String conversationId, String requestId, String questionnaireId) throws Exception {
        questionnaireState(conversationId, requestId, questionnaireId);
        replyQuestionnaire(conversationId, requestId, questionnaireId, null, true);
    }

    private JSONObject questionnaireState(String conversationId, String requestId, String questionnaireId) {
        synchronized (runLock) {
            SessionRun run = activeRuns.get(conversationId);
            if (run == null || !run.requestId.equals(requestId) || run.bridge == null
                    || questionnaireId.equals(run.questionnaireReplyPending)) {
                throw new IllegalStateException("问卷请求已失效");
            }
            JSONObject askUser = run.extensionUi.optJSONObject("askUser");
            if (askUser == null || !questionnaireId.equals(askUser.optString("id"))) {
                throw new IllegalStateException("问卷请求已失效");
            }
            return askUser;
        }
    }

    private void replyQuestionnaire(String conversationId, String requestId, String questionnaireId,
            JSONObject result, boolean cancelled) throws Exception {
        synchronized (runLock) {
            SessionRun run = activeRuns.get(conversationId);
            JSONObject askUser = run == null ? null : run.extensionUi.optJSONObject("askUser");
            if (run == null || !run.requestId.equals(requestId) || run.bridge == null
                    || run.questionnaireReplyPending != null || askUser == null
                    || !questionnaireId.equals(askUser.optString("id"))) {
                throw new IllegalStateException("问卷请求已失效");
            }
            run.questionnaireReplyPending = questionnaireId;
            run.questionnaireError = "";
            try {
                run.bridge.replyQuestionnaire(requestId, conversationId, questionnaireId, result, cancelled);
                emit(run, "questionnairePending", null, json("questionnaireId", questionnaireId));
            } catch (Exception exception) {
                run.questionnaireReplyPending = null;
                throw exception;
            }
        }
    }

    static JSONObject questionnaireResult(JSONObject askUser, JSONArray submitted, Object globalNote)
            throws org.json.JSONException {
        JSONArray questions = askUser.optJSONArray("questions");
        if (questions == null || submitted == null) throw new IllegalArgumentException("问卷答案格式无效");
        Set<Integer> used = new java.util.HashSet<>();
        JSONArray answers = new JSONArray();
        for (int i = 0; i < submitted.length(); i++) {
            JSONObject candidate = submitted.optJSONObject(i);
            int questionIndex = candidate == null ? -1 : candidate.optInt("questionIndex", -1);
            if (questionIndex < 0 || questionIndex >= questions.length() || !used.add(questionIndex)) {
                throw new IllegalArgumentException("问卷题号无效或重复");
            }
            JSONObject question = questions.optJSONObject(questionIndex);
            JSONArray options = question == null ? null : question.optJSONArray("options");
            if (options == null) throw new IllegalArgumentException("问卷内容已失效");
            Set<String> labels = new java.util.HashSet<>();
            Map<String, String> previews = new java.util.HashMap<>();
            for (int optionIndex = 0; optionIndex < options.length(); optionIndex++) {
                JSONObject option = options.optJSONObject(optionIndex);
                if (option == null || !option.has("label")) throw new IllegalArgumentException("问卷内容已失效");
                String label = option.optString("label", null);
                labels.add(label);
                if (option.has("preview")) previews.put(label, option.optString("preview"));
            }
            String kind = candidate.optString("kind");
            JSONObject answer = new JSONObject().put("questionIndex", questionIndex)
                    .put("question", question.optString("question")).put("kind", kind);
            if ("option".equals(kind)) {
                Object selected = candidate.opt("answer");
                if (question.optBoolean("multiSelect") || !(selected instanceof String)
                        || !labels.contains(selected)) throw new IllegalArgumentException("问卷单选答案无效");
                answer.put("answer", selected);
                if (previews.containsKey(selected)) answer.put("preview", previews.get(selected));
            } else if ("multi".equals(kind)) {
                JSONArray selected = candidate.optJSONArray("selected");
                if (!question.optBoolean("multiSelect") || selected == null) {
                    throw new IllegalArgumentException("问卷多选答案无效");
                }
                Set<String> selectedLabels = new java.util.HashSet<>();
                JSONArray normalized = new JSONArray();
                for (int selectedIndex = 0; selectedIndex < selected.length(); selectedIndex++) {
                    Object label = selected.opt(selectedIndex);
                    if (!(label instanceof String) || !labels.contains(label) || !selectedLabels.add((String) label)) {
                        throw new IllegalArgumentException("问卷多选答案无效");
                    }
                    normalized.put(label);
                }
                answer.put("answer", JSONObject.NULL).put("selected", normalized);
            } else if ("custom".equals(kind)) {
                Object custom = candidate.opt("answer");
                if (custom != null && custom != JSONObject.NULL && !(custom instanceof String)) {
                    throw new IllegalArgumentException("问卷自定义答案无效");
                }
                answer.put("answer", custom == null ? JSONObject.NULL : custom);
            } else throw new IllegalArgumentException("问卷答案类型无效");
            String notes = trimmed(candidate.opt("notes"), "问卷备注必须是文本");
            if (notes != null) answer.put("notes", notes);
            answers.put(answer);
        }
        JSONObject result = new JSONObject().put("answers", answers);
        String note = trimmed(globalNote, "问卷备注必须是文本");
        if (note != null) result.put("globalNote", note);
        return result;
    }

    private static String trimmed(Object value, String error) {
        if (value == null || value == JSONObject.NULL) return null;
        if (!(value instanceof String)) throw new IllegalArgumentException(error);
        String trimmed = ((String) value).trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
    /** Same recent-activity order as chat history, excluding unsent drafts. */
    JSONArray taskCards() {
        JSONArray cards = new JSONArray();
        for (ChatStore.Conversation conversation : store.conversations()) {
            if (store.load(conversation.id).isEmpty()) continue;
            cards.put(taskCard(conversation.id));
            if (cards.length() == 5) break;
        }
        return cards;
    }

    /** Detail lookup is not limited to the desktop's five-card window. */
    JSONObject taskCard(String conversationId) {
        ChatStore.Conversation conversation = null;
        for (ChatStore.Conversation candidate : store.conversations())
            if (candidate.id.equals(conversationId)) { conversation = candidate; break; }
        if (conversation == null) return null;
        SessionRun active = activeRuns.get(conversationId);
        SessionRun ending = terminatingRuns.get(conversationId);
        List<AgentLoop.Message> history = store.load(conversationId);
        JSONObject extensionUi = active != null ? active.extensionUi : ending != null ? ending.extensionUi
                : parseObject(store.extensionUi(conversationId, history));
        JSONObject todo = todoSnapshot(extensionUi);
        String modelState = ending != null ? "stopping" : active == null ? "idle"
                : "stopping".equals(active.status) ? "stopping" : "working";
        JSONObject askUser = "working".equals(modelState) ? active.extensionUi.optJSONObject("askUser") : null;
        RunResult result = recentResults.get(conversationId);
        String response = "";
        for (int i = history.size() - 1; i >= 0; i--) {
            AgentLoop.Message message = history.get(i);
            if ("assistant".equals(message.role) && message.content != null && !message.content.isEmpty()) {
                response = message.content; break;
            }
        }
        return json("conversationId", conversationId, "title", conversation.title,
                "modelState", modelState, "todo", todo == null ? JSONObject.NULL : todo,
                "askUser", askUser == null ? JSONObject.NULL : askUser,
                "requestId", active == null ? JSONObject.NULL : active.requestId,
                "questionnairePending", askUser != null && active.questionnaireReplyPending != null,
                "questionnaireError", askUser == null ? "" : active.questionnaireError,
                "result", response, "updated", conversation.updated,
                "created", store.createdAt(conversationId),
                "runStatus", result == null ? context.getSharedPreferences("chat", Context.MODE_PRIVATE)
                        .getString("run_status_" + conversationId, "") : result.status,
                "error", result == null ? context.getSharedPreferences("chat", Context.MODE_PRIVATE)
                        .getString("run_error_" + conversationId, "") : result.error);
    }

    /** Hides the card without cancelling its run or deleting its conversation. */
    void dismissTaskCard(String conversationId) { store.dismissTaskCard(conversationId); }

    private void startPi(SessionRun run, String text, List<ChatAttachment> attachments) throws Exception {
        store.ensureBotSession(run.conversationId);
        PiConfigStore configStore = new PiConfigStore(context, run.conversationId);
        configStore.initialize(context.getSharedPreferences("chat", Context.MODE_PRIVATE));
        String config = new JSONObject(configStore.snapshot())
                .put("botProfile", store.botProfile(run.conversationId))
                .put("selection", new JSONObject(store.piSelection(run.conversationId)))
                .put("chatAttachmentRoot", new java.io.File(context.getFilesDir(), "chat-attachments").getAbsolutePath())
                .toString();
        List<AgentLoop.Message> full = new ArrayList<>(store.load(run.conversationId));
        String sdkHistory = store.piResume(run.conversationId, full);
        List<AgentLoop.Message> prior = new ArrayList<>(full);
        String inputId = run.origin == null ? UUID.randomUUID().toString() : run.origin.getString("id");
        if (run.origin != null) store.saveBotOrigin(run.conversationId, inputId, run.origin);
        AgentLoop.Message user = new AgentLoop.Message(inputId, "user", text, null,
                Collections.emptyList(), false, attachments);
        full.add(user);
        store.save(run.conversationId, full);
        if (!run.background) {
            store.saveDraft(run.conversationId, "");
            store.saveDraftAttachments(run.conversationId, Collections.emptyList());
        }
        run.assistantId = UUID.randomUUID().toString();
        List<AgentLoop.Message> work = new ArrayList<>(prior);
        work.add(user);
        run.persistence = new PiTurnPersistence(store, run.conversationId, user.id, run.assistantId, work);
        emit(run, "snapshot", user.id, new JSONObject());
        executor.execute(() -> {
            try {
                PiAgentBridge bridge = PiAgentBridge.get(context);
                synchronized (runLock) {
                    if (!ownsRun(run) || run.cancellation.cancelled()) throw new InterruptedException("pi 启动已取消");
                    run.bridge = bridge;
                    bridge.prompt(run.requestId, run.conversationId, config, text, attachments, sdkHistory,
                            prior, configStore, event -> main.post(() -> {
                                if (ownsRun(run)) onPiEvent(event, run);
                                else if (terminatingRuns.get(run.conversationId) == run) {
                                    onTerminatingPiEvent(event, run);
                                }
                            }));
                    run.nodeRegistered = true;
                }
            } catch (Throwable exception) {
                endPersistence(run, run.cancellation.cancelled() ? "aborted" : "error", exception);
                if (ownsRun(run)) finish(run, run.cancellation.cancelled() ? "aborted" : "error",
                        detail(exception));
                else acknowledgeTermination(run);
            }
        });
    }

    void foregroundServiceTimedOut() {
        final String message = "Android 已停止超时的后台任务；返回应用后可重新发送";
        List<SessionRun> interrupted;
        synchronized (runLock) {
            interrupted = new ArrayList<>(activeRuns.values());
            for (SessionRun run : interrupted) {
                run.cancellation.cancel();
                if (run.nodeRegistered) {
                    if (run.persistence != null) run.persistence.savePreview();
                    terminatingRuns.put(run.conversationId, run);
                } else {
                    endPersistence(run, "aborted", new InterruptedException(message));
                }
                if (run.persistence != null) main.removeCallbacksAndMessages(run.persistence);
                synchronized (run.pendingDelta) { run.pendingDelta.setLength(0); }
                activeRuns.remove(run.conversationId, run);
                run.status = "aborted";
                run.message = "";
                run.error = message;
                recentResults.put(run.conversationId, new RunResult(run.status, run.error));
            }
            ChatExecutionService.setActiveCount(context, 0);
        }
        for (SessionRun run : interrupted) {
            emit(run, "error", null, json("message", message));
            emit(run, "end", null, json("status", "aborted", "finishedRequestId", run.requestId));
            synchronized (runLock) {
                run.timeoutFinalized = true;
                if (run.terminationAcknowledged) terminatingRuns.remove(run.conversationId, run);
            }
            if (run.nodeRegistered && run.bridge != null) run.bridge.abort(run.requestId);
        }
    }

    void onTerminatingPiEvent(JSONObject event, SessionRun run) {
        if (terminatingRuns.get(run.conversationId) != run) return;
        Exception persistenceFailure = null;
        try { run.persistence.accept(event); }
        catch (Exception exception) {
            persistenceFailure = exception;
            run.error = "Pi 会话未保存：" + detail(exception);
            recentResults.put(run.conversationId, new RunResult("error", run.error));
        }
        if (persistenceFailure != null) emit(run, "error", null, json("message", run.error));
        if ("end".equals(event.optString("type"))) acknowledgeTermination(run);
    }

    private void acknowledgeTermination(SessionRun run) {
        synchronized (runLock) {
            run.terminationAcknowledged = true;
            if (run.timeoutFinalized) terminatingRuns.remove(run.conversationId, run);
        }
        BotManager.start(context);
        maybePurgeExpiredArchives(run.conversationId);
    }

    void onPiEvent(JSONObject event, SessionRun run) {
        if (!ownsRun(run)) return;
        String type = event.optString("type");
        JSONObject message = event.optJSONObject("message");
        if ("message".equals(type) && message != null && "assistant".equals(message.optString("role"))) {
            main.removeCallbacksAndMessages(run.persistence);
            synchronized (run.pendingDelta) { run.pendingDelta.setLength(0); }
        }
        Exception persistenceFailure = null;
        try { run.persistence.accept(event); }
        catch (Exception exception) {
            persistenceFailure = exception;
            run.error = "Pi 会话未保存：" + detail(exception);
            emit(run, "error", null, json("message", run.error));
        }
        if ("text_delta".equals(type)) {
            synchronized (run.pendingDelta) { run.pendingDelta.append(event.optString("delta")); }
            flushPiDelta(false, run);
        } else if ("message".equals(type)) emit(run, "snapshot", null, event);
        else if ("extension_ui".equals(type) && persistenceFailure == null) {
            JSONObject previousQuestion = run.extensionUi.optJSONObject("askUser");
            run.extensionUi = parseObject(event.optJSONObject("state").toString());
            JSONObject askUser = run.extensionUi.optJSONObject("askUser");
            if (askUser == null || previousQuestion == null
                    || !askUser.optString("id").equals(previousQuestion.optString("id"))) {
                run.questionnaireError = "";
            }
            if (run.questionnaireReplyPending != null
                    && (askUser == null || !run.questionnaireReplyPending.equals(askUser.optString("id")))) {
                run.questionnaireReplyPending = null;
            }
            emit(run, "extensionUi", null, run.extensionUi);
        } else if ("tool_start".equals(type)) emit(run, "toolStart", null, event);
        else if ("tool_end".equals(type)) emit(run, "toolEnd", null, event);
        else if ("status".equals(type)) {
            run.status = "running";
            run.message = event.optString("message", "正在回复…");
            emit(run, "runStatus", null, event);
        } else if ("questionnaire_reply".equals(type)) {
            String questionnaireId = event.optString("questionnaireId");
            if (questionnaireId.equals(run.questionnaireReplyPending) && !event.optBoolean("accepted")) {
                run.questionnaireReplyPending = null;
                run.questionnaireError = event.optString("message", "回答未被接受，请重试");
            }
            emit(run, "questionnaireReply", null, event);
        } else if ("error".equals(type)) {
            run.error = event.optString("message");
            emit(run, "error", null, event);
        } else if ("end".equals(type)) {
            flushPiDelta(true, run);
            String status = persistenceFailure == null ? event.optString("status", "completed") : "error";
            finish(run, status, persistenceFailure == null ? "" : run.error);
        }
    }

    private void flushPiDelta(boolean immediate, SessionRun run) {
        long delay = Math.max(0, 40 - (System.currentTimeMillis() - run.lastDeltaFlush));
        Runnable flush = () -> {
            if (!ownsRun(run)) return;
            final String delta;
            synchronized (run.pendingDelta) {
                if (run.pendingDelta.length() == 0) return;
                delta = run.pendingDelta.toString();
                run.pendingDelta.setLength(0);
            }
            run.lastDeltaFlush = System.currentTimeMillis();
            AgentLoop.Message assistant = run.persistence.savePreview();
            if (assistant != null) emit(run, "textDelta", assistant.id, json("delta", delta));
        };
        if (immediate) {
            main.removeCallbacksAndMessages(run.persistence);
            flush.run();
        } else {
            main.postAtTime(flush, run.persistence, android.os.SystemClock.uptimeMillis() + delay);
        }
    }

    private void endPersistence(SessionRun run, String status, Throwable original) {
        PiTurnPersistence persistence = run.persistence;
        if (persistence == null) return;
        try { persistence.accept(new JSONObject().put("type", "end").put("status", status)); }
        catch (Exception saving) { original.addSuppressed(saving); }
    }

    private boolean ownsRun(SessionRun run) {
        return activeRuns.get(run.conversationId) == run;
    }

    void finish(SessionRun run, String status, String error) {
        synchronized (runLock) {
            if (!ownsRun(run)) return;
            if (error != null && !error.isEmpty()) run.error = error;
            run.status = status;
            run.message = "";
            if (run.persistence != null) main.removeCallbacksAndMessages(run.persistence);
            synchronized (run.pendingDelta) { run.pendingDelta.setLength(0); }
            activeRuns.remove(run.conversationId, run);
            recentResults.put(run.conversationId, new RunResult(status, run.error));
            context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit()
                    .putString("run_status_" + run.conversationId, status)
                    .putString("run_error_" + run.conversationId, run.error).apply();
            ChatExecutionService.setActiveCount(context, activeRuns.size());
        }
        if (error != null && !error.isEmpty()) emit(run, "error", null, json("message", error));
        emit(run, "end", null, json("status", status, "finishedRequestId", run.requestId));
        maybePurgeExpiredArchives(run.conversationId);
    }

    private void maybePurgeExpiredArchives(String conversationId) {
        if (store.isArchived(conversationId)) executor.execute(this::purgeExpiredArchives);
    }

    JSONObject snapshot() {
        String activeId = store.activeId();
        SessionRun current;
        RunResult recent;
        List<SessionRun> runs;
        synchronized (runLock) {
            current = activeRuns.get(activeId);
            recent = recentResults.get(activeId);
            runs = new ArrayList<>(activeRuns.values());
        }
        runs.sort(Comparator.comparing(value -> value.conversationId));
        JSONArray active = new JSONArray();
        for (SessionRun run : runs) active.put(json("conversationId", run.conversationId,
                "requestId", run.requestId, "status", run.status, "message", run.message));
        JSONObject extensionUi = current == null
                ? parseObject(store.extensionUi(activeId, store.load(activeId))) : current.extensionUi;
        return json("sequence", sequence.get(), "running", current != null,
                "requestId", current == null ? JSONObject.NULL : current.requestId,
                "conversationId", activeId, "conversation", NativeJson.conversation(store, activeId),
                "activeRuns", active, "extensionUi", extensionUi,
                "error", current != null ? current.error : recent == null ? "" : recent.error,
                "status", current != null ? current.message : recent == null ? "" : recent.status);
    }

    private void emit(SessionRun run, String type, String nodeId, JSONObject payload) {
        emit(run.conversationId, run.requestId, type, nodeId, payload);
    }

    private void emit(String conversationId, String requestId, String type, String nodeId, JSONObject payload) {
        JSONObject event = json("sequence", sequence.incrementAndGet(), "type", type,
                "conversationId", conversationId,
                "requestId", requestId == null ? JSONObject.NULL : requestId,
                "nodeId", nodeId == null ? JSONObject.NULL : nodeId, "payload", payload);
        List<AgentLoop.Message> messages = Collections.unmodifiableList(
                new ArrayList<>(store.load(conversationId)));
        main.post(() -> { for (Listener listener : listeners) listener.changed(messages, event); });
    }

    static final class SessionRun {
        final String conversationId;
        final String requestId;
        final AgentLoop.CancelToken cancellation = new AgentLoop.CancelToken();
        final StringBuilder pendingDelta = new StringBuilder();
        volatile PiAgentBridge bridge;
        volatile PiTurnPersistence persistence;
        volatile String assistantId;
        volatile String error = "";
        volatile String status = "running";
        volatile JSONObject extensionUi = new JSONObject();
        volatile String message = "正在启动…";
        volatile long lastDeltaFlush;
        volatile String questionnaireReplyPending;
        volatile String questionnaireError = "";
        boolean background;
        JSONObject origin;
        boolean nodeRegistered;
        boolean terminationAcknowledged;
        boolean timeoutFinalized;

        SessionRun(String conversationId, String requestId) {
            this.conversationId = conversationId;
            this.requestId = requestId;
        }
    }

    private static final class RunResult {
        final String status;
        final String error;
        RunResult(String status, String error) { this.status = status; this.error = error; }
    }

    private static JSONObject parseObject(String value) {
        try { return new JSONObject(value); }
        catch (org.json.JSONException exception) { return new JSONObject(); }
    }

    private static JSONObject todoSnapshot(JSONObject extensionUi) {
        JSONObject source = extensionUi == null ? null : extensionUi.optJSONObject("todo");
        if (source == null || !RPIV_TODO_PACKAGE.equals(source.optString("package"))) return null;
        JSONArray sourceTasks = source.optJSONArray("tasks");
        Long nextId = positiveInteger(source.opt("nextId"));
        if (sourceTasks == null || nextId == null) return null;
        Set<Long> ids = new HashSet<>();
        JSONArray tasks = new JSONArray();
        for (int index = 0; index < sourceTasks.length(); index++) {
            JSONObject task = sourceTasks.optJSONObject(index);
            if (task == null) return null;
            Long id = positiveInteger(task.opt("id"));
            Object subject = task.opt("subject");
            String status = task.optString("status", "");
            if (id == null || id >= nextId || !ids.add(id) || !(subject instanceof String)
                    || !("pending".equals(status) || "in_progress".equals(status)
                    || "completed".equals(status) || "deleted".equals(status))) return null;
            tasks.put(json("id", id, "subject", subject, "status", status));
        }
        return json("package", RPIV_TODO_PACKAGE, "tasks", tasks, "nextId", nextId);
    }

    private static Long positiveInteger(Object value) {
        if (!(value instanceof Byte || value instanceof Short
                || value instanceof Integer || value instanceof Long)) return null;
        long integer = ((Number) value).longValue();
        return integer >= 1 && integer <= 9_007_199_254_740_991L ? integer : null;
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
