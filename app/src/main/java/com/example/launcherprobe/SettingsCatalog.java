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
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;

/** Public metadata only; catalog text is never a command. */
final class SettingsCatalog {
    static final String REPOSITORY = "https://github.com/FireSpoonYZ/e-launcher";
    static final int PAGE_SIZE = 50, MAX_BYTES = 1024 * 1024;
    static final OkHttpClient HTTP = new OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build();

    static HttpUrl searchUrl(String query, String kind, String sort, int offset) {
        if (!java.util.Arrays.asList("", "extension", "skill", "theme", "prompt").contains(kind))
            throw new IllegalArgumentException("kind 无效");
        if (!java.util.Arrays.asList("downloads", "recent", "name").contains(sort))
            throw new IllegalArgumentException("sort 无效");
        HttpUrl.Builder url = HttpUrl.parse("https://pi.dev/packages").newBuilder();
        // pi.dev redirects default/empty parameters; request its canonical URL directly.
        if (!query.trim().isEmpty()) url.addQueryParameter("name", query.trim());
        if (!kind.isEmpty()) url.addQueryParameter("type", kind);
        if (!sort.equals("downloads")) url.addQueryParameter("sort", sort);
        int page = Math.max(0, offset) / PAGE_SIZE + 1;
        if (page > 1) url.addQueryParameter("page", String.valueOf(page));
        return url.build();
    }

    static Call call(HttpUrl url) {
        return HTTP.newCall(new Request.Builder().url(url)
                .header("Accept", url.host().equals("pi.dev") ? "text/html" : "application/json")
                .header("User-Agent", "E-Launcher").build());
    }

    static JSONObject read(Call call, boolean release) throws Exception {
        String body = readBody(call, release);
        return body == null ? null : new JSONObject(body);
    }

    static JSONObject readCatalog(Call call) throws Exception {
        return parseCatalog(readBody(call, false));
    }

    // pi.dev publishes an HTML catalog; keep its server-side order and pagination.
    static JSONObject parseCatalog(String html) throws Exception {
        Document document = Jsoup.parse(html);
        Element count = document.selectFirst(".packages-count");
        if (count == null) throw new IOException("无法读取 pi.dev 插件目录");
        java.util.regex.Matcher range = java.util.regex.Pattern
                .compile("^(?:(\\d+)-(\\d+) / (\\d+)|0 / \\d+)(?: \\(of \\d+\\))?$")
                .matcher(count.text());
        if (!range.matches()) throw new IOException("pi.dev 插件分页数据无效");
        int from = range.group(1) == null ? 0 : Integer.parseInt(range.group(1)) - 1;
        int total = range.group(3) == null ? 0 : Integer.parseInt(range.group(3));
        JSONArray objects = new JSONArray();
        for (Element card : document.select("article[data-package-card]")) {
            String name = card.attr("data-package-name");
            Element report = card.selectFirst(".packages-links a[href*='package-version=']");
            HttpUrl reportUrl = report == null ? null : HttpUrl.parse(report.attr("href"));
            String version = reportUrl == null ? null : reportUrl.queryParameter("package-version");
            JSONObject item = new JSONObject().put("name", name).put("version", version);
            installSource(item); // Validate names/versions at the public catalog boundary.
            JSONArray keywords = new JSONArray().put("pi-package");
            for (String type : card.attr("data-package-types").split("\\s+"))
                if (!type.isEmpty()) keywords.put(type);
            item.put("keywords", keywords).put("description", card.select(".packages-desc").text())
                    .put("publisher", new JSONObject().put("username", card.select(".packages-meta span:first-child").text()));
            objects.put(new JSONObject().put("package", item).put("downloads", new JSONObject()
                    .put("monthly", Long.parseLong(card.attr("data-package-downloads")))));
        }
        int expected = range.group(2) == null ? 0 : Integer.parseInt(range.group(2)) - from;
        if (objects.length() != expected || expected > PAGE_SIZE || total < from + expected)
            throw new IOException("pi.dev 插件列表与分页不一致");
        return new JSONObject().put("objects", objects).put("total", total).put("offset", from).put("pageSize", PAGE_SIZE);
    }

    private static String readBody(Call call, boolean release) throws Exception {
        try (Response response = call.execute()) {
            if (release && response.code() == 404) return null;
            if (!response.isSuccessful()) throw new IOException("HTTP " + response.code());
            if (response.body() == null) throw new IOException("Empty response");
            if (response.body().contentLength() > MAX_BYTES) throw new IOException("Response exceeds 1 MiB");
            try (InputStream input = response.body().byteStream()) {
                return readBounded(input);
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

    static String normalizeNpmSource(String value) {
        String source = value.trim();
        if (source.startsWith("npm:")) source = source.substring(4);
        String name = "(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*";
        String version = "[A-Za-z0-9*~^<>=][A-Za-z0-9._*+~^<>=-]*";
        int versionAt = source.startsWith("@") ? source.indexOf('@', source.indexOf('/') + 1) : source.indexOf('@');
        String packageName = versionAt < 0 ? source : source.substring(0, versionAt);
        String packageVersion = versionAt < 0 ? null : source.substring(versionAt + 1);
        if (!packageName.matches(name) || (packageVersion != null && !packageVersion.matches(version)))
            throw new IllegalArgumentException("请输入有效的 npm 包名，可附带版本");
        return "npm:" + source;
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
