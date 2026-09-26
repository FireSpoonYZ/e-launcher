package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.os.Binder;
import android.view.MotionEvent;
import android.view.Surface;
import com.ai.assistance.shower.IShowerService;
import java.lang.reflect.Proxy;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ShowerPreviewTest {
    @Test public void previewReusesDisplayAndOldViewerCannotDetachReplacement() throws Exception {
        FakeServer server = new FakeServer();
        ShowerToolBridge tools = server.tools();
        assertNull(tools.existingController("a"));
        tools.execute("a", new JSONObject().put("action", "create"));
        ShowerController controller = tools.existingController("a");
        assertTrue(controller.hasDisplay());
        assertEquals("Observing must not touch the idle clock", 0, server.touches);
        android.graphics.SurfaceTexture texture = new android.graphics.SurfaceTexture(0);
        Surface surface = new Surface(texture);
        ShowerController.Preview first = controller.openPreview(surface);
        ShowerController.Preview next = controller.openPreview(surface);
        assertEquals(first.displayId, next.displayId);
        assertEquals(1, server.created.get());
        controller.closePreview(first);
        assertEquals(0, server.detaches);
        controller.setManualControl(next, true);
        controller.previewLaunch(next, "com.example.one");
        controller.previewLaunch(next, "com.example.two");
        controller.previewLaunch(next, "com.example.one");
        assertEquals(java.util.List.of("com.example.one", "com.example.two"), controller.recentPackages(next));
        controller.closePreview(next);
        assertEquals(1, server.detaches);
        assertTrue("Leaving detail keeps AI's display alive", controller.hasDisplay());
        assertThrows(IllegalStateException.class, () -> controller.previewKey(next, 4));
        surface.release(); texture.release();
    }

    @Test public void takeoverWaitsOnlyThisChatAndDoesNotReplayStaleInput() throws Exception {
        FakeServer server = new FakeServer();
        ShowerToolBridge tools = server.tools();
        tools.execute("a", new JSONObject().put("action", "create"));
        tools.execute("b", new JSONObject().put("action", "create"));
        ShowerController controller = tools.existingController("a");
        android.graphics.SurfaceTexture texture = new android.graphics.SurfaceTexture(0);
        Surface surface = new Surface(texture);
        ShowerController.Preview preview = controller.openPreview(surface);
        assertThrows(IllegalStateException.class, () -> controller.previewKey(preview, 4));
        controller.setManualControl(preview, true);
        FutureTask<JSONObject> pending = new FutureTask<>(() -> tools.execute("a", new JSONObject().put("action", "key").put("key", "BACK")));
        Thread thread = new Thread(pending);
        try {
            thread.start();
            assertThrows(TimeoutException.class, () -> pending.get(100, TimeUnit.MILLISECONDS));
            assertEquals(0, server.keys.get());
            controller.previewKey(preview, 4);
            tools.execute("b", new JSONObject().put("action", "key").put("key", "BACK"));
            assertEquals(2, server.keys.get());
            controller.closePreview(preview);
            java.util.concurrent.ExecutionException rejected = assertThrows(java.util.concurrent.ExecutionException.class,
                    () -> pending.get(2, TimeUnit.SECONDS));
            assertTrue(rejected.getCause().getMessage().contains("请先 screenshot"));
            assertEquals("Do not replay coordinates/actions prepared before the user operated", 2, server.keys.get());
            tools.execute("a", new JSONObject().put("action", "key").put("key", "BACK"));
            assertEquals(3, server.keys.get());
        } finally {
            controller.closePreview(preview);
            thread.interrupt(); thread.join(2000); surface.release(); texture.release();
        }
    }

    @Test public void expiredDisplayIsNotRecreatedByViewer() throws Exception {
        FakeServer server = new FakeServer();
        ShowerToolBridge tools = server.tools();
        tools.execute("a", new JSONObject().put("action", "create"));
        ShowerController controller = tools.existingController("a");
        android.graphics.SurfaceTexture texture = new android.graphics.SurfaceTexture(0);
        Surface surface = new Surface(texture);
        ShowerController.Preview preview = controller.openPreview(surface);
        controller.setManualControl(preview, true);
        server.active.clear();
        assertFalse(controller.keepPreviewAlive(preview));
        assertFalse(controller.hasDisplay());
        controller.awaitAutomation(); // Expiry releases manual ownership, never leaves a waiting tool stuck.
        assertEquals(1, server.created.get());
        assertThrows(IllegalStateException.class, () -> controller.previewKey(preview, 4));
        surface.release(); texture.release();
    }

    @Test public void touchMappingPreservesPointersAndClampsDraggingOutsideViewport() {
        MotionEvent.PointerProperties one = new MotionEvent.PointerProperties(); one.id = 3;
        MotionEvent.PointerProperties two = new MotionEvent.PointerProperties(); two.id = 7;
        MotionEvent.PointerCoords a = new MotionEvent.PointerCoords(); a.x = 100; a.y = 200; a.pressure = .7f;
        MotionEvent.PointerCoords b = new MotionEvent.PointerCoords(); b.x = -10; b.y = 700;
        int action = MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
        MotionEvent original = MotionEvent.obtain(100, 120, action, 2,
                new MotionEvent.PointerProperties[]{one, two}, new MotionEvent.PointerCoords[]{a, b}, 0, 0, 1, 1, 0, 0, 0, 0);
        MotionEvent mapped = ShowerDesktopView.mapTouch(original, 300, 600, 1080, 2400);
        try {
            assertEquals(action, mapped.getAction()); assertEquals(7, mapped.getPointerId(1));
            assertEquals(360, mapped.getX(0), .01f); assertEquals(800, mapped.getY(0), .01f);
            assertEquals(0, mapped.getX(1), .01f); assertEquals(2399, mapped.getY(1), .01f);
            assertEquals(.7f, mapped.getPressure(0), .01f); assertEquals(100, mapped.getDownTime());
            assertEquals(100, original.getX(0), .01f);
        } finally { mapped.recycle(); original.recycle(); }
    }

    @Test public void viewportFitsInTheSameLayoutPassWhenFullscreenChanges() {
        android.content.Context context = RuntimeEnvironment.getApplication();
        ShowerDesktopView view = new ShowerDesktopView(context, AppAppearance.readWorkbench(context),
                () -> null, (available, live, manual, status) -> {});
        ReflectionHelpers.setField(view, "displayWidth", 1440);
        ReflectionHelpers.setField(view, "displayHeight", 3200);
        android.view.View texture = view.getChildAt(0);
        try {
            for (int height : new int[]{2000, 2400, 2000, 2400, 2000}) {
                view.measure(android.view.View.MeasureSpec.makeMeasureSpec(1200, android.view.View.MeasureSpec.EXACTLY),
                        android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY));
                view.layout(0, 0, 1200, height);
                int expectedWidth = height * 1440 / 3200;
                assertEquals("Resize must not lag one layout pass", expectedWidth, texture.getWidth());
                assertEquals(height, texture.getHeight());
                assertEquals((1200 - expectedWidth) / 2, texture.getLeft());
                assertEquals(0, texture.getTop());
            }
        } finally { view.dispose(); }
    }

    private static final class FakeServer {
        final Set<Integer> active = new HashSet<>();
        final AtomicInteger created = new AtomicInteger(), keys = new AtomicInteger();
        int touches, detaches;
        ShowerToolBridge tools() {
            ShowerToolBridge tools = new ShowerToolBridge(RuntimeEnvironment.getApplication());
            Binder binder = new Binder();
            IShowerService service = (IShowerService) Proxy.newProxyInstance(IShowerService.class.getClassLoader(),
                    new Class<?>[]{IShowerService.class}, (proxy, method, args) -> {
                return switch (method.getName()) {
                    case "asBinder" -> binder;
                    case "ensureDisplay" -> { int id = created.incrementAndGet(); active.add(id); yield id; }
                    case "attachClient", "hasDisplay" -> active.contains((Integer) args[0]);
                    case "launchApp" -> active.contains((Integer) args[1]);
                    case "touchDisplay" -> { touches++; yield active.contains((Integer) args[0]); }
                    case "setPreviewSurface" -> { if (args[1] == null) detaches++; yield true; }
                    case "injectKeyWithMeta" -> { assertTrue(active.contains((Integer) args[0])); keys.incrementAndGet(); yield true; }
                    default -> throw new AssertionError("Unexpected call " + method.getName());
                };
            });
            ShowerManager manager = ReflectionHelpers.getField(tools, "manager");
            ReflectionHelpers.setField(manager, "service", service);
            return tools;
        }
    }
}
