package com.example.launcherprobe;

import android.app.Activity;
import android.app.Instrumentation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.view.View;
import android.view.ViewGroup;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.atomic.AtomicInteger;

/** Exercises the real desktop card without creating conversations or contacting a model. */
final class HomeQuestionnaireChecks {
    static String run(Instrumentation test, Activity activity) throws Exception {
        java.lang.reflect.Field field = MainActivity.class.getDeclaredField("homeTaskCards");
        field.setAccessible(true);
        HomeTaskCards host = (HomeTaskCards) field.get(activity);
        ChatCoordinator coordinator = ChatCoordinator.get(activity);
        JSONObject ask = new JSONObject("""
                {"id":"visual-question","questions":[
                  {"questionIndex":0,"question":"你希望使用哪种布局？","options":[
                    {"label":"紧凑布局","description":"信息集中，一屏看全"},
                    {"label":"宽松布局","description":"留白更多，阅读轻松"}]},
                  {"questionIndex":1,"question":"哪些内容需要保留？","multiSelect":true,"options":[
                    {"label":"任务进度","description":"显示当前任务"},
                    {"label":"对话入口","description":"随时查看对话"},
                    {"label":"运行状态","description":"显示当前状态"},
                    {"label":"归档入口","description":"查看历史记录"}]}]}
                """);
        JSONObject card = new JSONObject().put("conversationId", "visual-check").put("requestId", "visual-run")
                .put("title", "问答卡片视觉检查").put("modelState", "working").put("askUser", ask);
        JSONArray cards = new JSONArray().put(card)
                .put(new JSONObject().put("conversationId", "visual-2").put("title", "第二个会话").put("modelState", "idle"))
                .put(new JSONObject().put("conversationId", "visual-3").put("title", "第三个会话").put("modelState", "idle"));
        AtomicInteger replies = new AtomicInteger();
        File screenshot = new File(activity.getExternalFilesDir(null), "questionnaire-card.png");
        try {
            test.runOnMainSync(() -> {
                host.setQuestionReply((c, r, q, answers, cancelled) -> {
                    require(!cancelled && answers.length() == 2, "all answers submitted together");
                    require("紧凑布局".equals(answers.getJSONObject(0).getString("answer")), "single choice retained");
                    require(answers.getJSONObject(1).getJSONArray("selected").length() == 2, "multi choice retained");
                    replies.incrementAndGet();
                });
                host.update(cards);
                host.showLatest();
                host.findViewWithTag("option:紧凑布局").performClick();
            });
            test.waitForIdleSync();
            test.runOnMainSync(() -> {
                View questionnaire = host.findViewWithTag("home-questionnaire");
                require(questionnaire != null, "questionnaire visible");
                require(host.findViewWithTag("option:紧凑布局").createAccessibilityNodeInfo().isChecked(), "choice selected");
                for (String description : new String[]{"上一题", "自定义回答", "下一题", "取消问答"}) {
                    View action = action(questionnaire, description);
                    require(action != null, "action exists: " + description);
                    Rect visible = new Rect();
                    require(action.getGlobalVisibleRect(visible) && visible.height() == action.getHeight(),
                            "action fully visible: " + description);
                    require(action.getHeight() >= Math.round(48 * activity.getResources().getDisplayMetrics().density),
                            "48dp action target: " + description);
                }
            });
            Bitmap image = Bitmap.createBitmap(activity.getWindow().getDecorView().getWidth(),
                    activity.getWindow().getDecorView().getHeight(), Bitmap.Config.ARGB_8888);
            java.util.concurrent.CountDownLatch captured = new java.util.concurrent.CountDownLatch(1);
            AtomicInteger captureResult = new AtomicInteger(-1);
            test.runOnMainSync(() -> android.view.PixelCopy.request(activity.getWindow(), image, value -> {
                captureResult.set(value);
                captured.countDown();
            }, new android.os.Handler(android.os.Looper.getMainLooper())));
            require(captured.await(10, java.util.concurrent.TimeUnit.SECONDS)
                    && captureResult.get() == android.view.PixelCopy.SUCCESS, "screen capture available");
            try (FileOutputStream output = new FileOutputStream(screenshot)) {
                image.compress(Bitmap.CompressFormat.PNG, 100, output);
            } finally { image.recycle(); }
            test.runOnMainSync(() -> {
                action(host, "下一题").performClick();
                host.findViewWithTag("option:任务进度").performClick();
                host.findViewWithTag("option:对话入口").performClick();
                action(host, "上一题").performClick();
                require(host.findViewWithTag("option:紧凑布局").createAccessibilityNodeInfo().isChecked(), "back retains answer");
                action(host, "下一题").performClick();
                action(host, "提交回答").performClick();
                require(replies.get() == 1, "one submission");
                require(!action(host, "提交回答").isEnabled(), "pending disables submit");
                require(!action(host, "取消问答").isEnabled(), "pending disables cancel");
            });
            return "PASS: desktop option selection, paging, multi-select, request payload, pending controls, 48dp actions; screenshot " + screenshot;
        } finally {
            test.runOnMainSync(() -> {
                host.setQuestionReply((c, r, q, answers, cancelled) -> {
                    if (cancelled) coordinator.cancelQuestionnaire(c, r, q);
                    else coordinator.submitQuestionnaire(c, r, q, answers, null);
                });
                host.update(coordinator.taskCards());
                host.showLatest();
            });
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

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
