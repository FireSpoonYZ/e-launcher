package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.graphics.Rect;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.OverScroller;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class HomeTaskCardsTest {
    @Test public void animationAndStepsAreIndependentOfModelIdle() throws Exception {
        for (String model : new String[]{"working", "idle", "stopping"}) {
            for (String state : new String[]{"pending", "in_progress", "completed"}) {
                assertEquals(model.equals("working") && state.equals("in_progress"),
                        HomeTaskCards.animateNode(model, state, true));
                assertFalse(HomeTaskCards.animateNode(model, state, false));
            }
        }
        JSONObject card = new JSONObject("{\"todo\":{\"package\":\"@juicesharp/rpiv-todo\",\"tasks\":[{\"status\":\"completed\"},{\"status\":\"deleted\"},{\"status\":\"in_progress\"}]}}");
        assertEquals(2, HomeTaskCards.tasks(card).size());
        card.getJSONObject("todo").getJSONArray("tasks").getJSONObject(2).put("status", "completed");
        assertEquals(2, HomeTaskCards.tasks(card).size());
        card.getJSONObject("todo").put("package", "untrusted");
        assertTrue(HomeTaskCards.tasks(card).isEmpty());
    }

    @Test public void cardSwipeDoesNotSwitchRootAndUpdatesKeepSelection() throws Exception {
        android.content.Context context = RuntimeEnvironment.getApplication();
        PagerRoot pager = new PagerRoot(context, new View(context), PagerState.Page.HOME, page -> {});
        HomeTaskCards cards = new HomeTaskCards(context, pager, id -> {}, id -> {}, id -> {});
        pager.setHome(cards);
        JSONArray data = new JSONArray("[{\"conversationId\":\"a\",\"title\":\"A\",\"modelState\":\"working\"},{\"conversationId\":\"b\",\"title\":\"B\",\"modelState\":\"idle\"}]");
        cards.update(data);
        pager.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY));
        pager.layout(0, 0, 600, 800);
        assertEquals("a", cards.selectedId());
        touch(pager, MotionEvent.ACTION_DOWN, 500, 50, 0);
        touch(pager, MotionEvent.ACTION_MOVE, 300, 50, 20);
        touch(pager, MotionEvent.ACTION_UP, 100, 50, 40);
        assertEquals(PagerState.Page.HOME, pager.page());
        assertEquals("a", cards.selectedId());
        touch(pager, MotionEvent.ACTION_DOWN, 300, 50, 60);
        touch(pager, MotionEvent.ACTION_MOVE, 300, 200, 80);
        touch(pager, MotionEvent.ACTION_UP, 300, 400, 100);
        assertEquals(PagerState.Page.HOME, pager.page());
        assertEquals("b", cards.selectedId());
        data.getJSONObject(0).put("modelState", "idle");
        cards.update(data);
        assertEquals("b", cards.selectedId());
    }

    @Test public void constrainedBodyScrollDoesNotSwitchCards() throws Exception {
        android.content.Context context = RuntimeEnvironment.getApplication();
        PagerRoot pager = new PagerRoot(context, new View(context), PagerState.Page.HOME, page -> {});
        HomeTaskCards cards = new HomeTaskCards(context, pager, id -> {}, id -> {}, id -> {});
        pager.setHome(cards);
        JSONObject todo = new JSONObject()
                .put("package", "@juicesharp/rpiv-todo")
                .put("tasks", new JSONArray()
                        .put(new JSONObject().put("id", "t1").put("subject", "Completed step").put("status", "completed"))
                        .put(new JSONObject().put("id", "t2").put("subject", "Active step").put("status", "in_progress"))
                        .put(new JSONObject().put("id", "t3").put("subject", "Pending step").put("status", "pending")));
        JSONArray data = new JSONArray()
                .put(new JSONObject().put("conversationId", "a").put("title", "A").put("modelState", "working").put("todo", todo))
                .put(new JSONObject().put("conversationId", "b").put("title", "B").put("modelState", "idle").put("todo", new JSONObject(todo.toString())));
        cards.setAvailableHeight(240);
        cards.update(data);
        pager.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(240, View.MeasureSpec.EXACTLY));
        pager.layout(0, 0, 600, 240);
        ScrollView scroll = first(cards, ScrollView.class);
        View heading = headingOf(cards);
        View strip = cards.findViewWithTag("todo-strip");
        assertNotNull(scroll);
        assertNotNull(heading);
        assertTrue(scroll.getChildAt(0).getHeight() > scroll.getHeight());
        assertEquals("a", cards.selectedId());
        assertEquals(0, scroll.getScrollY());
        Rect headingRect = new Rect();
        Rect bodyRect = new Rect();
        Rect stripRect = new Rect();
        assertTrue(heading.getGlobalVisibleRect(headingRect));
        assertTrue(scroll.getGlobalVisibleRect(bodyRect));
        if (strip != null) strip.getGlobalVisibleRect(stripRect);
        assertTrue(headingRect.bottom + 8 < bodyRect.bottom);
        int bodyX = bodyRect.centerX();
        int bodyY = headingRect.bottom + Math.min(24, Math.max(8, (bodyRect.bottom - headingRect.bottom) / 4));
        assertTrue(bodyRect.contains(bodyX, bodyY));
        assertFalse(headingRect.contains(bodyX, bodyY));
        assertFalse(stripRect.contains(bodyX, bodyY));
        touch(pager, MotionEvent.ACTION_DOWN, bodyX, bodyY, 0);
        touch(pager, MotionEvent.ACTION_MOVE, bodyX, bodyY - 20, 16);
        touch(pager, MotionEvent.ACTION_MOVE, bodyX, bodyY - 80, 32);
        touch(pager, MotionEvent.ACTION_UP, bodyX, bodyY - 100, 48);
        assertEquals(PagerState.Page.HOME, pager.page());
        assertEquals("a", cards.selectedId());
        assertTrue(scroll.getScrollY() > 0);
        stopFling(scroll);
        scroll.scrollTo(0, 0);
        assertTrue(heading.getGlobalVisibleRect(headingRect));
        touch(pager, MotionEvent.ACTION_DOWN, headingRect.centerX(), headingRect.centerY(), 60);
        touch(pager, MotionEvent.ACTION_MOVE, headingRect.centerX(), headingRect.centerY() + 120, 80);
        touch(pager, MotionEvent.ACTION_UP, headingRect.centerX(), headingRect.centerY() + 200, 100);
        assertEquals(PagerState.Page.HOME, pager.page());
        assertEquals("b", cards.selectedId());
        data.getJSONObject(0).put("modelState", "idle");
        cards.update(data);
        assertEquals("b", cards.selectedId());
    }

    @Test public void idleCardArchivesWithoutConfirmationAndBusyCardStops() throws Exception {
        android.content.Context context = RuntimeEnvironment.getApplication();
        PagerRoot pager = new PagerRoot(context, new View(context), PagerState.Page.HOME, page -> {});
        AtomicReference<String> archived = new AtomicReference<>();
        AtomicReference<String> stopped = new AtomicReference<>();
        AtomicBoolean listed = new AtomicBoolean();
        HomeTaskCards cards = new HomeTaskCards(context, pager, new View(context),
                id -> {}, stopped::set, archived::set, () -> listed.set(true));
        pager.setHome(cards);
        JSONArray data = new JSONArray("[{\"conversationId\":\"a\",\"title\":\"A\",\"modelState\":\"idle\"}]");
        cards.update(data);
        pager.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY));
        pager.layout(0, 0, 600, 800);
        TextView archive = firstExact(cards, "Archive", "归档");
        assertNotNull(archive);
        assertNull(firstExact(cards, "Delete", "删除"));
        archive.performClick();
        assertEquals("a", archived.get());
        assertNull(stopped.get());
        View archivedEntry = findDescription(cards, "Archived chats", "已归档对话");
        assertNotNull(archivedEntry);
        archivedEntry.performClick();
        assertTrue(listed.get());

        archived.set(null);
        data.getJSONObject(0).put("modelState", "working");
        cards.update(data);
        TextView stop = firstExact(cards, "Stop", "停止");
        assertNotNull(stop);
        stop.performClick();
        assertEquals("a", stopped.get());
        assertNull(archived.get());
    }

    @Test public void emptyCardExposesArchivedList() throws Exception {
        android.content.Context context = RuntimeEnvironment.getApplication();
        PagerRoot pager = new PagerRoot(context, new View(context), PagerState.Page.HOME, page -> {});
        AtomicBoolean listed = new AtomicBoolean();
        HomeTaskCards cards = new HomeTaskCards(context, pager, new View(context),
                id -> {}, id -> {}, id -> {}, () -> listed.set(true));
        pager.setHome(cards);
        cards.update(new JSONArray());
        pager.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY));
        pager.layout(0, 0, 600, 800);
        View entry = findDescription(cards, "Archived chats", "已归档对话");
        assertNotNull(entry);
        entry.performClick();
        assertTrue(listed.get());
    }

    @Test public void emptyCardActionsFitWhenAvailableSizeChanges() {
        android.content.Context context = RuntimeEnvironment.getApplication();
        HomeTaskCards cards = new HomeTaskCards(context, null, new View(context),
                id -> {}, id -> {}, id -> {}, () -> {});
        cards.update(new JSONArray());
        float density = context.getResources().getDisplayMetrics().density;
        for (int widthDp : new int[]{260, 354, 420}) {
            for (int heightDp : new int[]{160, 220, 244, 280, 400, 160}) {
                int width = Math.round(widthDp * density), height = Math.round(heightDp * density);
                cards.setAvailableHeight(height);
                cards.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
                cards.layout(0, 0, width, height);
                View archive = findDescription(cards, "Archived chats", "已归档对话");
                View start = firstExact(cards, "Start conversation", "开始对话");
                Rect archiveBounds = new Rect(), startBounds = new Rect();
                archive.getDrawingRect(archiveBounds);
                start.getDrawingRect(startBounds);
                cards.offsetDescendantRectToMyCoords(archive, archiveBounds);
                cards.offsetDescendantRectToMyCoords(start, startBounds);
                Rect bounds = new Rect(0, 0, width, height);
                assertTrue(bounds.contains(archiveBounds));
                assertTrue(bounds.contains(startBounds));
                assertFalse(Rect.intersects(archiveBounds, startBounds));
                assertTrue(start.getHeight() >= Math.round(48 * density));
                assertTrue(archive.getHeight() >= Math.round(48 * density));
                assertChildrenFit(cards);
                android.widget.ImageView star = first(cards, android.widget.ImageView.class);
                Rect iconBounds = star.getDrawable().getBounds();
                assertTrue(iconBounds.width() > 0);
                assertEquals(iconBounds.width(), iconBounds.height());
            }
        }
    }

    private static void assertChildrenFit(ViewGroup parent) {
        for (int i = 0; i < parent.getChildCount(); i++) {
            View child = parent.getChildAt(i);
            assertTrue(child.getLeft() >= 0 && child.getTop() >= 0);
            assertTrue(child.getRight() <= parent.getWidth());
            assertTrue(child.getBottom() <= parent.getHeight());
            if (child instanceof ViewGroup group) assertChildrenFit(group);
        }
    }

    private static void stopFling(ScrollView scroll) {
        // ACTION_UP may start OverScroller; ScrollView.scrollTo does not abort it.
        // A live fling DOWN calls requestDisallowInterceptTouchEvent, so the parent
        // never intercepts a following header swipe. Settle inertia first.
        OverScroller scroller = ReflectionHelpers.getField(scroll, "mScroller");
        if (scroller != null) scroller.abortAnimation();
    }

    private static View headingOf(View root) {
        // Product switch surface is tagged; brand text no longer includes "✦".
        return root.findViewWithTag("card-switch");
    }

    private static TextView firstExact(View view, String... texts) {
        if (view instanceof TextView text) {
            CharSequence value = text.getText();
            if (value != null) {
                String shown = value.toString();
                for (String expected : texts) if (shown.equals(expected)) return text;
            }
        }
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                TextView found = firstExact(group.getChildAt(i), texts);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static View findDescription(View view, String... texts) {
        CharSequence description = view.getContentDescription();
        if (description != null) {
            String shown = description.toString();
            for (String expected : texts) if (shown.equals(expected)) return view;
        }
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                View found = findDescription(group.getChildAt(i), texts);
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

    private void touch(View view, int action, float x, float y, long time) {
        MotionEvent event = MotionEvent.obtain(0, time, action, x, y, 0);
        view.dispatchTouchEvent(event);
        event.recycle();
    }
}
