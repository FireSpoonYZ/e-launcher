package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.animation.ValueAnimator;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.activity.ComponentActivity;
import androidx.dynamicanimation.animation.SpringAnimation;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.util.ReflectionHelpers;

import java.util.ArrayList;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {29, 35})
public class AppSwitcherTest {
    @Test public void historyContainsOnlyLaunchableUsedAppsInMostRecentOrder() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Context context = controller.get();
            var packages = Shadows.shadowOf(context.getPackageManager());
            Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            for (String name : new String[]{"app.old", "app.new", "app.unused", context.getPackageName()}) {
                ResolveInfo info = new ResolveInfo(); info.nonLocalizedLabel = name;
                info.activityInfo = new ActivityInfo(); info.activityInfo.packageName = name;
                info.activityInfo.name = name + ".Main"; info.activityInfo.enabled = true;
                info.activityInfo.applicationInfo = new ApplicationInfo();
                info.activityInfo.applicationInfo.packageName = name; info.activityInfo.applicationInfo.enabled = true;
                packages.addResolveInfoForIntent(launcher, info);
            }
            var history = context.getSharedPreferences("launcher_app_launches", Context.MODE_PRIVATE);
            history.edit().clear().putLong(key("app.old"), 10).putLong(key("app.new"), 20)
                    .putLong(key("app.uninstalled"), 30).putLong(key(context.getPackageName()), 40).commit();
            assertEquals(List.of("app.new", "app.old"), AppLaunchHistory.recent(context).stream()
                    .map(app -> app.activityInfo.packageName).toList());
        }
    }

    @Test public void dragSwitchesWithoutOpeningAndCancelReturnsToOriginalCard() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 3, 0);
            float stride = ReflectionHelpers.getField(scene.carousel, "stride");
            scene.touch(MotionEvent.ACTION_DOWN, 500);
            scene.touch(MotionEvent.ACTION_MOVE, 500 - stride * .2f);
            scene.touch(MotionEvent.ACTION_MOVE, 500 - stride * .7f);
            scene.touch(MotionEvent.ACTION_UP, 500 - stride * .7f);
            scene.finishSpring();
            assertEquals(key("app.1"), scene.page.selectedComponent());
            assertTrue(scene.opened.isEmpty());
            scene.touch(MotionEvent.ACTION_DOWN, 500);
            scene.touch(MotionEvent.ACTION_MOVE, 500 - stride * .2f);
            scene.touch(MotionEvent.ACTION_MOVE, 500 - stride * .7f);
            scene.touch(MotionEvent.ACTION_CANCEL, 500 - stride * .7f);
            scene.finishSpring();
            assertEquals(key("app.1"), scene.page.selectedComponent());
            assertTrue(scene.opened.isEmpty());
            assertEquals(1f, scene.carousel.getChildAt(1).getScaleX(), .001f);
        }
    }

    @Test public void interruptedSpringKeepsItsPositionAndEndsAtACard() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 3, 0);
            float distance = (float) ReflectionHelpers.getField(scene.carousel, "stride") * .7f;
            scene.touch(MotionEvent.ACTION_DOWN, 500);
            scene.touch(MotionEvent.ACTION_MOVE, 500 - distance);
            scene.touch(MotionEvent.ACTION_UP, 500 - distance);
            SpringAnimation previous = ReflectionHelpers.getField(scene.carousel, "spring");
            assertNotNull(previous);
            float position = ReflectionHelpers.getField(scene.carousel, "track");
            scene.touch(MotionEvent.ACTION_DOWN, 500);
            assertFalse(previous.isRunning());
            assertEquals(position, (float) ReflectionHelpers.getField(scene.carousel, "track"), .001f);
            scene.touch(MotionEvent.ACTION_CANCEL, 500);
            scene.finishSpring();
            float stride = ReflectionHelpers.getField(scene.carousel, "stride");
            assertEquals(stride, (float) ReflectionHelpers.getField(scene.carousel, "track"), .001f);
            assertTrue(scene.opened.isEmpty());
        }
    }

    @Test public void cardOpensOnlyAfterAnimationAndStopCannotLaunchItLater() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 3, 1);
            scene.carousel.getChildAt(1).performClick();
            assertTrue(scene.opened.isEmpty());
            ValueAnimator opening = ReflectionHelpers.getField(scene.page, "transition");
            assertNotNull(opening);
            scene.page.stopAnimations(); opening.end();
            assertTrue(scene.opened.isEmpty());
            scene.page.restoreAfterOpen();
            scene.carousel.getChildAt(1).performClick();
            ValueAnimator next = ReflectionHelpers.getField(scene.page, "transition"); next.end();
            assertEquals(List.of("app.1"), scene.opened);
            // Failure recovery must make the page usable, not leave an expanded cover on top.
            scene.page.restoreAfterOpen();
            assertNull(ReflectionHelpers.getField(scene.page, "expandingCover"));
            scene.page.close();
            ValueAnimator exit = ReflectionHelpers.getField(scene.page, "transition"); exit.end();
            assertEquals(1, scene.closed);
        }
    }

    @Test public void accessibilityPagingAndReducedMotionStillOpenAndClose() {
        ReflectionHelpers.callStaticMethod(ValueAnimator.class, "setDurationScale",
                ReflectionHelpers.ClassParameter.from(float.class, 0f));
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 2, 0);
            assertFalse(Motion.enabled());
            assertTrue(scene.carousel.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null));
            assertEquals(key("app.1"), scene.page.selectedComponent());
            assertNull(ReflectionHelpers.getField(scene.carousel, "spring"));
            assertFalse(scene.carousel.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null));
            scene.carousel.getChildAt(1).performClick();
            assertEquals(List.of("app.1"), scene.opened);
            scene.page.restoreAfterOpen(); scene.page.close();
            assertEquals(1, scene.closed);
        } finally {
            ReflectionHelpers.callStaticMethod(ValueAnimator.class, "setDurationScale",
                    ReflectionHelpers.ClassParameter.from(float.class, 1f));
        }
    }

    @Test public void emptyHistoryAndOneAppHaveNoInventedNeighbors() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene empty = new Scene(controller.get(), 0, 0);
            assertNull(empty.page.selectedComponent());
            assertNull(empty.carousel);
            Scene single = new Scene(controller.get(), 1, 0);
            single.touch(MotionEvent.ACTION_DOWN, 500);
            single.touch(MotionEvent.ACTION_MOVE, 850);
            single.touch(MotionEvent.ACTION_UP, 850);
            single.finishSpring();
            assertEquals(1, single.carousel.getChildCount());
            assertEquals(key("app.0"), single.page.selectedComponent());
            assertEquals(0f, (float) ReflectionHelpers.getField(single.carousel, "track"), .001f);
            assertTrue(single.opened.isEmpty());
        }
    }

    @Test public void openingReleaseAndMultiTouchCannotAccidentallyOpenACard() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 2, 0);
            scene.touch(MotionEvent.ACTION_UP, scene.carousel.getWidth() / 2f); // Opening finger has no card DOWN.
            ShadowLooper.idleMainLooper();
            assertTrue(scene.opened.isEmpty());
            assertNull(ReflectionHelpers.getField(scene.page, "transition"));
            scene.touch(MotionEvent.ACTION_DOWN, scene.carousel.getWidth() / 2f);
            MotionEvent.PointerProperties[] properties = {new MotionEvent.PointerProperties(), new MotionEvent.PointerProperties()};
            MotionEvent.PointerCoords[] coords = {new MotionEvent.PointerCoords(), new MotionEvent.PointerCoords()};
            for (int i = 0; i < 2; i++) {
                properties[i].id = i; properties[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
                coords[i].x = scene.carousel.getWidth() / 2f + 40 * i;
                coords[i].y = scene.carousel.getHeight() / 2f; coords[i].pressure = 1; coords[i].size = 1;
            }
            MotionEvent extra = MotionEvent.obtain(scene.downTime, scene.time + 16,
                    MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                    2, properties, coords, 0, 0, 1, 1, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0);
            scene.carousel.dispatchTouchEvent(extra); extra.recycle();
            scene.touch(MotionEvent.ACTION_UP, scene.carousel.getWidth() / 2f);
            ShadowLooper.idleMainLooper();
            assertTrue(scene.opened.isEmpty());
            assertNull(ReflectionHelpers.getField(scene.page, "transition"));
            // Activate through the same accessibility/click action as the other UI tests.
            // Actual native touch dispatch is also checked on the connected device.
            scene.carousel.getChildAt(0).performClick();
            ValueAnimator opening = ReflectionHelpers.getField(scene.page, "transition");
            assertNotNull(opening);
            opening.end(); assertEquals(List.of("app.0"), scene.opened);
        }
    }

    @Test public void shortLandscapeWindowRetainsSelectionAndReadableCoverContents() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 3, 1);
            scene.page.measure(View.MeasureSpec.makeMeasureSpec(1600, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY));
            scene.page.layout(0, 0, 1600, 400);
            assertEquals(key("app.1"), scene.page.selectedComponent());
            ViewGroup cover = ReflectionHelpers.getField(scene.carousel.getChildAt(1), "cover");
            ViewGroup identity = (ViewGroup) cover.getChildAt(1);
            assertTrue(cover.getHeight() > 0);
            assertTrue(identity.getTop() >= 0);
            assertTrue(identity.getBottom() <= cover.getHeight());
            assertTrue(identity.getChildAt(1).getBottom() <= identity.getHeight());
        }
    }

    private static String key(String name) { return new ComponentName(name, name + ".Main").flattenToString(); }

    private static final class Scene {
        final AppSwitcherView page;
        final ViewGroup carousel;
        final List<String> opened = new ArrayList<>();
        int closed;
        long time, downTime;

        Scene(ComponentActivity activity, int count, int selected) {
            page = new AppSwitcherView(activity, app -> opened.add(app.component().getPackageName()), () -> closed++, () -> closed++);
            activity.setContentView(page);
            List<AppSwitcherView.App> apps = new ArrayList<>();
            for (int i = 0; i < count; i++) {
                String name = "app." + i;
                apps.add(new AppSwitcherView.App(new ComponentName(name, name + ".Main"), "应用 " + i,
                        Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888), 0xffd9eff0));
            }
            page.showApps(apps, key("app." + selected));
            page.measure(View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1600, View.MeasureSpec.EXACTLY));
            page.layout(0, 0, 1000, 1600);
            carousel = ReflectionHelpers.getField(page, "carousel");
        }

        void finishSpring() {
            SpringAnimation animation = ReflectionHelpers.getField(carousel, "spring");
            if (animation == null) return;
            for (long frame = 16; animation.isRunning() && frame <= 4000; frame += 16) animation.doAnimationFrame(frame);
            assertFalse(animation.isRunning());
        }

        void touch(int action, float x) {
            time += 32;
            if (action == MotionEvent.ACTION_DOWN) downTime = time;
            MotionEvent event = MotionEvent.obtain(downTime, time, action, x, carousel.getHeight() / 2f, 0);
            carousel.dispatchTouchEvent(event); event.recycle();
        }
    }
}
