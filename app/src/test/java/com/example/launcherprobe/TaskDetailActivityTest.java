package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.AlertDialog;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import java.util.Collections;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;
import org.robolectric.shadows.ShadowToast;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class TaskDetailActivityTest {
    private Application application;

    @Before public void setUp() {
        application = RuntimeEnvironment.getApplication();
        application.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    @After public void tearDown() {
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    @Test public void idleDetailArchivesWithoutPromptAndKeepsConfirmedDelete() {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(new AgentLoop.Message("user", "Keep this chat")));
        String id = store.activeId();
        try (ActivityController<TaskDetailActivity> controller = Robolectric.buildActivity(
                TaskDetailActivity.class,
                new Intent(application, TaskDetailActivity.class)
                        .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id)).setup()) {
            TaskDetailActivity activity = controller.get();
            View root = activity.getWindow().getDecorView();
            TextView archive = firstExact(root, "归档");
            TextView remove = firstExact(root, "永久删除");
            TextView listed = firstExact(root, "已归档对话");
            assertNotNull(archive);
            assertNotNull(remove);
            assertNotNull(listed);
            assertNull(firstExact(root, "删除"));
            remove.performClick();
            AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();
            assertNotNull(dialog);
            assertEquals("删除对话？", Shadows.shadowOf(dialog).getTitle().toString());
            dialog.dismiss();
            assertFalse(activity.isFinishing());
            archive.performClick();
            assertTrue(activity.isFinishing());
            Intent started = Shadows.shadowOf(activity).getNextStartedActivity();
            assertNotNull(started);
            assertEquals(id, started.getStringExtra(TaskDetailActivity.EXTRA_ARCHIVED_ID));
            assertTrue(store.isArchived(id));
        }
    }

    @Test public void runningDetailKeepsStopAndStillOffersArchive() {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(new AgentLoop.Message("user", "Busy chat")));
        String id = store.activeId();
        coordinator.registerRun(id, null);
        try (ActivityController<TaskDetailActivity> controller = Robolectric.buildActivity(
                TaskDetailActivity.class,
                new Intent(application, TaskDetailActivity.class)
                        .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id)).setup()) {
            View root = controller.get().getWindow().getDecorView();
            assertNotNull(firstExact(root, "停止"));
            assertNotNull(firstExact(root, "归档"));
            assertNotNull(firstExact(root, "永久删除"));
            firstExact(root, "永久删除").performClick();
            assertTrue(String.valueOf(ShadowToast.getTextOfLatestToast()).contains("请先停止后再删除"));
        }
    }

    @Test public void virtualDesktopHasCompactActionsAndSafeNavigationOnlyAfterTakeover() {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        coordinator.store().save(Collections.singletonList(new AgentLoop.Message("user", "Desktop task")));
        String id = coordinator.store().activeId();
        try (ActivityController<TaskDetailActivity> controller = Robolectric.buildActivity(TaskDetailActivity.class,
                new Intent(application, TaskDetailActivity.class).putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id)).setup()) {
            TaskDetailActivity activity = controller.get();
            ShowerDesktopView desktop = ReflectionHelpers.getField(activity, "desktop");
            desktop.stop(); // Drive display states explicitly; no Binder/renderer in this layout test.
            ReflectionHelpers.callInstanceMethod(activity, "desktopChanged",
                    ReflectionHelpers.ClassParameter.from(boolean.class, true),
                    ReflectionHelpers.ClassParameter.from(boolean.class, true),
                    ReflectionHelpers.ClassParameter.from(boolean.class, false),
                    ReflectionHelpers.ClassParameter.from(String.class, "虚拟桌面 · 实时"));
            View root = activity.getWindow().getDecorView();
            assertNotNull(firstExact(root, "接管操作"));
            assertNotNull(firstExact(root, "查看对话"));
            assertNull("Low-frequency actions move to overflow", firstExact(root, "永久删除"));
            android.widget.LinearLayout navigation = ReflectionHelpers.getField(activity, "navigation");
            assertEquals(4, navigation.getChildCount());
            assertFalse(navigation.getChildAt(0).isEnabled());
            assertEquals("虚拟桌面应用列表", navigation.getChildAt(1).getContentDescription());
            ReflectionHelpers.callInstanceMethod(activity, "desktopChanged",
                    ReflectionHelpers.ClassParameter.from(boolean.class, true),
                    ReflectionHelpers.ClassParameter.from(boolean.class, true),
                    ReflectionHelpers.ClassParameter.from(boolean.class, true),
                    ReflectionHelpers.ClassParameter.from(String.class, "手动操作"));
            assertNotNull(firstExact(root, "结束接管"));
            assertTrue(navigation.getChildAt(0).isEnabled());
            View pane = ReflectionHelpers.getField(activity, "taskPane");
            assertEquals("Progress stays visible beside the compact viewer", View.VISIBLE, pane.getVisibility());
            View expand = ReflectionHelpers.getField(activity, "expand");
            expand.performClick();
            assertEquals(View.GONE, pane.getVisibility());
            View summary = ReflectionHelpers.getField(activity, "taskSummary");
            assertEquals(View.VISIBLE, summary.getVisibility());
            summary.performClick();
            assertEquals(View.VISIBLE, pane.getVisibility());
            expand.performClick();
            activity.getOnBackPressedDispatcher().onBackPressed();
            assertFalse(activity.isFinishing());
            assertEquals(View.VISIBLE, pane.getVisibility());
        }
    }

    @Test public void workbenchQuestionDraftSurvivesLiveUpdatesAndFullscreen() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        coordinator.store().save(Collections.singletonList(new AgentLoop.Message("user", "Desktop task")));
        String id = coordinator.store().activeId();
        try (var controller = Robolectric.buildActivity(TaskDetailActivity.class,
                new Intent(application, TaskDetailActivity.class).putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id)).setup()) {
            TaskDetailActivity activity = controller.get();
            ((ShowerDesktopView) ReflectionHelpers.getField(activity, "desktop")).stop();
            org.json.JSONObject card = HomeQuestionnaireTest.card().put("conversationId", id).put("todo", new org.json.JSONObject("""
                    {"package":"@juicesharp/rpiv-todo","tasks":[
                    {"id":"1","subject":"Read calendar","status":"completed"},
                    {"id":"2","subject":"Organize","status":"in_progress"}]}
                    """));
            ReflectionHelpers.callInstanceMethod(activity, "renderTaskPane", ReflectionHelpers.ClassParameter.from(org.json.JSONObject.class, card));
            View root = activity.getWindow().getDecorView();
            View question = root.findViewWithTag("home-questionnaire");
            assertNotNull(question);
            root.findViewWithTag("option:Compact").performClick();
            assertNotNull(root.findViewWithTag("todo-strip"));
            ReflectionHelpers.setField(activity, "desktopAvailable", true);
            ReflectionHelpers.callInstanceMethod(activity, "setFullscreen", ReflectionHelpers.ClassParameter.from(boolean.class, true));
            ReflectionHelpers.callInstanceMethod(activity, "setFullscreen", ReflectionHelpers.ClassParameter.from(boolean.class, false));
            card.getJSONObject("todo").getJSONArray("tasks").getJSONObject(1).put("status", "completed");
            ReflectionHelpers.callInstanceMethod(activity, "renderTaskPane", ReflectionHelpers.ClassParameter.from(org.json.JSONObject.class, card));
            assertSame("Progress refresh must not tear down an open questionnaire", question, root.findViewWithTag("home-questionnaire"));
            assertTrue(root.findViewWithTag("option:Compact").createAccessibilityNodeInfo().isChecked());
            card.put("questionnairePending", true);
            ReflectionHelpers.callInstanceMethod(activity, "renderTaskPane", ReflectionHelpers.ClassParameter.from(org.json.JSONObject.class, card));
            assertFalse(root.findViewWithTag("option:Compact").isEnabled());
            assertTrue(root.findViewWithTag("option:Compact").createAccessibilityNodeInfo().isChecked());
            card.put("questionnairePending", false).put("questionnaireError", "Try again");
            ReflectionHelpers.callInstanceMethod(activity, "renderTaskPane", ReflectionHelpers.ClassParameter.from(org.json.JSONObject.class, card));
            assertTrue(root.findViewWithTag("option:Compact").isEnabled());
            card.getJSONObject("askUser").put("id", "next-question");
            ReflectionHelpers.callInstanceMethod(activity, "renderTaskPane", ReflectionHelpers.ClassParameter.from(org.json.JSONObject.class, card));
            assertFalse(root.findViewWithTag("option:Compact").createAccessibilityNodeInfo().isChecked());
            card.put("modelState", "idle");
            ReflectionHelpers.callInstanceMethod(activity, "renderTaskPane", ReflectionHelpers.ClassParameter.from(org.json.JSONObject.class, card));
            assertNull(root.findViewWithTag("home-questionnaire"));
        }
    }

    @Test public void timelineFitsItsPaneWhenTheScreenIsWider() throws Exception {
        java.util.List<org.json.JSONObject> tasks = java.util.List.of(
                new org.json.JSONObject("{\"subject\":\"One\",\"status\":\"completed\"}"),
                new org.json.JSONObject("{\"subject\":\"Two\",\"status\":\"in_progress\"}"),
                new org.json.JSONObject("{\"subject\":\"Three\",\"status\":\"pending\"}"));
        TaskProgressStrip strip = new TaskProgressStrip(application, AppAppearance.readWorkbench(application), tasks, "working");
        float density = application.getResources().getDisplayMetrics().density;
        int width = Math.round(300 * density);
        strip.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        ViewGroup track = (ViewGroup) strip.getChildAt(0);
        assertTrue(track.getMeasuredWidth() <= width);
        for (int i = 0; i < 3; i++) assertEquals(width / 3, track.getChildAt(i).getMeasuredWidth());
    }

    private static TextView firstExact(View view, String expected) {
        if (view instanceof TextView text && expected.equals(String.valueOf(text.getText()))) return text;
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                TextView found = firstExact(group.getChildAt(i), expected);
                if (found != null) return found;
            }
        }
        return null;
    }
}
