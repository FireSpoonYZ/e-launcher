package com.example.launcherprobe;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.ComponentActivity;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;
import org.robolectric.util.ReflectionHelpers;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {29, 35})
public class HomeDesktopEditExitTest {
    @Test public void navigationAndOverlayOpenLeaveEditButCancelDoesNot() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            AtomicInteger library = new AtomicInteger();
            AtomicInteger search = new AtomicInteger();
            AtomicInteger assistant = new AtomicInteger();
            AtomicInteger settings = new AtomicInteger();
            AtomicInteger overlayOpen = new AtomicInteger();
            scene.desktop.setNavigation(library::incrementAndGet, search::incrementAndGet,
                    assistant::incrementAndGet, settings::incrementAndGet, new HomeDesktop.Overlay() {
                        @Override public void pull(boolean search, float progress) { }
                        @Override public void settle(boolean search, boolean open, float velocity) {
                            if (open) overlayOpen.incrementAndGet();
                        }
                    });

            runLeave(scene, "libraryAction", library);
            runLeave(scene, "searchAction", search);
            runLeave(scene, "assistantAction", assistant);
            runLeave(scene, "settingsAction", settings);

            scene.desktop.enterEdit();
            scene.layout();
            HomeDesktop.Overlay overlay = ReflectionHelpers.getField(scene.desktop, "overlay");
            overlay.settle(true, false, 0);
            assertTrue("Aborting a search/library pull must keep layout mode", scene.desktop.editing());
            overlay.settle(false, true, 0);
            assertEquals(1, overlayOpen.get());
            assertFalse(scene.desktop.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
        }
    }

    @Test public void settingsMenuAndDoneLeaveEditWhileInternalOpsStay() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            AtomicInteger settings = new AtomicInteger();
            scene.desktop.setNavigation(() -> {}, () -> {}, () -> {}, settings::incrementAndGet, null);

            scene.desktop.enterEdit();
            scene.layout();
            scene.more().performClick();
            AlertDialog more = ShadowAlertDialog.getLatestAlertDialog();
            assertNotNull(more);
            shadowOf(more).clickOnItem(0);
            assertTrue("Undo stays in layout mode", scene.desktop.editing());
            assertEquals(0, settings.get());

            scene.desktop.showAddMenu();
            assertTrue(scene.desktop.editing());
            AlertDialog add = ShadowAlertDialog.getLatestAlertDialog();
            if (add != null) add.dismiss();
            scene.desktop.undo();
            scene.desktop.setCurrentPage(0);
            scene.layout();
            assertTrue(scene.desktop.editing());
            assertEquals(View.VISIBLE, scene.tools().getVisibility());

            scene.more().performClick();
            shadowOf(ShadowAlertDialog.getLatestAlertDialog()).clickOnItem(1);
            assertEquals(1, settings.get());
            assertFalse(scene.desktop.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());

            scene.desktop.enterEdit();
            scene.layout();
            scene.done().performClick();
            assertFalse(scene.desktop.editing());
            scene.desktop.exitEdit();
            assertFalse(scene.desktop.editing());
        }
    }

    @Test public void launchingAnExternalActivityLeavesEdit() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            scene.desktop.enterEdit();
            scene.layout();
            Intent intent = new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER)
                    .setComponent(new ComponentName(scene.activity.getPackageName(), "TestApp"));
            ReflectionHelpers.callInstanceMethod(scene.desktop, "open",
                    ReflectionHelpers.ClassParameter.from(Intent.class, intent));
            assertFalse(scene.desktop.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
            Intent started = shadowOf(scene.activity).getNextStartedActivity();
            assertNotNull(started);
            assertEquals("TestApp", started.getComponent().getClassName());
        }
    }

    private static void runLeave(Scene scene, String field, AtomicInteger calls) {
        scene.desktop.enterEdit();
        scene.layout();
        assertTrue(scene.desktop.editing());
        int before = calls.get();
        ((Runnable) ReflectionHelpers.getField(scene.desktop, field)).run();
        assertEquals(before + 1, calls.get());
        assertFalse(field + " must leave layout mode", scene.desktop.editing());
        assertEquals(View.GONE, scene.tools().getVisibility());
    }

    private static final class Scene {
        final ComponentActivity activity;
        final HomeDesktop desktop;

        Scene(ComponentActivity activity) {
            this.activity = activity;
            activity.getSharedPreferences(HomeLayout.PREFERENCES, Context.MODE_PRIVATE).edit().clear().commit();
            activity.getSharedPreferences(DesktopPreferences.STORE, Context.MODE_PRIVATE).edit().clear().commit();
            ResolveInfo app = new ResolveInfo();
            app.activityInfo = new ActivityInfo();
            app.activityInfo.packageName = activity.getPackageName();
            app.activityInfo.name = "TestApp";
            app.activityInfo.applicationInfo = new ApplicationInfo(activity.getApplicationInfo());
            app.nonLocalizedLabel = "Test App";
            app.icon = android.R.drawable.sym_def_app_icon;
            HomeLayout model = HomeLayout.load(activity, List.of(app));
            model.set(0, HomeLayout.Item.app(app.activityInfo.packageName, app.activityInfo.name));
            PagerRoot pager = new PagerRoot(activity, new View(activity), PagerState.Page.HOME, page -> {});
            FrameLayout home = new FrameLayout(activity);
            desktop = new HomeDesktop(activity, pager, model, List.of(app), new LauncherShortcuts(activity), home);
            home.addView(desktop, new FrameLayout.LayoutParams(-1, -1));
            pager.setHome(home);
            activity.setContentView(pager);
            layout();
        }

        int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
        void layout() {
            View host = activity.findViewById(android.R.id.content);
            host.measure(View.MeasureSpec.makeMeasureSpec(dp(384), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(dp(1080), View.MeasureSpec.EXACTLY));
            host.layout(0, 0, dp(384), dp(1080));
        }
        LinearLayout tools() { return ReflectionHelpers.getField(desktop, "tools"); }
        View more() {
            View view = firstDescribed(desktop, "更多整理操作");
            assertNotNull(view);
            return view;
        }
        TextView done() {
            TextView view = firstText(desktop, "完成");
            assertNotNull(view);
            return view;
        }
    }

    private static View firstDescribed(View view, String text) {
        CharSequence description = view.getContentDescription();
        if (description != null && description.toString().contains(text)) return view;
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                View found = firstDescribed(group.getChildAt(i), text);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static TextView firstText(View view, String text) {
        if (view instanceof TextView label && text.contentEquals(label.getText())) return label;
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                TextView found = firstText(group.getChildAt(i), text);
                if (found != null) return found;
            }
        }
        return null;
    }
}
