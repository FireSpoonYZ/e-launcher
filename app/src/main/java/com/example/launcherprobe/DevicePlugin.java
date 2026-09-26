package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PluginMethod;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Device", permissions = {@Permission(alias = DevicePlugin.MICROPHONE,
        strings = {Manifest.permission.RECORD_AUDIO})})
public final class DevicePlugin extends Plugin {
    static final String MICROPHONE = "microphone";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private ShizukuRepair repair;
    private android.view.ViewTreeObserver.OnGlobalLayoutListener keyboardListener;
    private boolean keyboardVisible;

    private boolean isKeyboardVisible() {
        androidx.core.view.WindowInsetsCompat insets = androidx.core.view.ViewCompat.getRootWindowInsets(getBridge().getWebView());
        return insets != null && insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime());
    }
    @PluginMethod public void keyboardState(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(object("visible", isKeyboardVisible())));
    }

    @Override public void load() {
        repair = new ShizukuRepair(getContext(), () -> notifyListeners("deviceEvent", stateObject()));
        repair.register(); repair.resume();
        getActivity().runOnUiThread(() -> {
            keyboardListener = () -> {
                boolean visible = isKeyboardVisible();
                if (visible != keyboardVisible) {
                    keyboardVisible = visible;
                    notifyListeners("keyboardEvent", object("visible", visible));
                }
            };
            getBridge().getWebView().getViewTreeObserver().addOnGlobalLayoutListener(keyboardListener);
        });
    }
    @Override protected void handleOnResume() { if (repair != null) repair.resume(); notifyListeners("deviceEvent", stateObject()); }
    @Override protected void handleOnPause() { if (repair != null) repair.pause(); }
    @Override protected void handleOnDestroy() {
        if (keyboardListener != null) getBridge().getWebView().getViewTreeObserver().removeOnGlobalLayoutListener(keyboardListener);
        if (repair != null) repair.destroy(); worker.shutdownNow();
    }

    @PluginMethod public void state(PluginCall call) { call.resolve(stateObject()); }
    @PluginMethod public void apps(PluginCall call) {
        try { call.resolve(js(new JSONObject().put("apps", DeviceActions.appJson(getContext())))); }
        catch (Exception exception) { reject(call, exception); }
    }
    @PluginMethod public void launchApp(PluginCall call) {
        try { DeviceActions.launch(getContext(), required(call, "packageName"), required(call, "className")); call.resolve(); }
        catch (Exception exception) { reject(call, exception); }
    }
    @PluginMethod public void voice(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ChatStore store = ChatCoordinator.get(getContext()).store();
            VoiceManager.get(getContext()).listen(getActivity(), store.activeId(), new VoiceManager.Callback() {
                @Override public void onText(String words) {
                    try { String text = store.draft() + words; store.saveDraft(text); call.resolve(object("text", text)); }
                    catch (Exception exception) { reject(call, exception); }
                }
                @Override public void onError(String message) { call.reject(message); }
                @Override public void onCancel() { call.reject("语音输入已取消"); }
            });
        });
    }
    @PluginMethod public void openVoiceConversation(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try { VoiceSessionActivity.open(getActivity(), false, call.getString("conversationId")); call.resolve(); }
            catch (Exception exception) { reject(call, exception); }
        });
    }
    @PluginMethod public void speak(PluginCall call) {
        try {
            String text = required(call, "text");
            getActivity().runOnUiThread(() -> { VoiceManager.get(getContext()).speak(text); call.resolve(); });
        } catch (Exception exception) { reject(call, exception); }
    }
    @PluginMethod public void stopSpeaking(PluginCall call) {
        getActivity().runOnUiThread(() -> { VoiceManager.get(getContext()).stopSpeaking(); call.resolve(); });
    }

    /** Dictation for the settings test button; unlike voice() it never touches a conversation draft. */
    @PluginMethod public void listenOnce(PluginCall call) {
        getActivity().runOnUiThread(() -> VoiceManager.get(getContext()).listen(getActivity(), null, new VoiceManager.Callback() {
            @Override public void onText(String text) { call.resolve(object("text", text)); }
            @Override public void onError(String message) { call.reject(message); }
            @Override public void onCancel() { call.reject("语音输入已取消"); }
        }));
    }

    @PluginMethod public void voiceSettings(PluginCall call) {
        try { call.resolve(voiceObject()); } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void setVoiceSettings(PluginCall call) {
        try {
            VoiceSettings settings = VoiceManager.get(getContext()).settings();
            String stt = call.getString("sttEngine"); if (stt != null) settings.setEngine(VoiceSettings.STT, stt);
            String tts = call.getString("ttsEngine"); if (tts != null) settings.setEngine(VoiceSettings.TTS, tts);
            String mode = call.getString("speakMode"); if (mode != null) settings.setSpeakMode(mode);
            String language = call.getString("language"); if (language != null) settings.setLanguage(language);
            Double rate = call.getDouble("speechRate"); if (rate != null) settings.setSpeechRate(rate.floatValue());
            String words = call.getString("wakeWords");
            if (words != null) {
                // Reject words the offline model cannot spell before they reach the detector.
                WakeWords.keywordsFile(WakeWords.split(words), WakeWordEngine.vocabulary(getContext()));
                settings.setWakeWords(words);
                WakeWordService.sync(getContext(), true);
            }
            String sensitivity = call.getString("wakeSensitivity");
            if (sensitivity != null) { settings.setWakeSensitivity(sensitivity); WakeWordService.sync(getContext(), true); }
            call.resolve(voiceObject());
        } catch (Exception exception) { reject(call, exception); }
    }

    /** A null apiKey keeps the stored credential; an empty one removes it. */
    @PluginMethod public void setVoiceRemote(PluginCall call) {
        try {
            VoiceSettings settings = VoiceManager.get(getContext()).settings();
            String kind = required(call, "kind");
            settings.setRemote(kind, call.getString("baseUrl", ""), call.getString("model", ""),
                    call.getString("voice", settings.remote(kind).voice), call.getString("apiKey"));
            call.resolve(voiceObject());
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void setWakeEnabled(PluginCall call) {
        try {
            if (!Boolean.TRUE.equals(call.getBoolean("enabled"))) {
                VoiceManager.get(getContext()).settings().setWakeEnabled(false);
                WakeWordService.sync(getContext());
                call.resolve(voiceObject());
            } else if (microphoneGranted()) enableWake(call);
            else requestPermissionForAlias(MICROPHONE, call, "wakePermission");
        } catch (Exception exception) { reject(call, exception); }
    }

    @PermissionCallback private void wakePermission(PluginCall call) {
        if (microphoneGranted()) enableWake(call);
        else call.reject("需要麦克风权限才能开启语音唤醒");
    }

    private void enableWake(PluginCall call) {
        try {
            VoiceManager.get(getContext()).settings().setWakeEnabled(true);
            WakeWordService.sync(getContext(), true);
            call.resolve(voiceObject());
        } catch (Exception exception) { reject(call, exception); }
    }

    /** Shizuku grants the assistant role; the system default-apps screen stays available from openSystemSettings. */
    @PluginMethod public void requestAssistantRole(PluginCall call) {
        repair.requestAssistantFromButton(); call.resolve();
    }

    private boolean microphoneGranted() {
        return getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject voiceObject() {
        VoiceSettings settings = VoiceManager.get(getContext()).settings();
        boolean assistant = LauncherVoiceInteractionService.isDefaultAssistant(getContext());
        return object("sttEngine", settings.sttEngine(), "ttsEngine", settings.ttsEngine(),
                "speakMode", settings.speakMode(), "language", settings.language(), "speechRate", (double) settings.speechRate(),
                "stt", remoteObject(settings.remote(VoiceSettings.STT)), "tts", remoteObject(settings.remote(VoiceSettings.TTS)),
                "wakeEnabled", settings.wakeEnabled(), "wakeWords", settings.wakeWords(),
                "wakeWordsDetail", wakeDetail(settings.wakeWords()), "wakeSensitivity", settings.wakeSensitivity(),
                "wakeStatus", WakeWordService.status(),
                "wakeListening", assistant ? LauncherVoiceInteractionService.isListening() : WakeWordService.isRunning(),
                "assistantDefault", assistant, "microphoneGranted", microphoneGranted());
    }

    private static JSObject remoteObject(VoiceSettings.Remote remote) {
        return object("baseUrl", remote.baseUrl, "model", remote.model, "voice", remote.voice, "configured", !remote.apiKey.isEmpty());
    }

    /** Shows how the offline model spells each wake word, or why it cannot. */
    private String wakeDetail(String words) {
        try {
            StringBuilder out = new StringBuilder();
            for (String word : WakeWords.split(words)) {
                if (out.length() > 0) out.append('\n');
                out.append(word).append("  ·  ").append(WakeWords.tokens(word, WakeWordEngine.vocabulary(getContext())));
            }
            return out.toString();
        } catch (Exception exception) { return words + "\n" + exception.getMessage(); }
    }

    @PluginMethod public void chooseAttachment(PluginCall call) {
        try {
            String kind = required(call, "kind");
            required(call, "conversationId");
            java.io.File capture = "camera".equals(kind) ? AttachmentPicker.cameraFile(getContext()) : null;
            if (capture != null) call.getData().put("capturePath", capture.getAbsolutePath());
            startActivityForResult(call, AttachmentPicker.intent(getContext(), kind, capture), "attachmentResult");
        } catch (Exception exception) { reject(call, exception); }
    }

    @ActivityCallback private void attachmentResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        String capturePath = call.getString("capturePath");
        if (result.getResultCode() != Activity.RESULT_OK) {
            if (capturePath != null) new java.io.File(capturePath).delete();
            call.reject("选择已取消"); return;
        }
        worker.execute(() -> {
            try {
                java.util.List<ChatAttachment> published = AttachmentPicker.importResult(getContext(),
                        ChatCoordinator.get(getContext()).store(), required(call, "conversationId"),
                        call.getString("kind"), capturePath == null ? null : new java.io.File(capturePath), result.getData());
                call.resolve(object("attachments", AttachmentStore.json(published)));
            } catch (Exception exception) { reject(call, exception); }
        });
    }

    @PluginMethod public void removeAttachment(PluginCall call) {
        try {
            ChatStore store = ChatCoordinator.get(getContext()).store();
            store.removeDraftAttachment(required(call, "conversationId"), required(call, "attachmentId"));
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void openAttachment(PluginCall call) {
        try {
            String id = required(call, "attachmentId"); ChatAttachment found = null;
            ChatStore store = ChatCoordinator.get(getContext()).store();
            for (ChatAttachment item : store.draftAttachments()) if (id.equals(item.id)) found = item;
            for (ConversationTree.Node node : store.tree().nodes())
                for (ChatAttachment item : node.message.attachments) if (id.equals(item.id)) found = item;
            if (found == null) throw new SecurityException("附件不存在");
            java.io.File file = new AttachmentStore(getContext()).requireFile(found);
            Uri uri = androidx.core.content.FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".files", file);
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, found.mimeType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (intent.resolveActivity(getContext().getPackageManager()) == null) throw new IllegalStateException("没有可打开此附件的应用");
            getActivity().startActivity(intent); call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void chooseBackground(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE), "backgroundResult");
    }
    @ActivityCallback private void backgroundResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("图片选择已取消"); return; }
        Uri uri = result.getData().getData(); long operation = BackgroundImage.beginImport();
        worker.execute(() -> {
            try {
                if (!BackgroundImage.importImage(getContext(), uri, operation)) throw new IllegalStateException("背景操作已被取代");
                call.resolve();
            } catch (Exception exception) { reject(call, exception); }
        });
    }
    @PluginMethod public void clearBackground(PluginCall call) { try { BackgroundImage.clear(getContext()); call.resolve(); } catch (Exception exception) { reject(call, exception); } }
    @PluginMethod public void setAppearance(PluginCall call) {
        try {
            String language = call.getString("language"), theme = call.getString("theme"), background = call.getString("background");
            android.content.SharedPreferences.Editor edit = getContext().getSharedPreferences("ui", android.content.Context.MODE_PRIVATE).edit();
            if (language != null) { if (!Arrays.asList("system", "zh", "en").contains(language)) throw new IllegalArgumentException("language 无效"); edit.putString("language", language); }
            if (theme != null) { if (!Arrays.asList("system", "light", "dark").contains(theme)) throw new IllegalArgumentException("theme 无效"); edit.putString("theme", theme); }
            if (background != null) { if (!Arrays.asList("circles", "solid", "image").contains(background)) throw new IllegalArgumentException("background 无效"); BackgroundImage.setMode(getContext(), background); }
            Integer mask = call.getInt("backgroundMask"); if (mask != null) edit.putInt("backgroundMask", Math.max(20, Math.min(100, mask)));
            edit.apply(); call.resolve(stateObject());
        } catch (Exception exception) { reject(call, exception); }
    }
    @PluginMethod public void openSystemSettings(PluginCall call) {
        try {
            String target = required(call, "target"); Intent intent;
            if ("app".equals(target)) intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            else if ("settings".equals(target)) intent = new Intent(Settings.ACTION_SETTINGS);
            else if ("tts".equals(target)) intent = new Intent("com.android.settings.TTS_SETTINGS");
            else if ("assistant".equals(target)) intent = new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS);
            else throw new IllegalArgumentException("target 无效");
            try { getActivity().startActivity(intent); }
            catch (android.content.ActivityNotFoundException missing) {
                if ("assistant".equals(target)) getActivity().startActivity(new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS));
                else if ("tts".equals(target)) throw new IllegalStateException("系统未提供朗读引擎设置");
                else throw missing;
            }
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }
    @PluginMethod public void repairPermissions(PluginCall call) { repair.repairFromButton(); call.resolve(); }
    @PluginMethod public void share(PluginCall call) {
        try { getActivity().startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, required(call, "text")), call.getString("title", "分享"))); call.resolve(); }
        catch (Exception exception) { reject(call, exception); }
    }
    @PluginMethod public void openUrl(PluginCall call) {
        try { Uri uri = Uri.parse(required(call, "url")); if (!"https".equalsIgnoreCase(uri.getScheme())) throw new SecurityException("链接必须使用 HTTPS"); getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri)); call.resolve(); }
        catch (Exception exception) { reject(call, exception); }
    }
    @PluginMethod public void hideKeyboard(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            android.view.inputmethod.InputMethodManager input = getContext().getSystemService(android.view.inputmethod.InputMethodManager.class);
            input.hideSoftInputFromWindow(getBridge().getWebView().getWindowToken(), 0);
            call.resolve();
        });
    }
    @PluginMethod public void close(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().finish());
    }

    private JSObject stateObject() {
        android.content.SharedPreferences ui = getContext().getSharedPreferences("ui", android.content.Context.MODE_PRIVATE);
        String route = getActivity() instanceof MainActivity ? ((MainActivity) getActivity()).launchRoute() : null;
        return object("launchRoute", route == null ? "/chat" : route,
                "language", ui.getString("language", "system"), "theme", ui.getString("theme", "system"),
                "background", ui.getString("background", "circles"), "backgroundMask", AppAppearance.maskStrength(getContext()),
                "backgroundPath", new java.io.File(getContext().getFilesDir(), "appearance/background.png").isFile()
                    ? new java.io.File(getContext().getFilesDir(), "appearance/background.png").getAbsolutePath() : "",
                "canWriteSecureSettings", getContext().checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED,
                "legacyNavigationPending", LegacyNavigationRecovery.pending(getContext()),
                "legacyNavigationStatus", LegacyNavigationRecovery.status(getContext()), "shizukuStatus", ShizukuRepair.statusText());
    }
    private static JSObject object(Object... values) {
        JSObject result = new JSObject();
        try { for (int i = 0; i < values.length; i += 2) result.put(String.valueOf(values[i]), values[i + 1]); }
        catch (Exception exception) { throw new IllegalStateException(exception); }
        return result;
    }
    private static String required(PluginCall call, String name) { String value = call.getString(name); if (value == null || value.isEmpty()) throw new IllegalArgumentException(name + " is required"); return value; }
    private static JSObject js(JSONObject value) { try { return JSObject.fromJSONObject(value); } catch (Exception exception) { throw new IllegalStateException(exception); } }
    private static void reject(PluginCall call, Exception exception) { call.reject(exception.getMessage(), exception); }
}
