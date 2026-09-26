package com.example.launcherprobe;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class TaskCardModelTest {
    @Test public void trustedStepsKeepOrderAndAnimationDoesNotChangeMembership() throws Exception {
        JSONObject card = new JSONObject("{\"todo\":{\"package\":\"@juicesharp/rpiv-todo\",\"tasks\":[{\"id\":\"a\",\"status\":\"completed\"},null,{\"status\":\"deleted\"},{\"id\":\"b\",\"status\":\"in_progress\"}]}}");
        for (String model : new String[]{"working", "idle", "stopping"}) {
            card.put("modelState", model);
            assertEquals(2, TaskCardModel.tasks(card).size());
            assertEquals("a", TaskCardModel.tasks(card).get(0).optString("id"));
            assertEquals("b", TaskCardModel.tasks(card).get(1).optString("id"));
            for (String state : new String[]{"pending", "in_progress", "completed"}) {
                assertEquals(model.equals("working") && state.equals("in_progress"), TaskCardModel.animateNode(model, state, true));
                assertFalse(TaskCardModel.animateNode(model, state, false));
            }
        }
        card.getJSONObject("todo").put("package", "untrusted");
        assertTrue(TaskCardModel.tasks(card).isEmpty());
        assertEquals("", TaskCardModel.currentStep(card));
    }

    @Test public void statePriorityPreservesQuestionWorkingStoppingAndTerminalSemantics() throws Exception {
        JSONObject card = new JSONObject().put("modelState", "working").put("runStatus", "error")
                .put("requestId", "run").put("askUser", new JSONObject().put("id", "question")
                        .put("questions", new JSONArray().put(new JSONObject().put("question", "Choose"))));
        assertEquals("需要回答", TaskCardModel.status(card));
        card.put("questionnairePending", true);
        assertEquals("正在提交…", TaskCardModel.status(card));
        card.remove("requestId");
        assertEquals("正在执行", TaskCardModel.status(card));
        card.put("modelState", "stopping");
        assertEquals("正在停止…", TaskCardModel.status(card));
        card.put("modelState", "idle");
        assertEquals("执行失败", TaskCardModel.status(card));
        card.put("runStatus", "aborted");
        assertEquals("已停止", TaskCardModel.status(card));
        card.put("runStatus", "completed");
        assertEquals("对话已结束", TaskCardModel.status(card));
        JSONArray steps = new JSONArray().put(new JSONObject().put("status", "in_progress"));
        card.put("todo", new JSONObject().put("package", "@juicesharp/rpiv-todo").put("tasks", steps));
        assertEquals("本轮已结束", TaskCardModel.status(card));
        steps.getJSONObject(0).put("status", "completed");
        assertEquals("已完成", TaskCardModel.status(card));
    }

    @Test public void boundedTextKeepsSupplementaryCodePointsAndCurrentStepUsesTrustedTodo() throws Exception {
        assertEquals("😀😀…", TaskCardModel.shortText("😀😀😀😀", 3));
        assertEquals("a b c", TaskCardModel.shortText(" a\n\t b\u3000c ", 10));
        assertEquals("😀", TaskCardModel.shortText("😀", 1));
        JSONObject card = new JSONObject().put("todo", new JSONObject().put("package", "@juicesharp/rpiv-todo")
                .put("tasks", new JSONArray().put(new JSONObject().put("status", "completed").put("subject", "Done"))
                        .put(new JSONObject().put("status", "in_progress").put("subject", "😀".repeat(140)))));
        String step = TaskCardModel.currentStep(card);
        assertEquals(120, step.codePointCount(0, step.length()));
        assertTrue(step.endsWith("😀…"));
        card.getJSONObject("todo").put("package", "not-todo");
        assertEquals("", TaskCardModel.currentStep(card));
    }
}
