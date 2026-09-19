package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognizerIntent;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Process-wide voice entry point: dictation for the composers, spoken requests after a wake word or the assist
 * gesture, and read-aloud of finished replies. Main thread only unless noted.
 */
final class VoiceManager {
    static final int REQUEST_RECOGNIZER = 41, REQUEST_MICROPHONE = 43;
    private static final long WAKE_HOLD_TIMEOUT_MS = 5_000;

    interface Callback {
        void onText(String text);
        void onError(String message);
        default void onCancel() { }
    }

    /** A listening UI (dialog, session panel or none) that can abandon its input. */
    interface Presented { void cancelInput(); }

    private static volatile VoiceManager instance;
    /** Set by the wake word thread before it posts onWake, so it does not reopen the microphone meanwhile. */
    private static volatile boolean wakeHold;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    // A session that never shows must not keep the detector off forever.
    private static final Runnable STALE_HOLD = () -> {
        VoiceManager manager = instance;
        if (manager == null || manager.pending == null) wakeHold = false;
    };

    static synchronized VoiceManager get(Context context) {
        if (instance == null) instance = new VoiceManager(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final VoiceSettings settings;
    private final SpeechOutput output;
    private final Set<String> voiceTurns = new HashSet<>();
    private final ExecutorService sender = Executors.newSingleThreadExecutor();
    private volatile Pending pending;
    private volatile VoiceSession session;
    private Presented presented;

    private static final class Pending {
        final String conversationId;
        final Callback callback;
        Pending(String conversationId, Callback callback) { this.conversationId = conversationId; this.callback = callback; }
    }

    private VoiceManager(Context context) {
        this.context = context;
        settings = new VoiceSettings(context);
        output = new SpeechOutput(context, settings);
        ChatCoordinator.get(context).addListener(this::chatChanged);
    }

    VoiceSettings settings() { return settings; }
    SpeechOutput output() { return output; }
    boolean speaking() { return output.speaking(); }
    void speak(String markdown) { output.speak(markdown); }
    void stopSpeaking() { output.stop(); }

    /** Opens a continuous spoken conversation in the given window, replacing any session already running. */
    VoiceSession openSession(VoiceSession.Host host) {
        if (session != null) session.close();
        cancelListening();
        output.prewarm();
        VoiceSession opened = new VoiceSession(host, output);
        session = opened;
        releaseWakeHold();
        return opened;
    }

    void sessionClosed(VoiceSession closed) { if (session == closed) session = null; }

    /** True while dictation, a wake hand-off, a spoken conversation or read-aloud needs the microphone quiet. Any thread. */
    static boolean busy() {
        VoiceManager manager = instance;
        return wakeHold || (manager != null && (manager.pending != null || manager.session != null || manager.output.speaking()));
    }

    /** Any thread. */
    static void holdForWake() {
        wakeHold = true;
        MAIN.removeCallbacks(STALE_HOLD);
        MAIN.postDelayed(STALE_HOLD, WAKE_HOLD_TIMEOUT_MS);
    }

    static void releaseWakeHold() { wakeHold = false; }

    /** Captures one utterance for a composer. conversationId, when set, marks the next finished reply for read-aloud. */
    void listen(Activity activity, String conversationId, Callback callback) {
        start(conversationId, callback);
        if (VoiceSettings.SYSTEM.equals(settings.sttEngine()) && !SpeechInput.systemAvailable(context)) {
            // Some ROMs expose only the recognizer activity; it handles the microphone itself.
            try { activity.startActivityForResult(SpeechInput.recognizerIntent(settings.language()), REQUEST_RECOGNIZER); }
            catch (ActivityNotFoundException missing) { fail(UiText.get(context, "系统未提供语音识别，请在设置中改用远程模型或使用键盘麦克风")); }
            return;
        }
        if (!hasMicrophone()) {
            activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
            return;
        }
        presentInDialog(activity);
    }

    /** The assistant session was shown, by a wake word or the system assist gesture. */
    void listenInSession(LauncherVoiceSessionService.Session session, boolean fromWake) {
        output.stop();
        String conversationId = ChatCoordinator.get(context).conversationId();        Callback spoken = spokenRequest(conversationId);
        // The panel hides the session when it ends; failures before it appears must hide it too.
        Callback callback = new Callback() {
            @Override public void onText(String text) { spoken.onText(text); }
            @Override public void onError(String message) { session.hide(); spoken.onError(message); }
            @Override public void onCancel() { session.hide(); spoken.onCancel(); }
        };
        start(conversationId, callback);
        if (!ready()) return;
        if (fromWake) cue();
        Pending request = pending;
        // Let the cue finish so the recognizer does not hear it.
        MAIN.postDelayed(() -> {
            if (pending != request) return;
            presented = session.present(createInput(session.getContext()), target(request), () -> dismissed(request));
        }, fromWake ? 250 : 0);
    }

    /** Wake word while this app is not the assistant: the spoken conversation if the launcher is visible, else no UI. */
    void onWake(String keyword) {
        if (pending != null || session != null) { wakeHold = false; return; }
        output.stop();
        Activity visible = MainActivity.resumed();
        if (visible != null && VoiceSession.supported(context)) {
            // The hold stays until the session takes the microphone, so the detector does not grab it back meanwhile.
            VoiceSessionActivity.open(visible, true);
            return;
        }
        String conversationId = ChatCoordinator.get(context).conversationId();
        Callback callback = spokenRequest(conversationId);
        cue();
        MAIN.postDelayed(() -> {
            Activity resumed = MainActivity.resumed();
            if (resumed != null) listen(resumed, conversationId, callback);
            else listenHeadless(conversationId, callback);
        }, 250);
    }

    boolean onRequestPermissionsResult(Activity activity, int request, int[] results) {
        if (request != REQUEST_MICROPHONE) return false;
        if (pending == null) return true;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) presentInDialog(activity);
        else fail(UiText.get(context, "需要麦克风权限才能语音输入"));
        return true;
    }

    boolean onActivityResult(int request, int result, Intent data) {
        if (request != REQUEST_RECOGNIZER) return false;
        if (pending == null) return true;
        ArrayList<String> words = result == Activity.RESULT_OK && data != null
                ? data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS) : null;
        if (words == null || words.isEmpty() || words.get(0) == null || words.get(0).trim().isEmpty()) {
            if (result == Activity.RESULT_OK) fail(UiText.get(context, "未识别到语音"));
            else cancelled();
        } else succeed(words.get(0).trim());
        return true;
    }

    void cancelListening() {
        if (presented != null) presented.cancelInput();
        else cancelled();
    }

    private void start(String conversationId, Callback callback) {
        if (pending != null) cancelListening();
        output.stop();
        pending = new Pending(conversationId, callback);
    }

    /** Checks what a UI-less or session capture needs; fails the pending request otherwise. */
    private boolean ready() {
        if (!hasMicrophone()) { fail(UiText.get(context, "需要麦克风权限才能语音输入")); return false; }
        if (VoiceSettings.SYSTEM.equals(settings.sttEngine()) && !SpeechInput.systemAvailable(context)) {
            fail(UiText.get(context, "系统未提供语音识别，请在设置中改用远程模型或使用键盘麦克风"));
            return false;
        }
        return true;
    }

    private void presentInDialog(Activity activity) {
        if (activity.isFinishing() || activity.isDestroyed()) { cancelled(); return; }
        Pending request = pending;
        VoiceListeningDialog dialog = new VoiceListeningDialog(activity, createInput(activity), target(request), () -> dismissed(request));
        presented = dialog;
        dialog.show();
    }

    private void listenHeadless(String conversationId, Callback callback) {
        start(conversationId, callback);
        if (!ready()) return;
        Pending request = pending;
        SpeechInput input = createInput(context);
        presented = () -> { input.cancel(); dismissed(request); };
        WakeWordService.showProgress(UiText.get(context, "正在聆听…"));
        input.start(new SpeechInput.Listener() {
            @Override public void onLevel(float level) { }
            @Override public void onPartial(String text) { WakeWordService.showProgress(text); }
            @Override public void onProcessing() { WakeWordService.showProgress(UiText.get(context, "正在识别…")); }
            @Override public void onResult(String text) { target(request).onResult(text); }
            @Override public void onError(String message) { target(request).onError(message); }
        });
    }

    private SpeechInput createInput(Context ui) {
        return VoiceSettings.REMOTE.equals(settings.sttEngine())
                ? new SpeechInput.RemoteInput(settings.remote(VoiceSettings.STT), settings.language())
                : new SpeechInput.SystemInput(ui, settings.language());
    }

    private SpeechInput.Listener target(Pending request) {
        return new SpeechInput.Listener() {
            @Override public void onLevel(float level) { }
            @Override public void onPartial(String text) { }
            @Override public void onProcessing() { }
            @Override public void onResult(String text) { if (pending == request) succeed(text); }
            @Override public void onError(String message) { if (pending == request) fail(UiText.get(context, message)); }
        };
    }

    private void dismissed(Pending request) { if (pending == request) cancelled(); }

    private void succeed(String text) {
        Pending request = pending;
        pending = null; presented = null;
        if (request.conversationId != null) voiceTurns.add(request.conversationId);
        request.callback.onText(text);
    }

    private void fail(String message) {
        Pending request = pending;
        pending = null; presented = null;
        if (request != null) request.callback.onError(message);
    }

    private void cancelled() {
        Pending request = pending;
        pending = null; presented = null;
        if (request != null) request.callback.onCancel();
    }

    /** Sends what was said to the assistant; the reply is read aloud through the voice-turn mark. */
    private Callback spokenRequest(String conversationId) {
        return new Callback() {
            @Override public void onText(String text) { wakeHold = false; sendSpoken(conversationId, text); }
            @Override public void onError(String message) {
                wakeHold = false;
                WakeWordService.showProgress(null);
                Toast.makeText(context, message, Toast.LENGTH_SHORT).show();
            }
            @Override public void onCancel() { wakeHold = false; WakeWordService.showProgress(null); }
        };
    }

    private void sendSpoken(String conversationId, String text) {
        WakeWordService.showProgress(UiText.get(context, "已发送：") + text);
        sender.execute(() -> {
            try { ChatCoordinator.get(context).sendVoice(conversationId, text); }
            catch (Exception failure) {
                String message = failure.getMessage() == null ? UiText.get(context, "发送失败") : failure.getMessage();
                MAIN.post(() -> {
                    voiceTurns.remove(conversationId);
                    WakeWordService.showProgress(null);
                    output.speak(message);
                });
            }
        });
    }

    private boolean hasMicrophone() {
        return context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void cue() {
        try {
            android.media.ToneGenerator tone = new android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 60);
            tone.startTone(android.media.ToneGenerator.TONE_PROP_ACK, 150);
            MAIN.postDelayed(tone::release, 400);
        } catch (RuntimeException unavailable) { }
    }

    private void chatChanged(List<AgentLoop.Message> messages, JSONObject event) {
        if (session != null) return;
        if (!"end".equals(event.optString("type"))) return;
        String conversationId = event.optString("conversationId");
        WakeWordService.showProgress(null);
        boolean voiceTurn = voiceTurns.remove(conversationId);
        JSONObject payload = event.optJSONObject("payload");
        if (payload == null || !"completed".equals(payload.optString("status"))) return;
        String mode = settings.speakMode();
        boolean active = conversationId.equals(ChatCoordinator.get(context).conversationId());
        if (VoiceSettings.SPEAK_OFF.equals(mode) || (VoiceSettings.SPEAK_AFTER_VOICE.equals(mode) ? !voiceTurn : !active)) return;
        String reply = lastReply(messages);
        if (!reply.isEmpty()) output.speak(reply);
    }

    static String lastReply(List<AgentLoop.Message> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            AgentLoop.Message message = messages.get(i);
            if ("user".equals(message.role)) return "";
            if ("assistant".equals(message.role) && !message.incomplete && message.content != null && !message.content.trim().isEmpty())
                return message.content;
        }
        return "";
    }
}
