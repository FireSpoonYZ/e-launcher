package com.example.launcherprobe;

import java.net.InetAddress;
import java.net.URI;
import java.util.List;

/** Rejects non-web and local destinations before each web request and redirect. */
public final class WebAddressPolicy {
    private WebAddressPolicy() { }

    public static void validatePublic(URI uri) throws Exception {
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) || uri.getHost() == null || uri.getUserInfo() != null) {
            throw new IllegalArgumentException("只允许不含凭据的 HTTPS URL");
        }
    }

    public static List<InetAddress> validated(List<InetAddress> addresses) {
        if (addresses.isEmpty()) throw new IllegalArgumentException("域名没有可用地址");
        for (InetAddress address : addresses) validateAddress(address);
        return addresses;
    }

    public static void validateAddress(InetAddress address) {
            byte[] bytes = address.getAddress();
            int first = bytes[0] & 255;
            int second = bytes.length > 1 ? bytes[1] & 255 : 0;
            int third = bytes.length > 2 ? bytes[2] & 255 : 0;
            boolean privateV4 = bytes.length == 4 && (first == 10 || first == 127 || first == 0
                    || (first == 172 && (second & 240) == 16)
                    || (first == 192 && second == 168) || (first == 100 && (second & 192) == 64)
                    || (first == 192 && second == 0 && (third == 0 || third == 2))
                    || (first == 198 && (second == 18 || second == 19
                            || (second == 51 && third == 100)))
                    || (first == 203 && second == 0 && third == 113) || first >= 224);
            boolean privateV6 = bytes.length == 16 && ((first & 0xfe) == 0xfc
                    || (first == 0x20 && second == 0x01 && third == 0x0d
                            && (bytes[3] & 255) == 0xb8));
            if (privateV4 || privateV6 || address.isAnyLocalAddress()
                    || address.isLoopbackAddress() || address.isLinkLocalAddress()
                    || address.isSiteLocalAddress() || address.isMulticastAddress()) {
                throw new IllegalArgumentException("拒绝本机或内网地址");
            }
    }
}
