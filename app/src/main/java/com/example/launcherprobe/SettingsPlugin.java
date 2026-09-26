package com.example.launcherprobe;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "Settings")
public final class SettingsPlugin extends Plugin {
    private static final Set<String> QUERIES = new java.util.HashSet<>(Arrays.asList("catalog", "test_provider", "login", "logout",
            "packages", "install", "update", "remove", "resources", "resource_paths", "resource_toggle"));
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private PiConfigStore store;
    private final Map<String, PendingQuery> queries = new java.util.concurrent.ConcurrentHashMap<>();
    private volatile boolean destroyed;
    private volatile okhttp3.Call publicCall;

    @Override public void load() {
        store = new PiConfigStore(getContext());
        migrateDrafts();
    }

    @Override protected void handleOnDestroy() {
        destroyed = true;
        for (Map.Entry<String, PendingQuery> entry : queries.entrySet()) {
            PendingQuery pending = entry.getValue();
            synchronized (pending.bridge) {
                if (queries.remove(entry.getKey(), pending) && pending.cancellable) pending.bridge.abort(entry.getKey());
            }
        }
        okhttp3.Call call = publicCall; if (call != null) call.cancel();
        worker.shutdownNow();
    }

    @PluginMethod public void snapshot(PluginCall call) {
        try {
            initialize();
            JSONObject raw = new JSONObject(store.snapshot());
            raw.put("auth", maskedAuth(raw.optJSONObject("auth")));
            raw.remove("runtimeEnvironment");
            raw.remove("models"); // Provider definitions may contain inline credentials; use providers().
            call.resolve(js(raw));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void schema(PluginCall call) {
        try (InputStream input = getContext().getAssets().open("pi-settings-fields.json")) {
            call.resolve(js(new JSONObject().put("fields", new JSONArray(read(input)))));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void files(PluginCall call) {
        try {
            initialize();
            JSONArray files = new JSONArray();
            for (String name : store.files(call.getBoolean("project", false)))
                if (!name.startsWith("npm/") && !name.contains("/node_modules/") && !name.startsWith("node_modules/")) files.put(name);
            call.resolve(js(new JSONObject().put("files", files)));
        }
        catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void readFile(PluginCall call) {
        try {
            initialize();
            boolean project = call.getBoolean("project", false);
            String name = required(call, "name");
            boolean secret = secretFile(project, name);
            if (secret && !(call.getBoolean("allowSecrets", false) && call.getBoolean("warningAccepted", false)))
                throw new SecurityException("打开 auth.json 必须明确确认其可能包含凭据");
            String source = store.read(project, name);
            JSONObject result = new JSONObject().put("source", source).put("containsSecrets", secret);
            EditorDraft draft = draft(project, name);
            if (draft != null) result.put("draft", draft.source).put("draftBase", draft.base);
            call.resolve(js(result));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void saveFile(PluginCall call) {
        try {
            initialize();
            boolean project = call.getBoolean("project", false);
            String name = required(call, "name");
            store.save(project, name, string(call, "source"), string(call, "expected"));
            clearDraft(project, name);
            call.resolve(js(new JSONObject().put("source", store.read(project, name))));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void formatFile(PluginCall call) {
        try { call.resolve(js(new JSONObject().put("source", ConfigJson.format(required(call, "source"))))); }
        catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void previous(PluginCall call) {
        try {
            initialize();
            boolean project = call.getBoolean("project", false);
            String name = required(call, "name");
            if (secretFile(project, name) && !(call.getBoolean("allowSecrets", false) && call.getBoolean("warningAccepted", false)))
                throw new SecurityException("打开 auth.json 必须明确确认其可能包含凭据");
            call.resolve(js(new JSONObject().put("source", store.previous(project, name))));
        }
        catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void saveDraft(PluginCall call) {
        try {
            initialize();
            String key = draftKey(call.getBoolean("project", false), required(call, "name"));
            drafts().edit().putString(key, string(call, "source")).putString(key + "/base", string(call, "base")).apply();
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void clearDraft(PluginCall call) {
        try { initialize(); clearDraft(call.getBoolean("project", false), required(call, "name")); call.resolve(); }
        catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void importFile(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
                .addCategory(Intent.CATEGORY_OPENABLE), "importResult");
    }

    @ActivityCallback private void importResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("文件选择已取消"); return;
        }
        try (InputStream input = getContext().getContentResolver().openInputStream(result.getData().getData())) {
            call.resolve(js(new JSONObject().put("source", readBounded(input))));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void exportFile(PluginCall call) {
        try {
            String name = required(call, "name");
            if (name.contains("/") || name.contains("\\")) name = new java.io.File(name).getName();
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .setType(call.getBoolean("json", false) ? "application/json" : "text/plain")
                    .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(call, intent, "exportResult");
        } catch (Exception exception) { reject(call, exception); }
    }

    @ActivityCallback private void exportResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("导出已取消"); return;
        }
        try (java.io.OutputStream output = getContext().getContentResolver().openOutputStream(result.getData().getData(), "wt")) {
            if (output == null) throw new java.io.IOException("无法打开导出文件");
            output.write(string(call, "source").getBytes(StandardCharsets.UTF_8)); call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void settings(PluginCall call) {
        try {
            initialize(call.getString("conversationId"));
            boolean effective = call.getBoolean("effective", false), project = call.getBoolean("project", false);
            Map<String, Object> value = effective ? store.effectiveSettings() : store.settings(project);
            JSONObject result = new JSONObject().put("settings", NativeJson.jsonValue(value));
            if (!effective) {
                result.put("revision", revision(store.read(project, "settings.json")));
                JSONObject sources = new JSONObject();
                try (InputStream input = getContext().getAssets().open("pi-settings-fields.json")) {
                    JSONArray fields = new JSONArray(read(input));
                    for (int i = 0; i < fields.length(); i++) {
                        String key = fields.getJSONObject(i).getString("key");
                        sources.put(key, ConfigJson.encode(ConfigJson.get(value, key)));
                    }
                }
                result.put("sources", sources);
            }
            call.resolve(js(result));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void updateSetting(PluginCall call) {
        try {
            initialize();
            String source = required(call, "value");
            JSONObject field = null;
            try (InputStream input = getContext().getAssets().open("pi-settings-fields.json")) {
                JSONArray fields = new JSONArray(read(input));
                for (int i = 0; i < fields.length(); i++) if (fields.getJSONObject(i).getString("key").equals(required(call, "key"))) field = fields.getJSONObject(i);
            }
            if (field == null) throw new IllegalArgumentException("未知配置字段");
            if (call.getBoolean("project", false) && field.optBoolean("globalOnly")) throw new IllegalArgumentException("此字段仅支持全局配置");
            PiSettingsActivity.validateField(field, ConfigJson.parse(source));
            store.updateSetting(call.getBoolean("project", false), required(call, "key"), source, required(call, "previous"));
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void resetSetting(PluginCall call) {
        try {
            initialize();
            boolean project = call.getBoolean("project", false);
            String original = store.read(project, "settings.json");
            requireRevision(original, required(call, "revision"));
            Map<String, Object> settings = ConfigJson.object(original);
            ConfigJson.set(settings, required(call, "key"), null, true);
            store.save(project, "settings.json", ConfigJson.encode(settings), original);
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void providers(PluginCall call) {
        try {
            initialize();
            JSONObject models = new JSONObject(store.read(false, "models.json"));
            JSONObject providers = models.optJSONObject("providers");
            JSONObject auth = new JSONObject(store.read(false, "auth.json"));
            JSONArray result = new JSONArray();
            if (providers != null) for (java.util.Iterator<String> ids = providers.keys(); ids.hasNext();) {
                String id = ids.next();
                result.put(new JSONObject().put("id", id).put("definition", safeDefinition(providers.getJSONObject(id)))
                        .put("credentialConfigured", auth.has(id) && !auth.isNull(id)));
            }
            call.resolve(js(new JSONObject().put("providers", result)
                    .put("modelsRevision", revision(store.read(false, "models.json")))
                    .put("authRevision", revision(store.read(false, "auth.json")))));
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void saveProvider(PluginCall call) {
        try {
            initialize();
            String id = required(call, "providerId");
            if (!id.matches("[A-Za-z0-9][A-Za-z0-9_-]*")) throw new IllegalArgumentException("服务商 ID 无效");
            JSONObject definition = call.getObject("definition");
            if (definition == null) throw new IllegalArgumentException("definition is required");
            ProviderConfig.validateBaseUrl(definition.optString("baseUrl"));
            if (definition.optString("api").isEmpty() || definition.optJSONArray("models") == null || definition.optJSONArray("models").length() == 0)
                throw new IllegalArgumentException("API 协议和模型不能为空");
            String modelsSource = store.read(false, "models.json");
            String authSource = store.read(false, "auth.json");
            requireRevision(modelsSource, required(call, "modelsRevision"));
            requireRevision(authSource, required(call, "authRevision"));
            Map<String, Object> models = ConfigJson.object(modelsSource);
            Map<String, Object> providers = models.get("providers") instanceof Map ? ConfigJson.asObject(models.get("providers")) : new LinkedHashMap<>();
            models.put("providers", providers);
            Map<String, Object> original = providers.get(id) instanceof Map ? ConfigJson.asObject(providers.get(id)) : new LinkedHashMap<>();
            Map<String, Object> next = new LinkedHashMap<>(original);
            for (String field : new String[]{"name", "baseUrl", "api"}) next.put(field, definition.optString(field));
            java.util.List<Object> updatedModels = new java.util.ArrayList<>();
            java.util.List<?> priorModels = original.get("models") instanceof java.util.List ? (java.util.List<?>) original.get("models") : java.util.Collections.emptyList();
            java.util.Set<String> modelIds = new java.util.HashSet<>();
            JSONArray incoming = definition.getJSONArray("models");
            for (int i = 0; i < incoming.length(); i++) {
                String modelId = incoming.getJSONObject(i).getString("id").trim();
                if (modelId.isEmpty() || !modelIds.add(modelId)) throw new IllegalArgumentException("模型 ID 不能为空或重复");
                Map<String, Object> model = new LinkedHashMap<>();
                for (Object previous : priorModels) if (previous instanceof Map && modelId.equals(ConfigJson.asObject(previous).get("id"))) model.putAll(ConfigJson.asObject(previous));
                model.put("id", modelId);
                if (!model.containsKey("name")) model.put("name", modelId);
                updatedModels.add(model);
            }
            next.put("models", updatedModels); providers.put(id, next);
            Map<String, Object> auth = ConfigJson.object(authSource);
            String key = call.getString("apiKey");
            if (key != null && !key.trim().isEmpty()) auth.put(id, ConfigJson.object(new JSONObject().put("type", "api_key").put("key", key.trim()).toString()));
            Map<String, String> updates = new LinkedHashMap<>(), originals = new LinkedHashMap<>();
            updates.put("models.json", ConfigJson.encode(models)); originals.put("models.json", modelsSource);
            updates.put("auth.json", ConfigJson.encode(auth)); originals.put("auth.json", authSource);
            store.saveTogether(updates, originals);
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void updateCredential(PluginCall call) {
        try {
            initialize();
            String id = required(call, "providerId");
            String authSource = store.read(false, "auth.json");
            requireRevision(authSource, required(call, "authRevision"));
            JSONObject auth = new JSONObject(authSource);
            String previous = auth.isNull(id) || !auth.has(id) ? null : auth.getJSONObject(id).toString();
            String key = call.getString("apiKey");
            String next = key == null || key.trim().isEmpty() ? null : new JSONObject().put("type", "api_key").put("key", key.trim()).toString();
            store.updateCredential(id, next, previous);
            call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void deleteProvider(PluginCall call) {
        try {
            initialize();
            String id = required(call, "providerId"), modelsSource = store.read(false, "models.json"), authSource = store.read(false, "auth.json");
            requireRevision(modelsSource, required(call, "modelsRevision"));
            requireRevision(authSource, required(call, "authRevision"));
            Map<String, Object> models = ConfigJson.object(modelsSource), auth = ConfigJson.object(authSource);
            if (models.get("providers") instanceof Map) ConfigJson.asObject(models.get("providers")).remove(id);
            auth.remove(id);
            Map<String, String> updates = new LinkedHashMap<>(), originals = new LinkedHashMap<>();
            updates.put("models.json", ConfigJson.encode(models)); originals.put("models.json", modelsSource);
            updates.put("auth.json", ConfigJson.encode(auth)); originals.put("auth.json", authSource);
            store.saveTogether(updates, originals); call.resolve();
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void query(PluginCall call) {
        try {
            initialize();
            String operation = required(call, "operation");
            if (!QUERIES.contains(operation)) throw new IllegalArgumentException("不支持的 Pi 操作");
            JSONObject arguments = call.getObject("arguments", new JSObject());
            validateQuery(operation, arguments);
            PiAgentBridge bridge = PiAgentBridge.get(getContext());
            PiConfigStore queryStore = store;
            synchronized (bridge) {
                if (destroyed) throw new IllegalStateException("设置页面已关闭");
                PendingQuery pending = new PendingQuery(bridge, operation);
                String id = bridge.query(operation, queryStore.snapshot(), arguments, queryStore, event -> {
                    String type = event.optString("type");
                    if ("auth_prompt".equals(type)) pending.promptId = event.optString("promptId");
                    if ("auth_prompt_end".equals(type) && event.optString("promptId").equals(pending.promptId)) pending.promptId = null;
                    if ("end".equals(type)) {
                        pending.ended = true;
                        queries.remove(event.optString("id"), pending);
                    }
                    if (!destroyed) notifyListeners("settingsEvent", js(event), true);
                });
                if (!pending.ended) queries.put(id, pending);
                if (destroyed) {
                    if (queries.remove(id, pending) && pending.cancellable) bridge.abort(id);
                    throw new IllegalStateException("设置页面已关闭");
                }
                call.resolve(js(new JSONObject().put("requestId", id).put("cancellable", pending.cancellable)));
            }
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void cancelQuery(PluginCall call) {
        try {
            String id = required(call, "requestId");
            PendingQuery pending = queries.get(id);
            if (pending != null) synchronized (pending.bridge) {
                if (queries.get(id) == pending && pending.cancellable) pending.bridge.abort(id);
            }
            call.resolve(); // Cancelling an already-ended request is harmless.
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void replyAuth(PluginCall call) {
        try {
            String id = required(call, "requestId"), promptId = required(call, "promptId");
            PendingQuery pending = queries.get(id);
            if (pending == null) throw new IllegalStateException("登录请求已结束");
            synchronized (pending.bridge) {
                if (queries.get(id) != pending || !pending.login || !promptId.equals(pending.promptId))
                    throw new IllegalStateException("登录提示已结束");
                pending.bridge.replyAuth(id, promptId, call.getString("value", ""), call.getBoolean("cancelled", false));
                pending.promptId = null;
                call.resolve();
            }
        } catch (Exception exception) { reject(call, exception); }
    }

    @PluginMethod public void publicSearch(PluginCall call) {
        okhttp3.Call previous = publicCall; if (previous != null) previous.cancel();
        worker.execute(() -> {
            try {
                String kind = call.getString("kind", "");
                okhttp3.Call request = SettingsCatalog.call(SettingsCatalog.searchUrl(call.getString("query", ""), kind,
                        call.getString("sort", "downloads"), call.getInt("offset", 0)));
                publicCall = request;
                JSONObject response = SettingsCatalog.readCatalog(request);
                if (publicCall == request) { publicCall = null; call.resolve(js(response)); }
            } catch (Exception exception) { if (!call.isReleased()) reject(call, exception); }
        });
    }

    @PluginMethod public void latestRelease(PluginCall call) {
        okhttp3.Call previous = publicCall; if (previous != null) previous.cancel();
        worker.execute(() -> {
            try {
                okhttp3.HttpUrl url = okhttp3.HttpUrl.parse("https://api.github.com/repos/FireSpoonYZ/e-launcher/releases/latest");
                okhttp3.Call request = SettingsCatalog.call(url); publicCall = request;
                JSONObject response = SettingsCatalog.read(request, true);
                if (response != null && (!response.optString("html_url").startsWith(SettingsCatalog.REPOSITORY + "/releases/") || response.optString("tag_name").isEmpty()))
                    throw new IllegalStateException("发布数据无效");
                if (publicCall == request) { publicCall = null; call.resolve(js(new JSONObject().put("release", response == null ? JSONObject.NULL : response))); }
            } catch (Exception exception) { if (!call.isReleased()) reject(call, exception); }
        });
    }

    private void initialize() throws Exception { initialize(null); }
    private void initialize(String requestedConversationId) throws Exception {
        SharedPreferences chat = getContext().getSharedPreferences("chat", Context.MODE_PRIVATE);
        String conversationId = requestedConversationId == null || requestedConversationId.isEmpty()
                ? chat.getString("active_chat", "legacy") : requestedConversationId;
        if (store == null || !conversationId.equals(store.conversationId())) {
            store = new PiConfigStore(getContext(), conversationId);
        }
        store.initialize(chat);
    }
    private static final class PendingQuery {
        final PiAgentBridge bridge;
        final boolean cancellable, login;
        boolean ended;
        String promptId;
        PendingQuery(PiAgentBridge bridge, String operation) {
            this.bridge = bridge;
            cancellable = !Arrays.asList("install", "update", "remove").contains(operation);
            login = "login".equals(operation);
        }
    }
    private SharedPreferences drafts() { return getContext().getSharedPreferences("settings_editor_drafts", Context.MODE_PRIVATE); }
    private String draftKey(boolean project, String name) {
        return (project ? "project/" + store.conversationId() + "/" : "global/") + name;
    }
    private EditorDraft draft(boolean project, String name) {
        String key = draftKey(project, name);
        SharedPreferences values = drafts();
        String legacy = "project/" + name;
        if (project && !values.contains(key) && values.contains(legacy)) {
            values.edit().putString(key, values.getString(legacy, ""))
                    .putString(key + "/base", values.getString(legacy + "/base", ""))
                    .remove(legacy).remove(legacy + "/base").apply();
        }
        return values.contains(key) ? new EditorDraft(values.getString(key, ""),
                values.getString(key + "/base", "")) : null;
    }
    private void clearDraft(boolean project, String name) {
        String key = draftKey(project, name);
        SharedPreferences.Editor edit = drafts().edit().remove(key).remove(key + "/base");
        if (project) edit.remove("project/" + name).remove("project/" + name + "/base");
        edit.apply();
    }
    private void migrateDrafts() {
        SharedPreferences target = drafts(); if (target.getBoolean("migrated", false)) return;
        SharedPreferences.Editor edit = target.edit();
        for (String oldName : new String[]{"PiSettingsActivity", PiSettingsActivity.class.getName()}) {
            for (Map.Entry<String, ?> item : getContext().getSharedPreferences(oldName, Context.MODE_PRIVATE).getAll().entrySet())
                if (item.getValue() instanceof String && !target.contains(item.getKey())) edit.putString(item.getKey(), (String) item.getValue());
        }
        edit.putBoolean("migrated", true).apply();
    }
    private boolean secretFile(boolean project, String name) throws Exception {
        java.io.File target = new java.io.File(store.directory(project), name).getCanonicalFile();
        java.io.File auth = new java.io.File(store.directory(false), "auth.json").getCanonicalFile();
        java.io.File projectAuth = new java.io.File(store.directory(true), "auth.json").getCanonicalFile();
        return target.getPath().equals(auth.getPath()) || target.getPath().startsWith(auth.getPath() + ".")
                || target.getPath().equals(projectAuth.getPath()) || target.getPath().startsWith(projectAuth.getPath() + ".");
    }
    private static JSONObject safeDefinition(JSONObject provider) throws Exception {
        JSONObject result = new JSONObject();
        for (String key : new String[]{"name", "baseUrl", "api"}) if (provider.has(key)) result.put(key, provider.get(key));
        JSONArray models = new JSONArray(), original = provider.optJSONArray("models");
        if (original != null) for (int i = 0; i < original.length(); i++) {
            JSONObject model = original.optJSONObject(i);
            if (model != null) models.put(new JSONObject().put("id", model.optString("id")).put("name", model.optString("name")));
        }
        return result.put("models", models);
    }
    private static String string(PluginCall call, String name) {
        String value = call.getString(name);
        if (value == null) throw new IllegalArgumentException(name + " is required");
        return value;
    }
    private static JSONObject maskedAuth(JSONObject auth) throws Exception {
        JSONObject result = new JSONObject(); if (auth == null) return result;
        for (java.util.Iterator<String> ids = auth.keys(); ids.hasNext();) { String id = ids.next(); result.put(id, NativeJson.object("configured", !auth.isNull(id))); }
        return result;
    }
    private static void validateQuery(String operation, JSONObject arguments) {
        if (Arrays.asList("test_provider", "login", "logout").contains(operation) && arguments.optString("providerId").isEmpty())
            throw new IllegalArgumentException("providerId is required");
        if (Arrays.asList("install", "update", "remove").contains(operation) && arguments.optString("source").trim().isEmpty())
            throw new IllegalArgumentException("source is required");
        if ("resource_toggle".equals(operation) && (arguments.optString("kind").isEmpty() || arguments.optString("path").isEmpty()))
            throw new IllegalArgumentException("kind and path are required");
    }
    private static String read(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
        for (int count; (count = input.read(buffer)) != -1;) output.write(buffer, 0, count);
        return output.toString(StandardCharsets.UTF_8.name());
    }
    private static String readBounded(InputStream input) throws Exception {
        if (input == null) throw new java.io.IOException("无法打开文件");
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
        for (int count; (count = input.read(buffer)) != -1;) {
            if (output.size() + count > ConfigJson.MAX_LENGTH * 4) throw new java.io.IOException("文件过大");
            output.write(buffer, 0, count);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }
    private static String revision(String source) throws Exception {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(); for (byte value : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", value));
        return result.toString();
    }
    private static void requireRevision(String source, String expected) throws Exception {
        if (!revision(source).equals(expected)) throw new java.io.IOException("配置已变化，请重新读取后修改");
    }
    private static String required(PluginCall call, String name) { String value = call.getString(name); if (value == null || value.isEmpty()) throw new IllegalArgumentException(name + " is required"); return value; }
    private static JSObject js(JSONObject value) { try { return JSObject.fromJSONObject(value); } catch (Exception exception) { throw new IllegalStateException(exception); } }
    private static void reject(PluginCall call, Exception exception) { call.reject(exception.getMessage(), exception); }
    private static final class EditorDraft { final String source, base; EditorDraft(String source, String base) { this.source = source; this.base = base; } }
}
