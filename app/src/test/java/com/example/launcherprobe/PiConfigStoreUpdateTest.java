package com.example.launcherprobe;

import android.content.Context;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = HostAtomicFile.class)
public class PiConfigStoreUpdateTest {
    @Test public void titleModelUsesSettingsSnapshotAndWorkspaceOverride() throws Exception {
        PiConfigStore store = new PiConfigStore(RuntimeEnvironment.getApplication());
        store.save(false, "settings.json", "{\"defaultModel\":\"chat-model\"}", null);
        store.save(true, "settings.json", "{}", null);
        String titleValue = "\"titles/small-model\"";
        PiSettingsActivity.validateField(new org.json.JSONObject().put("type", "string"),
                ConfigJson.parse(titleValue)); // Same scalar validation as SettingsPlugin.updateSetting.
        store.updateSetting(false, "conversationTitle.model", titleValue, "null");
        org.json.JSONObject snapshot = new org.json.JSONObject(store.snapshot());
        assertEquals("titles/small-model", snapshot.getJSONObject("settings")
                .getJSONObject("conversationTitle").getString("model"));
        assertEquals("chat-model", snapshot.getJSONObject("settings").getString("defaultModel"));
        store.updateSetting(true, "conversationTitle.model", "\"\"", "null");
        snapshot = new org.json.JSONObject(store.snapshot());
        assertEquals("", snapshot.getJSONObject("settings").getJSONObject("conversationTitle").getString("model"));
        assertEquals("titles/small-model", snapshot.getJSONObject("globalSettings")
                .getJSONObject("conversationTitle").getString("model"));
    }

    @Test public void bridgeSettingEventPersistsDeviceIdWithNullAndStringPreviousWithoutChangingCredentials() throws Exception {
        PiConfigStore store = new PiConfigStore(RuntimeEnvironment.getApplication());
        String id = "11111111-1111-4111-8111-111111111111";
        store.save(false, "auth.json", "{\"fixture\":{\"type\":\"api_key\",\"key\":\"synthetic-only\"}}", null);
        String auth = store.read(false, "auth.json");
        for (Object previous : new Object[] { JSONObject.NULL, "" }) {
            store.save(false, "settings.json", previous == JSONObject.NULL ? "{}" : "{\"deviceId\":\"\"}",
                    store.read(false, "settings.json"));
            JSONObject event = new JSONObject().put("type", "setting").put("project", false).put("key", "deviceId")
                    .put("value", id).put("previous", previous);
            PiAgentBridge.applySettingEvent(store, new JSONObject(event.toString()));
            assertEquals(id, store.settings(false).get("deviceId"));
            assertEquals(id, new JSONObject(store.snapshot()).getJSONObject("globalSettings").getString("deviceId"));
            assertThrows(java.io.IOException.class,
                    () -> PiAgentBridge.applySettingEvent(store, new JSONObject(event.toString())));
            event.put("previous", id); // String CAS must also accept an existing installation ID.
            PiAgentBridge.applySettingEvent(store, new JSONObject(event.toString()));
            assertEquals(id, new JSONObject(store.snapshot()).getJSONObject("globalSettings").getString("deviceId"));
            event.put("value", JSONObject.NULL);
            PiAgentBridge.applySettingEvent(store, new JSONObject(event.toString()));
            assertNull(store.settings(false).get("deviceId"));
            assertEquals(auth, store.read(false, "auth.json"));
        }
    }

    @Test public void pi100SettingsMetadataAcceptsMixedQuietStartupAndDefaultsToFullscreen() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        JSONArray fields;
        try (InputStream input = context.getAssets().open("pi-settings-fields.json")) {
            fields = new JSONArray(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
        JSONObject quiet = null, tui = null;
        for (int i = 0; i < fields.length(); i++) {
            JSONObject field = fields.getJSONObject(i);
            if (field.getString("key").equals("quietStartup")) quiet = field;
            if (field.getString("key").equals("tuiMode")) tui = field;
        }
        assertEquals("boolean or \"header\"", quiet.getString("type"));
        assertEquals("[false,true,\"header\"]", quiet.getJSONArray("options").toString());
        assertEquals(Boolean.FALSE, ConfigJson.parse(quiet.getString("default")));
        for (Object value : new Object[] { false, true, "header" }) PiSettingsActivity.validateField(quiet, value);
        JSONObject mixed = quiet;
        for (Object invalid : new Object[] { "true", "false", "other", 1, JSONObject.NULL }) {
            assertThrows(IllegalArgumentException.class, () -> PiSettingsActivity.validateField(mixed, invalid));
        }
        assertEquals("fullscreen", ConfigJson.parse(tui.getString("default")));
        assertFalse(tui.getString("description").contains("experimental"));
        PiSettingsActivity.validateField(tui, "fullscreen");
        PiSettingsActivity.validateField(tui, "regular");
        JSONObject terminal = tui;
        assertThrows(IllegalArgumentException.class, () -> PiSettingsActivity.validateField(terminal, "other"));
    }

    @Test public void updateSettingUsesSchemaPathInsteadOfCreatingDottedKey() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        PiConfigStore store = new PiConfigStore(context);
        Files.createDirectories(store.directory(false).toPath());
        Files.write(store.directory(false).toPath().resolve("settings.json"),
                "{\"compaction\":{\"reserveTokens\":100}}\n".getBytes(StandardCharsets.UTF_8));

        store.updateSetting(false, "compaction.reserveTokens", "200", "100");

        Map<String, Object> settings = store.settings(false);
        assertEquals("200", ConfigJson.get(settings, "compaction.reserveTokens").toString());
        assertFalse(settings.containsKey("compaction.reserveTokens"));
    }
}
