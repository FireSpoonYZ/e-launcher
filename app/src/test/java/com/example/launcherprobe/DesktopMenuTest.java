package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {29, 35}, qualifiers = "w384dp-h853dp-xxxhdpi")
public class DesktopMenuTest {
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(sdk = 35)
    public void highDensityIconsAndCompactMenuUseDp() throws Exception {
        try (var controller = Robolectric.buildActivity(Activity.class).setup()) {
            Scene scene = new Scene(controller.get());
            LinearLayout cell = (LinearLayout) scene.grid.getChildAt(0);
            FrameLayout iconFrame = (FrameLayout) cell.getChildAt(0);
            ImageView image = (ImageView) iconFrame.getChildAt(0);
            assertEquals(scene.dp(52), image.getMeasuredWidth());
            assertEquals(iconFrame.getMeasuredWidth(), image.getMeasuredWidth());

            cell.performLongClick();
            scene.layout();
            DesktopMenu menu = scene.menu();
            View panel = menu.getChildAt(0);
            assertEquals(scene.dp(244), panel.getMeasuredWidth());
            assertTrue("No fixed-height blank card", panel.getHeight() < scene.dp(260));
            assertTrue(panel.getLeft() >= 0);
            assertTrue(panel.getRight() <= scene.host.getWidth());
            assertTrue(panel.getBottom() <= scene.host.getHeight());
            View preview = menu.getChildAt(1);
            assertEquals(scene.dp(56), preview.getWidth());
            assertTrue("Selected icon stays outside the menu", preview.getBottom() <= panel.getTop()
                    || preview.getTop() >= panel.getBottom());
            String previewPath = System.getenv("LAUNCHER_MENU_PREVIEW");
            if (previewPath != null) {
                android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(
                        scene.host.getWidth(), scene.host.getHeight(), android.graphics.Bitmap.Config.ARGB_8888);
                android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
                canvas.drawColor(0xfff6f5f0);
                scene.host.draw(canvas);
                try (var output = new java.io.FileOutputStream(previewPath)) {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
                }
                bitmap.recycle();
            }
            scene.desktop.dismissMenu();
        }
    }

    @Test public void outsideTapDismissesWithoutActivatingUnderlyingViewAndBackAlsoCloses() {
        try (var controller = Robolectric.buildActivity(Activity.class).setup()) {
            Scene scene = new Scene(controller.get());
            AtomicInteger clicks = new AtomicInteger();
            View composer = new View(scene.activity);
            composer.setOnClickListener(view -> clicks.incrementAndGet());
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, scene.dp(70));
            params.gravity = android.view.Gravity.BOTTOM;
            scene.home.addView(composer, params);
            scene.grid.getChildAt(0).performLongClick();
            scene.layout();
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS,
                    scene.pager.getImportantForAccessibility());
            tap(scene.host, scene.dp(180), scene.host.getHeight() - scene.dp(20));
            assertNull(scene.menu());
            assertEquals(0, clicks.get());
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, scene.pager.getImportantForAccessibility());
            tap(scene.host, scene.dp(180), scene.host.getHeight() - scene.dp(20));
            assertEquals(1, clicks.get());

            scene.grid.getChildAt(0).performLongClick();
            scene.layout();
            DesktopMenu menu = scene.menu();
            menu.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK));
            menu.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK));
            assertNull(scene.menu());
        }
    }

    @Test public void tappingAnIconWorksAgainAfterDismissingItsLongPressMenu() {
        try (var controller = Robolectric.buildActivity(Activity.class).setup()) {
            Scene scene = new Scene(controller.get());
            View cell = scene.grid.getChildAt(0);
            AtomicInteger clicks = new AtomicInteger();
            cell.setOnClickListener(view -> clicks.incrementAndGet());
            touch(cell, MotionEvent.ACTION_DOWN, 20, 20);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500));
            touch(cell, MotionEvent.ACTION_UP, 20, 20);
            assertNotNull(scene.menu());
            scene.desktop.dismissMenu();
            tap(cell, 20, 20);
            assertEquals(1, clicks.get());
        }
    }

    @Test public void backInFolderClosesTheMenuBeforeClosingTheFolder() {
        try (var controller = Robolectric.buildActivity(Activity.class).setup()) {
            Scene scene = new Scene(controller.get());
            scene.model.set(0, HomeLayout.Item.folder("Tools", List.of(scene.model.get(0))));
            scene.desktop.shortcutsChanged();
            scene.layout();
            scene.grid.getChildAt(0).performClick();
            var dialog = (androidx.activity.ComponentDialog) org.robolectric.shadows.ShadowDialog.getLatestDialog();
            var icons = new java.util.ArrayList<View>();
            dialog.getWindow().getDecorView().findViewsWithText(icons, "Open Test App",
                    View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION);
            assertFalse(icons.isEmpty());
            icons.get(0).performLongClick();
            dialog.getOnBackPressedDispatcher().onBackPressed();
            assertTrue("First back must keep the folder open", dialog.isShowing());
            assertFalse("Menu is already closed", scene.desktop.dismissMenu());
            dialog.getOnBackPressedDispatcher().onBackPressed();
            assertFalse(dialog.isShowing());
        }
    }

    private static final class Scene {
        final Activity activity;
        final FrameLayout host;
        final FrameLayout home;
        final PagerRoot pager;
        final HomeDesktop desktop;
        final HomeLayout model;
        final GridLayout grid;

        Scene(Activity activity) {
            this.activity = activity;
            ResolveInfo app = new ResolveInfo();
            app.activityInfo = new ActivityInfo();
            app.activityInfo.packageName = activity.getPackageName();
            app.activityInfo.name = "TestApp";
            app.activityInfo.applicationInfo = new ApplicationInfo(activity.getApplicationInfo());
            app.nonLocalizedLabel = "Test App";
            app.icon = android.R.drawable.sym_def_app_icon;
            model = HomeLayout.load(activity, List.of(app));
            model.set(0, HomeLayout.Item.app(app.activityInfo.packageName, app.activityInfo.name));
            pager = new PagerRoot(activity, new View(activity), PagerState.Page.HOME, page -> {});
            home = new FrameLayout(activity);
            desktop = new HomeDesktop(activity, pager, model, List.of(app), new LauncherShortcuts(activity), home);
            FrameLayout.LayoutParams position = new FrameLayout.LayoutParams(-1, dp(232));
            position.topMargin = dp(180);
            home.addView(desktop, position);
            pager.setHome(home);
            activity.setContentView(pager);
            host = activity.findViewById(android.R.id.content);
            grid = (GridLayout) desktop.getChildAt(0);
            layout();
        }

        int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
        void layout() {
            host.measure(View.MeasureSpec.makeMeasureSpec(dp(384), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(dp(800), View.MeasureSpec.EXACTLY));
            host.layout(0, 0, dp(384), dp(800));
        }
        DesktopMenu menu() {
            for (int i = 0; i < host.getChildCount(); i++) {
                if (host.getChildAt(i) instanceof DesktopMenu menu) return menu;
            }
            return null;
        }
    }

    private static void tap(View view, int x, int y) {
        touch(view, MotionEvent.ACTION_DOWN, x, y);
        touch(view, MotionEvent.ACTION_UP, x, y);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }

    private static void touch(View view, int action, int x, int y) {
        MotionEvent event = MotionEvent.obtain(0, android.os.SystemClock.uptimeMillis(), action, x, y, 0);
        view.dispatchTouchEvent(event);
        event.recycle();
    }
}
