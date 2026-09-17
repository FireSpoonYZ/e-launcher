package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.Application;
import android.graphics.Rect;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.OverScroller;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

import java.time.Duration;

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

    @Test public void unconstrainedBodySwipeSwitchesCardsAndCancelsChildClick() throws Exception {
        android.content.Context context = RuntimeEnvironment.getApplication();
        PagerRoot pager = new PagerRoot(context, new View(context), PagerState.Page.HOME, page -> {});
        HomeTaskCards cards = new HomeTaskCards(context, pager, id -> {}, id -> {}, id -> {});
        pager.setHome(cards);
        JSONArray data = twoTodoCards();
        cards.setAvailableHeight(800);
        cards.update(data);
        pager.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY));
        pager.layout(0, 0, 600, 800);
        ScrollView scroll = first(cards, ScrollView.class);
        View heading = headingOf(cards);
        TextView title = firstText(scroll, "A");
        assertNotNull(scroll);
        assertNotNull(heading);
        assertNotNull(title);
        assertTrue(scroll.getChildAt(0).getHeight() <= scroll.getHeight());
        assertEquals("a", cards.selectedId());
        Rect headingRect = new Rect();
        Rect bodyRect = new Rect();
        Rect titleRect = new Rect();
        assertTrue(heading.getGlobalVisibleRect(headingRect));
        assertTrue(scroll.getGlobalVisibleRect(bodyRect));
        assertTrue(title.getGlobalVisibleRect(titleRect));
        int bodyX = titleRect.centerX();
        int bodyY = titleRect.centerY();
        assertTrue(bodyRect.contains(bodyX, bodyY));
        assertFalse(headingRect.contains(bodyX, bodyY));
        touch(pager, MotionEvent.ACTION_DOWN, bodyX, bodyY, 0);
        touch(pager, MotionEvent.ACTION_MOVE, bodyX, bodyY + 20, 16);
        touch(pager, MotionEvent.ACTION_MOVE, bodyX, bodyY + 120, 32);
        touch(pager, MotionEvent.ACTION_UP, bodyX, bodyY + 200, 48);
        assertEquals(PagerState.Page.HOME, pager.page());
        assertEquals("b", cards.selectedId());
        assertNull(Shadows.shadowOf((Application) context).getNextStartedActivity());
        pager.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY));
        pager.layout(0, 0, 600, 800);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300));

        heading = headingOf(cards);
        assertTrue(heading.getGlobalVisibleRect(headingRect));
        try {
            heading.performClick();
            fail("detail starts an activity");
        } catch (android.util.AndroidRuntimeException e) {
            assertTrue(e.getMessage().contains("FLAG_ACTIVITY_NEW_TASK"));
        }
        data.getJSONObject(0).put("modelState", "idle");
        cards.update(data);
        assertEquals("b", cards.selectedId());
    }

    @Test public void actionSwipeSwitchesCardsWithoutClick() throws Exception {
        android.content.Context context = RuntimeEnvironment.getApplication();
        boolean[] opened = {false};
        PagerRoot pager = new PagerRoot(context, new View(context), PagerState.Page.HOME, page -> {});
        HomeTaskCards cards = new HomeTaskCards(context, pager, id -> opened[0] = true, id -> {}, id -> {});
        pager.setHome(cards);
        cards.setAvailableHeight(800);
        cards.update(twoTodoCards());
        pager.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY));
        pager.layout(0, 0, 600, 800);
        TextView chat = firstText(cards, "查看对话", "View chat");
        assertNotNull(chat);
        Rect rect = new Rect();
        assertTrue(chat.getGlobalVisibleRect(rect));
        touch(pager, MotionEvent.ACTION_DOWN, rect.centerX(), rect.centerY(), 0);
        touch(pager, MotionEvent.ACTION_MOVE, rect.centerX(), rect.centerY() + 20, 16);
        touch(pager, MotionEvent.ACTION_MOVE, rect.centerX(), rect.centerY() + 120, 32);
        touch(pager, MotionEvent.ACTION_UP, rect.centerX(), rect.centerY() + 200, 48);
        assertEquals(PagerState.Page.HOME, pager.page());
        assertEquals("b", cards.selectedId());
        assertFalse(opened[0]);
        assertNull(Shadows.shadowOf((Application) context).getNextStartedActivity());
    }

    @Test public void overflowingStripScrollsHorizontallyWithoutSwitchingCards() throws Exception {
        android.content.Context context = RuntimeEnvironment.getApplication();
        PagerRoot pager = new PagerRoot(context, new View(context), PagerState.Page.HOME, page -> {});
        HomeTaskCards cards = new HomeTaskCards(context, pager, id -> {}, id -> {}, id -> {});
        pager.setHome(cards);
        JSONArray tasks = new JSONArray();
        for (int i = 0; i < 20; i++) {
            tasks.put(new JSONObject().put("id", "t" + i).put("subject", "Step " + i)
                    .put("status", i == 1 ? "in_progress" : i == 0 ? "completed" : "pending"));
        }
        JSONObject todo = new JSONObject().put("package", "@juicesharp/rpiv-todo").put("tasks", tasks);
        JSONArray data = new JSONArray()
                .put(new JSONObject().put("conversationId", "a").put("title", "A").put("modelState", "working").put("todo", todo))
                .put(new JSONObject().put("conversationId", "b").put("title", "B").put("modelState", "idle").put("todo", new JSONObject(todo.toString())));
        cards.setAvailableHeight(800);
        cards.update(data);
        pager.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY));
        pager.layout(0, 0, 600, 800);
        HorizontalScrollView strip = cards.findViewWithTag("todo-strip");
        assertNotNull(strip);
        strip.scrollTo(0, 0);
        assertTrue(strip.getChildAt(0).getWidth() > strip.getWidth());
        Rect stripRect = new Rect();
        assertTrue(strip.getGlobalVisibleRect(stripRect));
        int x = stripRect.centerX(), y = stripRect.centerY();
        touch(pager, MotionEvent.ACTION_DOWN, x, y, 0);
        touch(pager, MotionEvent.ACTION_MOVE, x - 20, y, 16);
        touch(pager, MotionEvent.ACTION_MOVE, x - 120, y, 32);
        touch(pager, MotionEvent.ACTION_UP, x - 200, y, 48);
        assertEquals(PagerState.Page.HOME, pager.page());
        assertEquals("a", cards.selectedId());
        assertTrue(strip.getScrollX() > 0);
    }

    private static JSONArray twoTodoCards() throws Exception {
        JSONObject todo = new JSONObject()
                .put("package", "@juicesharp/rpiv-todo")
                .put("tasks", new JSONArray()
                        .put(new JSONObject().put("id", "t1").put("subject", "Completed step").put("status", "completed"))
                        .put(new JSONObject().put("id", "t2").put("subject", "Active step").put("status", "in_progress"))
                        .put(new JSONObject().put("id", "t3").put("subject", "Pending step").put("status", "pending")));
        return new JSONArray()
                .put(new JSONObject().put("conversationId", "a").put("title", "A").put("modelState", "working").put("todo", todo))
                .put(new JSONObject().put("conversationId", "b").put("title", "B").put("modelState", "idle").put("todo", new JSONObject(todo.toString())));
    }

    private static void stopFling(ScrollView scroll) {
        // ACTION_UP may start OverScroller; ScrollView.scrollTo does not abort it.
        // A live fling DOWN calls requestDisallowInterceptTouchEvent, so the parent
        // never intercepts a following header swipe. Settle inertia first.
        OverScroller scroller = ReflectionHelpers.getField(scroll, "mScroller");
        if (scroller != null) scroller.abortAnimation();
    }

    private static View headingOf(View root) {
        View heading = root.findViewWithTag("card-switch");
        if (heading != null) return heading;
        TextView title = firstText(root, "✦  AI 助手", "✦  AI assistant", "AI 助手", "AI assistant");
        if (title != null && title.getParent() instanceof View) return (View) title.getParent();
        ScrollView scroll = first(root, ScrollView.class);
        View panel = scroll == null ? null : scroll.getChildAt(0);
        return panel instanceof ViewGroup group ? group.getChildAt(0) : null;
    }

    private static TextView firstText(View view, String... texts) {
        if (view instanceof TextView text) {
            CharSequence value = text.getText();
            if (value != null) {
                String shown = value.toString();
                for (String expected : texts) if (shown.contains(expected)) return text;
            }
        }
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                TextView found = firstText(group.getChildAt(i), texts);
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
