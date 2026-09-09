package com.example.launcherprobe;

import java.net.URI;

/** Provider URL boundary shared by settings and HTTP construction. */
public final class ProviderConfig {
    private ProviderConfig() { }

    public static String validateBaseUrl(String value) {
        try {
            URI uri = new URI(value == null ? "" : value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException("模型 Base URL 必须是无凭据、查询或片段的完整 HTTPS URL");
            }
            return uri.toString().replaceAll("/+$", "");
        } catch (java.net.URISyntaxException exception) {
            throw new IllegalArgumentException("模型 Base URL 格式无效", exception);
        }
    }
}
