package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class AskUserQuestionBridgeTest {
    @Test public void canonicalizesAnswersFromThePublishedQuestionnaire() throws Exception {
        JSONObject askUser = questionnaire();
        JSONArray submitted = new JSONArray()
                .put(new JSONObject().put("questionIndex", 1).put("kind", "multi")
                        .put("selected", new JSONArray().put("Tests").put("Docs")))
                .put(new JSONObject().put("questionIndex", 0).put("kind", "option")
                        .put("answer", "Safe").put("notes", "  prefer this  ")
                        .put("question", "forged").put("preview", "forged"));

        JSONObject result = ChatCoordinator.questionnaireResult(askUser, submitted, "  ship it  ");
        JSONArray answers = result.getJSONArray("answers");
        assertEquals("Real question?", answers.getJSONObject(1).getString("question"));
        assertEquals("Trusted preview", answers.getJSONObject(1).getString("preview"));
        assertEquals("prefer this", answers.getJSONObject(1).getString("notes"));
        assertEquals("Tests", answers.getJSONObject(0).getJSONArray("selected").getString(0));
        assertEquals("Docs", answers.getJSONObject(0).getJSONArray("selected").getString(1));
        assertEquals("ship it", result.getString("globalNote"));
        assertFalse(result.has("cancelled"));
    }

    @Test public void rejectsForgedAndDuplicateAnswers() throws Exception {
        JSONObject askUser = questionnaire();
        JSONArray forged = new JSONArray().put(new JSONObject().put("questionIndex", 0)
                .put("kind", "option").put("answer", "Injected"));
        assertThrows(IllegalArgumentException.class,
                () -> ChatCoordinator.questionnaireResult(askUser, forged, null));

        JSONArray duplicate = new JSONArray()
                .put(new JSONObject().put("questionIndex", 0).put("kind", "custom").put("answer", "one"))
                .put(new JSONObject().put("questionIndex", 0).put("kind", "custom").put("answer", "two"));
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> ChatCoordinator.questionnaireResult(askUser, duplicate, null));
        assertTrue(error.getMessage().contains("重复"));
    }

    private static JSONObject questionnaire() throws Exception {
        JSONArray questions = new JSONArray()
                .put(new JSONObject().put("question", "Real question?").put("multiSelect", false)
                        .put("options", new JSONArray()
                                .put(new JSONObject().put("label", "Safe").put("description", "Safe option")
                                        .put("preview", "Trusted preview"))
                                .put(new JSONObject().put("label", "Fast").put("description", "Fast option"))))
                .put(new JSONObject().put("question", "Which extras?").put("multiSelect", true)
                        .put("options", new JSONArray()
                                .put(new JSONObject().put("label", "Tests").put("description", "Add tests"))
                                .put(new JSONObject().put("label", "Docs").put("description", "Add docs"))));
        return new JSONObject().put("id", "questionnaire-1").put("questions", questions);
    }
}
