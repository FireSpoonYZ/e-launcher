package com.example.launcherprobe;

import static org.junit.Assert.*;
import static org.robolectric.util.ReflectionHelpers.ClassParameter.from;

import android.app.Application;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.LooperMode;
import org.robolectric.shadows.ShadowAppWidgetManager;
import org.robolectric.util.ReflectionHelpers;

import java.time.Duration;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = {HostAtomicFile.class, TaskWidgetProviderTest.CountingWidgets.class})
@LooperMode(LooperMode.Mode.PAUSED)
public class TaskWidgetProviderTest {
    private Application context;
    private AppWidgetManager manager;
    private ShadowAppWidgetManager host;
    private SharedPreferences prefs;
    private final TaskWidgetProvider provider = new TaskWidgetProvider();

    @Implements(AppWidgetManager.class)
    public static class CountingWidgets extends ShadowAppWidgetManager {
        static int updates;
        static final Map<Integer, RemoteViews> views = new HashMap<>();
        @Override @Implementation protected void updateAppWidget(int id, RemoteViews value) {
            updates++;
            views.put(id, value);
            super.updateAppWidget(id, value);
        }
    }

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        manager = AppWidgetManager.getInstance(context);
        host = Shadows.shadowOf(manager);
        prefs = context.getSharedPreferences("task_widget", Context.MODE_PRIVATE);
        prefs.edit().clear().commit();
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        CountingWidgets.updates = 0;
        CountingWidgets.views.clear();
        resetProcessState();
    }

    @After public void cleanup() { resetProcessState(); }

    private void resetProcessState() {
        Handler handler = ReflectionHelpers.getStaticField(TaskWidgetProvider.class, "MAIN");
        handler.removeCallbacks(ReflectionHelpers.getStaticField(TaskWidgetProvider.class, "REFRESH"));
        ReflectionHelpers.setStaticField(TaskWidgetProvider.class, "scheduled", false);
        ReflectionHelpers.setStaticField(TaskWidgetProvider.class, "refreshContext", null);
        ReflectionHelpers.setStaticField(TaskWidgetProvider.class, "lastRefresh", SystemClock.uptimeMillis() - 1000);
        Map<?, ?> rendered = ReflectionHelpers.getStaticField(TaskWidgetProvider.class, "rendered");
        rendered.clear();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    private int widget() { return host.createWidget(TaskWidgetProvider.class, R.layout.task_widget); }

    private JSONObject display(String id) throws Exception {
        return new JSONObject().put("conversationId", id).put("title", "Task " + id).put("status", "正在执行")
                .put("step", "Step " + id).put("result", "Result " + id).put("savedAt", 1_700_000_000_000L);
    }

    private void snapshot(JSONObject... cards) { prefs.edit().putString("snapshot", new JSONArray(Arrays.asList(cards)).toString()).commit(); }

    private String text(int id, int view) { return ((TextView) host.getViewFor(id).findViewById(view)).getText().toString(); }

    private void move(int id, boolean next) {
        provider.onReceive(context, new Intent(context, TaskWidgetProvider.class)
                .setAction("com.example.launcherprobe.widget." + (next ? "NEXT" : "PREVIOUS"))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id));
    }

    @Test public void callbacksUseOnlySnapshotAcrossProcessResetResizeAndRestore() throws Exception {
        snapshot(display("a"), display("b"));
        int first = widget(), second = widget();
        move(second, true);
        assertEquals("a", prefs.getString("selected:" + first, ""));
        assertEquals("b", prefs.getString("selected:" + second, ""));
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
        resetProcessState();
        provider.onUpdate(context, manager, new int[]{first, second});
        assertEquals("Task b", text(second, R.id.task_widget_title));
        assertEquals("上次状态：正在执行", text(second, R.id.task_widget_status));
        assertTrue(text(second, R.id.task_widget_updated).startsWith("快照 · "));
        Bundle options = new Bundle();
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180);
        manager.updateAppWidgetOptions(second, options);
        provider.onAppWidgetOptionsChanged(context, manager, second, options);
        assertEquals(1, ((TextView) host.getViewFor(second).findViewById(R.id.task_widget_result)).getMaxLines());
        int replacement = widget();
        provider.onRestored(context, new int[]{second}, new int[]{replacement});
        assertEquals("b", prefs.getString("selected:" + replacement, ""));
        assertFalse(prefs.contains("selected:" + second));
        assertEquals("Task b", text(replacement, R.id.task_widget_title));
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
        assertNull(Shadows.shadowOf(context).getNextStartedActivity());
        assertNull(Shadows.shadowOf(context).getNextStartedService());
    }

    @Test public void selectionSurvivesReorderAndFallsBackAfterRemovalWithoutTouchingTasks() throws Exception {
        JSONObject a = display("a"), b = display("b"), c = display("c");
        snapshot(a, b, c);
        int first = widget(), second = widget();
        move(second, true);
        snapshot(c, b, a);
        provider.onUpdate(context, manager, new int[]{first, second});
        assertEquals("Task a", text(first, R.id.task_widget_title));
        assertEquals("3/3", text(first, R.id.task_widget_position));
        assertEquals("Task b", text(second, R.id.task_widget_title));
        move(first, true);
        assertEquals("Task c", text(first, R.id.task_widget_title));
        move(first, false);
        assertEquals("Task a", text(first, R.id.task_widget_title));
        snapshot(c, a);
        provider.onUpdate(context, manager, new int[]{first, second});
        assertEquals("c", prefs.getString("selected:" + second, ""));
        String saved = prefs.getString("snapshot", "");
        provider.onDeleted(context, new int[]{second});
        assertFalse(prefs.contains("selected:" + second));
        assertEquals(saved, prefs.getString("snapshot", ""));
        assertEquals("a", prefs.getString("selected:" + first, ""));
        move(99999, true);
        assertFalse(prefs.contains("selected:99999"));
        snapshot();
        provider.onUpdate(context, manager, new int[]{first});
        assertEquals("", prefs.getString("selected:" + first, ""));
        assertFalse(host.getViewFor(first).findViewById(R.id.task_widget_next).isEnabled());
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
    }

    @Test public void remoteViewsApplyAtBothSizesAndClicksAreDirectActivities() throws Exception {
        snapshot(display("a"));
        int id = widget();
        for (int height : new int[]{180, 320}) {
            Bundle options = new Bundle();
            options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height);
            manager.updateAppWidgetOptions(id, options);
            provider.onAppWidgetOptionsChanged(context, manager, id, options);
            View root = CountingWidgets.views.get(id).apply(context, new FrameLayout(context));
            float density = context.getResources().getDisplayMetrics().density;
            root.measure(View.MeasureSpec.makeMeasureSpec(Math.round(250 * density), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(Math.round(height * density), View.MeasureSpec.EXACTLY));
            root.layout(0, 0, root.getMeasuredWidth(), root.getMeasuredHeight());
            assertNoEditor(root);
            assertTrue(root.findViewById(R.id.task_widget_new_chat).getHeight() >= Math.round(48 * density));
            assertTrue(root.findViewById(R.id.task_widget_result).getHeight() > 0);
            root.findViewById(R.id.task_widget_body).performClick();
            Intent detail = Shadows.shadowOf(context).getNextStartedActivity();
            assertEquals(TaskDetailActivity.class.getName(), detail.getComponent().getClassName());
            assertEquals("a", detail.getStringExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID));
            root.findViewById(R.id.task_widget_new_chat).performClick();
            Intent create = Shadows.shadowOf(context).getNextStartedActivity();
            assertEquals(MainActivity.class.getName(), create.getComponent().getClassName());
            assertTrue(create.getBooleanExtra(MainActivity.EXTRA_NEW_CHAT, false));
            root.findViewById(R.id.task_widget_voice).performClick();
            Intent voice = Shadows.shadowOf(context).getNextStartedActivity();
            assertEquals(VoiceSessionActivity.class.getName(), voice.getComponent().getClassName());
            assertEquals("a", voice.getStringExtra(VoiceSessionActivity.EXTRA_CONVERSATION_ID));
            assertFalse(voice.getBooleanExtra(LauncherVoiceInteractionService.EXTRA_WAKE, true));
        }
    }

    @Test public void pendingIntentIdentityIncludesWidgetActionAndExactConversation() {
        PendingIntent detail = activity(1, "detail", "a/b 😀");
        assertTrue(Shadows.shadowOf(detail).isActivity());
        assertTrue(Shadows.shadowOf(detail).isImmutable());
        assertTrue((Shadows.shadowOf(detail).getFlags() & PendingIntent.FLAG_UPDATE_CURRENT) != 0);
        assertNotEquals(detail, activity(2, "detail", "a/b 😀"));
        assertNotEquals(detail, activity(1, "detail", "other"));
        assertNotEquals(detail, activity(1, "voice", "a/b 😀"));
        Intent intent = Shadows.shadowOf(detail).getSavedIntent();
        assertEquals("a/b 😀", intent.getData().getLastPathSegment());
        assertEquals(new ComponentName(context, TaskDetailActivity.class), intent.getComponent());
        PendingIntent next = ReflectionHelpers.callStaticMethod(TaskWidgetProvider.class, "switchTask",
                from(Context.class, context), from(int.class, 1), from(boolean.class, false), from(String.class, "a"));
        assertTrue(Shadows.shadowOf(next).isBroadcast());
        assertTrue(Shadows.shadowOf(next).isImmutable());
        assertEquals(new ComponentName(context, TaskWidgetProvider.class), Shadows.shadowOf(next).getSavedIntent().getComponent());
        assertEquals(1, Shadows.shadowOf(next).getSavedIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1));
    }

    @Test public void ordinaryEventsMergeAtOneSecondAndTerminalUpdateCancelsTheirTail() throws Exception {
        int id = widget();
        ChatStore store = ChatCoordinator.get(context).store();
        store.newConversation();
        saveReply(store, "initial");
        TaskWidgetProvider.requestRefresh(context, true);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        CountingWidgets.updates = 0;
        for (int i = 0; i < 20; i++) {
            saveReply(store, "delta " + i);
            TaskWidgetProvider.requestRefresh(context, false);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(40));
        }
        assertEquals(0, CountingWidgets.updates);
        assertEquals("initial", text(id, R.id.task_widget_result));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        assertEquals(1, CountingWidgets.updates);
        assertEquals("delta 19", text(id, R.id.task_widget_result));
        TaskWidgetProvider.requestRefresh(context, false);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        assertEquals("identical display must not make another binder update", 1, CountingWidgets.updates);
        TaskWidgetProvider.requestRefresh(context, false);
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit()
                .putString("run_status_" + store.activeId(), "error")
                .putString("run_error_" + store.activeId(), "Terminal failure").commit();
        TaskWidgetProvider.requestRefresh(context, true);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(2, CountingWidgets.updates);
        assertEquals("上次状态：执行失败", text(id, R.id.task_widget_status));
        assertEquals("Terminal failure", text(id, R.id.task_widget_result));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertEquals(2, CountingWidgets.updates);
        assertEquals("Terminal failure", new JSONArray(prefs.getString("snapshot", "[]")).getJSONObject(0).getString("result"));
    }

    @Test public void snapshotIsBoundedDisplayOnlyAndMalformedStorageStaysAnEmptyState() throws Exception {
        JSONArray cards = new JSONArray();
        for (int i = 0; i < 120; i++) cards.put(new JSONObject().put("conversationId", "c" + i)
                .put("title", "😀".repeat(200)).put("modelState", "idle").put("result", "😀".repeat(600))
                .put("attachments", new JSONArray().put("private attachment path"))
                .put("messages", new JSONArray().put("entire history")));
        JSONArray saved = ReflectionHelpers.callStaticMethod(TaskWidgetProvider.class, "saveSnapshot",
                from(Context.class, context), from(JSONArray.class, cards));
        assertEquals(100, saved.length());
        JSONObject card = saved.getJSONObject(0);
        assertEquals(6, card.length());
        assertFalse(card.has("attachments"));
        assertFalse(card.has("messages"));
        assertEquals(80, card.getString("title").codePointCount(0, card.getString("title").length()));
        assertEquals(240, card.getString("result").codePointCount(0, card.getString("result").length()));
        int id = widget();
        prefs.edit().putString("snapshot", "broken JSON").commit();
        resetProcessState();
        provider.onUpdate(context, manager, new int[]{id});
        assertEquals(context.getString(R.string.task_widget_empty), text(id, R.id.task_widget_status));
        host.getViewFor(id).findViewById(R.id.task_widget_body).performClick();
        assertTrue(Shadows.shadowOf(context).getNextStartedActivity().getBooleanExtra(MainActivity.EXTRA_NEW_CHAT, false));
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
    }

    private PendingIntent activity(int id, String action, String conversation) {
        return ReflectionHelpers.callStaticMethod(TaskWidgetProvider.class, "activity", from(Context.class, context),
                from(int.class, id), from(String.class, action), from(String.class, conversation));
    }

    private void saveReply(ChatStore store, String text) {
        store.save(Arrays.asList(new AgentLoop.Message("user", "user", "Task", null, java.util.List.of(), false),
                new AgentLoop.Message("reply", "assistant", text, null, java.util.List.of(), false)));
    }

    private void assertNoEditor(View view) {
        assertFalse(view instanceof EditText);
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) assertNoEditor(group.getChildAt(i));
    }
}
