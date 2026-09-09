package com.example.launcherprobe;

import java.net.URI;

/** User-owned SearXNG origin; unlike model-supplied fetch URLs it may resolve privately. */
public final class SearchConfig {
    public static final String DUCKDUCKGO = "duckduckgo";
    public static final String SEARXNG = "searxng";

    private SearchConfig() { }

    public static String provider(String value) {
        return SEARXNG.equals(value) ? SEARXNG : DUCKDUCKGO;
    }

    public static String validateBaseUrl(String value) {
        try {
            URI uri = new URI(value == null ? "" : value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException("SearXNG 地址必须是完整、无凭据/查询/片段的 HTTPS URL");
            }
            return uri.toString().replaceAll("/+$", "");
        } catch (java.net.URISyntaxException exception) {
            throw new IllegalArgumentException("SearXNG 地址格式无效", exception);
        }
    }

    public static boolean sameOrigin(URI expected, URI actual) {
        return actual.getScheme() != null && actual.getHost() != null && actual.getUserInfo() == null
                && expected.getScheme().equalsIgnoreCase(actual.getScheme())
                && expected.getHost().equalsIgnoreCase(actual.getHost())
                && port(expected) == port(actual);
    }

    private static int port(URI uri) { return uri.getPort() == -1 ? 443 : uri.getPort(); }
}
