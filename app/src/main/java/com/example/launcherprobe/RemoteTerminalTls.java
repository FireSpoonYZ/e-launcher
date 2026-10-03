package com.example.launcherprobe;

import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;

/** Out-of-band SHA-256 DER identity, NOT OkHttp CertificatePinner's SPKI hash. */
final class RemoteTerminalTls {
    static final class PinMismatchException extends CertificateException {
        PinMismatchException() { super("Terminal certificate fingerprint mismatch"); }
    }

    static boolean matches(X509Certificate certificate, String fingerprint) throws Exception {
        byte[] actual = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
        String normalized = RemoteTerminalProtocol.fingerprint(fingerprint);
        byte[] expected = new byte[32];
        for (int i = 0; i < expected.length; i++)
            expected[i] = (byte) Integer.parseInt(normalized.substring(i * 2, i * 2 + 2), 16);
        return MessageDigest.isEqual(actual, expected);
    }

    static X509TrustManager trustManager(String fingerprint) {
        String pin = RemoteTerminalProtocol.fingerprint(fingerprint);
        return new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Client certificates not supported");
            }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    if (chain == null || chain.length == 0 || !matches(chain[0], pin))
                        throw new PinMismatchException();
                    chain[0].checkValidity();
                } catch (CertificateException failure) { throw failure; }
                catch (Exception failure) { throw new CertificateException("Terminal certificate verification failed", failure); }
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
    }

    static OkHttpClient client(String fingerprint) throws Exception {
        X509TrustManager trust = trustManager(fingerprint);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] { trust }, null);
        return new OkHttpClient.Builder()
                .sslSocketFactory(context.getSocketFactory(), trust)
                // Address is user-selectable (LAN/Tailscale). The pinned certificate, not its
                // self-signed SAN/CN, is the host identity. This verifier never accepts other certs.
                .hostnameVerifier((hostname, session) -> {
                    try { return matches((X509Certificate) session.getPeerCertificates()[0], fingerprint); }
                    catch (Exception failure) { return false; }
                })
                .followRedirects(false).followSslRedirects(false)
                .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build();
    }

    private RemoteTerminalTls() {}
}
