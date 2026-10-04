package com.example.launcherprobe;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
public class RemoteTerminalPluginTest {
    private final RemoteTerminalPlugin plugin = new RemoteTerminalPlugin();
    private Map<String, Object> owners;
    private final List<RemoteTerminalConnection> sockets = new ArrayList<>();

    private static Field field(Class<?> type, String name) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    @Before @SuppressWarnings("unchecked") public void setup() throws Exception {
        owners = (Map<String, Object>) field(RemoteTerminalPlugin.class, "connections").get(plugin);
        android.content.Context context = RuntimeEnvironment.getApplication();
        Files.write(new java.io.File(context.getNoBackupFilesDir(), "remote_terminal_hosts_v1.json").toPath(),
                new JSONObject().put("host", new JSONObject().put("clientId", "client")).toString()
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        field(RemoteTerminalPlugin.class, "store").set(plugin, new RemoteTerminalStore(context));
    }

    @After public void cleanup() {
        plugin.handleOnDestroy();
        for (RemoteTerminalConnection socket : sockets) socket.close("Test finished");
        shadowOf(Looper.getMainLooper()).idle();
    }

    private static final class Call extends PluginCall {
        int successes;
        final List<String> errors = new ArrayList<>();
        final List<JSObject> values = new ArrayList<>();
        Call() { super(null, "RemoteTerminal", "test", "connect", new JSObject().put("hostId", "host")); }
        @Override public void resolve(JSObject value) { successes++; values.add(value); }
        @Override public void reject(String message, String code) { errors.add(code); }
    }

    private static final class Wire extends OkHttpClient implements WebSocket {
        WebSocketListener listener;
        final List<JSONObject> sent = new ArrayList<>();
        boolean cancelled;
        @Override public WebSocket newWebSocket(Request request, WebSocketListener listener) {
            this.listener = listener;
            return this;
        }
        @Override public Request request() { return new Request.Builder().url("https://localhost").build(); }
        @Override public long queueSize() { return 0; }
        @Override public boolean send(String text) {
            try { sent.add(new JSONObject(text)); } catch (Exception e) { throw new AssertionError(e); }
            return true;
        }
        @Override public boolean send(ByteString bytes) { throw new AssertionError("No binary replay"); }
        @Override public boolean close(int code, String reason) { return true; }
        @Override public void cancel() { cancelled = true; }
        void open() { listener.onOpen(this, null); shadowOf(Looper.getMainLooper()).idle(); }
        void auth(String error) throws Exception {
            JSONObject response = new JSONObject().put("id", sent.get(0).getString("id"));
            if (error == null) response.put("result", new JSONObject().put("protocolVersion", 1));
            else response.put("error", new JSONObject().put("code", error).put("message", "secret must not escape"));
            listener.onMessage(this, response.toString());
            shadowOf(Looper.getMainLooper()).idle();
        }
    }

    @SuppressWarnings("unchecked") private Call listen() throws Exception {
        Call events = new Call();
        Map<String, List<PluginCall>> listeners = (Map<String, List<PluginCall>>)
                field(com.getcapacitor.Plugin.class, "eventListeners").get(plugin);
        listeners.put("terminalEvent", List.of(events));
        return events;
    }

    private Object install(Wire wire) throws Exception {
        Class<?> type = Class.forName(RemoteTerminalPlugin.class.getName() + "$HostConnection");
        Constructor<?> constructor = type.getDeclaredConstructors()[0];
        constructor.setAccessible(true);
        Object owner = constructor.newInstance(plugin, "host",
                new JSONObject().put("hostId", "host").put("clientId", "client"), "private-token");
        RemoteTerminalConnection socket = new RemoteTerminalConnection(new Handler(Looper.getMainLooper()),
                new JSONObject().put("address", "localhost").put("port", 7768),
                (RemoteTerminalConnection.Listener) owner, wire);
        field(type, "socket").set(owner, socket);
        sockets.add(socket);
        owners.put("host", owner);
        return owner;
    }

    @Test public void readinessDistinguishesSavedPendingAuthenticatedAndDisconnectedWithoutDialing() throws Exception {
        android.content.Context context = RuntimeEnvironment.getApplication();
        JSONObject host = new JSONObject().put("id", "host").put("name", "Fixture").put("address", "localhost")
                .put("port", 7768).put("fingerprint", "host").put("clientId", "client")
                .put("tokenCiphertext", "private-token").put("tokenIv", "private-iv");
        Files.writeString(new java.io.File(context.getNoBackupFilesDir(), "remote_terminal_hosts_v1.json").toPath(),
                new JSONObject().put("host", host).toString());
        Call saved = new Call(); plugin.readiness(saved); shadowOf(Looper.getMainLooper()).idle();
        assertEquals(1, saved.values.get(0).getInt("paired"));
        assertEquals(0, saved.values.get(0).getInt("connected"));
        assertTrue(owners.isEmpty());
        Wire wire = new Wire(); install(wire);
        Call pending = new Call(); plugin.readiness(pending); shadowOf(Looper.getMainLooper()).idle();
        assertEquals(0, pending.values.get(0).getInt("connected")); assertTrue(wire.sent.isEmpty());
        wire.open(); wire.auth(null);
        Call connected = new Call(); plugin.readiness(connected); shadowOf(Looper.getMainLooper()).idle();
        assertEquals(1, connected.values.get(0).getInt("connected"));
        assertEquals(2, connected.values.get(0).length());
        assertFalse(connected.values.get(0).toString().contains("private"));
        assertEquals(1, wire.sent.size()); // Only the explicit fixture authentication, no readiness request.
        plugin.handleOnStop();
        Call stopped = new Call(); plugin.readiness(stopped); shadowOf(Looper.getMainLooper()).idle();
        assertEquals(0, stopped.values.get(0).getInt("connected"));
    }

    @Test public void eightConcurrentConnectsJoinOneAuthentication() throws Exception {
        Wire wire = new Wire();
        install(wire);
        List<Call> calls = new ArrayList<>();
        for (int i = 0; i < 8; i++) { Call call = new Call(); calls.add(call); plugin.connect(call); }
        shadowOf(Looper.getMainLooper()).idle();
        for (Call call : calls) { assertEquals(0, call.successes); assertTrue(call.errors.isEmpty()); }
        wire.open();
        wire.auth(null);
        for (Call call : calls) { assertEquals(1, call.successes); assertTrue(call.errors.isEmpty()); }
        Call connected = new Call();
        plugin.connect(connected);
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(1, connected.successes);
        assertEquals(1, wire.sent.size());
        assertEquals("auth", wire.sent.get(0).getString("method"));
    }

    @Test public void staleCallbacksCannotRemoveOrAuthenticateReplacement() throws Exception {
        Wire old = new Wire();
        Object retired = install(old);
        Call pending = new Call();
        plugin.connect(pending);
        shadowOf(Looper.getMainLooper()).idle();
        old.open();
        Wire replacement = new Wire();
        Object current = install(replacement);
        Call events = listen();
        old.auth(null);
        ((RemoteTerminalConnection.Listener) retired).closed("Late close");
        ((RemoteTerminalConnection.Listener) retired).event(new JSONObject().put("event", "terminal.output"));
        assertSame(current, owners.get("host"));
        assertFalse(sockets.get(1).authenticated);
        assertEquals(0, pending.successes);
        assertEquals(List.of("CONNECT_FAILED"), pending.errors);
        assertTrue(replacement.sent.isEmpty());
        assertTrue(events.values.isEmpty());
    }

    @Test public void stopClosesNowNotTheNextForegroundSocketAndResumeRetiresOnlyStaleDial() throws Exception {
        Wire old = new Wire();
        install(old);
        Call pending = new Call();
        plugin.connect(pending);
        shadowOf(Looper.getMainLooper()).idle();
        plugin.handleOnStop();
        assertTrue(old.cancelled);
        assertEquals(List.of("CONNECT_FAILED"), pending.errors);
        Wire fresh = new Wire();
        Object current = install(fresh);
        shadowOf(Looper.getMainLooper()).idle();
        plugin.handleOnResume();
        assertSame(current, owners.get("host"));
        assertFalse(fresh.cancelled);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        plugin.handleOnResume();
        assertTrue(fresh.cancelled);
        assertTrue(owners.isEmpty());
    }

    @Test public void authRejectionAndTimeoutSettleAllWaitersWithoutMutationReplay() throws Exception {
        for (String failure : new String[] { "UNAUTHORIZED", "CLIENT_ID_IN_USE", "timeout" }) {
            Wire wire = new Wire();
            install(wire);
            Call events = listen();
            Call first = new Call(), second = new Call();
            plugin.connect(first); plugin.connect(second);
            shadowOf(Looper.getMainLooper()).idle();
            wire.open();
            if ("timeout".equals(failure)) shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(31));
            else wire.auth(failure);
            String expected = "UNAUTHORIZED".equals(failure) ? failure : "CONNECT_FAILED";
            assertEquals(List.of(expected), first.errors);
            assertEquals(List.of(expected), second.errors);
            assertEquals(1, events.values.size());
            JSObject event = events.values.get(0);
            assertEquals("host", event.getString("hostId"));
            assertEquals("connection", event.getString("event"));
            assertEquals("disconnected", event.getString("state"));
            assertEquals(expected, event.getString("code"));
            assertFalse(event.getString("message").contains("secret"));
            assertTrue(owners.isEmpty());
            assertEquals(1, wire.sent.size());
            assertEquals("auth", wire.sent.get(0).getString("method"));
            assertTrue(wire.cancelled);
        }
    }

    @Test public void dialTimeoutClearsWaitersAndResumePreservesAuthenticatedSocket() throws Exception {
        Wire dial = new Wire();
        install(dial);
        Call waiting = new Call();
        plugin.connect(waiting);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(21));
        assertEquals(List.of("CONNECT_FAILED"), waiting.errors);
        assertTrue(owners.isEmpty());
        Wire connected = new Wire();
        Object current = install(connected);
        connected.open();
        connected.auth(null);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3));
        plugin.handleOnResume();
        assertSame(current, owners.get("host"));
        assertFalse(connected.cancelled);
    }

    @Test public void transportFailureEventAndConnectRejectionCarryTheSameCode() throws Exception {
        Throwable[] failures = { new RemoteTerminalTls.PinMismatchException(),
                new java.security.cert.CertificateExpiredException("private certificate details"),
                new java.net.ConnectException("private address") };
        String[] codes = { "PIN_MISMATCH", "CERTIFICATE_INVALID", "CONNECT_FAILED" };
        for (int i = 0; i < failures.length; i++) {
            Wire wire = new Wire();
            install(wire);
            Call events = listen(), pending = new Call();
            plugin.connect(pending);
            shadowOf(Looper.getMainLooper()).idle();
            wire.listener.onFailure(wire, failures[i], null);
            shadowOf(Looper.getMainLooper()).idle();
            assertEquals(List.of(codes[i]), pending.errors);
            assertEquals(1, events.values.size());
            assertEquals(codes[i], events.values.get(0).getString("code"));
            assertEquals("disconnected", events.values.get(0).getString("state"));
            assertFalse(events.values.get(0).getString("message").contains("private"));
            assertTrue(owners.isEmpty());
        }
    }

    @Test public void tlsIdentityCertificateAndNetworkFailuresHaveDistinctSanitizedCodes() {
        javax.net.ssl.SSLHandshakeException handshake = new javax.net.ssl.SSLHandshakeException("TLS");
        handshake.initCause(new java.security.cert.CertificateException(new RemoteTerminalTls.PinMismatchException()));
        assertEquals("PIN_MISMATCH", RemoteTerminalConnection.failureCode(handshake));
        assertEquals("CERTIFICATE_INVALID", RemoteTerminalConnection.failureCode(new java.security.cert.CertificateExpiredException()));
        assertEquals("CONNECT_FAILED", RemoteTerminalConnection.failureCode(new java.net.ConnectException("private address")));
    }
}
