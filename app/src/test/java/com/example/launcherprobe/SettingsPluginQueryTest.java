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
        plugin = new SettingsPlugin();
    }

    @After public void destroy() { plugin.handleOnDestroy(); }

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
        for (String operation : new String[]{"install", "update", "remove"}) {
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
        RecordingCall(JSObject data) { super(null, "Settings", "test", "query", data); }
        @Override public void resolve(JSObject value) { result = value; resolved = true; }
        @Override public void resolve() { resolved = true; }
        @Override public void reject(String message, Exception exception) { error = message; }
    }
}
