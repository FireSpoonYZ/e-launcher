package com.example.launcherprobe;

import android.app.Activity;
import android.app.role.RoleManager;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.speech.RecognizerIntent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Device")
public final class DevicePlugin extends Plugin {
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
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "说出你的消息");
        startActivityForResult(call, intent, "voiceResult");
    }
    @ActivityCallback private void voiceResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("语音输入已取消"); return; }
        ArrayList<String> words = result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (words == null || words.isEmpty()) { call.reject("未识别到语音"); return; }
        ChatStore store = ChatCoordinator.get(getContext()).store();
        String text = store.draft() + words.get(0); store.saveDraft(text);
        call.resolve(object("text", text));
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
            else if ("home".equals(target)) intent = new Intent(Settings.ACTION_HOME_SETTINGS);
            else if ("accessibility".equals(target)) intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            else if ("settings".equals(target)) intent = new Intent(Settings.ACTION_SETTINGS);
            else throw new IllegalArgumentException("target 无效");
            getActivity().startActivity(intent); call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }
    @PluginMethod public void repairPermissions(PluginCall call) { repair.repairFromButton(); call.resolve(); }
    @PluginMethod public void requestHome(PluginCall call) {
        RoleManager roles = getContext().getSystemService(RoleManager.class);
        if (roles == null || !roles.isRoleAvailable(RoleManager.ROLE_HOME)) { call.reject("系统未提供 HOME 角色请求"); return; }
        if (roles.isRoleHeld(RoleManager.ROLE_HOME)) { call.resolve(); return; }
        startActivityForResult(call, roles.createRequestRoleIntent(RoleManager.ROLE_HOME), "roleResult");
    }
    @ActivityCallback private void roleResult(PluginCall call, androidx.activity.result.ActivityResult result) { if (call != null) call.resolve(stateObject()); }
    // Overlay input must belong to the main Looper, not the WebView's disposable plugin thread.
    @PluginMethod public void enableGestures(PluginCall call) {
        getActivity().runOnUiThread(() -> { GestureService.enable(getContext()); call.resolve(stateObject()); });
    }
    @PluginMethod public void disableGestures(PluginCall call) {
        getActivity().runOnUiThread(() -> { GestureService.disable(getContext()); call.resolve(stateObject()); });
    }
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
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).showHomeFromWeb();
        } else {
            getActivity().finish();
        }
    }

    private JSObject stateObject() {
        android.content.SharedPreferences ui = getContext().getSharedPreferences("ui", android.content.Context.MODE_PRIVATE);
        RoleManager roles = getContext().getSystemService(RoleManager.class);
        String route = getActivity() instanceof MainActivity ? ((MainActivity) getActivity()).launchRoute() : null;
        return object("launchRoute", route == null ? "/chat" : route,
                "language", ui.getString("language", "system"), "theme", ui.getString("theme", "system"),
                "background", ui.getString("background", "circles"), "backgroundMask", AppAppearance.maskStrength(getContext()),
                "backgroundPath", new java.io.File(getContext().getFilesDir(), "appearance/background.png").isFile()
                    ? new java.io.File(getContext().getFilesDir(), "appearance/background.png").getAbsolutePath() : "",
                "homeRole", roles != null && roles.isRoleHeld(RoleManager.ROLE_HOME), "gestureStatus", GestureService.status(getContext()),
                "canWriteSecureSettings", GestureService.canWrite(getContext()), "accessibilityConnected", GestureService.isConnected());
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
