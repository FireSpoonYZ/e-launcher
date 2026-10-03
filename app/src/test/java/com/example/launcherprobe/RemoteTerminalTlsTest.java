package com.example.launcherprobe;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import static org.junit.Assert.*;

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner.class)
@org.robolectric.annotation.Config(sdk = 35, manifest = org.robolectric.annotation.Config.NONE)
public class RemoteTerminalTlsTest {
    // Public, self-signed test certificate only; no private key is shipped.
    private static final String CERT = """
-----BEGIN CERTIFICATE-----
MIIC1jCCAb6gAwIBAgIJAJJfUNL6U6hDMA0GCSqGSIb3DQEBDAUAMBgxFjAUBgNV
BAMTDVRlcm1pbmFsIHRlc3QwIBcNMTkxMjMxMTYwMDAwWhgPMjExOTEyMDcxNjAw
MDBaMBgxFjAUBgNVBAMTDVRlcm1pbmFsIHRlc3QwggEiMA0GCSqGSIb3DQEBAQUA
A4IBDwAwggEKAoIBAQCumZ1ywDTdipJ0k9+rnJ/fCO4X+h1hUtUHARafShFKIxJU
8v8b68dCRjF1agO0m+LjgbztminlULja6mzA/sOyQvcOW53Z5t7yuAA/pYJS1eLH
xEB8Q3JOlP2NCDbZW5Yq55TArg0VDKLU5JcMif1RKvhNERKCVPPGctVl2S9bYS/P
jFN3CdvE3sQ88w9JmIge9o0sLMspURbkiQIKM/l+vqJQH3geLMudWZ4wmc/+ZG/m
6qlGRI/XrCzfuqrdMzdEgFHe0t8lPIo2VJJkH98/xIjXrY2POCnoBu2roO5R781w
75/DowRX1LUS+xyvz/n8yNnJw/+rY+BHIiq/WbDHAgMBAAGjITAfMB0GA1UdDgQW
BBTlYGurdhMkeGO6srjWbSxFYKy69DANBgkqhkiG9w0BAQwFAAOCAQEARJDyQPE6
Vx5FrhDckh7CqfcO4/dNhROuKbxNI9IlBaCzB2T4WdPoq8bV6fBhHz6gujgCoG2X
OlANOpPKOsnB/ElPybkjY34S1xKGaoNZ1u25ziS1eed/xlPRhxaf4TBPd84DNNGk
vDwaSift5YrmddWyYXHCUpbG8HVzfnPYgWw2o8j0/DdlWgXD0HP8uGx3K02T9V7M
P1iMGcI4LpFGmp0kcGWOoq8To6Kez9NrrMr/E/1unmVPiUZ9p/Z2AmJSw8GIOr62
SE63FVbk2O/a4SrBvRHoaNAHSj30FlQBkU0nNjttelMxLV9ty3vYAcurFVO7JGRa
LwypoD/H+UBKSw==
-----END CERTIFICATE-----
""";

    @Test public void onlyExactDerPinTrustsSelfSignedLeaf() throws Exception {
        X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(CERT.getBytes(StandardCharsets.US_ASCII)));
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()))
            hex.append(String.format("%02x", b & 255));
        String pin = hex.toString();
        assertTrue(RemoteTerminalTls.matches(cert, pin));
        RemoteTerminalTls.trustManager(pin).checkServerTrusted(new X509Certificate[] { cert }, "RSA");
        assertFalse(RemoteTerminalTls.matches(cert, "00".repeat(32)));
        assertThrows(CertificateException.class, () ->
                RemoteTerminalTls.trustManager("00".repeat(32)).checkServerTrusted(new X509Certificate[] { cert }, "RSA"));
        assertThrows(CertificateException.class, () ->
                RemoteTerminalTls.trustManager(pin).checkServerTrusted(new X509Certificate[0], "RSA"));
        assertThrows(CertificateException.class, () ->
                RemoteTerminalTls.trustManager(pin).checkClientTrusted(new X509Certificate[] { cert }, "RSA"));
        assertFalse(RemoteTerminalTls.client(pin).followRedirects());
    }
}
