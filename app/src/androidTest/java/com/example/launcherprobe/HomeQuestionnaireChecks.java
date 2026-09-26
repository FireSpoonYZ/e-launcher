package com.example.launcherprobe;

import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

/** Exercises the retained questionnaire in real task details, without a model request. */
final class HomeQuestionnaireChecks {
    static String run(Instrumentation test) throws Exception {
        File screenshot = new File(ChatStoreChecks.artifacts(test), "questionnaire-detail.png");
        ChatCoordinator coordinator = ChatCoordinator.get(test.getTargetContext());
        ChatStore store = coordinator.store();
        String previous = store.activeId(), id = UUID.randomUUID().toString();
        AgentLoop.Message user = new AgentLoop.Message("user", "问答详情检查");
        store.save(id, Collections.singletonList(user));
        store.selectConversation(id);
        TaskDetailActivity activity = (TaskDetailActivity) test.startActivitySync(new Intent(test.getTargetContext(), TaskDetailActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        JSONObject state = new JSONObject("""
                {"askUser":{"id":"visual-question","questions":[
                  {"questionIndex":0,"question":"你希望使用哪种布局？","options":[
                    {"label":"紧凑布局","description":"信息集中，一屏看全"},
                    {"label":"宽松布局","description":"留白更多，阅读轻松"}]},
                  {"questionIndex":1,"question":"哪些内容需要保留？","multiSelect":true,"options":[
                    {"label":"任务进度","description":"显示当前任务"},
                    {"label":"对话入口","description":"随时查看对话"},
                    {"label":"运行状态","description":"显示当前状态"},
                    {"label":"归档入口","description":"查看历史记录"}]}]}}
                """);
        AtomicInteger replies = new AtomicInteger();
        ChatCoordinator.SessionRun[] run = {null};
        View[] host = {null};
        try {
            test.runOnMainSync(() -> {
                run[0] = coordinator.registerRun(id, null);
                run[0].persistence = new PiTurnPersistence(store, id, user.id, "fixture-" + run[0].requestId,
                        Collections.singletonList(user));
                try { coordinator.onPiEvent(new JSONObject().put("type", "extension_ui").put("state", state), run[0]); }
                catch (Exception failure) { throw new AssertionError(failure); }
            });
            long deadline = SystemClock.uptimeMillis() + 10000;
            do {
                test.waitForIdleSync();
                test.runOnMainSync(() -> host[0] = activity.getWindow().getDecorView().findViewWithTag("home-questionnaire"));
                if (host[0] != null) break;
                SystemClock.sleep(50);
            } while (SystemClock.uptimeMillis() < deadline);
            require(host[0] instanceof HomeQuestionnaire, "questionnaire is hosted in TaskDetailActivity");
            test.runOnMainSync(() -> {
                try {
                    // Local reply sink: test payload/controls, not a paid model session.
                    java.lang.reflect.Field reply = HomeQuestionnaire.class.getDeclaredField("reply");
                    reply.setAccessible(true);
                    reply.set(host[0], (HomeQuestionnaire.Reply) (c, r, q, answers, cancelled) -> {
                        require(id.equals(c) && run[0].requestId.equals(r) && "visual-question".equals(q), "exact question ownership");
                        require(!cancelled && answers.length() == 2, "all answers submitted together");
                        require("紧凑布局".equals(answers.getJSONObject(0).getString("answer")), "single choice retained");
                        require(answers.getJSONObject(1).getJSONArray("selected").length() == 2, "multi choice retained");
                        replies.incrementAndGet();
                    });
                } catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
                host[0].findViewWithTag("option:紧凑布局").performClick();
            });
            test.waitForIdleSync();
            test.runOnMainSync(() -> {
                require(host[0].findViewWithTag("option:紧凑布局").createAccessibilityNodeInfo().isChecked(), "choice selected");
                for (String description : new String[]{"上一题", "自定义回答", "下一题", "取消问答"}) {
                    View action = action(host[0], description);
                    require(action != null, "action exists: " + description);
                    Rect visible = new Rect();
                    require(action.getGlobalVisibleRect(visible) && visible.height() == action.getHeight(), "action fully visible: " + description);
                    require(action.getHeight() >= Math.round(48 * activity.getResources().getDisplayMetrics().density), "48dp action target: " + description);
                }
            });
            Bitmap image = test.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES).takeScreenshot();
            require(image != null, "screen capture available");
            try (FileOutputStream output = new FileOutputStream(screenshot)) { image.compress(Bitmap.CompressFormat.PNG, 100, output); }
            finally { image.recycle(); }
            test.runOnMainSync(() -> {
                action(host[0], "下一题").performClick();
                host[0].findViewWithTag("option:任务进度").performClick();
                host[0].findViewWithTag("option:对话入口").performClick();
                action(host[0], "上一题").performClick();
                require(host[0].findViewWithTag("option:紧凑布局").createAccessibilityNodeInfo().isChecked(), "back retains answer");
                action(host[0], "下一题").performClick();
                action(host[0], "提交回答").performClick();
                require(replies.get() == 1, "one submission");
                require(!action(host[0], "提交回答").isEnabled(), "pending disables submit");
                require(!action(host[0], "取消问答").isEnabled(), "pending disables cancel");
            });
            return "PASS: task-detail choice selection, paging, multi-select, exact reply ownership, pending controls, 48dp actions; screenshot " + screenshot;
        } finally {
            test.runOnMainSync(() -> {
                activity.finish();
                if (run[0] != null) coordinator.finish(run[0], "aborted", "fixture cleanup");
            });
            coordinator.deleteConversation(id);
            if (store.conversations().stream().anyMatch(item -> previous.equals(item.id))) store.selectConversation(previous);
        }
    }

    static View action(View view, String description) {
        String english = switch (description) {
            case "上一题" -> "Previous";
            case "自定义回答" -> "Custom answer";
            case "下一题" -> "Next";
            case "取消问答" -> "Cancel questionnaire";
            case "提交回答" -> "Submit answers";
            default -> description;
        };
        CharSequence label = view.getContentDescription() == null ? "" : view.getContentDescription();
        if (description.contentEquals(label) || english.contentEquals(label)) return view;
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
