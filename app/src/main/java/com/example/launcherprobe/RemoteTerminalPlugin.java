package com.example.launcherprobe;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;

@CapacitorPlugin(name = "RemoteTerminal")
public final class RemoteTerminalPlugin extends Plugin {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, HostConnection> connections = new HashMap<>();
    private final Map<String, RemoteTerminalConnection> pairings = new HashMap<>();
    private RemoteTerminalStore store;
    private boolean destroyed;

    @Override public void load() { store = new RemoteTerminalStore(getContext()); }

    @PluginMethod public void setTerminalPage(PluginCall call) {
        run(call, () -> {
            String token = RemoteTerminalProtocol.text(call.getData(), "token", 128);
            if (!(call.getData().opt("active") instanceof Boolean))
                throw new IllegalArgumentException("Invalid active");
            if (!(getActivity() instanceof MainActivity))
                throw new IllegalArgumentException("Terminal page requires MainActivity");
            ((MainActivity) getActivity()).setTerminalPage(token, call.getBoolean("active", false));
            call.resolve();
        });
    }

    @PluginMethod public void readClipboard(PluginCall call) {
        handler.post(() -> {
            try {
                android.content.ClipboardManager clipboard = (android.content.ClipboardManager)
                        getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                android.content.ClipData clip = clipboard.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) {
                    call.resolve(new JSObject().put("text", "")); return;
                }
                CharSequence text = clip.getItemAt(0).getText();
                if (text == null) throw new IllegalArgumentException("Clipboard has no text");
                if (text.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 65536)
                    throw new IllegalArgumentException("Clipboard exceeds 64 KiB");
                call.resolve(new JSObject().put("text", text.toString()));
            } catch (Exception failure) {
                call.reject("Clipboard read failed or text exceeds 64 KiB", "CLIPBOARD_ERROR");
            }
        });
    }

    @PluginMethod public void writeClipboard(PluginCall call) {
        handler.post(() -> {
            try {
                Object text = call.getData().opt("text");
                if (!(text instanceof String) || ((String) text).length() > 1024 * 1024)
                    throw new IllegalArgumentException("Invalid clipboard text");
                android.content.ClipboardManager clipboard = (android.content.ClipboardManager)
                        getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Terminal", (String) text));
                call.resolve();
            } catch (Exception failure) { call.reject("Clipboard write failed", "CLIPBOARD_ERROR"); }
        });
    }

    private interface Operation { void run() throws Exception; }
    private void run(PluginCall call, Operation operation) {
        handler.post(() -> {
            if (destroyed) { call.reject("Terminal plugin destroyed", "DISCONNECTED"); return; }
            try { operation.run(); }
            catch (Exception failure) {
                // Validation messages are native-owned; storage/crypto errors get no secret-bearing details.
                call.reject(failure instanceof IllegalArgumentException ? failure.getMessage()
                        : "Terminal operation failed; check pairing or remove host and pair again", "TERMINAL_ERROR");
            }
        });
    }
    private static void resolve(PluginCall call, JSONObject value) throws Exception {
        call.resolve(JSObject.fromJSONObject(value));
    }
    private static String hostId(PluginCall call) throws Exception {
        return RemoteTerminalProtocol.text(call.getData(), "hostId", 256);
    }

    @PluginMethod public void loadShortcuts(PluginCall call) {
        run(call, () -> {
            try {
                String value = TerminalShortcutStore.read(getContext());
                resolve(call, new JSONObject().put("value", value == null ? JSONObject.NULL : value));
            } catch (Exception failure) { call.reject("Could not read saved terminal shortcuts", "STORAGE_ERROR"); }
        });
    }

    @PluginMethod public void saveShortcuts(PluginCall call) {
        run(call, () -> {
            try {
                if (!call.getData().has("value")) throw new IllegalArgumentException("Missing shortcut value");
                Object value = call.getData().get("value");
                if (value != JSONObject.NULL && !(value instanceof String)) throw new IllegalArgumentException("Invalid shortcut value");
                TerminalShortcutStore.write(getContext(), value == JSONObject.NULL ? null : (String) value);
                call.resolve();
            } catch (Exception failure) { call.reject("Could not save terminal shortcuts", "STORAGE_ERROR"); }
        });
    }

    @PluginMethod public void listHosts(PluginCall call) {
        run(call, () -> resolve(call, new JSONObject().put("hosts", store.hosts())));
    }

    @PluginMethod public void pair(PluginCall call) {
        run(call, () -> {
            JSONObject data = call.getData();
            String override = data.has("address") ? RemoteTerminalProtocol.text(data, "address", 253) : null;
            JSONObject descriptor = RemoteTerminalProtocol.descriptor(
                    RemoteTerminalProtocol.text(data, "descriptor", 16384), override);
            String name = data.has("deviceName") ? RemoteTerminalProtocol.text(data, "deviceName", 256) : "Android";
            String id = descriptor.getString("fingerprint");
            if (pairings.containsKey(id)) throw new IllegalArgumentException("Pairing already in progress");
            RemoteTerminalConnection connection = new RemoteTerminalConnection(handler, descriptor,
                    new RemoteTerminalConnection.Listener() {
                        private boolean settled;
                        @Override public void opened() {
                            RemoteTerminalConnection current = pairings.get(id);
                            if (current == null) return;
                            try {
                                current.send("pair", new JSONObject().put("code", descriptor.getString("code"))
                                        .put("deviceName", name), (result, code, message) -> {
                                    if (settled) return;
                                    settled = true;
                                    try {
                                        if (code != null || !(result instanceof JSONObject))
                                            throw new IllegalArgumentException("Pairing rejected or timed out");
                                        JSONObject response = (JSONObject) result;
                                        String token = RemoteTerminalProtocol.text(response, "token", 8192);
                                        String hostName = RemoteTerminalProtocol.text(response, "hostName", 256);
                                        JSONObject record = store.save(descriptor, hostName, token);
                                        disconnectHost(id);
                                        resolve(call, new JSONObject().put("host", RemoteTerminalStore.publicHost(record)));
                                    } catch (Exception failure) {
                                        call.reject("Pairing failed; check the descriptor or create a new pairing code", "PAIR_FAILED");
                                    } finally { current.close("Pairing finished"); }
                                });
                            } catch (Exception failure) { current.close("Pairing failed"); }
                        }
                        @Override public void event(JSONObject event) { }
                        @Override public void closed(String message) {
                            pairings.remove(id);
                            if (!settled) { settled = true; call.reject(message, "PAIR_FAILED"); }
                        }
                    });
            pairings.put(id, connection);
        });
    }

    @PluginMethod public void removeHost(PluginCall call) {
        run(call, () -> {
            String id = hostId(call);
            RemoteTerminalConnection pairing = pairings.get(id);
            if (pairing != null) pairing.close("Host removed");
            disconnectHost(id);
            store.remove(id);
            call.resolve(new JSObject());
        });
    }

    @PluginMethod public void connect(PluginCall call) {
        run(call, () -> {
            String id = hostId(call);
            JSONObject host = store.host(id);
            String clientId = host.getString("clientId");
            JSONObject result = new JSONObject().put("hostId", id).put("clientId", clientId);
            HostConnection existing = connections.get(id);
            if (existing != null) {
                existing.join(call);
                return;
            }
            HostConnection owner = new HostConnection(id, result, store.token(host));
            owner.socket = new RemoteTerminalConnection(handler, host, owner);
            connections.put(id, owner);
            owner.join(call);
        });
    }

    /** One owner per physical handshake; late callbacks never act on a replacement. */
    private final class HostConnection implements RemoteTerminalConnection.Listener {
        final String id;
        final JSONObject result;
        final String token;
        final long startedAt = SystemClock.elapsedRealtime();
        final List<PluginCall> waiting = new ArrayList<>();
        RemoteTerminalConnection socket;
        boolean settled;

        HostConnection(String id, JSONObject result, String token) {
            this.id = id;
            this.result = result;
            this.token = token;
        }

        boolean current() { return connections.get(id) == this; }

        void join(PluginCall call) throws Exception {
            if (socket.authenticated) resolve(call, result);
            else waiting.add(call);
        }

        @Override public void opened() {
            if (!current()) return;
            try {
                socket.send("auth", new JSONObject().put("token", token)
                        .put("clientId", result.getString("clientId")).put("clientType", "mobile"),
                        this::authenticated);
            } catch (Exception failure) { socket.close("Invalid authentication response", "PROTOCOL"); }
        }

        private void authenticated(Object value, String code, String message) {
            if (!current() || settled) return;
            if (code != null) {
                if ("UNAUTHORIZED".equals(code))
                    socket.close("Terminal authorization revoked; pair this host again", "UNAUTHORIZED");
                else socket.close("Terminal handshake interrupted; reconnect when the host is available", "CONNECT_FAILED");
                return;
            }
            try {
                if (!(value instanceof JSONObject)) throw new IllegalArgumentException();
                RemoteTerminalProtocol.integer((JSONObject) value, "protocolVersion", 1, 1);
                socket.authenticated = true;
                settled = true;
                for (PluginCall call : waiting) resolve(call, result);
                waiting.clear();
                connectionEvent(id, "connected", null, null);
            } catch (Exception failure) { socket.close("Invalid authentication response", "PROTOCOL"); }
        }

        @Override public void event(JSONObject event) {
            if (!current()) return;
            try {
                event.put("hostId", id);
                notifyListeners("terminalEvent", JSObject.fromJSONObject(event));
            } catch (Exception failure) { socket.close("Invalid terminal event", "PROTOCOL"); }
        }

        @Override public void closed(String message) {
            settled = true;
            for (PluginCall call : waiting) call.reject(message, socket.failureCode);
            waiting.clear();
            if (!current()) return;
            connections.remove(id);
            connectionEvent(id, "disconnected", message, socket.failureCode);
        }
    }

    @PluginMethod public void disconnect(PluginCall call) {
        run(call, () -> { disconnectHost(hostId(call)); call.resolve(new JSObject()); });
    }

    @PluginMethod public void request(PluginCall call) {
        run(call, () -> {
            String id = hostId(call);
            String method = RemoteTerminalProtocol.text(call.getData(), "method", 64);
            JSONObject params = call.getData().getJSONObject("params");
            RemoteTerminalProtocol.request(method, params);
            HostConnection owner = connections.get(id);
            RemoteTerminalConnection connection = owner == null ? null : owner.socket;
            if (connection == null || !connection.authenticated) {
                call.reject("Terminal is not connected", "DISCONNECTED");
                return;
            }
            connection.send(method, params, (result, code, message) -> {
                if (code != null) call.reject(message, code);
                else {
                    try { resolve(call, new JSONObject().put("result", result)); }
                    catch (Exception failure) { call.reject("Invalid terminal response", "PROTOCOL"); }
                }
            });
        });
    }

    private void disconnectHost(String id) {
        HostConnection owner = connections.get(id);
        if (owner != null) owner.socket.close("Terminal disconnected");
    }

    private void connectionEvent(String id, String state, String message, String code) {
        JSObject event = new JSObject();
        event.put("hostId", id);
        event.put("event", "connection");
        event.put("state", state);
        if (message != null) event.put("message", message);
        if (code != null) event.put("code", code);
        notifyListeners("terminalEvent", event);
    }

    private void closeAll() {
        for (HostConnection owner : connections.values().toArray(new HostConnection[0]))
            owner.socket.close("App backgrounded; reconnect and subscribe to restore");
        for (RemoteTerminalConnection connection : pairings.values().toArray(new RemoteTerminalConnection[0]))
            connection.close("Pairing cancelled");
    }

    // Capacitor lifecycle hooks run on main; do not queue a close behind a new foreground connect.
    @Override protected void handleOnStop() { closeAll(); }
    @Override protected void handleOnResume() {
        for (HostConnection owner : connections.values().toArray(new HostConnection[0])) {
            if (!owner.socket.authenticated && SystemClock.elapsedRealtime() - owner.startedAt >= 2000)
                owner.socket.close("Foreground interrupted a stale handshake; reconnect", "CONNECT_FAILED");
        }
    }
    @Override protected void handleOnDestroy() {
        destroyed = true;
        closeAll();
    }
}
