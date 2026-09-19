package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Process-wide voice entry point: dictation for the composers and read-aloud of finished replies. Main thread only. */
final class VoiceManager {
    static final int REQUEST_RECOGNIZER = 41, REQUEST_MICROPHONE = 43;

    interface Callback {
        void onText(String text);
        void onError(String message);
        default void onCancel() { }
    }

    private static volatile VoiceManager instance;
    /** Set by the wake word thread before it posts onWake, so it does not reopen the microphone meanwhile. */
    private static volatile boolean wakeHold;
    static synchronized VoiceManager get(Context context) {
        if (instance == null) instance = new VoiceManager(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final VoiceSettings settings;
    private final SpeechOutput output;
    private final Set<String> voiceTurns = new HashSet<>();
    private volatile Pending pending;
    private VoiceListeningDialog dialog;
    private SpeechInput headless;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private final java.util.concurrent.ExecutorService sender = java.util.concurrent.Executors.newSingleThreadExecutor();

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

    /** True while dictation, a wake hand-off or read-aloud needs the microphone quiet. Any thread. */
    static boolean busy() {
        VoiceManager manager = instance;
        return wakeHold || (manager != null && (manager.pending != null || manager.output.speaking()));
    }

    static void holdForWake() { wakeHold = true; }

    /** Main thread. Listens for the request after the wake word, sends it to the assistant and reads the reply. */
    void onWake(String keyword) {
        if (pending != null) { wakeHold = false; return; }
        output.stop();
        String conversationId = ChatCoordinator.get(context).conversationId();
        Callback callback = new Callback() {
            @Override public void onText(String text) { wakeHold = false; sendSpoken(conversationId, text); }
            @Override public void onError(String message) {
                wakeHold = false;
                WakeWordService.showProgress(null);
                android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_SHORT).show();
            }
            @Override public void onCancel() { wakeHold = false; WakeWordService.showProgress(null); }
        };
        cue();
        // Let the cue finish so the recognizer does not hear it.
        main.postDelayed(() -> {
            Activity visible = MainActivity.resumed();
            if (visible != null) listen(visible, conversationId, callback);
            else listenHeadless(conversationId, callback);
        }, 250);
    }

    private void listenHeadless(String conversationId, Callback callback) {
        if (pending != null) cancelListening();
        pending = new Pending(conversationId, callback);
        if (VoiceSettings.SYSTEM.equals(settings.sttEngine()) && !SpeechRecognizer.isRecognitionAvailable(context)) {
            fail(UiText.get(context, "系统未提供语音识别，请在设置中改用远程模型或使用键盘麦克风"));
            return;
        }
        Pending request = pending;
        SpeechInput input = VoiceSettings.REMOTE.equals(settings.sttEngine())
                ? new SpeechInput.RemoteInput(settings.remote(VoiceSettings.STT), settings.language())
                : new SpeechInput.SystemInput(context, settings.language());
        headless = input;
        WakeWordService.showProgress(UiText.get(context, "正在聆听…"));
        input.start(new SpeechInput.Listener() {
            @Override public void onLevel(float level) { }
            @Override public void onPartial(String text) { WakeWordService.showProgress(text); }
            @Override public void onProcessing() { WakeWordService.showProgress(UiText.get(context, "正在识别…")); }
            @Override public void onResult(String text) { if (pending == request) { headless = null; succeed(text); } }
            @Override public void onError(String message) { if (pending == request) { headless = null; fail(UiText.get(context, message)); } }
        });
    }

    private void sendSpoken(String conversationId, String text) {
        WakeWordService.showProgress(UiText.get(context, "已发送：") + text);
        sender.execute(() -> {
            try { ChatCoordinator.get(context).sendVoice(conversationId, text); }
            catch (Exception failure) {
                String message = failure.getMessage() == null ? UiText.get(context, "发送失败") : failure.getMessage();
                main.post(() -> {
                    voiceTurns.remove(conversationId);
                    WakeWordService.showProgress(null);
                    output.speak(message);
                });
            }
        });
    }

    private void cue() {
        try {
            android.media.ToneGenerator tone = new android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 60);
            tone.startTone(android.media.ToneGenerator.TONE_PROP_ACK, 150);
            main.postDelayed(tone::release, 400);
        } catch (RuntimeException unavailable) { }
    }
    boolean speaking() { return output.speaking(); }
    void speak(String markdown) { output.speak(markdown); }
    void stopSpeaking() { output.stop(); }

    /** Captures one utterance. conversationId, when set, marks the next finished reply there for read-aloud. */
    void listen(Activity activity, String conversationId, Callback callback) {
        if (pending != null) cancelListening();
        output.stop();
        pending = new Pending(conversationId, callback);
        boolean system = VoiceSettings.SYSTEM.equals(settings.sttEngine());
        if (system && !SpeechRecognizer.isRecognitionAvailable(context)) {
            // Some ROMs expose only the recognizer activity; it handles the microphone itself.
            try { activity.startActivityForResult(SpeechInput.recognizerIntent(settings.language()), REQUEST_RECOGNIZER); }
            catch (ActivityNotFoundException missing) { fail(UiText.get(context, "系统未提供语音识别，请在设置中改用远程模型或使用键盘麦克风")); }
            return;
        }
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
            return;
        }
        begin(activity);
    }

    boolean onRequestPermissionsResult(Activity activity, int request, int[] results) {
        if (request != REQUEST_MICROPHONE) return false;
        if (pending == null) return true;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) begin(activity);
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
        if (dialog != null) dialog.cancelInput();
        else {
            if (headless != null) { headless.cancel(); headless = null; }
            cancelled();
        }
    }

    private void cancelled() {
        Pending request = pending;
        pending = null; dialog = null;
        if (request != null) request.callback.onCancel();
    }

    private void begin(Activity activity) {
        if (activity.isFinishing() || activity.isDestroyed()) { cancelled(); return; }
        SpeechInput input = VoiceSettings.REMOTE.equals(settings.sttEngine())
                ? new SpeechInput.RemoteInput(settings.remote(VoiceSettings.STT), settings.language())
                : new SpeechInput.SystemInput(activity, settings.language());
        Pending request = pending;
        dialog = new VoiceListeningDialog(activity, input, new SpeechInput.Listener() {
            @Override public void onLevel(float level) { }
            @Override public void onPartial(String text) { }
            @Override public void onProcessing() { }
            @Override public void onResult(String text) { if (pending == request) succeed(text); }
            @Override public void onError(String message) { if (pending == request) fail(UiText.get(context, message)); }
        }, () -> { if (pending == request) cancelled(); });
        dialog.show();
    }

    private void succeed(String text) {
        Pending request = pending;
        pending = null; dialog = null;
        if (request.conversationId != null) voiceTurns.add(request.conversationId);
        request.callback.onText(text);
    }

    private void fail(String message) {
        Pending request = pending;
        pending = null; dialog = null;
        if (request != null) request.callback.onError(message);
    }

    private void chatChanged(List<AgentLoop.Message> messages, JSONObject event) {
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
