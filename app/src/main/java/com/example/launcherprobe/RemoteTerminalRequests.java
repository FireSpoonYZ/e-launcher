package com.example.launcherprobe;

/*
 * Adapted from Orca mobile/src/transport/rpc-client-request-tracker.ts and
 * mobile/src/transport/relay-pending-requests.ts @ de8bffe24045b396212f4f63de8960ec8380ea07.
 * Copyright (c) 2026 Lovecast Inc. MIT; full notice: docs/remote-terminal-android.md.
 * Java/Handler port of track/settle/rejectAll with bounded pending requests.
 * No reconnect wait, encrypted envelope, logging, or automatic delivery retry.
 */
import android.os.Handler;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

final class RemoteTerminalRequests {
    interface Reply { void complete(Object result, String code, String message); }
    private static final int MAX_PENDING = 128;
    private final Handler handler;
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private long counter;

    private static final class Pending {
        final Reply reply;
        final Runnable timeout;
        Pending(Reply reply, Runnable timeout) { this.reply = reply; this.timeout = timeout; }
    }

    RemoteTerminalRequests(Handler handler) { this.handler = handler; }

    String track(Reply reply, long timeoutMs) {
        if (pending.size() >= MAX_PENDING) {
            reply.complete(null, "BUSY", "Too many pending terminal requests");
            return null;
        }
        String id = "mobile-rpc-" + (++counter);
        Runnable timeout = () -> fail(id, "DELIVERY_UNKNOWN", "Request timed out; delivery unknown, do not blindly retry");
        pending.put(id, new Pending(reply, timeout));
        handler.postDelayed(timeout, timeoutMs);
        return id;
    }

    boolean settle(JSONObject response) throws Exception {
        Pending request = pending.remove(response.getString("id"));
        if (request == null) return false;
        handler.removeCallbacks(request.timeout);
        JSONObject error = response.optJSONObject("error");
        if (error != null) request.reply.complete(null, error.optString("code", "REMOTE_ERROR"),
                error.optString("message", "Terminal request failed"));
        else if (response.has("result")) request.reply.complete(response.get("result"), null, null);
        else request.reply.complete(null, "PROTOCOL", "Invalid terminal response");
        return true;
    }

    void fail(String id, String code, String message) {
        Pending request = pending.remove(id);
        if (request == null) return;
        handler.removeCallbacks(request.timeout);
        request.reply.complete(null, code, message);
    }

    void rejectAll(String message) {
        // Detach before callbacks, which may themselves close the connection.
        Map<String, Pending> rejected = new LinkedHashMap<>(pending);
        pending.clear();
        for (Pending request : rejected.values()) {
            handler.removeCallbacks(request.timeout);
            request.reply.complete(null, "DELIVERY_UNKNOWN", message);
        }
    }
}
