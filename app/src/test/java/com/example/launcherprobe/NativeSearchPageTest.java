package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.graphics.Rect;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ListView;
import androidx.activity.ComponentActivity;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class NativeSearchPageTest {
    @Test public void globalSearchOverflowingListScrollsInsteadOfClosing() throws Exception {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), NativeSearchPage.Mode.GLOBAL_SEARCH, 720);
            scene.fill(24);
            assertTrue(scene.listOverflows());
            int before = scene.scrollMark();
            scene.swipeOnList(0, -160);
            assertFalse(scene.closing());
            assertEquals(0f, scene.page.getTranslationY(), .01f);
            assertEquals(0, scene.host.closed);
            assertTrue("list should move toward later results", scene.scrollMark() > before);
            scene.cancelGesture();
            scene.scrollToEnd();
            assertFalse("list should be at the last row", scene.canScrollTowardEnd());
            scene.swipeOnList(0, -160);
            assertTrue("upward pull at bottom still closes search", scene.closing());
            assertTrue(scene.page.getTranslationY() < 0);
            assertEquals(0, scene.host.closed);
        }
    }

    @Test public void appLibraryScrolledListPullsBackInsteadOfClosing() throws Exception {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), NativeSearchPage.Mode.APP_LIBRARY, 720);
            scene.fill(24);
            assertTrue(scene.listOverflows());
            scene.swipeOnList(0, 160);
            assertTrue(scene.closing());
            assertTrue(scene.page.getTranslationY() > 0);
            scene.cancelGesture();
            scene.scrollToEnd();
            assertTrue("scrolled library list can still move toward the top", scene.canScrollTowardStart());
            int before = scene.scrollMark();
            scene.swipeOnList(0, 160);
            assertFalse("downward pull must scroll, not close", scene.closing());
            assertEquals(0f, scene.page.getTranslationY(), .01f);
            assertEquals(0, scene.host.closed);
            assertTrue(scene.scrollMark() < before);
            View alphabet = ReflectionHelpers.getField(scene.page, "alphabet");
            java.util.Map<String, Integer> sections = ReflectionHelpers.getField(scene.page, "sectionPositions");
            scene.input.setText("QQ");
            ReflectionHelpers.callInstanceMethod(scene.page, "cancelSearch");
            sections.put("Q", 0);
            sections.put("T", 1);
            ReflectionHelpers.callInstanceMethod(scene.page, "buildAlphabet");
            scene.layout();
            assertEquals(View.GONE, alphabet.getVisibility());
            assertEquals(((View) scene.list.getParent()).getWidth(), scene.list.getWidth());
            scene.input.setText("");
            ReflectionHelpers.callInstanceMethod(scene.page, "cancelSearch");
            sections.put("Q", 0);
            sections.put("T", 1);
            ReflectionHelpers.callInstanceMethod(scene.page, "buildAlphabet");
            scene.layout();
            assertEquals(View.VISIBLE, alphabet.getVisibility());
        }
    }

    @Test public void headerAndShortListCloseOnlyInEntryDirection() throws Exception {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene global = new Scene(controller.get(), NativeSearchPage.Mode.GLOBAL_SEARCH, 720);
            global.fill(2);
            assertFalse(global.listOverflows());
            global.swipeOnList(0, 160);
            assertFalse(global.closing());
            assertEquals(0f, global.page.getTranslationY(), .01f);
            global.swipeOnList(0, -160);
            assertTrue(global.closing());
            assertTrue(global.page.getTranslationY() < 0);
            global.cancelGesture();
            global.swipeOnHeader(0, -160);
            assertTrue(global.closing());
            assertTrue(global.page.getTranslationY() < 0);

            Scene library = new Scene(controller.get(), NativeSearchPage.Mode.APP_LIBRARY, 720);
            library.fill(2);
            assertFalse(library.listOverflows());
            library.swipeOnList(0, -160);
            assertFalse(library.closing());
            assertEquals(0f, library.page.getTranslationY(), .01f);
            library.swipeOnList(0, 160);
            assertTrue(library.closing());
            assertTrue(library.page.getTranslationY() > 0);
            library.cancelGesture();
            library.swipeOnHeader(0, 160);
            assertTrue(library.closing());
            assertTrue(library.page.getTranslationY() > 0);
        }
    }

    @Test public void keyboardResizeKeepsOverflowingListScrollable() throws Exception {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), NativeSearchPage.Mode.GLOBAL_SEARCH, 720);
            scene.fill(24);
            scene.resize(320);
            assertTrue(scene.list.getHeight() > 0);
            assertTrue(scene.listOverflows());
            int before = scene.scrollMark();
            scene.swipeOnList(0, -160);
            assertFalse(scene.closing());
            assertEquals(0f, scene.page.getTranslationY(), .01f);
            assertEquals(0, scene.host.closed);
            assertTrue(scene.scrollMark() > before);
        }
    }

    private static final class HostStub implements NativeSearchPage.Host {
        int closed;
        @Override public void showDesktop() { closed++; }
        @Override public void sendToAssistant(String prompt) { }
        @Override public void openSettings(String destination) { }
        @Override public void onDragStarted(NativeSearchPage.DragItem item) { }
    }

    private static final class Scene {
        final HostStub host = new HostStub();
        final NativeSearchPage page;
        final ListView list;
        final EditText input;
        int height;
        long time;
        long downTime;

        Scene(ComponentActivity activity, NativeSearchPage.Mode mode, int height) {
            this.height = height;
            page = new NativeSearchPage(activity, mode, mode == NativeSearchPage.Mode.GLOBAL_SEARCH ? "QQ" : "", host);
            activity.setContentView(page);
            ShadowLooper.idleMainLooper();
            ReflectionHelpers.callInstanceMethod(page, "cancelSearch");
            list = first(page, ListView.class);
            input = first(page, EditText.class);
            assertNotNull(list);
            assertNotNull(input);
            layout();
        }

        void fill(int count) throws Exception {
            ReflectionHelpers.callInstanceMethod(page, "cancelSearch");
            ArrayList<Object> rows = ReflectionHelpers.getField(page, "rows");
            rows.clear();
            Class<?> row = Class.forName("com.example.launcherprobe.NativeSearchPage$Row");
            var ctor = row.getDeclaredConstructor(String.class, List.class, Runnable.class, boolean.class);
            ctor.setAccessible(true);
            for (int i = 0; i < count; i++)
                rows.add(ctor.newInstance("结果 " + i, null, (Runnable) () -> {}, false));
            ReflectionHelpers.callInstanceMethod(page, "notifyRows");
            layout();
            ShadowLooper.idleMainLooper();
            assertEquals(count, list.getCount());
            assertTrue(list.getChildCount() > 0);
        }

        void scrollToEnd() {
            for (int i = 0; i < 80 && canScrollTowardEnd(); i++) list.scrollListBy(Math.max(48, list.getHeight() / 3));
        }

        void layout() {
            page.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
            page.layout(0, 0, 1080, height);
        }

        void resize(int nextHeight) {
            height = nextHeight;
            layout();
        }

        boolean listOverflows() {
            return canScrollTowardStart() || canScrollTowardEnd();
        }

        boolean canScrollTowardStart() {
            return ReflectionHelpers.callInstanceMethod(page, "listCanScrollTowardStart");
        }

        boolean canScrollTowardEnd() {
            return ReflectionHelpers.callInstanceMethod(page, "listCanScrollTowardEnd");
        }

        boolean closing() {
            return ReflectionHelpers.getField(page, "closing");
        }

        int scrollMark() {
            View first = list.getChildAt(0);
            int top = first == null ? 0 : first.getTop();
            return list.getFirstVisiblePosition() * 1000 - top;
        }

        void swipeOnList(float dx, float dy) {
            Rect bounds = new Rect(0, 0, list.getWidth(), list.getHeight());
            page.offsetDescendantRectToMyCoords(list, bounds);
            swipe(bounds.centerX() + dx, bounds.centerY(), dx, dy);
        }

        void swipeOnHeader(float dx, float dy) {
            Rect bounds = new Rect(0, 0, input.getWidth(), input.getHeight());
            page.offsetDescendantRectToMyCoords(input, bounds);
            swipe(bounds.centerX() + dx, bounds.centerY(), dx, dy);
        }

        void swipe(float x, float y, float dx, float dy) {
            touch(MotionEvent.ACTION_DOWN, x, y);
            touch(MotionEvent.ACTION_MOVE, x + dx / 2, y + dy / 2);
            touch(MotionEvent.ACTION_MOVE, x + dx, y + dy);
        }

        void cancelGesture() {
            touch(MotionEvent.ACTION_CANCEL, 10, 10);
            page.setTranslationY(0);
            ReflectionHelpers.setField(page, "closing", false);
        }

        void touch(int action, float x, float y) {
            time += 16;
            if (action == MotionEvent.ACTION_DOWN) downTime = time;
            MotionEvent event = MotionEvent.obtain(downTime, time, action, x, y, 0);
            page.dispatchTouchEvent(event);
            event.recycle();
        }
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
}
