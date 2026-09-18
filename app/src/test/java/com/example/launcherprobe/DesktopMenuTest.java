package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageView;

import androidx.activity.ComponentActivity;
import androidx.core.view.ViewCompat;

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
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            View cell = scene.appCell();
            ImageView image = first(cell, ImageView.class);
            assertNotNull(image);
            FrameLayout iconFrame = (FrameLayout) image.getParent();
            assertEquals(scene.dp(52), image.getMeasuredWidth());
            assertEquals(iconFrame.getMeasuredWidth(), image.getMeasuredWidth());

            scene.openHomeMenu();
            DesktopMenu menu = scene.menu();
            assertNotNull(menu);
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
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            AtomicInteger clicks = new AtomicInteger();
            View composer = new View(scene.activity);
            composer.setOnClickListener(view -> clicks.incrementAndGet());
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, scene.dp(70));
            params.gravity = android.view.Gravity.BOTTOM;
            scene.home.addView(composer, params);
            scene.openHomeMenu();
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS,
                    scene.pager.getImportantForAccessibility());
            tap(scene.host, scene.dp(180), scene.host.getHeight() - scene.dp(20));
            assertNull(scene.menu());
            assertEquals(0, clicks.get());
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, scene.pager.getImportantForAccessibility());
            tap(scene.host, scene.dp(180), scene.host.getHeight() - scene.dp(20));
            assertEquals(1, clicks.get());

            scene.openHomeMenu();
            DesktopMenu menu = scene.menu();
            assertNotNull(menu);
            menu.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK));
            menu.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK));
            assertNull(scene.menu());
        }
    }

    @Test public void tappingAnIconWorksAgainAfterDismissingItsLongPressMenu() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            scene.openHomeMenu();
            assertNotNull(scene.menu());
            View cell = scene.appCell();
            scene.desktop.dismissMenu();
            AtomicInteger clicks = new AtomicInteger();
            cell.setOnClickListener(view -> clicks.incrementAndGet());
            tap(cell, 20, 20);
            assertEquals(1, clicks.get());
        }
    }

    @Test public void backInFolderClosesTheMenuBeforeClosingTheFolder() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            scene.model.set(0, HomeLayout.Item.folder("Tools", List.of(scene.model.get(0))));
            scene.desktop.shortcutsChanged();
            scene.layout();
            scene.folderCell().performClick();
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            View folder = scene.folderLayer();
            assertNotNull(folder);
            View icon = firstDescribed(folder, "Open Test App", "打开 Test App");
            assertNotNull(icon);
            icon.performLongClick();
            scene.layout();
            assertNotNull(scene.menu());
            scene.activity.getOnBackPressedDispatcher().onBackPressed();
            assertNotNull("First back must keep the folder open", scene.folderLayer());
            assertFalse("Menu is already closed", scene.desktop.dismissMenu());
            scene.activity.getOnBackPressedDispatcher().onBackPressed();
            // closeFolder() animates for Motion.PAGE; teardownFolder runs on the end action.
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(Motion.PAGE));
            assertNull(scene.folderLayer());
        }
    }

    private static final class Scene {
        final ComponentActivity activity;
        final FrameLayout host;
        final FrameLayout home;
        final PagerRoot pager;
        final HomeDesktop desktop;
        final HomeLayout model;

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
            model = HomeLayout.load(activity, List.of(app));
            model.set(0, HomeLayout.Item.app(app.activityInfo.packageName, app.activityInfo.name));
            pager = new PagerRoot(activity, new View(activity), PagerState.Page.HOME, page -> {});
            home = new FrameLayout(activity);
            desktop = new HomeDesktop(activity, pager, model, List.of(app), new LauncherShortcuts(activity), home);
            home.addView(desktop, new FrameLayout.LayoutParams(-1, -1));
            pager.setHome(home);
            activity.setContentView(pager);
            host = activity.findViewById(android.R.id.content);
            layout();
        }

        int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
        void layout() {
            // 8-row workspace + dock + edit toolbar need this or Cell.onMeasure shrinks below 52dp.
            host.measure(View.MeasureSpec.makeMeasureSpec(dp(384), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(dp(1080), View.MeasureSpec.EXACTLY));
            host.layout(0, 0, dp(384), dp(1080));
        }
        void openHomeMenu() {
            desktop.enterEdit();
            layout();
            appCell().performClick();
            layout();
        }
        View appCell() {
            View cell = firstDescribed(workspace(), "Open Test App", "打开 Test App");
            assertNotNull("home app cell", cell);
            return cell;
        }
        View folderCell() {
            View cell = firstDescribed(workspace(), "Open folder Tools", "打开文件夹 Tools");
            assertNotNull("home folder cell", cell);
            return cell;
        }
        View folderLayer() {
            for (int i = 0; i < host.getChildCount(); i++) {
                View child = host.getChildAt(i);
                if (child == pager || child instanceof DesktopMenu) continue;
                CharSequence title = ViewCompat.getAccessibilityPaneTitle(child);
                if (title != null && title.toString().equals("Tools")) return child;
                if (firstDescribed(child, "Rename folder Tools", "重命名文件夹 Tools") != null) {
                    return child;
                }
            }
            return null;
        }
        DesktopMenu menu() { return first(host, DesktopMenu.class); }
        GridLayout workspace() {
            GridLayout grid = first(desktop, GridLayout.class);
            assertNotNull("desktop workspace", grid);
            return grid;
        }
    }

    private static View firstDescribed(View view, String... texts) {
        CharSequence description = view.getContentDescription();
        if (description != null) {
            String value = description.toString();
            for (String text : texts) if (value.contains(text)) return view;
        }
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                View found = firstDescribed(group.getChildAt(i), texts);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static <T extends View> T first(View view, Class<T> type) {
        if (type.isInstance(view)) return type.cast(view);
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                T found = first(group.getChildAt(i), type);
                if (found != null) return found;
            }
        }
        return null;
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
