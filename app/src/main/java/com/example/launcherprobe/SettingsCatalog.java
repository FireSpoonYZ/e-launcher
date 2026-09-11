package com.example.launcherprobe;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

/** Public metadata only; registry text is never a command. */
final class SettingsCatalog {
    static final String REPOSITORY = "https://github.com/FireSpoonYZ/e-launcher";
    static final int PAGE_SIZE = 20, MAX_BYTES = 1024 * 1024;
    static final OkHttpClient HTTP = new OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();

    static HttpUrl searchUrl(String query, String kind, int offset) {
        return HttpUrl.parse("https://registry.npmjs.org/-/v1/search").newBuilder()
                .addQueryParameter("text", "keywords:pi-package" + (kind.isEmpty() ? "" : " keywords:" + kind) + " " + query.trim())
                .addQueryParameter("size", String.valueOf(PAGE_SIZE)).addQueryParameter("from", String.valueOf(Math.max(0, offset))).build();
    }

    static Call call(HttpUrl url) {
        return HTTP.newCall(new Request.Builder().url(url).header("Accept", "application/json")
                .header("User-Agent", "E-Launcher").build());
    }

    static JSONObject read(Call call, boolean release) throws Exception {
        try (Response response = call.execute()) {
            if (release && response.code() == 404) return null;
            if (!response.isSuccessful()) throw new IOException("HTTP " + response.code());
            if (response.body() == null) throw new IOException("Empty response");
            if (response.body().contentLength() > MAX_BYTES) throw new IOException("Response exceeds 1 MiB");
            try (InputStream input = response.body().byteStream()) {
                return new JSONObject(readBounded(input));
            }
        }
    }

    static String readBounded(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > MAX_BYTES) throw new IOException("Response exceeds 1 MiB");
            output.write(buffer, 0, count);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    static boolean matchesSource(String source, String name) {
        return source.equals("npm:" + name) || source.startsWith("npm:" + name + "@");
    }

    static boolean keyword(JSONObject item, String kind) {
        if (kind.isEmpty()) return true;
        JSONArray words = item.optJSONArray("keywords");
        if (words != null) for (int i = 0; i < words.length(); i++) if (kind.equalsIgnoreCase(words.optString(i))) return true;
        return false;
    }

    static String installSource(JSONObject item) {
        String name = item.optString("name"), version = item.optString("version");
        if (!name.matches("(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*")
                || !version.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\\+[A-Za-z0-9.-]+)?"))
            throw new IllegalArgumentException("Invalid npm package name/version");
        return "npm:" + name + "@" + version;
    }
}
