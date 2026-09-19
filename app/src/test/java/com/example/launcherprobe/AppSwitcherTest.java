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
            scene.time += 300;
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

    @Test public void oneContinuousDragCanCrossSeveralStackedCards() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 8, 0);
            float stride = ReflectionHelpers.getField(scene.carousel, "stride");
            scene.touch(MotionEvent.ACTION_DOWN, 900);
            scene.touch(MotionEvent.ACTION_MOVE, 900 - stride);
            scene.touch(MotionEvent.ACTION_MOVE, 900 - stride * 3.1f);
            scene.time += 300; // Release after holding: test distance, not fling speed.
            scene.touch(MotionEvent.ACTION_MOVE, 900 - stride * 3.1f);
            scene.touch(MotionEvent.ACTION_UP, 900 - stride * 3.1f);
            scene.finishSpring();
            assertEquals(key("app.3"), scene.page.selectedComponent());
            View front = scene.carousel.getChildAt(3), behind = scene.carousel.getChildAt(4);
            assertEquals(1f, front.getScaleX(), .001f);
            assertTrue(behind.getScaleX() < front.getScaleX());
            assertTrue(behind.getTranslationZ() < front.getTranslationZ());
            assertTrue(behind.getTranslationX() - front.getTranslationX() < front.getWidth() / 2f);
            assertTrue(scene.opened.isEmpty());
        }
    }

    @Test public void fastFlickCrossesMultipleCardsInBothDirectionsAndClampsAtEnds() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 12, 5);
            float stride = ReflectionHelpers.getField(scene.carousel, "stride");
            scene.flick(800, -stride * .8f);
            int forward = ReflectionHelpers.getField(scene.carousel, "selected");
            assertTrue("A short fast flick must skip more than one card", forward >= 7);
            scene.finishSpring();
            scene.flick(200, stride * .8f);
            int backward = ReflectionHelpers.getField(scene.carousel, "selected");
            assertTrue(backward <= forward - 2);
            scene.finishSpring();
            scene.flick(200, stride * 20);
            scene.finishSpring();
            assertEquals(key("app.0"), scene.page.selectedComponent());
            assertEquals(0f, (float) ReflectionHelpers.getField(scene.carousel, "track"), .001f);
            assertTrue(scene.opened.isEmpty());
        }
    }

    @Test public void catchingLongThrowSelectsVisibleCardRatherThanOldDestination() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 12, 0);
            float stride = ReflectionHelpers.getField(scene.carousel, "stride");
            scene.flick(800, -stride * .8f);
            int destination = ReflectionHelpers.getField(scene.carousel, "selected");
            float caught = ReflectionHelpers.getField(scene.carousel, "track");
            assertTrue(destination > Math.round(caught / stride));
            scene.touch(MotionEvent.ACTION_DOWN, 500);
            assertEquals(caught, (float) ReflectionHelpers.getField(scene.carousel, "track"), .001f);
            scene.touch(MotionEvent.ACTION_CANCEL, 500);
            scene.finishSpring();
            assertEquals(Math.round(caught / stride), (int) ReflectionHelpers.getField(scene.carousel, "selected"));
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

    @Test public void flickingACardUpwardsForgetsOnlyThatAppAndClosesTheGap() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 3, 0);
            float middle = scene.carousel.getWidth() / 2f, bottom = scene.carousel.getHeight() * .8f;
            scene.touch(MotionEvent.ACTION_DOWN, middle, bottom);
            scene.touch(MotionEvent.ACTION_MOVE, middle, bottom - 60);
            scene.touch(MotionEvent.ACTION_MOVE, middle, bottom - 500);
            scene.touch(MotionEvent.ACTION_UP, middle, bottom - 500);
            assertEquals(List.of("app.0"), scene.forgotten);
            scene.finishCollapse();
            assertEquals(key("app.1"), scene.page.selectedComponent());
            assertEquals(2, ((List<?>) ReflectionHelpers.getField(scene.carousel, "cards")).size());
            assertEquals(0f, (float) ReflectionHelpers.getField(scene.carousel, "track"), .001f);
            assertTrue(scene.opened.isEmpty());
        }
    }

    @Test public void shortUpwardNudgeKeepsTheCardAndNeverForgetsIt() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 2, 0);
            float middle = scene.carousel.getWidth() / 2f, bottom = scene.carousel.getHeight() * .8f;
            scene.touch(MotionEvent.ACTION_DOWN, middle, bottom);
            scene.touch(MotionEvent.ACTION_MOVE, middle, bottom - 60);
            scene.time += 300; // Released slowly and well short of the removal distance.
            scene.touch(MotionEvent.ACTION_MOVE, middle, bottom - 60);
            scene.touch(MotionEvent.ACTION_UP, middle, bottom - 60);
            assertTrue(scene.forgotten.isEmpty());
            assertEquals(2, ((List<?>) ReflectionHelpers.getField(scene.carousel, "cards")).size());
            assertTrue(scene.opened.isEmpty());
        }
    }

    @Test public void clearingEverythingForgetsEveryAppAndLeavesNoStack() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 3, 1);
            ReflectionHelpers.callInstanceMethod(scene.page, "clearAll");
            assertEquals(List.of("app.0", "app.1", "app.2"), scene.forgotten);
            ShadowLooper.idleMainLooper(1, java.util.concurrent.TimeUnit.SECONDS);
            assertNull(scene.page.selectedComponent());
            assertNull(ReflectionHelpers.getField(scene.page, "carousel"));
            assertTrue(scene.opened.isEmpty());
        }
    }

    @Test public void artLoadsOnlyAroundTheVisibleWindowAndIsCancelledBehindIt() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), 40, 0);
            assertEquals(List.of("app.0", "app.1", "app.2", "app.3", "app.4", "app.5"), scene.loaded);
            assertTrue(scene.cancelled.isEmpty());
            scene.loaded.clear();
            float stride = ReflectionHelpers.getField(scene.carousel, "stride");
            scene.flick(800, -stride * 4);
            scene.finishSpring();
            int selected = ReflectionHelpers.getField(scene.carousel, "selected");
            assertTrue("The window must follow the selection", selected >= 4);
            assertEquals(List.of("app." + (selected + 5)), scene.loaded.subList(scene.loaded.size() - 1, scene.loaded.size()));
            assertTrue(scene.loaded.size() < 40);
            // Cards left far behind release their bitmaps instead of holding the whole history.
            List<?> cards = ReflectionHelpers.getField(scene.carousel, "cards");
            assertNull(ReflectionHelpers.getField(cards.get(0), "art"));
            assertNotNull(ReflectionHelpers.getField(cards.get(selected), "art"));
            assertTrue(scene.opened.isEmpty());
        }
    }

    private static String key(String name) { return new ComponentName(name, name + ".Main").flattenToString(); }

    private static final class Scene implements AppSwitcherView.Host {
        final AppSwitcherView page;
        final ViewGroup carousel;
        final List<String> opened = new ArrayList<>();
        final List<String> forgotten = new ArrayList<>();
        final List<String> loaded = new ArrayList<>();
        final List<String> cancelled = new ArrayList<>();
        int closed;
        long time, downTime;

        @Override public void open(AppSwitcherView.App app) { opened.add(app.component().getPackageName()); }
        @Override public void close() { closed++; }
        @Override public void home() { closed++; }
        @Override public void forget(AppSwitcherView.App app) { forgotten.add(app.component().getPackageName()); }
        @Override public void cancel(AppSwitcherView.App app) { cancelled.add(app.component().getPackageName()); }
        @Override public void load(AppSwitcherView.App app, java.util.function.Consumer<AppSwitcherView.Art> ready) {
            loaded.add(app.component().getPackageName());
            ready.accept(new AppSwitcherView.Art(
                    Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888), 0xffd9eff0, null));
        }

        Scene(ComponentActivity activity, int count, int selected) {
            page = new AppSwitcherView(activity, this);
            activity.setContentView(page);
            List<AppSwitcherView.App> apps = new ArrayList<>();
            for (int i = 0; i < count; i++) {
                String name = "app." + i;
                apps.add(new AppSwitcherView.App(new ComponentName(name, name + ".Main"), "应用 " + i));
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

        void flick(float x, float distance) {
            touch(MotionEvent.ACTION_DOWN, x);
            for (int i = 1; i <= 4; i++) {
                time -= 20; // 12 ms samples, including UP, exercise the real VelocityTracker.
                touch(i == 4 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE, x + distance * i / 4);
            }
        }

        void touch(int action, float x) { touch(action, x, carousel.getHeight() / 2f); }

        void touch(int action, float x, float y) {
            time += 32;
            if (action == MotionEvent.ACTION_DOWN) downTime = time;
            MotionEvent event = MotionEvent.obtain(downTime, time, action, x, y, 0);
            carousel.dispatchTouchEvent(event); event.recycle();
        }

        void finishCollapse() {
            ValueAnimator animation = ReflectionHelpers.getField(carousel, "collapse");
            if (animation != null) animation.end();
        }
    }
}
