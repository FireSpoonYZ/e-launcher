package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.content.Context;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.GridLayout;

import androidx.activity.ComponentActivity;
import androidx.dynamicanimation.animation.SpringAnimation;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {29, 35})
public class HomeDesktopPagingTest {
    @Test public void reversingDuringSettleCannotCommitRemovedPage() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            SpringAnimation old = scene.startSettle();
            scene.touch(MotionEvent.ACTION_DOWN, 200);
            scene.touch(MotionEvent.ACTION_MOVE, 300);
            scene.touch(MotionEvent.ACTION_MOVE, 950);
            // The previous implementation keeps this spring alive after dropping its target grid.
            finish(old);
            scene.touch(MotionEvent.ACTION_UP, 950);
            scene.finish();
            assertEquals(0, scene.page());
            assertEquals(0f, scene.grid().getTranslationX(), .01f);
            assertEquals(1, scene.track.getChildCount());
        }
    }

    @Test public void newDragContinuesAtDisplayedOffsetAndCanReverseOrContinue() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            for (int direction : new int[]{1, -1}) {
                scene.desktop.setCurrentPage(0);
                SpringAnimation old = scene.startSettle();
                float offset = scene.grid().getTranslationX();
                scene.touch(MotionEvent.ACTION_DOWN, 500);
                assertFalse("Touch down must stop the previous spring", old.isRunning());
                assertEquals(offset, scene.grid().getTranslationX(), .01f);
                scene.touch(MotionEvent.ACTION_MOVE, 500 + direction * 100);
                assertEquals(offset + direction * 100, scene.grid().getTranslationX(), .01f);
                scene.touch(MotionEvent.ACTION_UP, 500 + direction * 100);
                scene.finish();
                assertEquals(direction > 0 ? 0 : 1, scene.page());
                assertEquals(1, scene.track.getChildCount());
            }
        }
    }

    @Test public void interruptedSettleCanBeTappedOrCancelledWithoutLeavingTwoPages() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            for (int end : new int[]{MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL}) {
                scene.desktop.setCurrentPage(0);
                SpringAnimation old = scene.startSettle();
                scene.touch(MotionEvent.ACTION_DOWN, 500);
                assertFalse(old.isRunning());
                scene.touch(end, 500);
                scene.finish();
                assertEquals(end == MotionEvent.ACTION_CANCEL ? 0 : 1, scene.page());
                assertEquals(0f, scene.grid().getTranslationX(), .01f);
                assertEquals(1, scene.track.getChildCount());
            }
        }
    }

    private static void finish(SpringAnimation animation) {
        if (animation == null) return;
        for (long frame = 16; animation.isRunning() && frame <= 4000; frame += 16) {
            animation.doAnimationFrame(frame);
        }
        assertFalse("Spring must settle", animation.isRunning());
    }

    private static final class Scene {
        final HomeDesktop desktop;
        final FrameLayout track;
        final PagerRoot pager;
        long time;
        long downTime;

        Scene(ComponentActivity activity) {
            activity.getSharedPreferences(HomeLayout.PREFERENCES, Context.MODE_PRIVATE).edit().clear().commit();
            activity.getSharedPreferences(DesktopPreferences.STORE, Context.MODE_PRIVATE).edit().clear().commit();
            HomeLayout model = HomeLayout.load(activity, List.of());
            for (int slot = 0; slot < model.size(); slot++) model.remove(slot);
            model.addPage();
            pager = new PagerRoot(activity, new View(activity), PagerState.Page.HOME, page -> {});
            FrameLayout home = new FrameLayout(activity);
            desktop = new HomeDesktop(activity, pager, model, List.of(), new LauncherShortcuts(activity), home);
            home.addView(desktop, new FrameLayout.LayoutParams(-1, -1));
            pager.setHome(home);
            activity.setContentView(pager);
            pager.measure(View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1600, View.MeasureSpec.EXACTLY));
            pager.layout(0, 0, 1000, 1600);
            track = ReflectionHelpers.getField(desktop, "pageTrack");
            assertEquals(1000, track.getWidth());
            assertTrue(Motion.enabled());
        }

        GridLayout grid() { return ReflectionHelpers.getField(desktop, "grid"); }
        int page() { return ReflectionHelpers.getField(desktop, "currentPage"); }
        void finish() { HomeDesktopPagingTest.finish(ReflectionHelpers.getField(desktop, "pageSpring")); }

        SpringAnimation startSettle() {
            touch(MotionEvent.ACTION_DOWN, 800);
            touch(MotionEvent.ACTION_MOVE, 740); // Child receives CANCEL when the workspace intercepts.
            touch(MotionEvent.ACTION_MOVE, 350);
            touch(MotionEvent.ACTION_UP, 350);
            SpringAnimation animation = ReflectionHelpers.getField(desktop, "pageSpring");
            assertNotNull(animation);
            assertTrue(animation.isRunning());
            assertEquals(-450f, grid().getTranslationX(), .01f);
            return animation;
        }

        void touch(int action, float x) {
            time += 20;
            if (action == MotionEvent.ACTION_DOWN) downTime = time;
            MotionEvent event = MotionEvent.obtain(downTime, time, action, x, 500, 0);
            pager.dispatchTouchEvent(event);
            event.recycle();
        }
    }
}
