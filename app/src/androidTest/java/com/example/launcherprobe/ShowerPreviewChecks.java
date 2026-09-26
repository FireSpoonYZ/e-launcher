package com.example.launcherprobe;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.SurfaceTexture;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.TextureView;
import android.view.View;
import java.lang.reflect.Field;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Opt-in device check: uses a temporary conversation and the Settings app, never a model/API call. */
final class ShowerPreviewChecks {
    static String run(Instrumentation instrumentation) throws Exception {
        java.io.File screenshot = new java.io.File(ChatStoreChecks.artifacts(instrumentation), "shower-preview-check.png");
        Context context = instrumentation.getTargetContext();
        PiAgentBridge bridge = PiAgentBridge.get(context);
        ShowerToolBridge tools = field(bridge, "showerTools");
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        String id = UUID.randomUUID().toString();
        coordinator.store().save(id, Collections.singletonList(new AgentLoop.Message("user", "实时桌面验收")));
        TaskDetailActivity activity = null;
        try {
            tools.execute(id, new JSONObject().put("action", "create").put("width", 720).put("height", 1280).put("dpi", 240));
            tools.execute(id, new JSONObject().put("action", "launch").put("packageName", "com.android.settings"));
            activity = (TaskDetailActivity) instrumentation.startActivitySync(new Intent(context, TaskDetailActivity.class)
                    .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            TaskDetailActivity detail = activity;
            ShowerDesktopView desktop = field(detail, "desktop");
            TextureView texture = field(desktop, "texture");
            waitFor(instrumentation, () -> Boolean.TRUE.equals(field(desktop, "live")), "No compositor frame reached the detail page");
            AtomicInteger frames = new AtomicInteger();
            instrumentation.runOnMainSync(() -> {
                TextureView.SurfaceTextureListener delegate = texture.getSurfaceTextureListener();
                texture.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
                    @Override public void onSurfaceTextureAvailable(SurfaceTexture t, int w, int h) { delegate.onSurfaceTextureAvailable(t, w, h); }
                    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture t, int w, int h) { delegate.onSurfaceTextureSizeChanged(t, w, h); }
                    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture t) { return delegate.onSurfaceTextureDestroyed(t); }
                    @Override public void onSurfaceTextureUpdated(SurfaceTexture t) { frames.incrementAndGet(); delegate.onSurfaceTextureUpdated(t); }
                });
                desktop.toggleControl();
            });
            waitFor(instrumentation, desktop::isManual, "Manual takeover did not become available");
            require(tools.existingController(id).hasDisplay(), "Preview lost its owning display");
            long before = fingerprint(instrumentation, texture);
            swipe(instrumentation, texture, .82f, .22f);
            require(frames.get() >= 3, "Expected continuous rendered frames during touch; got " + frames.get());
            require(before != fingerprint(instrumentation, texture), "Touch did not change the virtual Settings screen");
            View expand = field(detail, "expand");
            instrumentation.runOnMainSync(expand::performClick);
            waitFor(instrumentation, () -> Boolean.TRUE.equals(field(detail, "fullscreen")), "Fullscreen did not open");
            instrumentation.runOnMainSync(() -> detail.getOnBackPressedDispatcher().onBackPressed());
            waitFor(instrumentation, () -> !Boolean.TRUE.equals(field(detail, "fullscreen")) && !detail.isFinishing(), "Back should exit fullscreen before closing details");
            // ROMs place Settings search at different heights; locate its real bounds after scrolling back.
            swipe(instrumentation, texture, .22f, .9f);
            android.app.UiAutomation automation = instrumentation.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            android.accessibilityservice.AccessibilityServiceInfo info = automation.getServiceInfo();
            info.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            automation.setServiceInfo(info);
            int displayId = tools.existingController(id).screenshot(360, 640).getInt("displayId");
            android.graphics.Rect search = new android.graphics.Rect();
            java.util.List<android.view.accessibility.AccessibilityWindowInfo> searchWindows = automation.getWindowsOnAllDisplays().get(displayId);
            if (searchWindows != null) for (android.view.accessibility.AccessibilityWindowInfo window : searchWindows) {
                android.view.accessibility.AccessibilityNodeInfo root = window.getRoot();
                if (root == null) continue;
                for (String label : new String[]{"搜索", "Search"})
                    for (android.view.accessibility.AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText(label))
                        if (node.isVisibleToUser()) node.getBoundsInScreen(search);
            }
            require(!search.isEmpty(), "Settings search field was not visible on the virtual display");
            instrumentation.runOnMainSync(() -> {
                long now = SystemClock.uptimeMillis();
                for (int action : new int[]{MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP}) {
                    MotionEvent event = MotionEvent.obtain(now, now, action,
                            texture.getWidth() * search.exactCenterX() / 720,
                            texture.getHeight() * search.exactCenterY() / 1280, 0);
                    try { texture.dispatchTouchEvent(event); } finally { event.recycle(); }
                }
            });
            long focusDeadline = SystemClock.uptimeMillis() + 8000;
            while (focusedInput(automation, displayId) == null && SystemClock.uptimeMillis() < focusDeadline) SystemClock.sleep(100);
            require(focusedInput(automation, displayId) != null, "Settings search did not focus an editable field");
            instrumentation.runOnMainSync(() -> desktop.text("桌面输入验收"));
            long textDeadline = SystemClock.uptimeMillis() + 8000;
            boolean textVisible = false;
            while (!textVisible && SystemClock.uptimeMillis() < textDeadline) {
                android.view.accessibility.AccessibilityNodeInfo focused = focusedInput(automation, displayId);
                textVisible = focused != null && "桌面输入验收".contentEquals(focused.getText() == null ? "" : focused.getText());
                if (!textVisible) SystemClock.sleep(100);
            }
            // AI screenshot capture must remain usable while the local Surface is attached.
            ShowerController controller = tools.existingController(id);
            require(controller.screenshot(360, 640).getString("data").length() > 100, "AI screenshot failed with preview attached");
            Bitmap image = instrumentation.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES).takeScreenshot();
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(screenshot)) { image.compress(Bitmap.CompressFormat.PNG, 100, output); }
            finally { image.recycle(); }
            require(textVisible, "Unicode text was not found in the virtual display's focused search field; search="
                    + search + ", manual=" + desktop.isManual() + ", screenshot=" + screenshot);
            instrumentation.runOnMainSync(detail::finish);
            waitFor(instrumentation, () -> !Boolean.TRUE.equals(field(desktop, "started")), "Preview did not stop with the Activity");
            long deadline = SystemClock.uptimeMillis() + 5000;
            while (field(controller, "preview") != null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(20);
            require(field(controller, "preview") == null, "Viewer Surface was not detached");
            require(tools.execute(id, new JSONObject().put("action", "key").put("key", "BACK")).getBoolean("ok"), "Automation did not resume on close");
            return "PASS: direct Surface frames=" + frames.get() + ", mapped live touch changed Settings, fullscreen/back, Unicode input, AI screenshot with preview, detach/resume; screenshot=" + screenshot;
        } finally {
            if (activity != null) { TaskDetailActivity detail = activity; instrumentation.runOnMainSync(detail::finish); }
            tools.forgetConversation(id);
            coordinator.deleteConversation(id);
        }
    }

    private static android.view.accessibility.AccessibilityNodeInfo focusedInput(android.app.UiAutomation automation, int displayId) {
        automation.clearCache();
        java.util.List<android.view.accessibility.AccessibilityWindowInfo> windows = automation.getWindowsOnAllDisplays().get(displayId);
        if (windows != null) for (android.view.accessibility.AccessibilityWindowInfo window : windows) {
            android.view.accessibility.AccessibilityNodeInfo root = window.getRoot();
            android.view.accessibility.AccessibilityNodeInfo focused = root == null ? null
                    : root.findFocus(android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT);
            if (focused != null && focused.isEditable()) return focused;
        }
        return null;
    }

    private static void swipe(Instrumentation instrumentation, TextureView texture, float from, float to) {
        long down = SystemClock.uptimeMillis();
        for (int i = 0; i <= 16; i++) {
            final int step = i;
            instrumentation.runOnMainSync(() -> {
                int action = step == 0 ? MotionEvent.ACTION_DOWN : step == 16 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
                MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action,
                        texture.getWidth() * .5f, texture.getHeight() * (from + (to - from) * step / 16), 0);
                try { texture.dispatchTouchEvent(event); } finally { event.recycle(); }
            });
            SystemClock.sleep(25);
        }
        SystemClock.sleep(700);
    }

    private interface Check { boolean get() throws Exception; }
    private static void waitFor(Instrumentation instrumentation, Check check, String failure) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15000;
        while (SystemClock.uptimeMillis() < deadline) {
            boolean[] result = new boolean[1]; Exception[] error = new Exception[1];
            instrumentation.runOnMainSync(() -> { try { result[0] = check.get(); } catch (Exception e) { error[0] = e; } });
            if (error[0] != null) throw error[0];
            if (result[0]) return;
            SystemClock.sleep(50);
        }
        throw new AssertionError(failure);
    }
    private static long fingerprint(Instrumentation instrumentation, TextureView texture) {
        long[] result = new long[1];
        instrumentation.runOnMainSync(() -> {
            Bitmap bitmap = texture.getBitmap(90, 160);
            require(bitmap != null, "No texture bitmap");
            int[] pixels = new int[90 * 160]; bitmap.getPixels(pixels, 0, 90, 0, 0, 90, 160); bitmap.recycle();
            result[0] = java.util.Arrays.hashCode(pixels);
        });
        return result[0];
    }
    @SuppressWarnings("unchecked") private static <T> T field(Object object, String name) throws Exception {
        Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return (T) field.get(object);
    }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
