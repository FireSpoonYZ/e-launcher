package com.example.launcherprobe;

import android.content.Context;
import java.util.Map;

/** Real Android JsonReader + AtomicFile checks. Uses only the instrumentation package's private files. */
final class PiConfigChecks {
    static void run(Context context) throws Exception {
        String source = "{\"large\":9007199254740993123456789,\"tiny\":1e-9999,\"zero\":-0,"
                + "\"nested\":{\"unknown\":[true,null,\"中文\\ntext\"]}}";
        String pretty = ConfigJson.format(source);
        require(pretty.contains("9007199254740993123456789") && pretty.contains("1e-9999")
                && pretty.contains("-0"), "numeric tokens preserved exactly");
        require(pretty.endsWith("\n") && pretty.contains("\n  \"large\":"), "two-space format with newline");
        require(ConfigJson.format(pretty).equals(pretty), "formatting is idempotent");
        for (String invalid : new String[]{"{\"a\":1,}", "{a:1}", "{\"a\":01}", "{\"a\":true} junk", "[]", "{\"a\":1,\"a\":2}", "{/* comment */}"}) {
            boolean failed = false;
            try { ConfigJson.format(invalid); } catch (Exception expected) { failed = true; }
            require(failed, "invalid JSON rejected: " + invalid);
        }
        Map<String, Object> object = ConfigJson.object(source);
        ConfigJson.set(object, "compaction.enabled", true, false);
        require(ConfigJson.encode(object).contains("9007199254740993123456789"), "form patch preserves unknown numbers");
        Map<String, Object> merged = ConfigJson.merge(ConfigJson.object("{\"a\":{\"x\":true,\"y\":false},\"list\":[1] }"),
                ConfigJson.object("{\"a\":{\"y\":true},\"list\":[]}"));
        require(Boolean.TRUE.equals(ConfigJson.get(merged, "a.x")) && Boolean.TRUE.equals(ConfigJson.get(merged, "a.y")), "nested inheritance");
        require(((java.util.List<?>) merged.get("list")).isEmpty(), "project arrays replace global arrays");
        require(ConfigJson.sameValue(ConfigJson.object("{\"expires\":123,\"env\":{\"a\":\"b\"}}"),
                ConfigJson.object("{\"env\":{\"a\":\"b\"},\"expires\":123}")), "credential comparison ignores key order");
        require(!ConfigJson.sameValue(ConfigJson.object("{\"expires\":123}"), ConfigJson.object("{\"expires\":124}")),
                "credential comparison detects changed token expiry");
        org.json.JSONObject numeric = new org.json.JSONObject("{\"type\":\"number\",\"min\":3,\"max\":20}");
        PiSettingsActivity.validateField(numeric, ConfigJson.object("{\"value\":5}").get("value"));
        for (String invalid : new String[]{"2", "21", "3.5", "1e-9999", "true", "null"}) {
            boolean rejected = false;
            try { PiSettingsActivity.validateField(numeric, ConfigJson.object("{\"value\":" + invalid + "}").get("value")); }
            catch (IllegalArgumentException expected) { rejected = true; }
            require(rejected, "numeric control rejects invalid range/type: " + invalid);
        }
        boolean rejected = false;
        try { PiSettingsActivity.validateField(new org.json.JSONObject("{\"type\":\"string[]\"}"), java.util.Arrays.asList("ok", 1)); }
        catch (IllegalArgumentException expected) { rejected = true; }
        require(rejected, "string array rejects non-string elements");
        PiConfigStore store = new PiConfigStore(context);
        String name = "checks/" + java.util.UUID.randomUUID() + ".json";
        try {
            String initial = store.read(false, name);
            store.save(false, name, source, initial);
            require(store.read(false, name).equals(pretty), "atomic save formats");
            boolean failed = false;
            try { store.save(false, name, "{broken", pretty); } catch (Exception expected) { failed = true; }
            require(failed && store.read(false, name).equals(pretty), "invalid save preserves file");
            failed = false;
            try { store.save(false, name, "{}", initial); } catch (Exception expected) { failed = true; }
            require(failed && store.read(false, name).equals(pretty), "stale editor cannot overwrite newer file");
            store.save(false, name, "{\"new\":true}", pretty);
            require(store.previous(false, name).equals(pretty), "previous version recoverable");
            failed = false;
            try { store.read(false, "../../escape.json"); } catch (Exception expected) { failed = true; }
            require(failed, "path traversal rejected");
        } finally {
            new java.io.File(store.directory(false), name).delete();
            new java.io.File(store.directory(false), name + ".previous").delete();
        }
    }

    private static void require(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }
}
