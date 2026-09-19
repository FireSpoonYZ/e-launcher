package com.example.launcherprobe;

import android.content.Intent;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = HostAtomicFile.class)
public class DesktopSettingsGestureTest {
    @Test public void gesturePageHostsNavControlsWithoutCopyingGestureService() {
        Intent intent = new Intent().putExtra("desktop_destination", "gestures");
        try (ActivityController<DesktopSettingsActivity> controller =
                     Robolectric.buildActivity(DesktopSettingsActivity.class, intent).setup()) {
            DesktopSettingsActivity activity = controller.get();
            View root = activity.getWindow().getDecorView();
            assertNotNull(findText(root, "上滑"));
            assertNotNull(findText(root, "下滑"));
            assertNotNull(findContaining(root, "无障碍服务"));
            assertSame(org.robolectric.util.ReflectionHelpers.getField(activity, "refreshGestures"),
                    GestureService.statusListener);

            clickLabeled(root, "启用固定导航手势");
            assertNotNull(findContaining(root, "无障碍服务尚未连接"));

            clickLabeled(root, "停止手势并恢复三键");
            clickLabeled(root, "打开无障碍授权设置");
            Intent started = Shadows.shadowOf(activity).getNextStartedActivity();
            assertEquals(Settings.ACTION_ACCESSIBILITY_SETTINGS, started.getAction());

            clickLabeled(root, "展开安全说明");
            assertNotNull(findContaining(root, "HyperOS"));
            assertNotNull(findContaining(root, GestureService.GRANT_COMMAND));

            controller.pause();
            assertNull(GestureService.statusListener);
            controller.resume();
            assertNotNull(GestureService.statusListener);
            assertNotNull(findContaining(activity.getWindow().getDecorView(), "无障碍服务"));
        }
    }

    @Test public void desktopSettingsHomeKeepsSwipeAndNavEntry() {
        try (ActivityController<DesktopSettingsActivity> controller =
                     Robolectric.buildActivity(DesktopSettingsActivity.class).setup()) {
            View root = controller.get().getWindow().getDecorView();
            assertNotNull(findContaining(root, "固定导航与三键"));
            assertNull(findText(root, "启用固定导航手势"));
        }
    }

    @Test public void assistantShortcutHandsOffToChatSettings() {
        try (ActivityController<DesktopSettingsActivity> controller =
                     Robolectric.buildActivity(DesktopSettingsActivity.class).setup()) {
            DesktopSettingsActivity activity = controller.get();
            clickLabeled(activity.getWindow().getDecorView(), "助手设置");
            Intent started = Shadows.shadowOf(activity).getNextStartedActivity();
            assertEquals(MainActivity.class.getName(), started.getComponent().getClassName());
            assertEquals("assistant_settings", started.getStringExtra(DesktopSettingsActivity.EXTRA_ACTION));
            assertTrue(activity.isFinishing());
        }
    }

    private static void clickLabeled(View root, String title) {
        TextView label = findText(root, title);
        assertNotNull(title, label);
        View current = label;
        while (current != null && !current.hasOnClickListeners()) {
            Object parent = current.getParent();
            current = parent instanceof View ? (View) parent : null;
        }
        assertNotNull("clickable " + title, current);
        current.performClick();
    }

    private static TextView findText(View view, String value) {
        if (view instanceof TextView && value.equals(((TextView) view).getText().toString()))
            return (TextView) view;
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                TextView found = findText(group.getChildAt(i), value);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static TextView findContaining(View view, String value) {
        if (view instanceof TextView && String.valueOf(((TextView) view).getText()).contains(value))
            return (TextView) view;
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                TextView found = findContaining(group.getChildAt(i), value);
                if (found != null) return found;
            }
        }
        return null;
    }
}
