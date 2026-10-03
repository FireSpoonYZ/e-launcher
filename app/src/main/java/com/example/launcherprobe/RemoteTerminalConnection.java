package com.example.launcherprobe;

import android.os.Handler;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** One physical socket. All state/callbacks belong to the plugin's main Handler. */
final class RemoteTerminalConnection {
    interface Listener {
        void opened();
        void event(JSONObject event);
        void closed(String message);
    }

    private final Handler handler;
    private final Listener listener;
    private final OkHttpClient client;
    private final RemoteTerminalRequests requests;
    private final AtomicInteger queuedBytes = new AtomicInteger();
    private final AtomicInteger queuedMessages = new AtomicInteger();
    private final Runnable dialTimeout;
    private WebSocket socket;
    private boolean closed;
    private boolean open;
    boolean authenticated;
    String failureCode = "CONNECT_FAILED";

    RemoteTerminalConnection(Handler handler, JSONObject host, Listener listener) throws Exception {
        this(handler, host, listener, RemoteTerminalTls.client(host.getString("fingerprint")));
    }

    RemoteTerminalConnection(Handler handler, JSONObject host, Listener listener, OkHttpClient client) throws Exception {
        this.handler = handler;
        this.listener = listener;
        this.requests = new RemoteTerminalRequests(handler);
        this.client = client;
        dialTimeout = () -> close("Terminal connection timed out");
        handler.postDelayed(dialTimeout, 20000);
        socket = client.newWebSocket(new Request.Builder().url(RemoteTerminalProtocol.url(host)).build(),
                new WebSocketListener() {
                    @Override public void onOpen(WebSocket webSocket, Response response) {
                        handler.post(() -> {
                            if (closed) return;
                            handler.removeCallbacks(dialTimeout);
                            open = true;
                            listener.opened();
                        });
                    }
                    @Override public void onMessage(WebSocket webSocket, String text) {
                        int bytes = text.getBytes(StandardCharsets.UTF_8).length;
                        int total = queuedBytes.addAndGet(bytes);
                        int count = queuedMessages.incrementAndGet();
                        if (bytes > RemoteTerminalProtocol.MAX_MESSAGE_BYTES
                                || total > 2 * RemoteTerminalProtocol.MAX_MESSAGE_BYTES || count > 256) {
                            queuedBytes.addAndGet(-bytes);
                            queuedMessages.decrementAndGet();
                            webSocket.cancel();
                            handler.post(() -> close("Terminal inbound queue overflow; reconnect for snapshot"));
                            return;
                        }
                        handler.post(() -> {
                            try {
                                if (!closed) receive(new JSONObject(text));
                            } catch (Exception failure) { close("Invalid terminal message"); }
                            finally { queuedBytes.addAndGet(-bytes); queuedMessages.decrementAndGet(); }
                        });
                    }
                    @Override public void onMessage(WebSocket webSocket, ByteString bytes) {
                        webSocket.cancel();
                        handler.post(() -> close("Binary terminal messages are not supported"));
                    }
                    @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                        handler.post(() -> close("Terminal connection closed"));
                    }
                    @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                        handler.post(() -> close("Terminal connection closed"));
                    }
                    @Override public void onFailure(WebSocket webSocket, Throwable failure, Response response) {
                        // Never forward exception/HTTP bodies (which may contain credentials).
                        String code = failureCode(failure);
                        String message = "PIN_MISMATCH".equals(code)
                                ? "Terminal identity changed; verify the host and pair again"
                                : "CERTIFICATE_INVALID".equals(code)
                                ? "Terminal certificate invalid; check the host certificate and device clock"
                                : "Terminal connection failed; check the network and whether the host is running";
                        handler.post(() -> close(message, code));
                    }
                });
    }

    private void receive(JSONObject message) throws Exception {
        if (message.has("id")) { requests.settle(message); return; }
        if (!authenticated) throw new IllegalArgumentException("Event before auth");
        String event = message.getString("event");
        if (!java.util.Arrays.asList("terminal.output", "terminal.snapshot", "terminal.control",
                "terminal.exit", "terminal.listChanged").contains(event))
            throw new IllegalArgumentException("Unknown event");
        listener.event(message);
    }

    void send(String method, JSONObject params, RemoteTerminalRequests.Reply reply) {
        if (closed || !open) { reply.complete(null, "DISCONNECTED", "Terminal is not connected"); return; }
        String id = requests.track(reply, 30000);
        if (id == null) return;
        try {
            String message = new JSONObject().put("id", id).put("method", method).put("params", params).toString();
            if (message.getBytes(StandardCharsets.UTF_8).length > RemoteTerminalProtocol.MAX_MESSAGE_BYTES) {
                requests.fail(id, "TOO_LARGE", "Terminal request too large");
            } else if (socket.queueSize() + message.length() * 3L > RemoteTerminalProtocol.MAX_MESSAGE_BYTES
                    || !socket.send(message)) {
                close("Terminal send queue overflow; delivery unknown, reconnect for snapshot");
            }
        } catch (Exception failure) { requests.fail(id, "PROTOCOL", "Invalid terminal request"); }
    }

    static String failureCode(Throwable failure) {
        boolean certificateInvalid = false;
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof RemoteTerminalTls.PinMismatchException) return "PIN_MISMATCH";
            if (cause instanceof java.security.cert.CertificateException) certificateInvalid = true;
        }
        return certificateInvalid ? "CERTIFICATE_INVALID" : "CONNECT_FAILED";
    }

    void close(String message) { close(message, "CONNECT_FAILED"); }

    void close(String message, String code) {
        if (closed) return;
        failureCode = code;
        closed = true;
        open = false;
        authenticated = false;
        handler.removeCallbacks(dialTimeout);
        if (socket != null) socket.cancel();
        // Retire the owner before rejecting auth, so its reply cannot overwrite the close reason.
        listener.closed(message);
        requests.rejectAll(message + "; in-flight delivery unknown");
        client.connectionPool().evictAll();
        client.dispatcher().executorService().shutdown();
    }
}
