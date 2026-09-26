package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.Activity;
import android.view.View;
import android.view.ViewGroup;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class HomeQuestionnaireTest {
    static JSONObject card() throws Exception {
        return new JSONObject("""
                {"conversationId":"a","requestId":"r","modelState":"working","askUser":{"id":"q","questions":[
                  {"questionIndex":0,"question":"Choose layout","options":[{"label":"Compact","description":"All in one"},{"label":"Spacious","description":"More room"}]},
                  {"questionIndex":1,"question":"Choose features","multiSelect":true,"options":[{"label":"A"},{"label":"B"}]}]}}
                """);
    }

    @Test public void draftsPreserveQuestionOrderAndMatchWebSelectionRules() throws Exception {
        JSONObject card = card();
        JSONArray questions = card.getJSONObject("askUser").getJSONArray("questions");
        HomeQuestionnaire.Draft draft = new HomeQuestionnaire.Draft(card);
        draft.choose(questions.getJSONObject(0), "Compact");
        draft.choose(questions.getJSONObject(1), "B");
        draft.choose(questions.getJSONObject(1), "A");
        assertEquals("[\"A\",\"B\"]", draft.result(questions).getJSONObject(1).getJSONArray("selected").toString());
        draft.choose(questions.getJSONObject(1), "A");
        draft.choose(questions.getJSONObject(1), "B");
        assertEquals(1, draft.result(questions).length());
        HomeQuestionnaire.Answer custom = draft.answer(0);
        custom.kind = "custom";
        custom.text = "  ";
        assertEquals(0, draft.result(questions).length());
        custom.text = "my layout";
        assertEquals("my layout", draft.result(questions).getJSONObject(0).getString("answer"));
        draft.choose(questions.getJSONObject(0), "Spacious");
        assertEquals("option", draft.result(questions).getJSONObject(0).getString("kind"));
        draft.page = 1;
        HomeQuestionnaire.Draft restored = new HomeQuestionnaire.Draft(card);
        restored.restore(draft.save());
        assertEquals(1, restored.page);
        assertEquals(draft.result(questions).toString(), restored.result(questions).toString());
        assertTrue(draft.matches(card));
        card.put("requestId", "new-run");
        assertFalse(draft.matches(card));
        card.put("requestId", "r").put("modelState", "stopping");
        assertNull(HomeQuestionnaire.liveQuestion(card));
    }

    @Test public void detailControlRestoresOnlyTheSameLiveRequestDraft() throws Exception {
        try (var controller = Robolectric.buildActivity(Activity.class).setup()) {
            Activity activity = controller.get();
            JSONObject card = card();
            HomeQuestionnaire.Draft draft = new HomeQuestionnaire.Draft(card);
            HomeQuestionnaire view = new HomeQuestionnaire(activity, card, draft,
                    (c, r, q, a, cancelled) -> {}, AppAppearance.readWorkbench(activity));
            activity.setContentView(view);
            view.findViewWithTag("option:Compact").performClick();
            android.os.Bundle saved = draft.save();
            HomeQuestionnaire.Draft restored = new HomeQuestionnaire.Draft(card);
            restored.restore(saved);
            HomeQuestionnaire refreshed = new HomeQuestionnaire(activity, card, restored,
                    (c, r, q, a, cancelled) -> {}, AppAppearance.readWorkbench(activity));
            activity.setContentView(refreshed);
            assertTrue(refreshed.findViewWithTag("option:Compact").createAccessibilityNodeInfo().isChecked());
            card.put("requestId", "next-run");
            HomeQuestionnaire.Draft nextRun = new HomeQuestionnaire.Draft(card);
            nextRun.restore(saved);
            assertTrue(nextRun.answers.isEmpty());
            card.put("requestId", "r").getJSONObject("askUser").put("id", "new-question");
            HomeQuestionnaire.Draft nextQuestion = new HomeQuestionnaire.Draft(card);
            nextQuestion.restore(saved);
            assertTrue(nextQuestion.answers.isEmpty());
            assertFalse(draft.matches(card));
            card.put("modelState", "idle");
            assertNull(HomeQuestionnaire.liveQuestion(card));
        }
    }

    @Test public void submissionFailureKeepsAnswersAndPendingDisablesAllReplies() throws Exception {
        try (var controller = Robolectric.buildActivity(Activity.class).setup()) {
            Activity activity = controller.get();
            JSONObject card = card();
            HomeQuestionnaire.Draft draft = new HomeQuestionnaire.Draft(card);
            draft.page = 1;
            draft.choose(card.getJSONObject("askUser").getJSONArray("questions").getJSONObject(1), "A");
            AtomicInteger calls = new AtomicInteger();
            HomeQuestionnaire.Reply reply = (c, r, q, a, cancelled) -> {
                assertEquals("a", c); assertEquals("r", r); assertEquals("q", q);
                assertFalse(cancelled);
                assertEquals("A", a.getJSONObject(0).getJSONArray("selected").getString(0));
                if (calls.incrementAndGet() == 1) throw new IllegalStateException("retry me");
            };
            HomeQuestionnaire view = new HomeQuestionnaire(activity, card, draft, reply, AppAppearance.readWorkbench(activity));
            activity.setContentView(view);
            action(view, "Submit answers").performClick();
            assertEquals("retry me", draft.error);
            assertTrue(action(view, "Submit answers").isEnabled());
            action(view, "Submit answers").performClick();
            assertEquals(2, calls.get());
            assertFalse(action(view, "Submit answers").isEnabled());
            assertFalse(action(view, "Cancel questionnaire").isEnabled());
            assertFalse(view.findViewWithTag("option:A").isEnabled());
            card.put("questionnairePending", true);
            HomeQuestionnaire refreshed = new HomeQuestionnaire(activity, card, draft, reply, AppAppearance.readWorkbench(activity));
            assertFalse(action(refreshed, "Submit answers").isEnabled());
            card.put("questionnairePending", false).put("questionnaireError", "rejected");
            refreshed = new HomeQuestionnaire(activity, card, draft, reply, AppAppearance.readWorkbench(activity));
            assertTrue(action(refreshed, "Submit answers").isEnabled());
            assertTrue(refreshed.findViewWithTag("option:A").createAccessibilityNodeInfo().isChecked());
        }
    }

    private static View action(View view, String description) {
        if (description.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) {
            View found = action(group.getChildAt(i), description);
            if (found != null) return found;
        }
        return null;
    }
}
