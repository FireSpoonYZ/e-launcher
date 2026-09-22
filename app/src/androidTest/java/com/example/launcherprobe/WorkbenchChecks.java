package com.example.launcherprobe;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import java.io.File;
import java.lang.reflect.Field;
import java.util.Collections;
import java.util.UUID;
import org.json.JSONObject;

/** Interactive device fixture: real Shower display, local question, no model/API request.
 * Run checks=workbench, interact with Orca, then touch external-files/workbench-stop to finish.
 */
final class WorkbenchChecks {
    static String run(Instrumentation test) throws Exception {
        Context context = test.getTargetContext();
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        String previous = coordinator.store().activeId();
        String id = UUID.randomUUID().toString();
        coordinator.store().save(id, Collections.singletonList(new AgentLoop.Message("user", "整理本周日程")));
        coordinator.store().selectConversation(id);
        ChatCoordinator.SessionRun run = coordinator.registerRun(id, null);
        run.extensionUi = new JSONObject("""
                {"todo":{"package":"@juicesharp/rpiv-todo","nextId":4,"tasks":[
                  {"id":1,"subject":"读取日历","status":"completed"},
                  {"id":2,"subject":"整理日程","status":"in_progress"},
                  {"id":3,"subject":"生成摘要","status":"pending"}]},
                 "askUser":{"id":"workbench-question","questions":[
                  {"questionIndex":0,"question":"日程摘要按哪种方式整理？","options":[
                   {"label":"按日期","description":"按每天的安排依次展示"},
                   {"label":"按事项","description":"把相似安排放在一起"}]}]}}
                """);
        ShowerToolBridge tools = field(PiAgentBridge.get(context), "showerTools");
        TaskDetailActivity activity = null;
        File directory = context.getExternalFilesDir(null);
        File stop = new File(directory, "workbench-stop"); stop.delete();
        File ready = new File(directory, "workbench-ready"); ready.delete();
        File submitted = new File(directory, "workbench-answer.json"); submitted.delete();
        try {
            tools.execute(id, new JSONObject().put("action", "create").put("width", 720).put("height", 1280).put("dpi", 240));
            tools.execute(id, new JSONObject().put("action", "launch").put("packageName", "com.android.settings"));
            activity = (TaskDetailActivity) test.startActivitySync(new Intent(context, TaskDetailActivity.class)
                    .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            TaskDetailActivity detail = activity;
            ShowerDesktopView desktop = field(detail, "desktop");
            long deadline = SystemClock.uptimeMillis() + 20000;
            while (!Boolean.TRUE.equals(field(desktop, "live")) && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
            require(Boolean.TRUE.equals(field(desktop, "live")), "No real compositor frame");
            test.waitForIdleSync(); SystemClock.sleep(500);
            android.graphics.Bitmap screenshot = test.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES).takeScreenshot();
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(new File(directory, "workbench-initial.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            } finally { screenshot.recycle(); }
            test.runOnMainSync(() -> {
                View root = detail.getWindow().getDecorView();
                View question = root.findViewWithTag("home-questionnaire");
                require(question != null, "Question and desktop must coexist");
                require(root.findViewWithTag("todo-strip") != null, "Progress timeline stays visible");
                for (String description : new String[]{"自定义回答", "提交回答", "取消问答"}) {
                    View action = action(question, description); Rect bounds = new Rect();
                    require(action != null && action.getGlobalVisibleRect(bounds) && bounds.height() == action.getHeight(),
                            "Question action clipped: " + description + ", bounds=" + bounds + ", height=" + (action == null ? -1 : action.getHeight()));
                }
                require(desktop.getHeight() < root.getHeight() / 2, "Default viewport must leave space for the task card");
                // Local submission sink exercises the unchanged questionnaire payload, without a paid model session.
                try {
                    Field reply = HomeQuestionnaire.class.getDeclaredField("reply"); reply.setAccessible(true);
                    reply.set(question, (HomeQuestionnaire.Reply) (c, r, q, answers, cancelled) -> {
                        require(id.equals(c) && run.requestId.equals(r) && "workbench-question".equals(q), "Wrong question ownership");
                        JSONObject payload = new JSONObject().put("cancelled", cancelled).put("answers", answers);
                        java.nio.file.Files.write(submitted.toPath(), payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    });
                } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
            });
            java.nio.file.Files.write(ready.toPath(), id.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            deadline = SystemClock.uptimeMillis() + 900000;
            while (!stop.exists() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250);
            return "PASS: real virtual display, simultaneous progress/question, unclipped question actions; local answer="
                    + (submitted.exists() ? new String(java.nio.file.Files.readAllBytes(submitted.toPath()), java.nio.charset.StandardCharsets.UTF_8) : "not submitted");
        } finally {
            if (activity != null) { TaskDetailActivity detail = activity; test.runOnMainSync(detail::finish); }
            tools.forgetConversation(id); coordinator.finish(run, "completed", null); coordinator.deleteConversation(id);
            if (coordinator.store().conversations().stream().anyMatch(conversation -> previous.equals(conversation.id)))
                coordinator.store().selectConversation(previous);
            ready.delete(); stop.delete();
        }
    }

    private static View action(View view, String description) {
        if (description.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) {
            View found = action(group.getChildAt(i), description); if (found != null) return found;
        }
        return null;
    }
    @SuppressWarnings("unchecked") private static <T> T field(Object object, String name) throws Exception {
        Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return (T) field.get(object);
    }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
