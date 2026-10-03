package com.example.launcherprobe;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
public class RemoteTerminalRequestsTest {
    @Test public void correlationTimeoutAndDisconnectSettleExactlyOnceWithoutReplay() throws Exception {
        RemoteTerminalRequests requests = new RemoteTerminalRequests(new Handler(Looper.getMainLooper()));
        List<String> results = new ArrayList<>();
        String first = requests.track((result, code, message) -> results.add(code == null ? result.toString() : code), 100);
        String second = requests.track((result, code, message) -> results.add(code), 100);
        assertNotEquals(first, second);
        assertTrue(requests.settle(new JSONObject().put("id", first).put("result", "ok")));
        assertFalse(requests.settle(new JSONObject().put("id", first).put("result", "duplicate")));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(101));
        assertEquals(java.util.Arrays.asList("ok", "DELIVERY_UNKNOWN"), results);
        assertFalse(requests.settle(new JSONObject().put("id", second).put("result", "late")));
        requests.track((result, code, message) -> results.add(code), 100);
        requests.rejectAll("Disconnected");
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(101));
        assertEquals(java.util.Arrays.asList("ok", "DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN"), results);
    }

    @Test public void rejectsUnboundedPendingAndClearsTimersBeforeCallbacks() {
        RemoteTerminalRequests requests = new RemoteTerminalRequests(new Handler(Looper.getMainLooper()));
        List<String> results = new ArrayList<>();
        for (int i = 0; i < 128; i++)
            assertNotNull(requests.track((result, code, message) -> {
                results.add(code);
                requests.rejectAll("Nested close");
            }, 100));
        assertNull(requests.track((result, code, message) -> results.add(code), 100));
        assertEquals(java.util.Collections.singletonList("BUSY"), results);
        requests.rejectAll("Disconnected");
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(101));
        assertEquals(129, results.size());
    }
}
