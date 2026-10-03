package com.example.launcherprobe;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import okhttp3.HttpUrl;

/** Validation at the WebView/native and pairing-descriptor boundaries. */
final class RemoteTerminalProtocol {
    static final int MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
    private static final Set<String> METHODS = new HashSet<>(Arrays.asList(
            "profiles.list", "terminal.list", "terminal.create", "terminal.subscribe",
            "terminal.unsubscribe", "terminal.claim", "terminal.release", "terminal.send",
            "terminal.updateViewport", "terminal.close"));

    static String text(JSONObject object, String key, int max) throws Exception {
        Object value = object.opt(key);
        if (!(value instanceof String) || ((String) value).isEmpty()
                || ((String) value).length() > max) throw new IllegalArgumentException("Invalid " + key);
        return (String) value;
    }

    static int integer(JSONObject object, String key, int min, int max) {
        Object value = object.opt(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException("Invalid " + key);
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number != Math.floor(number) || number < min || number > max)
            throw new IllegalArgumentException("Invalid " + key);
        return (int) number;
    }

    static String fingerprint(String value) {
        String normalized = value.replace(":", "").toLowerCase(Locale.ROOT);
        if (!normalized.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid fingerprint");
        return normalized;
    }

    static String address(String value) {
        // Only a host, never a URL, credentials, path, query, or injected port.
        if (value == null || value.isEmpty() || value.length() > 253
                || !value.matches("[a-zA-Z0-9.:%\\[\\]_-]+"))
            throw new IllegalArgumentException("Invalid address");
        return new HttpUrl.Builder().scheme("https").host(value).build().host();
    }

    static String url(JSONObject host) throws Exception {
        return new HttpUrl.Builder().scheme("https")
                .host(address(text(host, "address", 253)))
                .port(integer(host, "port", 1, 65535)).build().toString().replaceFirst("^https:", "wss:");
    }

    static JSONObject descriptor(String raw, String override) throws Exception {
        if (raw == null || raw.length() > 16384) throw new IllegalArgumentException("Invalid descriptor");
        JSONObject descriptor = new JSONObject(raw);
        integer(descriptor, "version", 1, 1);
        text(descriptor, "name", 256);
        integer(descriptor, "port", 1, 65535);
        descriptor.put("fingerprint", fingerprint(text(descriptor, "fingerprint", 95)));
        text(descriptor, "code", 1024);
        JSONArray addresses = descriptor.getJSONArray("addresses");
        if (addresses.length() == 0 || addresses.length() > 64)
            throw new IllegalArgumentException("Invalid addresses");
        for (int i = 0; i < addresses.length(); i++) {
            if (!(addresses.get(i) instanceof String)) throw new IllegalArgumentException("Invalid address");
            address(addresses.getString(i));
        }
        descriptor.put("address", address(override == null ? addresses.getString(0) : override));
        return descriptor;
    }

    static void request(String method, JSONObject params) throws Exception {
        if (!METHODS.contains(method)) throw new IllegalArgumentException("Method not permitted");
        Set<String> allowed = new HashSet<>();
        if (!method.equals("profiles.list") && !method.equals("terminal.list") && !method.equals("terminal.create")) {
            allowed.add("sessionId");
            text(params, "sessionId", 256);
        }
        if (method.equals("terminal.subscribe") || method.equals("terminal.unsubscribe")) {
            allowed.add("subscriptionId");
            if (params.has("subscriptionId")) text(params, "subscriptionId", 128);
        }
        if (method.equals("terminal.send")) {
            allowed.addAll(Arrays.asList("data", "encoding"));
            // Match the host's 64 KiB byte boundary, not UTF-16 character count.
            if (!(params.opt("data") instanceof String)) throw new IllegalArgumentException("Invalid data");
            String data = params.getString("data");
            if (params.has("encoding")) {
                if (!"binary".equals(params.opt("encoding")) || data.length() > 65536)
                    throw new IllegalArgumentException("Invalid binary input");
                for (int i = 0; i < data.length(); i++)
                    if (data.charAt(i) > 255) throw new IllegalArgumentException("Invalid binary input");
            } else if (data.getBytes(StandardCharsets.UTF_8).length > 65536) {
                throw new IllegalArgumentException("Terminal input exceeds 64 KiB");
            }
        }
        if (method.equals("terminal.create")) {
            allowed.addAll(Arrays.asList("profileId", "cwd", "executable"));
            String profile = text(params, "profileId", 32);
            if (!Arrays.asList("pwsh", "powershell", "bash", "nu").contains(profile))
                throw new IllegalArgumentException("Invalid profileId");
            for (String key : Arrays.asList("cwd", "executable"))
                if (params.has(key) && text(params, key, 4096).indexOf('\0') >= 0)
                    throw new IllegalArgumentException("Invalid " + key);
        }
        if (method.equals("terminal.create") || method.equals("terminal.claim") || method.equals("terminal.updateViewport")) {
            allowed.addAll(Arrays.asList("cols", "rows"));
            for (String key : Arrays.asList("cols", "rows"))
                if (params.has(key) || method.equals("terminal.updateViewport")) integer(params, key, 1, 1000);
        }
        java.util.Iterator<String> keys = params.keys();
        while (keys.hasNext()) if (!allowed.contains(keys.next()))
            throw new IllegalArgumentException("Unexpected parameter");
    }

    private RemoteTerminalProtocol() {}
}
