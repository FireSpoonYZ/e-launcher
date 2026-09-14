package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.view.MotionEvent;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

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
        touch(pager, MotionEvent.ACTION_DOWN, 500, 40, 0);
        touch(pager, MotionEvent.ACTION_MOVE, 300, 40, 20);
        touch(pager, MotionEvent.ACTION_UP, 100, 40, 40);
        assertEquals(PagerState.Page.HOME, pager.page());
        assertEquals("b", cards.selectedId());
        data.getJSONObject(0).put("modelState", "idle");
        cards.update(data);
        assertEquals("b", cards.selectedId());
    }

    private void touch(View view, int action, float x, float y, long time) {
        MotionEvent event = MotionEvent.obtain(0, time, action, x, y, 0);
        view.dispatchTouchEvent(event);
        event.recycle();
    }
}
