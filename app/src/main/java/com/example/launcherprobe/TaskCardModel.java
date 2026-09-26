package com.example.launcherprobe;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Shared task semantics for the detail screen and the widget's text-only projection. */
final class TaskCardModel {
    private TaskCardModel() { }

    static List<JSONObject> tasks(JSONObject card) {
        List<JSONObject> result = new ArrayList<>();
        JSONObject todo = card.optJSONObject("todo");
        if (todo == null || !"@juicesharp/rpiv-todo".equals(todo.optString("package"))) return result;
        JSONArray values = todo.optJSONArray("tasks");
        if (values != null) for (int i = 0; i < values.length(); i++) {
            JSONObject task = values.optJSONObject(i);
            if (task != null && !"deleted".equals(task.optString("status"))) result.add(task);
        }
        return result;
    }

    static String status(JSONObject card) {
        String model = card.optString("modelState");
        if (HomeQuestionnaire.liveQuestion(card) != null)
            return card.optBoolean("questionnairePending") ? "正在提交…" : "需要回答";
        if ("working".equals(model)) return "正在执行";
        if ("stopping".equals(model)) return "正在停止…";
        if ("error".equals(card.optString("runStatus"))) return "执行失败";
        if ("aborted".equals(card.optString("runStatus"))) return "已停止";
        List<JSONObject> steps = tasks(card);
        if (steps.isEmpty()) return "对话已结束";
        return steps.stream().allMatch(t -> "completed".equals(t.optString("status"))) ? "已完成" : "本轮已结束";
    }

    static boolean animateNode(String modelState, String taskState, boolean enabled) {
        return enabled && "working".equals(modelState) && "in_progress".equals(taskState);
    }

    static String currentStep(JSONObject card) {
        for (JSONObject task : tasks(card))
            if ("in_progress".equals(task.optString("status"))) return shortText(task.optString("subject"), 120);
        return "";
    }

    static String shortText(String text, int limit) {
        String value = text.replaceAll("[\\s\\p{Z}]+", " ").trim();
        if (value.codePointCount(0, value.length()) <= limit) return value;
        return value.substring(0, value.offsetByCodePoints(0, limit - 1)) + "…";
    }
}
