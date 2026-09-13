package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.os.Binder;
import com.ai.assistance.shower.IShowerService;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ShowerLifecycleTest {
    @Test public void chatOwnershipReuseReleaseAndExpiredDisplayRecovery() throws Exception {
        ShowerToolBridge tools = new ShowerToolBridge(RuntimeEnvironment.getApplication());
        Set<Integer> active = new HashSet<>();
        AtomicInteger nextId = new AtomicInteger(10);
        Binder binder = new Binder();
        IShowerService service = (IShowerService) Proxy.newProxyInstance(
                IShowerService.class.getClassLoader(), new Class<?>[]{IShowerService.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "asBinder": return binder;
                        case "ensureDisplay":
                            int id = nextId.incrementAndGet();
                            active.add(id);
                            return id;
                        case "attachClient":
                        case "touchDisplay": return active.contains((Integer) args[0]);
                        case "destroyDisplay": return active.remove((Integer) args[0]);
                        case "injectKeyWithMeta":
                            assertTrue("Input must target an existing nonzero display", active.contains((Integer) args[0]));
                            return true;
                        default: throw new AssertionError("Unexpected Binder call: " + method.getName());
                    }
                });
        Field managerField = ShowerToolBridge.class.getDeclaredField("manager");
        managerField.setAccessible(true);
        Object manager = managerField.get(tools);
        Field serviceField = ShowerManager.class.getDeclaredField("service");
        serviceField.setAccessible(true);
        serviceField.set(manager, service);

        JSONObject create = new JSONObject().put("action", "create");
        assertThrows(IllegalArgumentException.class, () -> tools.execute(null, create));
        int a = tools.execute("chat-a", create).getInt("displayId");
        int b = tools.execute("chat-b", create).getInt("displayId");
        assertNotEquals(a, b);
        assertEquals(Set.of(a, b), active);
        assertTrue(tools.execute("chat-a", create).getBoolean("reused"));
        assertEquals(300_000, tools.execute("chat-b", create).getInt("idleTimeoutMs"));

        // Model-supplied IDs cannot redirect release to another conversation.
        tools.execute("chat-a", new JSONObject().put("action", "release")
                .put("conversationId", "chat-b").put("displayId", b));
        assertEquals(Set.of(b), active);
        assertSame("Releasing one screen must not stop the shared service", service, serviceField.get(manager));
        JSONObject key = new JSONObject().put("action", "key").put("key", "BACK");
        assertEquals(b, tools.execute("chat-b", key).getInt("displayId"));

        a = tools.execute("chat-a", create).getInt("displayId");
        active.remove(a); // Server reclaimed this chat's idle display while another chat stayed active.
        assertThrows(IllegalStateException.class, () -> tools.execute("chat-a", key));
        assertEquals(b, tools.execute("chat-b", key).getInt("displayId"));
        JSONObject recreated = tools.execute("chat-a", create);
        assertFalse(recreated.getBoolean("reused"));
        assertNotEquals(a, recreated.getInt("displayId"));

        active.remove(recreated.getInt("displayId"));
        assertFalse("create must also recover expiry without a preceding failed input",
                tools.execute("chat-a", create).getBoolean("reused"));
        tools.forgetConversation("chat-a");
        assertEquals(Set.of(b), active);
        tools.forgetConversation("chat-b");
        assertTrue(active.isEmpty());
    }
}
