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
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
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
import java.util.List;
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
        context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().clear().commit();
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
        ChatCoordinator coordinator = ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance");
        if (coordinator != null) ((java.util.concurrent.ExecutorService) ReflectionHelpers.getField(coordinator, "executor")).shutdownNow();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    private int widget() { return host.createWidget(TaskWidgetProvider.class, R.layout.task_widget); }

    /** Existing six-field snapshots must continue to work without reading ChatStore. */
    private JSONObject display(String id) throws Exception {
        return new JSONObject().put("conversationId", id).put("title", "Task " + id).put("status", "正在执行")
                .put("step", "Step " + id).put("result", "Result " + id).put("savedAt", 1_700_000_000_000L);
    }

    private JSONObject node(String subject, String status) throws Exception {
        return new JSONObject().put("subject", subject).put("status", status);
    }

    private void snapshot(JSONObject... cards) { prefs.edit().putString("snapshot", new JSONArray(Arrays.asList(cards)).toString()).commit(); }

    private String text(int id, int view) { return ((TextView) host.getViewFor(id).findViewById(view)).getText().toString(); }

    private void move(int id, boolean next) {
        provider.onReceive(context, new Intent(context, TaskWidgetProvider.class)
                .setAction("com.example.launcherprobe.widget." + (next ? "NEXT" : "PREVIOUS"))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id));
    }

    @Test public void pickerPreviewAndEmptyWidgetShowOnlyOriginalEmptyState() {
        View preview = new RemoteViews(context.getPackageName(), R.layout.task_widget)
                .apply(context, new FrameLayout(context));
        int id = widget();
        for (View root : new View[]{preview, host.getViewFor(id)}) {
            for (int hidden : new int[]{R.id.task_widget_status, R.id.task_widget_position,
                    R.id.task_widget_switch, R.id.task_widget_body, R.id.task_widget_actions,
                    R.id.task_widget_back_one, R.id.task_widget_back_two})
                assertEquals(View.GONE, root.findViewById(hidden).getVisibility());
            assertEquals(View.VISIBLE, root.findViewById(R.id.task_widget_start).getVisibility());
            for (int icon : new int[]{R.id.task_widget_brand_icon, R.id.task_widget_folder, R.id.task_widget_empty_icon})
                assertNotNull(((ImageView) root.findViewById(icon)).getDrawable());
        }
        host.getViewFor(id).findViewById(R.id.task_widget_start).performClick();
        Intent start = Shadows.shadowOf(context).getNextStartedActivity();
        assertEquals(MainActivity.class.getName(), start.getComponent().getClassName());
        assertTrue(start.getBooleanExtra(MainActivity.EXTRA_NEW_CHAT, false));
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
    }

    @Test public void callbacksUseOnlyLegacySnapshotAcrossProcessResetResizeAndRestore() throws Exception {
        snapshot(display("a"), display("b"));
        int first = widget(), second = widget();
        move(second, true);
        assertEquals("a", prefs.getString("selected:" + first, ""));
        assertEquals("b", prefs.getString("selected:" + second, ""));
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
        resetProcessState();
        provider.onUpdate(context, manager, new int[]{first, second});
        assertEquals("Task b", text(second, R.id.task_widget_title));
        assertEquals("正在执行", text(second, R.id.task_widget_status));
        String description = host.getViewFor(second).findViewById(R.id.task_widget_body).getContentDescription().toString();
        assertTrue(description.contains("上次状态：正在执行"));
        assertTrue(description.contains("快照 · "));
        assertFalse(description.contains("Result b"));
        assertEquals(context.getString(R.string.task_widget_detail_hint), text(second, R.id.task_widget_count));
        Bundle options = new Bundle();
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 360);
        manager.updateAppWidgetOptions(second, options);
        provider.onAppWidgetOptionsChanged(context, manager, second, options);
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
        assertEquals("对话 3/3", text(first, R.id.task_widget_position));
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

    @Test @org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
    public void originalCardGeometryPaletteAndDirectActivityTargets() throws Exception {
        JSONObject card = display("a").put("modelState", "idle").put("unreadResult", true)
                .put("taskCount", 1).put("completedCount", 1)
                .put("tasks", new JSONArray().put(node("Original subject", "completed")));
        snapshot(card, display("b"), display("c"));
        int id = widget();
        for (boolean dark : new boolean[]{false, true}) {
            context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("theme", dark ? "dark" : "light").commit();
            for (int height : new int[]{180, 320}) {
                Bundle options = new Bundle();
                options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height);
                options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 360);
                manager.updateAppWidgetOptions(id, options);
                provider.onAppWidgetOptionsChanged(context, manager, id, options);
                View root = CountingWidgets.views.get(id).apply(context, new FrameLayout(context));
                root.measure(View.MeasureSpec.makeMeasureSpec(dp(360), View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(dp(height), View.MeasureSpec.EXACTLY));
                root.layout(0, 0, root.getMeasuredWidth(), root.getMeasuredHeight());
                assertNoEditor(root);
                assertEquals(dp(48), root.findViewById(R.id.task_widget_archive).getHeight());
                assertEquals(dp(48), root.findViewById(R.id.task_widget_heading).getHeight());
                assertEquals(dp(14), root.findViewById(R.id.task_widget_panel).getPaddingLeft());
                assertEquals(dp(4), root.findViewById(R.id.task_widget_panel).getPaddingTop());
                assertEquals(dp(10), root.findViewById(R.id.task_widget_panel).getPaddingBottom());
                assertEquals(dp(8), root.findViewById(R.id.task_widget_front).getPaddingBottom());
                assertEquals(View.VISIBLE, root.findViewById(R.id.task_widget_back_two).getVisibility());
                assertEquals(dp(24), root.findViewById(R.id.task_widget_previous).getHeight());
                TextView title = root.findViewById(R.id.task_widget_title);
                assertFalse(title.getIncludeFontPadding());
                assertEquals(17 * context.getResources().getDisplayMetrics().scaledDensity, title.getTextSize(), .01f);
                assertEquals(dark ? 0xffe5f5f8 : 0xff092e40, title.getCurrentTextColor());
                GradientDrawable background = (GradientDrawable) root.findViewById(R.id.task_widget_panel).getBackground();
                assertEquals(dp(22), background.getCornerRadius(), .01f);
                assertArrayEquals(dark ? new int[]{0xeb1b3b47, 0xe6264652} : new int[]{0xf5fbfeff, 0xe3f2fcff}, background.getColors());
                assertEquals("已完成 1 项，共 1 项", text(id, R.id.task_widget_count));
                assertEquals("正在执行 · 未读", text(id, R.id.task_widget_status));
                ImageView steps = root.findViewById(R.id.task_widget_steps);
                assertTrue(steps.getContentDescription().toString().contains("Original subject, 已完成"));
                Bitmap bitmap = ((BitmapDrawable) steps.getDrawable()).getBitmap();
                assertEquals(dp(332), bitmap.getWidth());
                // Original single node is centered; sample inside the completed disk, away from the tick.
                assertEquals(dark ? 0xff70d4df : 0xff0098ad, bitmap.getPixel(bitmap.getWidth() / 2 + dp(7), dp(19)));
                root.findViewById(R.id.task_widget_body).performClick();
                Intent detail = Shadows.shadowOf(context).getNextStartedActivity();
                assertEquals(TaskDetailActivity.class.getName(), detail.getComponent().getClassName());
                assertEquals("a", detail.getStringExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID));
                root.findViewById(R.id.task_widget_chat).performClick();
                Intent chat = Shadows.shadowOf(context).getNextStartedActivity();
                assertEquals(MainActivity.class.getName(), chat.getComponent().getClassName());
                assertEquals("a", chat.getStringExtra(TaskDetailActivity.EXTRA_OPEN_CHAT));
                assertFalse(chat.hasExtra(MainActivity.EXTRA_NEW_CHAT));
                root.findViewById(R.id.task_widget_folder).performClick();
                assertTrue(Shadows.shadowOf(context).getNextStartedActivity().getBooleanExtra(MainActivity.EXTRA_OPEN_ARCHIVED, false));
            }
        }
        assertEquals("workbench must retain its own palette", 0xff70d4df, AppAppearance.readWorkbench(context).accent);
        context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("theme", "light").commit();
        assertEquals(0xff087f8c, AppAppearance.readWorkbench(context).accent);
    }

    @Test public void pendingIntentIdentityIncludesWidgetActionAndExactConversation() {
        PendingIntent detail = activity(1, "detail", "a/b 😀");
        assertTrue(Shadows.shadowOf(detail).isActivity());
        assertTrue(Shadows.shadowOf(detail).isImmutable());
        assertTrue((Shadows.shadowOf(detail).getFlags() & PendingIntent.FLAG_UPDATE_CURRENT) != 0);
        assertNotEquals(detail, activity(2, "detail", "a/b 😀"));
        assertNotEquals(detail, activity(1, "detail", "other"));
        assertNotEquals(detail, activity(1, "chat", "a/b 😀"));
        Intent intent = Shadows.shadowOf(detail).getSavedIntent();
        assertEquals("a/b 😀", intent.getData().getLastPathSegment());
        assertEquals(new ComponentName(context, TaskDetailActivity.class), intent.getComponent());
        PendingIntent stop = operation(1, "STOP", "a");
        assertTrue(Shadows.shadowOf(stop).isBroadcast());
        assertTrue(Shadows.shadowOf(stop).isImmutable());
        assertEquals(new ComponentName(context, TaskWidgetProvider.class), Shadows.shadowOf(stop).getSavedIntent().getComponent());
        assertEquals(1, Shadows.shadowOf(stop).getSavedIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1));
        assertNotEquals(stop, operation(2, "STOP", "a"));
        assertNotEquals(stop, operation(1, "ARCHIVE", "a"));
        assertNotEquals(stop, operation(1, "STOP", "b"));
    }

    @Test public void archiveAndStopRequireOwnedWidgetAndExplicitSelectedTarget() throws Exception {
        snapshot(display("a"), display("b"));
        int id = widget();
        for (Intent invalid : new Intent[]{Shadows.shadowOf(operation(-1, "STOP", "a")).getSavedIntent(),
                Shadows.shadowOf(operation(id, "ARCHIVE", "b")).getSavedIntent(),
                new Intent().setAction("com.example.launcherprobe.widget.STOP").putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)})
            provider.onReceive(context, invalid);
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        ChatStore store = coordinator.store();
        store.newConversation();
        saveTitle(store, "Selected");
        String selected = store.activeId();
        store.newConversation();
        saveTitle(store, "Other active chat");
        String other = store.activeId();
        snapshot(display(selected).put("modelState", "working"), display(other));
        prefs.edit().putString("selected:" + id, selected).commit();
        store.selectConversation(selected);
        ChatCoordinator.SessionRun run = coordinator.registerRun(selected, null);
        assertEquals(new ComponentName(context, ChatExecutionService.class),
                Shadows.shadowOf(context).getNextStartedService().getComponent());
        store.selectConversation(other);
        provider.onReceive(context, Shadows.shadowOf(operation(id, "ARCHIVE", selected)).getSavedIntent());
        assertFalse("stale idle button cannot archive a now-running task", store.isArchived(selected));
        provider.onUpdate(context, manager, new int[]{id});
        assertEquals("停止", text(id, R.id.task_widget_archive));
        View root = CountingWidgets.views.get(id).apply(context, new FrameLayout(context));
        clickOperation(root, "STOP");
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertTrue(run.cancellation.cancelled());
        assertEquals("正在停止…", text(id, R.id.task_widget_archive));
        assertFalse(host.getViewFor(id).findViewById(R.id.task_widget_archive).isEnabled());
        assertFalse(store.isArchived(other));
        coordinator.finish(run, "aborted", "");
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("归档", text(id, R.id.task_widget_archive));
        root = CountingWidgets.views.get(id).apply(context, new FrameLayout(context));
        clickOperation(root, "ARCHIVE");
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertTrue(store.isArchived(selected));
        assertFalse(store.isArchived(other));
        assertEquals(other, store.activeId());
        assertNull(Shadows.shadowOf(context).getNextStartedService());
    }

    private void clickOperation(View root, String action) {
        assertTrue(root.findViewById(R.id.task_widget_archive).performClick());
        List<Intent> sent = Shadows.shadowOf(context).getBroadcastIntents();
        Intent intent = sent.get(sent.size() - 1);
        assertEquals("com.example.launcherprobe.widget." + action, intent.getAction());
        // Robolectric records this explicit broadcast; Android delivers it to the manifest receiver.
        provider.onReceive(context, intent);
    }

    @Test public void ordinaryEventsMergeAtOneSecondAndTerminalUpdateCancelsTheirTail() throws Exception {
        int id = widget();
        ChatStore store = ChatCoordinator.get(context).store();
        store.newConversation();
        saveTitle(store, "initial");
        TaskWidgetProvider.requestRefresh(context, true);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        CountingWidgets.updates = 0;
        for (int i = 0; i < 20; i++) {
            saveTitle(store, "delta " + i);
            TaskWidgetProvider.requestRefresh(context, false);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(40));
        }
        assertEquals(0, CountingWidgets.updates);
        assertEquals("initial", text(id, R.id.task_widget_title));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        assertEquals(1, CountingWidgets.updates);
        assertEquals("delta 19", text(id, R.id.task_widget_title));
        TaskWidgetProvider.requestRefresh(context, false);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        assertEquals("identical display must not make another binder update", 1, CountingWidgets.updates);
        TaskWidgetProvider.requestRefresh(context, false);
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit()
                .putString("run_status_" + store.activeId(), "error").commit();
        TaskWidgetProvider.requestRefresh(context, true);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(2, CountingWidgets.updates);
        assertEquals("执行失败", text(id, R.id.task_widget_status));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertEquals(2, CountingWidgets.updates);
    }

    @Test public void snapshotIsBoundedDisplayOnlyAndMalformedStorageStaysAnEmptyState() throws Exception {
        JSONArray nodes = new JSONArray();
        for (int i = 0; i < 30; i++) nodes.put(node("😀".repeat(200), i == 28 ? "in_progress" : "completed")
                .put("toolResult", "private tool data"));
        JSONObject todo = new JSONObject().put("package", "@juicesharp/rpiv-todo").put("tasks", nodes);
        JSONArray cards = new JSONArray();
        for (int i = 0; i < 120; i++) cards.put(new JSONObject().put("conversationId", "c" + i)
                .put("title", "😀".repeat(200)).put("modelState", "working").put("result", "private reply")
                .put("unreadResult", true).put("todo", todo)
                .put("attachments", new JSONArray().put("private attachment path"))
                .put("messages", new JSONArray().put("entire history")));
        JSONArray saved = ReflectionHelpers.callStaticMethod(TaskWidgetProvider.class, "saveSnapshot",
                from(Context.class, context), from(JSONArray.class, cards));
        assertEquals(100, saved.length());
        assertTrue(prefs.getString("snapshot", "").length() <= 512_000);
        JSONObject card = saved.getJSONObject(0);
        assertFalse(card.has("attachments"));
        assertFalse(card.has("messages"));
        assertFalse(card.has("result"));
        assertFalse(card.has("todo"));
        assertEquals(80, card.getString("title").codePointCount(0, card.getString("title").length()));
        assertEquals(30, card.getInt("taskCount"));
        assertEquals(29, card.getInt("completedCount"));
        assertEquals(20, card.getJSONArray("tasks").length());
        assertEquals(2, card.getJSONArray("tasks").getJSONObject(0).length());
        assertEquals("in_progress", card.getJSONArray("tasks").getJSONObject(18).getString("status"));
        assertTrue(card.getBoolean("unreadResult"));
        String nodeSubject = card.getJSONArray("tasks").getJSONObject(0).getString("subject");
        assertEquals(64, nodeSubject.codePointCount(0, nodeSubject.length()));
        int id = widget();
        resetProcessState();
        provider.onUpdate(context, manager, new int[]{id});
        assertEquals("已完成 29 项，共 30 项", text(id, R.id.task_widget_count));
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
        prefs.edit().putString("snapshot", "broken JSON").commit();
        provider.onUpdate(context, manager, new int[]{id});
        assertEquals(View.GONE, host.getViewFor(id).findViewById(R.id.task_widget_body).getVisibility());
        assertEquals(View.VISIBLE, host.getViewFor(id).findViewById(R.id.task_widget_empty_icon).getVisibility());
        host.getViewFor(id).findViewById(R.id.task_widget_start).performClick();
        assertTrue(Shadows.shadowOf(context).getNextStartedActivity().getBooleanExtra(MainActivity.EXTRA_NEW_CHAT, false));
        assertNull(ReflectionHelpers.getStaticField(ChatCoordinator.class, "instance"));
    }

    private PendingIntent activity(int id, String action, String conversation) {
        return ReflectionHelpers.callStaticMethod(TaskWidgetProvider.class, "activity", from(Context.class, context),
                from(int.class, id), from(String.class, action), from(String.class, conversation));
    }

    private PendingIntent operation(int id, String action, String conversation) {
        return ReflectionHelpers.callStaticMethod(TaskWidgetProvider.class, "operation", from(Context.class, context),
                from(int.class, id), from(String.class, "com.example.launcherprobe.widget." + action), from(String.class, conversation));
    }

    private void saveTitle(ChatStore store, String text) throws Exception {
        store.save(List.of(new AgentLoop.Message("user", "user", text, null, List.of(), false)));
        SharedPreferences chat = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
        JSONObject index = new JSONObject(chat.getString("conversations", "{}"));
        index.getJSONObject(store.activeId()).put("title", text);
        chat.edit().putString("conversations", index.toString()).commit();
    }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    private void assertNoEditor(View view) {
        assertFalse(view instanceof EditText);
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) assertNoEditor(group.getChildAt(i));
    }
}
