package com.example.launcherprobe;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Minimal parser for DuckDuckGo Lite's stable result-link/result-snippet markup. */
public final class SearchParser {
    private static final Pattern RESULT = Pattern.compile(
            "(?is)<a(?=[^>]*class=['\"]result-link['\"])[^>]*href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>"
                    + ".*?<td[^>]*class=['\"]result-snippet['\"][^>]*>(.*?)</td>");

    public static final class Result {
        public final String title;
        public final String url;
        public final String snippet;
        Result(String title, String url, String snippet) {
            this.title = title;
            this.url = url;
            this.snippet = snippet;
        }
    }

    private SearchParser() { }

    public static List<Result> parse(String html) {
        String lower = html.toLowerCase(java.util.Locale.ROOT);
        if (lower.contains("class=\"anomaly-modal") || lower.contains("class='anomaly-modal")
                || lower.contains("id=\"challenge-form\"")
                || lower.contains("id='challenge-form'")) {
            throw new IllegalStateException("搜索服务要求人机验证");
        }
        List<Result> results = new ArrayList<>();
        Matcher matcher = RESULT.matcher(html);
        while (matcher.find() && results.size() < 10) {
            String url = decodeUrl(entity(matcher.group(1)));
            if (!url.startsWith("https://") || url.length() > 2048) continue;
            results.add(new Result(limit(text(matcher.group(2)), 300), url,
                    limit(text(matcher.group(3)), 800)));
        }
        if (results.isEmpty()) throw new IllegalStateException("搜索服务未返回可解析的结果");
        return results;
    }

    private static String decodeUrl(String value) {
        int marker = value.indexOf("uddg=");
        if (marker < 0) return value.startsWith("//") ? "https:" + value : value;
        String encoded = value.substring(marker + 5);
        int ampersand = encoded.indexOf('&');
        if (ampersand >= 0) encoded = encoded.substring(0, ampersand);
        try { return URLDecoder.decode(encoded, StandardCharsets.UTF_8.name()); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new AssertionError(impossible); }
    }

    private static String limit(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max);
    }

    private static String text(String value) {
        return entity(value.replaceAll("(?is)<[^>]+>", " "))
                .replaceAll("\\s+", " ").trim();
    }

    private static String entity(String value) {
        return value.replace("&amp;", "&").replace("&quot;", "\"")
                .replace("&#x27;", "'").replace("&#39;", "'")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ");
    }
}
