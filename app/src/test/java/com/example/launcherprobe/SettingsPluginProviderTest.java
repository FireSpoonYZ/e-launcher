package com.example.launcherprobe;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import java.util.Map;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = {HostAtomicFile.class, SettingsPluginProviderTest.PluginHost.class})
public class SettingsPluginProviderTest {
    private static final String BASE_URL = "https://127.0.0.1:8895/fixture/v1";
    private static final String[] NAMES = {null, "", " \t\r\n ", "Fixture 显示名称", "  Padded name  "};
    private SettingsPlugin plugin;
    private PiConfigStore store;

    @Before public void setup() throws Exception {
        plugin = new SettingsPlugin();
        Context context = RuntimeEnvironment.getApplication();
        store = new PiConfigStore(context);
        store.initialize(context.getSharedPreferences("chat", Context.MODE_PRIVATE));
        store.save(false, "models.json", "{}", null);
        store.save(false, "auth.json", "{\"fixture\":{\"type\":\"api_key\",\"key\":\"saved-secret\"}}", null);
    }

    @After public void destroy() { plugin.handleOnDestroy(); }

    @Test public void newProvidersOmitMissingOrBlankNamesAndKeepNormalNames() throws Exception {
        for (String name : NAMES) {
            store.save(false, "models.json", "{}", null);
            JSObject definition = new JSObject().put("baseUrl", BASE_URL).put("api", "openai-completions")
                    .put("models", new JSONArray().put(new JSONObject().put("id", "fixture")));
            if (name != null) definition.put("name", name);
            RecordingCall save = save(definition, providers());
            assertNull(save.error);
            assertTrue(save.resolved);
            JSONObject saved = new JSONObject(store.read(false, "models.json")).getJSONObject("providers").getJSONObject("fixture");
            assertName(saved, name);
            assertName(projectedDefinition(providers()), name);
            assertEquals(BASE_URL, saved.getString("baseUrl"));
            assertEquals("fixture", saved.getJSONArray("models").getJSONObject(0).getString("id"));
        }
    }

    @Test public void clearingProjectedNamePreservesOtherProvidersAdvancedFieldsCredentialsAndCas() throws Exception {
        String original = """
                {"providers":{
                  "fixture":{"name":"Old name","baseUrl":"https://127.0.0.1:8895/fixture/v1","api":"openai-completions",
                    "headers":{"X-Provider":"preserved"},"models":[{"id":"fixture","name":"Model display name",
                    "contextWindow":123456,"maxTokens":4321,"cost":{"input":1e-3},"compat":{"supportsDeveloperRole":false}}]},
                  "other":{"name":"Other provider","baseUrl":"https://example.com/v1","api":"openai-completions",
                    "models":[{"id":"other-model"}]}}}
                """;
        for (String name : NAMES) {
            store.save(false, "models.json", original, null);
            String credentials = store.read(false, "auth.json");
            JSObject revisions = providers();
            JSObject definition = JSObject.fromJSONObject(projectedDefinition(revisions));
            definition.remove("name");
            if (name != null) definition.put("name", name);
            RecordingCall save = save(definition, revisions);
            assertNull(save.error);
            assertTrue(save.resolved);
            Map<String, Object> expected = ConfigJson.object(original);
            Map<String, Object> fixture = ConfigJson.asObject(ConfigJson.asObject(expected.get("providers")).get("fixture"));
            if (name == null || name.trim().isEmpty()) fixture.remove("name");
            else fixture.put("name", name);
            assertEquals(ConfigJson.encode(expected), store.read(false, "models.json"));
            assertEquals(credentials, store.read(false, "auth.json"));
            assertName(projectedDefinition(providers()), name);

            // Retrying with stale modelsRevision must still reject without modifying either file.
            String savedModels = store.read(false, "models.json");
            definition.put("name", "Stale overwrite");
            assertNotNull(save(definition, revisions).error);
            assertEquals(savedModels, store.read(false, "models.json"));
            assertEquals(credentials, store.read(false, "auth.json"));

            JSObject current = providers();
            store.save(false, "auth.json", "{\"fixture\":{\"type\":\"api_key\",\"key\":\"rotated-secret\"}}", null);
            assertNotNull(save(definition, current).error);
            assertEquals(savedModels, store.read(false, "models.json"));
            assertTrue(store.read(false, "auth.json").contains("rotated-secret"));
            store.save(false, "auth.json", credentials, null);
        }
    }

    private static void assertName(JSONObject definition, String name) throws Exception {
        if (name == null || name.trim().isEmpty()) assertFalse("Optional blank name must be omitted", definition.has("name"));
        else assertEquals(name, definition.getString("name"));
    }
    private static JSONObject projectedDefinition(JSObject result) throws Exception {
        JSONArray providers = result.getJSONArray("providers");
        for (int i = 0; i < providers.length(); i++) {
            JSONObject provider = providers.getJSONObject(i);
            if ("fixture".equals(provider.getString("id"))) return provider.getJSONObject("definition");
        }
        throw new AssertionError("Missing fixture provider");
    }
    private JSObject providers() {
        RecordingCall call = new RecordingCall("providers", new JSObject());
        plugin.providers(call);
        assertNull(call.error);
        return call.result;
    }
    private RecordingCall save(JSObject definition, JSObject revisions) throws Exception {
        RecordingCall call = new RecordingCall("saveProvider", new JSObject().put("providerId", "fixture")
                .put("definition", definition).put("modelsRevision", revisions.getString("modelsRevision"))
                .put("authRevision", revisions.getString("authRevision")));
        plugin.saveProvider(call);
        return call;
    }

    @Implements(value = Plugin.class, isInAndroidSdk = false)
    public static class PluginHost {
        @Implementation protected Context getContext() { return RuntimeEnvironment.getApplication(); }
    }
    private static class RecordingCall extends PluginCall {
        JSObject result;
        boolean resolved;
        String error;
        RecordingCall(String method, JSObject data) { super(null, "Settings", "test", method, data); }
        @Override public void resolve(JSObject value) { result = value; resolved = true; }
        @Override public void resolve() { resolved = true; }
        @Override public void reject(String message, Exception exception) { error = message; }
    }
}
