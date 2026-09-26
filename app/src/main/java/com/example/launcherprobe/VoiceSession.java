package com.example.launcherprobe;

import android.content.Context;
import android.graphics.Color;
import android.content.res.ColorStateList;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.widget.ImageButton;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A spoken conversation that keeps running until the user closes it: the microphone stays open, each finished
 * utterance is transcribed and sent, and the reply is read aloud sentence by sentence while it is still being
 * written. Talking over the reply stops it and starts the next turn.
 *
 * <p>The conversation itself is created lazily, on the first utterance that actually transcribes, so a wake word
 * followed by silence leaves no empty chat behind. Everything here runs on the main thread except the transcription
 * and send calls, which are handed to a single background executor.
 */
final class VoiceSession implements VoiceStream.Listener {
    /** The window showing this session: the full-screen activity, or the assistant session over another app. */
    interface Host {
        Context context();
        /** Dismiss the window; the session has already released everything. */
        void closed();
    }

    private enum State { GREETING, LISTENING, TRANSCRIBING, THINKING, SPEAKING }

    private final Host host;
    private final Context context;
    private final ChatCoordinator coordinator;
    private final VoiceSettings settings;
    private final SpeechOutput output;
    private final VoiceStream stream = new VoiceStream(this);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ChatCoordinator.Listener chatListener = this::onChatEvent;
    private final StringBuilder reply = new StringBuilder();
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    private View view;
    private VoiceOrbView orb;
    private TextView statusLabel, transcriptLabel, titleLabel;
    private ScrollView transcriptScroll;

    private SpeechInput systemInput;
    private boolean remoteInput;
    private State state = State.GREETING;
    private String conversationId;
    private volatile String ownedRequestId;
    private boolean sending;
    private final String emptyChatEntry;
    private String pendingText;
    private int spoken;
    private boolean streaming, closed, interrupted;
    private Questionnaire questionnaire;
    private int inputGeneration;

    private static final class Questionnaire {
        final String requestId, id;
        final JSONArray questions, answers = new JSONArray();
        int index;
        boolean pending;

        Questionnaire(String requestId, JSONObject prompt) {
            this.requestId = requestId;
            id = prompt.optString("id");
            questions = prompt.optJSONArray("questions");
        }
    }

    VoiceSession(Host host, SpeechOutput output) { this(host, output, null); }

    VoiceSession(Host host, SpeechOutput output, String conversationId) {
        this.conversationId = conversationId;
        this.host = host;
        this.context = host.context();
        this.output = output;
        coordinator = ChatCoordinator.get(context);
        emptyChatEntry = context instanceof VoiceSessionActivity && conversationId != null
                && conversationId.equals(coordinator.conversationId())
                && !coordinator.store().isArchived(conversationId)
                && coordinator.store().conversations().stream().noneMatch(item -> item.id.equals(conversationId))
                ? conversationId : null;
        settings = new VoiceSettings(context);
        remoteInput = VoiceSettings.REMOTE.equals(settings.sttEngine());
    }

    /** Both recognition engines share this page; only remote STT supports hands-free interruption. */
    static boolean supported(Context context) {
        VoiceSettings settings = new VoiceSettings(context);
        return VoiceSettings.REMOTE.equals(settings.sttEngine())
                ? settings.remote(VoiceSettings.STT).configured() : SpeechInput.systemAvailable(context);
    }

    /** Blur the windows behind us, not the letter or the controls. */
    static void applyGlass(android.view.Window window) {
        window.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0x55131B2A));
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            window.setBackgroundBlurRadius(90);
            android.view.WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.flags |= android.view.WindowManager.LayoutParams.FLAG_BLUR_BEHIND;
            attributes.setBlurBehindRadius(90);
            window.setAttributes(attributes);
        }
        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);
    }

    View view() {
        if (view == null) view = build();
        return view;
    }

    /** Only a wake word gets the greeting; the system assist gesture starts listening immediately. */
    void start(boolean fromWake) {
        coordinator.addListener(chatListener);
        output.setPlaybackListener((active, level) -> {
            if (!closed && orb != null && state == State.SPEAKING) orb.setLevel(active ? level : 0);
        });
        // Do not capture the greeting as the user's first instruction.
        stream.setMuted(true);
        if (remoteInput) stream.start();
        if (!fromWake) { greetingFinished(); return; }
        setState(State.GREETING, UiText.get(context, "我在"));
        output.speakGreeting(this::greetingFinished);
    }

    private void greetingFinished() {
        if (closed) return;
        stream.setMuted(false);
        listen();
    }

    void close() {
        if (closed) return;
        closed = true;
        coordinator.removeListener(chatListener);
        stream.stop();
        pauseInput();
        questionnaire = null;
        main.removeCallbacksAndMessages(null);
        output.setPlaybackListener(null);
        output.stop();
        worker.shutdownNow();
        VoiceManager.get(context).sessionClosed(this);
        host.closed();
    }

    // VoiceStream.Listener, all on the main thread.

    @Override public void onLevel(float level) {
        if (!closed && orb != null && state == State.LISTENING) orb.setLevel(level);
    }

    @Override public void onSpeechActivity(boolean speaking) {
        if (!closed && orb != null) orb.setUserSpeaking(state == State.LISTENING && speaking);
    }

    @Override public void onSpeechStart() {
        if (closed || state == State.GREETING) return;
        if (questionnaire != null) {
            // The system recognizer's interrupt button may skip reading, but must keep the tool waiting.
            if (!remoteInput && state == State.SPEAKING && !questionnaire.pending) {
                pauseInput();
                output.stop();
                stream.setPlaying(false);
                listen();
            }
            return;
        }
        if (state == State.SPEAKING || state == State.THINKING) {
            interrupted = true;
            // Interrupting: silence the reply now and let the rest of this utterance become the next turn.
            output.stop();
            stream.setPlaying(false);
            streaming = false;
            listen();
        }
    }

    @Override public void onUtterance(byte[] wav) {
        if (closed || state == State.GREETING || state == State.TRANSCRIBING) return;
        if (questionnaire != null && (questionnaire.pending || state != State.LISTENING)) return;
        int generation = inputGeneration;
        if (questionnaire != null) stream.setMuted(true);
        setState(State.TRANSCRIBING, UiText.get(context, "正在识别…"));
        VoiceSettings.Remote remote = settings.remote(VoiceSettings.STT);
        String language = settings.language();
        worker.execute(() -> {
            String text, failure = null;
            try { text = RemoteVoiceApi.transcription(RemoteVoiceApi.transcribeCall(remote, wav, language)); }
            catch (Exception error) {
                text = "";
                failure = error.getMessage() == null ? UiText.get(context, "远程语音识别失败") : error.getMessage();
            }
            String heard = text.trim();
            String problem = failure;
            post(() -> {
                if (generation != inputGeneration) return;
                if (!heard.isEmpty()) submit(heard);
                else listen(problem);
            });
        });
    }

    @Override public void onIdle() {
        // Silence never ends voice mode; only the user closes it.
    }

    @Override public void onError(String message) {
        if (closed) return;
        if (questionnaire != null) statusLabel.setText(UiText.get(context, message));
        else setState(State.LISTENING, UiText.get(context, message));
    }

    // Turn handling.

    private void submit(String text) {
        if (closed) return;
        if (text == null || text.trim().isEmpty()) { listen(); return; }
        text = text.trim();
        if (sending) { listen(busyMessage()); return; }
        if (conversationId != null) {
            try { coordinator.voiceConversationTitle(conversationId); }
            catch (RuntimeException failure) { listen(failure.getMessage()); return; }
        }
        if (questionnaire != null) {
            answerQuestion(text);
            return;
        }
        transcriptLabel.setText(text);
        scrollTranscript();
        setState(State.THINKING, UiText.get(context, "正在思考…"));
        if (conversationId != null && coordinator.running(conversationId)) {
            // One run per conversation, so an interrupted turn has to end before the new one can start.
            pendingText = text;
            if (!coordinator.cancelVoice(conversationId, ownedRequestId)) {
                pendingText = null;
                listen(busyMessage());
            }
            return;
        }
        send(text);
    }

    private void send(String text) {
        interrupted = false;
        reply.setLength(0);
        spoken = 0;
        if (conversationId == null) conversationId = coordinator.startVoiceConversation();
        updateTitle();
        String target = conversationId;
        sending = true;
        worker.execute(() -> deliver(target, text));
    }

    private void deliver(String target, String text) {
        try { coordinator.sendVoice(target, text, requestId -> ownedRequestId = requestId); }
        catch (Exception failure) {
            String message = failure.getMessage() == null ? UiText.get(context, "发送失败") : failure.getMessage();
            post(() -> listen(message));
        } finally { post(() -> sending = false); }
    }

    private String busyMessage() {
        return UiText.isEnglish(context) ? "This conversation is busy. Wait or continue in text chat." : "此会话正在运行，请等待或转文字聊天";
    }

    private void updateTitle() {
        if (titleLabel == null) return;
        try { titleLabel.setText(conversationId == null
                ? (UiText.isEnglish(context) ? "New topic" : "新话题")
                : coordinator.voiceConversationTitle(conversationId)); }
        catch (RuntimeException failure) { titleLabel.setText(failure.getMessage()); }
    }

    void newTopic() {
        if (sending || (conversationId != null && coordinator.running(conversationId))) {
            statusLabel.setText(busyMessage());
            return;
        }
        pauseInput();
        output.stop();
        stream.setPlaying(false);
        questionnaire = null;
        pendingText = null;
        ownedRequestId = null;
        conversationId = null;
        streaming = interrupted = false;
        reply.setLength(0);
        spoken = 0;
        transcriptLabel.setText("");
        updateTitle();
        listen();
    }

    void openTextChat() {
        if (sending) { statusLabel.setText(busyMessage()); return; }
        // Return to the originating composer: an unsaved chat has no selectable history-list entry.
        if (conversationId != null && conversationId.equals(emptyChatEntry)
                && conversationId.equals(coordinator.conversationId())
                && coordinator.store().conversations().stream().noneMatch(item -> item.id.equals(conversationId))) {
            close();
            return;
        }
        // The assistant entry resolves archived/deleted targets explicitly; never substitute the active chat.
        android.content.Intent intent = new android.content.Intent(context, MainActivity.class)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK | android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, conversationId == null ? "" : conversationId);
        context.startActivity(intent);
        close();
    }

    private void onChatEvent(List<AgentLoop.Message> messages, JSONObject event) {
        if (closed || conversationId == null || !conversationId.equals(event.optString("conversationId"))) return;
        updateTitle();
        if (ownedRequestId == null || !ownedRequestId.equals(event.optString("requestId"))) return;
        JSONObject payload = event.optJSONObject("payload");
        switch (event.optString("type")) {
            case "textDelta":
                // Deltas from a turn the user already interrupted must not leak into the next answer.
                if (interrupted || pendingText != null || questionnaire != null) break;
                reply.append(payload == null ? "" : payload.optString("delta"));
                flushSpeech(false);
                break;
            case "toolStart":
                if (questionnaire == null) setState(State.THINKING, UiText.get(context, "正在使用工具…"));
                break;
            case "runStatus":
                if (questionnaire == null && state == State.THINKING && payload != null && !payload.optString("message").isEmpty())
                    statusLabel.setText(payload.optString("message"));
                break;
            case "extensionUi":
                updateQuestionnaire(event.optString("requestId"), payload == null ? null : payload.optJSONObject("askUser"));
                break;
            case "questionnairePending":
                if (matchesQuestionnaire(event, payload)) waitForQuestionnaire();
                break;
            case "questionnaireReply":
                if (matchesQuestionnaire(event, payload) && !payload.optBoolean("accepted"))
                    retryQuestion(payload.optString("message", UiText.get(context, "回答未被接受，请重试")));
                break;
            case "end":
                clearQuestionnaire();
                flushSpeech(true);
                if (pendingText != null) { String next = pendingText; pendingText = null; send(next); }
                else if (!streaming) listen();
                else output.endStream();
                break;
            case "error":
                if (payload != null && !payload.optString("message").isEmpty())
                    statusLabel.setText(payload.optString("message"));
                break;
            default:
                break;
        }
    }

    // A questionnaire owns the microphone until the original tool receives its answers.

    private void updateQuestionnaire(String requestId, JSONObject prompt) {
        if (questionnaire != null && questionnaire.requestId.equals(requestId)
                && prompt != null && questionnaire.id.equals(prompt.optString("id"))) return;
        clearQuestionnaire();
        if (prompt == null || interrupted || pendingText != null) return;
        questionnaire = new Questionnaire(requestId, prompt);
        reply.setLength(0);
        spoken = 0;
        readQuestion();
    }

    private boolean matchesQuestionnaire(JSONObject event, JSONObject payload) {
        return questionnaire != null && payload != null
                && questionnaire.requestId.equals(event.optString("requestId"))
                && questionnaire.id.equals(payload.optString("questionnaireId"));
    }

    private void readQuestion() {
        Questionnaire current = questionnaire;
        pauseInput();
        int generation = inputGeneration;
        streaming = false;
        JSONObject question = current.questions.optJSONObject(current.index);
        StringBuilder text = new StringBuilder(question.optString("question"));
        JSONArray options = question.optJSONArray("options");
        for (int i = 0; i < options.length(); i++)
            text.append('\n').append(i + 1).append("：").append(options.optJSONObject(i).optString("label")).append('。');
        transcriptLabel.setText(SpeechText.plain(text.toString()));
        scrollTranscript();
        setState(State.SPEAKING, (current.index + 1) + " / " + current.questions.length()
                + " · " + UiText.get(context, "正在提问…"));
        // Muting while reading prevents the question itself from becoming an answer on speakerphone.
        output.beginStream(() -> {
            if (closed || generation != inputGeneration) return;
            stream.setPlaying(false);
            listen();
        });
        stream.setPlaying(true);
        output.offer(text.toString());
        output.endStream();
    }

    private void answerQuestion(String text) {
        Questionnaire current = questionnaire;
        if (current.pending) return;
        transcriptLabel.setText(text);
        scrollTranscript();
        try {
            current.answers.put(current.index, new JSONObject().put("questionIndex", current.index)
                    .put("kind", "custom").put("answer", text));
            if (++current.index < current.questions.length()) {
                readQuestion();
                return;
            }
            waitForQuestionnaire();
            coordinator.submitQuestionnaire(conversationId, current.requestId, current.id, current.answers, null);
        } catch (Exception failure) {
            retryQuestion(failure.getMessage() == null ? UiText.get(context, "发送失败") : failure.getMessage());
        }
    }

    private void waitForQuestionnaire() {
        questionnaire.pending = true;
        pauseInput();
        output.stop();
        stream.setPlaying(false);
        setState(State.THINKING, UiText.get(context, "正在提交回答…"));
    }

    private void retryQuestion(String message) {
        questionnaire.pending = false;
        questionnaire.index = Math.min(questionnaire.index, questionnaire.questions.length() - 1);
        readQuestion();
        statusLabel.setText(message);
    }

    private void clearQuestionnaire() {
        if (questionnaire == null) return;
        questionnaire = null;
        pauseInput();
        output.stop();
        stream.setPlaying(false);
        stream.setMuted(false);
        setState(State.THINKING, UiText.get(context, "正在思考…"));
    }

    /** Invalidates in-flight transcription and delayed system-recognizer retries when their question ends. */
    private void pauseInput() {
        inputGeneration++;
        stream.setMuted(true);
        if (systemInput != null) { systemInput.cancel(); systemInput = null; }
    }

    /** Hands whole sentences to the reader as they appear, so speaking starts long before the turn finishes. */
    private void flushSpeech(boolean finishing) {
        if (interrupted || pendingText != null) return;
        String text = reply.toString();
        int upto = finishing ? text.length() : SpeechText.lastBoundary(text);
        if (upto <= spoken) return;
        String next = text.substring(spoken, upto);
        spoken = upto;
        if (next.trim().isEmpty()) return;
        if (!streaming) {
            streaming = true;
            setState(State.SPEAKING, UiText.get(context, "正在回答…"));
            output.beginStream(() -> { streaming = false; stream.setPlaying(false); listen(); });
            stream.setPlaying(true);
        }
        output.offer(next);
        transcriptLabel.setText(SpeechText.plain(text));
        scrollTranscript();
    }

    private void listen() { listen(null); }

    private void listen(String problem) {
        if (closed || (questionnaire != null && questionnaire.pending)) return;
        stream.setMuted(false);
        String status = UiText.get(context, "正在聆听…");
        if (questionnaire != null) status = (questionnaire.index + 1) + " / " + questionnaire.questions.length() + " · " + status;
        setState(State.LISTENING, problem != null ? problem : status);
        if (!remoteInput && systemInput == null) {
            int generation = inputGeneration;
            systemInput = new SpeechInput.SystemInput(context, settings.language());
            systemInput.start(new SpeechInput.Listener() {
                @Override public void onLevel(float level) { VoiceSession.this.onLevel(level); }
                @Override public void onSpeechActivity(boolean speaking) { VoiceSession.this.onSpeechActivity(speaking); }
                @Override public void onPartial(String text) {
                    if (!closed && generation == inputGeneration) transcriptLabel.setText(text);
                }
                @Override public void onProcessing() {
                    if (!closed && generation == inputGeneration) setState(State.TRANSCRIBING, UiText.get(context, "正在识别…"));
                }
                @Override public void onResult(String text) {
                    if (closed || generation != inputGeneration) return;
                    systemInput = null;
                    submit(text);
                }
                @Override public void onError(String error) {
                    if (closed || generation != inputGeneration) return;
                    systemInput = null;
                    if (!closed) main.postDelayed(() -> {
                        if (generation == inputGeneration) listen(error);
                    }, 1000);
                }
            });
        }
    }

    private void setState(State next, String status) {
        state = next;
        if (statusLabel != null) statusLabel.setText(status);
        if (orb == null) return;
        if (next == State.SPEAKING || next == State.GREETING) orb.setState(VoiceOrbView.State.SPEAKING);
        else if (next == State.THINKING || next == State.TRANSCRIBING) orb.setState(VoiceOrbView.State.THINKING);
        else orb.setState(VoiceOrbView.State.LISTENING);
    }

    private void post(Runnable action) {
        main.post(() -> { if (!closed) action.run(); });
    }

    private void scrollTranscript() {
        transcriptScroll.post(() -> transcriptScroll.fullScroll(View.FOCUS_DOWN));
    }

    private View build() {
        float density = context.getResources().getDisplayMetrics().density;
        int pad = Math.round(24 * density);
        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.TRANSPARENT);
        root.setPadding(pad, Math.round(20 * density), pad, Math.round(16 * density));
        root.setClickable(true);
        root.setFitsSystemWindows(true);

        titleLabel = new TextView(context);
        titleLabel.setTextSize(20);
        titleLabel.setTextColor(Color.WHITE);
        titleLabel.setGravity(Gravity.CENTER);
        titleLabel.setMaxLines(2);
        root.addView(titleLabel, new LinearLayout.LayoutParams(-1, -2));
        updateTitle();

        statusLabel = new TextView(context);
        statusLabel.setTextSize(14);
        statusLabel.setTextColor(Color.WHITE);
        statusLabel.setShadowLayer(2 * density, 0, density, 0xCC101722);
        statusLabel.setGravity(Gravity.CENTER);
        statusLabel.setMaxLines(2);
        statusLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        orb = new VoiceOrbView(context);
        transcriptScroll = new ScrollView(context);
        transcriptScroll.setVerticalScrollBarEnabled(false);
        transcriptScroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        transcriptLabel = new TextView(context);
        transcriptLabel.setTextSize(18);
        transcriptLabel.setTextColor(Color.WHITE);
        transcriptLabel.setShadowLayer(2 * density, 0, density, 0xCC101722);
        transcriptLabel.setGravity(Gravity.CENTER);
        transcriptLabel.setLineSpacing(5 * density, 1f);
        transcriptScroll.addView(transcriptLabel);

        // Size and position from the actual host window, including short/landscape assistant windows.
        FrameLayout stage = new FrameLayout(context) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                super.onMeasure(widthSpec, heightSpec);
                int width = getMeasuredWidth(), height = getMeasuredHeight();
                int side = Math.round(Math.min(340 * density, Math.min(width * .84f, height * .49f)));
                orb.measure(View.MeasureSpec.makeMeasureSpec(side, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(side, View.MeasureSpec.EXACTLY));
                transcriptScroll.measure(View.MeasureSpec.makeMeasureSpec(Math.max(0, width - 2 * pad), View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(Math.round(Math.min(88 * density, height * .2f)), View.MeasureSpec.EXACTLY));
                statusLabel.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(Math.round(48 * density), View.MeasureSpec.AT_MOST));
            }
            @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
                int width = right - left, height = bottom - top;
                int side = orb.getMeasuredWidth();
                int y = Math.round(height * .68f - side / 2f);
                orb.layout((width - side) / 2, y, (width + side) / 2, y + side);
                int captionBottom = Math.max(transcriptScroll.getMeasuredHeight(), y - Math.round(22 * density));
                transcriptScroll.layout(pad, captionBottom - transcriptScroll.getMeasuredHeight(), width - pad, captionBottom);
                int statusTop = Math.min(y + side + Math.round(10 * density), height - statusLabel.getMeasuredHeight());
                statusLabel.layout(0, statusTop, width, statusTop + statusLabel.getMeasuredHeight());
            }
        };
        stage.addView(transcriptScroll);
        stage.addView(orb);
        stage.addView(statusLabel);
        root.addView(stage, new LinearLayout.LayoutParams(-1, 0, 1f));

        LinearLayout actions = new LinearLayout(context);
        actions.setGravity(Gravity.CENTER);
        actions.addView(action("plus", UiText.isEnglish(context) ? "New topic" : "新话题", false, density, this::newTopic));
        actions.addView(action("bubble", UiText.isEnglish(context) ? "Text chat" : "文字聊天", false, density, this::openTextChat));
        if (!remoteInput) actions.addView(action("stop", "打断", false, density, this::onSpeechStart));
        actions.addView(action("close", "结束", true, density, this::close));
        root.addView(actions, new LinearLayout.LayoutParams(-2, -2));
        return root;
    }

    private LinearLayout action(String icon, String label, boolean end, float density, Runnable run) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setPadding(Math.round(6 * density), Math.round(12 * density), Math.round(6 * density), 0);
        ImageButton button = new ImageButton(context);
        button.setContentDescription(UiText.get(context, label));
        button.setImageDrawable(new ChatIcon(icon, end ? 0xFFFFB3BF : Color.WHITE));
        button.setPadding(Math.round(17 * density), Math.round(17 * density), Math.round(17 * density), Math.round(17 * density));
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setColor(end ? 0x884B3B48 : 0x88404A58);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x35FFFFFF), shape, null));
        button.setOnClickListener(clicked -> run.run());
        column.addView(button, new LinearLayout.LayoutParams(Math.round(58 * density), Math.round(58 * density)));
        TextView caption = new TextView(context);
        caption.setText(UiText.get(context, label));
        caption.setTextSize(12);
        caption.setTextColor(Color.WHITE);
        caption.setShadowLayer(2 * density, 0, density, 0xCC101722);
        caption.setGravity(Gravity.CENTER);
        caption.setPadding(0, Math.round(9 * density), 0, 0);
        caption.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        column.addView(caption);
        return column;
    }
}
