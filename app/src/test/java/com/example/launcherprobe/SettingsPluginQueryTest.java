package com.example.launcherprobe;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
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
import org.robolectric.util.ReflectionHelpers;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = {HostAtomicFile.class, SettingsPluginQueryTest.PluginHost.class,
        SettingsPluginQueryTest.BridgeShadow.class})
public class SettingsPluginQueryTest {
    private SettingsPlugin plugin;

    @Before public void setup() {
        BridgeShadow.instance = null;
        BridgeShadow.listeners.clear();
        BridgeShadow.aborted.clear();
        BridgeShadow.replies.clear();
        BridgeShadow.fastEnd = false;
        BridgeShadow.failStart = false;
        BridgeShadow.duringStart = null;
        BridgeShadow.fileArguments = null;
        plugin = new SettingsPlugin();
    }

    @After public void destroy() { plugin.handleOnDestroy(); }

    @Test public void mcpOperationsUseSettingsWireAndOAuthOwnsItsPrompt() throws Exception {
        for (String operation : new String[]{"mcp_list", "mcp_edit", "mcp_save", "mcp_toggle", "mcp_remove", "mcp_check", "mcp_logout"}) {
            RecordingCall call = query(operation);
            assertNull(call.error);
            assertTrue(call.result.getBoolean("cancellable"));
        }
        String login = start("mcp_login");
        BridgeShadow.prompt(login, "mcp-redirect", "auth_prompt");
        assertNull(reply(login, "mcp-redirect").error);
        assertNotNull(reply(login, "mcp-redirect").error);
        cancel(login);
        assertTrue(BridgeShadow.aborted.contains(login));
    }

    @Test public void wholeMcpFileAliasSaveUsesTheNodeQueryInsteadOfJavaWrite() throws Exception {
        PiConfigStore store = new PiConfigStore(RuntimeEnvironment.getApplication());
        store.save(false, "mcp.json", "{}", null);
        String original = store.read(false, "mcp.json");
        RecordingCall call = new RecordingCall(new JSObject().put("name", "./mcp.json")
                .put("source", "{\"number\":1e+02}").put("expected", original));
        plugin.saveFile(call);
        assertTrue(call.finished.await(5, java.util.concurrent.TimeUnit.SECONDS));
        assertNull(call.error);
        assertEquals("./mcp.json", BridgeShadow.fileArguments.getString("name"));
        assertEquals(original, BridgeShadow.fileArguments.getString("expected"));
        assertTrue(BridgeShadow.fileArguments.getString("source").contains("1e+02"));
        assertEquals(original, store.read(false, "mcp.json"));
    }

    @Test public void legacyProjectWriteRequestsAreRejectedWithoutChangingEitherScope() throws Exception {
        PiConfigStore store = new PiConfigStore(RuntimeEnvironment.getApplication());
        store.save(false, "settings.json", "{\"theme\":\"dark\"}", null);
        store.save(true, "settings.json", "{\"theme\":\"legacy-project\"}", null);
        String global = store.read(false, "settings.json"), project = store.read(true, "settings.json");
        for (String operation : new String[]{"install", "update", "remove"}) {
            RecordingCall call = new RecordingCall(new JSObject().put("operation", operation).put("arguments",
                    new JSObject().put("source", "npm:test").put("project", true)));
            plugin.query(call); assertTrue(call.error.contains("全局"));
        }
        RecordingCall file = new RecordingCall(new JSObject().put("project", true).put("name", "settings.json")
                .put("source", "{}").put("expected", project));
        plugin.saveFile(file); assertTrue(file.error.contains("全局"));
        RecordingCall update = new RecordingCall(new JSObject().put("project", true).put("key", "theme").put("value", "\"light\"").put("previous", "\"legacy-project\""));
        plugin.updateSetting(update); assertTrue(update.error.contains("全局"));
        RecordingCall reset = new RecordingCall(new JSObject().put("project", true).put("key", "theme").put("revision", "ignored"));
        plugin.resetSetting(reset); assertTrue(reset.error.contains("全局"));
        RecordingCall mcp = new RecordingCall(new JSObject().put("operation", "mcp_file_save").put("arguments",
                new JSObject().put("scope", "project").put("name", "./mcp.json").put("source", "{}").put("expected", "{}")));
        plugin.query(mcp); assertTrue(mcp.error.contains("全局"));
        assertEquals(global, store.read(false, "settings.json"));
        assertEquals(project, store.read(true, "settings.json"));
        assertTrue(BridgeShadow.listeners.isEmpty());
    }

    @Test public void parallelRequestsCancelOnlySpecifiedIdAndOldEndDoesNotClearNewRequest() throws Exception {
        String old = start("catalog"), login = start("login");
        cancel(old);
        assertEquals(List.of(old), BridgeShadow.aborted);
        BridgeShadow.emit(old, "end");
        cancel(old);
        cancel(login);
        assertEquals(List.of(old, login), BridgeShadow.aborted);
        BridgeShadow.emit(old, "end");
        cancel(login);
        assertEquals(List.of(old, login, login), BridgeShadow.aborted);
        BridgeShadow.emit(login, "end");
        cancel(login);
        assertEquals(3, BridgeShadow.aborted.size());
    }

    @Test public void missingOrForeignIdsCannotCancelAnotherRequest() throws Exception {
        String login = start("login");
        RecordingCall missing = new RecordingCall(new JSObject());
        plugin.cancelQuery(missing);
        assertNotNull(missing.error);
        cancel("foreign");
        assertTrue(BridgeShadow.aborted.isEmpty());
        cancel(login);
        assertEquals(List.of(login), BridgeShadow.aborted);
    }

    @Test public void packageMutationsCannotBeCancelledEvenOnDestroy() throws Exception {
        for (String operation : new String[]{"install", "update", "remove", "mcp_file_save"}) {
            RecordingCall call = query(operation);
            assertFalse(call.result.getBoolean("cancellable"));
            cancel(call.result.getString("requestId"));
        }
        String first = start("login"), second = start("resources");
        plugin.handleOnDestroy();
        assertEquals(2, BridgeShadow.aborted.size());
        assertTrue(BridgeShadow.aborted.containsAll(List.of(first, second)));
        assertNotNull(query("catalog").error);
    }

    @Test public void immediateCompletionAndStartupFailureLeaveNoCancellableEntry() throws Exception {
        BridgeShadow.fastEnd = true;
        String completed = start("catalog");
        cancel(completed);
        BridgeShadow.fastEnd = false;
        BridgeShadow.failStart = true;
        assertNotNull(query("login").error);
        cancel("q2");
        BridgeShadow.failStart = false;
        String active = start("login");
        cancel(active);
        assertEquals(List.of(active), BridgeShadow.aborted);
    }

    @Test public void destructionDuringStartupDoesNotLeaveAnUntrackedRequest() throws Exception {
        BridgeShadow.duringStart = plugin::handleOnDestroy;
        assertNotNull(query("login").error);
        assertEquals(List.of("q1"), BridgeShadow.aborted);
        cancel("q1");
        assertEquals(1, BridgeShadow.aborted.size());
    }

    @Test public void authRepliesRequireOwnedLoginAndItsCurrentPrompt() throws Exception {
        String login = start("login"), other = start("login"), catalog = start("catalog");
        BridgeShadow.prompt(login, "prompt-a", "auth_prompt");
        BridgeShadow.prompt(other, "prompt-b", "auth_prompt");
        assertNotNull(reply(login, "prompt-b").error);
        assertNotNull(reply("foreign", "prompt-a").error);
        assertNotNull(reply(catalog, "prompt-a").error);
        BridgeShadow.prompt(login, "stale", "auth_prompt_end");
        assertNull(reply(login, "prompt-a").error);
        assertNotNull(reply(login, "prompt-a").error);
        BridgeShadow.emit(login, "end");
        assertNull(reply(other, "prompt-b").error);
        BridgeShadow.prompt(other, "prompt-c", "auth_prompt");
        BridgeShadow.prompt(other, "prompt-c", "auth_prompt_end");
        assertNotNull(reply(other, "prompt-c").error);
        assertEquals(List.of(login + "/prompt-a", other + "/prompt-b"), BridgeShadow.replies);
    }

    private RecordingCall query(String operation) {
        RecordingCall call = new RecordingCall(new JSObject().put("operation", operation).put("arguments",
                new JSObject().put("providerId", "test").put("source", "npm:test")));
        plugin.query(call);
        return call;
    }
    private String start(String operation) throws Exception {
        RecordingCall call = query(operation);
        assertNull(call.error);
        assertNotNull(call.result);
        return call.result.getString("requestId");
    }
    private void cancel(String id) {
        RecordingCall call = new RecordingCall(new JSObject().put("requestId", id));
        plugin.cancelQuery(call);
        assertNull(call.error);
        assertTrue(call.resolved);
    }
    private RecordingCall reply(String id, String promptId) {
        RecordingCall call = new RecordingCall(new JSObject().put("requestId", id).put("promptId", promptId).put("value", "secret"));
        plugin.replyAuth(call);
        return call;
    }

    @Implements(value = Plugin.class, isInAndroidSdk = false)
    public static class PluginHost {
        @Implementation protected Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Implementation protected void notifyListeners(String event, JSObject data, boolean retain) { }
    }

    @Implements(value = PiAgentBridge.class, isInAndroidSdk = false)
    public static class BridgeShadow {
        static PiAgentBridge instance;
        static final Map<String, PiAgentBridge.Listener> listeners = new LinkedHashMap<>();
        static final List<String> aborted = new ArrayList<>(), replies = new ArrayList<>();
        static boolean fastEnd, failStart;
        static Runnable duringStart;
        static JSONObject fileArguments;
        @Implementation protected void __constructor__(Context context) { }
        @Implementation protected static PiAgentBridge get(Context context) {
            if (instance == null) instance = ReflectionHelpers.callConstructor(PiAgentBridge.class,
                    ReflectionHelpers.ClassParameter.from(Context.class, context));
            return instance;
        }
        @Implementation protected String query(String type, String config, JSONObject arguments,
                PiConfigStore store, PiAgentBridge.Listener listener) throws Exception {
            String id = "q" + (listeners.size() + 1);
            listeners.put(id, listener);
            if ("mcp_file_save".equals(type)) {
                fileArguments = arguments;
                listener.event(new JSONObject().put("id", id).put("type", "result")
                        .put("result", new JSONObject().put("source", arguments.getString("source"))));
                emit(id, "end");
                return id;
            }
            if (duringStart != null) duringStart.run();
            if (fastEnd || failStart) emit(id, "end");
            if (failStart) throw new IllegalStateException("send failed");
            return id;
        }
        @Implementation protected void abort(String id) { aborted.add(id); }
        @Implementation protected void replyAuth(String id, String promptId, String value, boolean cancelled) {
            replies.add(id + "/" + promptId);
        }
        static void emit(String id, String type) throws Exception {
            synchronized (instance) { listeners.get(id).event(new JSONObject().put("id", id).put("type", type)); }
        }
        static void prompt(String id, String promptId, String type) throws Exception {
            synchronized (instance) { listeners.get(id).event(new JSONObject().put("id", id).put("type", type).put("promptId", promptId)); }
        }
    }

    private static class RecordingCall extends PluginCall {
        JSObject result;
        boolean resolved;
        String error;
        final java.util.concurrent.CountDownLatch finished = new java.util.concurrent.CountDownLatch(1);
        RecordingCall(JSObject data) { super(null, "Settings", "test", "query", data); }
        @Override public void resolve(JSObject value) { result = value; resolved = true; finished.countDown(); }
        @Override public void resolve() { resolved = true; }
        @Override public void reject(String message, Exception exception) { error = message; finished.countDown(); }
    }
}
