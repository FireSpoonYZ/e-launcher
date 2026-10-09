package com.example.launcherprobe;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.*;

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner.class)
@org.robolectric.annotation.Config(sdk = 35, manifest = org.robolectric.annotation.Config.NONE)
public class RemoteTerminalProtocolTest {
    private static final String PIN = "ab".repeat(32);

    private JSONObject descriptor() throws Exception {
        return new JSONObject().put("version", 1).put("name", "Desktop").put("port", 6768)
                .put("addresses", new org.json.JSONArray().put("192.168.1.2").put("::1"))
                .put("fingerprint", PIN).put("code", "one-use-pairing-code");
    }

    @Test public void pairingValidatesEveryAddressAndNormalizesPin() throws Exception {
        JSONObject source = descriptor().put("fingerprint", "AB:".repeat(31) + "AB");
        JSONObject result = RemoteTerminalProtocol.descriptor(source.toString(), "::1");
        assertEquals(PIN, result.getString("fingerprint"));
        assertEquals("wss://[::1]:6768/", RemoteTerminalProtocol.url(result));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.descriptor(
                descriptor().put("version", "1").toString(), null));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.descriptor(
                descriptor().put("port", 1.5).toString(), null));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.descriptor(
                descriptor().put("fingerprint", "00").toString(), null));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.descriptor(
                descriptor().put("addresses", new org.json.JSONArray().put("localhost").put("http://evil")).toString(), null));
        for (String address : new String[] { "ws://localhost", "host/path", "user@host", "host?token=secret", "host:6768" })
            assertThrows(address, Exception.class, () -> RemoteTerminalProtocol.address(address));
    }

    @Test public void genericBridgeHasAnExplicitAllowlistAndStrictParams() throws Exception {
        for (String method : new String[] { "auth", "pair", "pairing.create", "devices.list", "devices.revoke", "unknown" })
            assertThrows(method, Exception.class, () -> RemoteTerminalProtocol.request(method, new JSONObject()));
        RemoteTerminalProtocol.request("profiles.list", new JSONObject());
        RemoteTerminalProtocol.request("terminal.send", new JSONObject().put("sessionId", "s").put("data", "ls"));
        RemoteTerminalProtocol.request("terminal.create", new JSONObject().put("profileId", "bash"));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.send",
                new JSONObject().put("sessionId", "s").put("data", "ls").put("token", "secret")));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.updateViewport",
                new JSONObject().put("sessionId", "s").put("cols", 80).put("rows", -1)));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.claim",
                new JSONObject().put("sessionId", "s").put("cols", "80")));
    }

    @Test public void subscriptionIdentityIsOptionalBoundedAndOnlyAllowedOnSubscriptions() throws Exception {
        for (String method : new String[] { "terminal.subscribe", "terminal.unsubscribe" }) {
            RemoteTerminalProtocol.request(method, new JSONObject().put("sessionId", "s"));
            RemoteTerminalProtocol.request(method, new JSONObject().put("sessionId", "s").put("subscriptionId", "n".repeat(128)));
            for (Object invalid : new Object[] { "", "n".repeat(129), 1, JSONObject.NULL })
                assertThrows(Exception.class, () -> RemoteTerminalProtocol.request(method,
                        new JSONObject().put("sessionId", "s").put("subscriptionId", invalid)));
        }
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.close",
                new JSONObject().put("sessionId", "s").put("subscriptionId", "n")));
    }

    @Test public void terminalInputUsesTheHostsByteLimitAndPreservesBinaryValues() throws Exception {
        JSONObject params = new JSONObject().put("sessionId", "s");
        RemoteTerminalProtocol.request("terminal.send", params.put("data", "中".repeat(21845) + "x"));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.send",
                params.put("data", "中".repeat(21846))));
        RemoteTerminalProtocol.request("terminal.send", params.put("data", "\u00ff".repeat(65536)).put("encoding", "binary"));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.send", params.put("data", "中")));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.send",
                params.put("data", "x").put("encoding", "utf8")));
    }

    @Test public void displayModeUsesScopedSubscriptionAndBoundedPhoneGrid() throws Exception {
        JSONObject p = new JSONObject().put("sessionId", "s").put("subscriptionId", "page")
                .put("displayMode", "auto").put("viewport", new JSONObject().put("cols", 20).put("rows", 8));
        RemoteTerminalProtocol.request("terminal.subscribe", p);
        RemoteTerminalProtocol.request("terminal.displayModeSet", p);
        RemoteTerminalProtocol.request("terminal.displayModeSet", new JSONObject().put("sessionId", "s")
                .put("subscriptionId", "page").put("displayMode", "desktop"));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.displayModeSet",
                new JSONObject().put("sessionId", "s").put("displayMode", "auto")));
        assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.displayModeSet",
                p.put("displayMode", "phone")));
        p.put("displayMode", "auto");
        for (JSONObject invalid : new JSONObject[] {
                new JSONObject().put("cols", 19).put("rows", 8),
                new JSONObject().put("cols", 20).put("rows", 7),
                new JSONObject().put("cols", 401).put("rows", 8),
                new JSONObject().put("cols", 20).put("rows", 201),
                new JSONObject().put("cols", 20).put("rows", 8).put("extra", 1) }) {
            assertThrows(Exception.class, () -> RemoteTerminalProtocol.request("terminal.displayModeSet",
                    p.put("viewport", invalid)));
        }
    }

    @Test public void publicHostCannotExposeCredentialOrClientInternals() throws Exception {
        JSONObject record = descriptor().put("id", PIN).put("address", "localhost")
                .put("token", "secret").put("tokenCiphertext", "ciphertext")
                .put("tokenIv", "iv").put("clientId", "private-id");
        JSONObject visible = RemoteTerminalStore.publicHost(record);
        assertEquals(5, visible.length());
        assertFalse(visible.toString().contains("secret"));
        assertFalse(visible.has("clientId"));
    }
}
