package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.AlarmManager;
import android.app.Application;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.os.Looper;

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
import org.robolectric.util.ReflectionHelpers;

import java.time.ZoneId;
import java.util.Collections;
import java.util.TimeZone;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class ScheduledTasksTest {
    private Application application;
    private ScheduledTasks tasks;
    private TimeZone previousZone;

    @Before public void setup() {
        application = RuntimeEnvironment.getApplication();
        previousZone = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        application.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE).edit().clear().commit();
        application.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "activeCount", 0);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "foreground", false);
        Shadows.shadowOf(application.getSystemService(AlarmManager.class)).setCanScheduleExactAlarms(true);
        Shadows.shadowOf(application).clearStartedServices();
        tasks = ScheduledTasks.get(application);
    }

    @After public void cleanup() {
        ChatExecutionService.setActiveCount(application, 0);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
        TimeZone.setDefault(previousZone);
    }

    @Test public void crudPersistsRulesAndControlsTheNativeAlarmWithoutLostUpdates() throws Exception {
        JSONObject task = tasks.save(input()).getJSONArray("tasks").getJSONObject(0);
        String id = task.getString("id");
        assertTrue(task.getLong("nextRunAt") > System.currentTimeMillis());
        assertEquals(1, Shadows.shadowOf(application.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        task.put("repeat", "weekly").put("weekday", 5).put("time", "18:00");
        JSONObject updated = tasks.save(task).getJSONArray("tasks").getJSONObject(0);
        assertEquals("weekly", updated.getString("repeat"));
        assertEquals(5, updated.getInt("weekday"));
        assertThrows(IllegalStateException.class, () -> tasks.save(task));
        JSONObject paused = tasks.setEnabled(id, 2, false).getJSONArray("tasks").getJSONObject(0);
        assertEquals(0, paused.getLong("nextRunAt"));
        assertEquals(0, Shadows.shadowOf(application.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        tasks.restore();
        assertFalse(tasks.snapshot().getJSONArray("tasks").getJSONObject(0).getBoolean("enabled"));
        JSONObject resumed = tasks.setEnabled(id, 3, true).getJSONArray("tasks").getJSONObject(0);
        assertTrue(resumed.getLong("nextRunAt") > System.currentTimeMillis());
        tasks.delete(id, 4);
        assertEquals(0, tasks.snapshot().getJSONArray("tasks").length());
        assertEquals(0, Shadows.shadowOf(application.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        assertThrows(IllegalArgumentException.class, () -> tasks.setEnabled(id, 4, true));
    }

    @Test public void missingPermissionKeepsDefinitionsAndRestoresFutureAlarmsWhenGranted() throws Exception {
        Shadows.shadowOf(application.getSystemService(AlarmManager.class)).setCanScheduleExactAlarms(false);
        JSONObject snapshot = tasks.save(input());
        assertFalse(snapshot.getBoolean("exactAlarmGranted"));
        assertTrue(snapshot.getJSONArray("tasks").getJSONObject(0).getBoolean("enabled"));
        assertEquals(0, Shadows.shadowOf(application.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        Shadows.shadowOf(application.getSystemService(AlarmManager.class)).setCanScheduleExactAlarms(true);
        tasks.restore();
        assertEquals(1, Shadows.shadowOf(application.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        assertNull(Shadows.shadowOf(application).getNextStartedService());
    }

    @Test public void bootSkipsOverdueOccurrenceWithoutLaunchingAnAgent() throws Exception {
        tasks.save(input());
        JSONObject state = stored();
        state.getJSONArray("tasks").getJSONObject(0).put("nextRunAt", System.currentTimeMillis() - 60_000);
        persist(state);
        new ScheduledTaskReceiver().onReceive(application, new Intent(Intent.ACTION_BOOT_COMPLETED));
        JSONObject snapshot = tasks.snapshot();
        JSONObject record = snapshot.getJSONArray("records").getJSONObject(0);
        assertEquals("skipped", record.getString("status"));
        assertEquals("missed", record.getString("reason"));
        assertTrue(record.isNull("conversationId"));
        assertTrue(snapshot.getJSONArray("tasks").getJSONObject(0).getLong("nextRunAt") > System.currentTimeMillis());
        tasks.restore();
        assertEquals(1, tasks.snapshot().getJSONArray("records").length());
        assertNull(Shadows.shadowOf(application).getNextStartedService());
    }

    @Test public void timeZoneChangeRecalculatesLocalWallClockTime() throws Exception {
        tasks.save(input());
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"));
        new ScheduledTaskReceiver().onReceive(application, new Intent(Intent.ACTION_TIMEZONE_CHANGED));
        JSONObject snapshot = tasks.snapshot();
        assertEquals("Asia/Shanghai", snapshot.getString("timeZone"));
        assertEquals(new ScheduleRule("daily", "08:00", 1, 1).nextAfter(System.currentTimeMillis(), ZoneId.systemDefault()),
                snapshot.getJSONArray("tasks").getJSONObject(0).getLong("nextRunAt"));
    }

    @Test public void changingTheClockAlsoRecalculatesWhenTheOldAlarmIsStillInTheFuture() throws Exception {
        tasks.save(input());
        JSONObject state = stored();
        state.getJSONArray("tasks").getJSONObject(0).put("nextRunAt", System.currentTimeMillis() + 7 * 86_400_000L);
        persist(state);
        new ScheduledTaskReceiver().onReceive(application, new Intent(Intent.ACTION_TIME_CHANGED));
        assertEquals(new ScheduleRule("daily", "08:00", 1, 1).nextAfter(System.currentTimeMillis(), ZoneId.systemDefault()),
                tasks.snapshot().getJSONArray("tasks").getJSONObject(0).getLong("nextRunAt"));
        assertEquals(0, tasks.snapshot().getJSONArray("records").length());
    }

    @Test public void failedStartIsDurableAndDuplicateAlarmsCannotReplayOrSwitchChat() throws Exception {
        Context deniedStart = new ContextWrapper(application) {
            @Override public ComponentName startForegroundService(Intent service) {
                throw new IllegalStateException("fixture foreground start denied");
            }
        };
        ChatCoordinator coordinator = ReflectionHelpers.callConstructor(ChatCoordinator.class,
                ReflectionHelpers.ClassParameter.from(Context.class, deniedStart));
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", coordinator);
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
        tasks = ScheduledTasks.get(application);
        ChatStore chat = coordinator.store();
        chat.save(Collections.singletonList(new AgentLoop.Message("kept", "user", "keep this chat", null, Collections.emptyList(), false)));
        chat.saveDraft("unsent draft");
        String active = chat.activeId();
        tasks.save(input());
        JSONObject state = stored();
        state.getJSONArray("tasks").getJSONObject(0).put("nextRunAt", System.currentTimeMillis() - 1000);
        persist(state);
        tasks.onAlarm();
        JSONObject record = tasks.snapshot().getJSONArray("records").getJSONObject(0);
        assertEquals("error", record.getString("status"));
        assertTrue(record.getString("message").contains("fixture foreground start denied"));
        assertNotNull(record.getString("conversationId"));
        assertTrue(record.getBoolean("conversationAvailable"));
        assertEquals(active, chat.activeId());
        assertEquals("unsent draft", chat.draft());
        assertEquals(2, chat.conversations().size());
        tasks.onAlarm();
        assertEquals(1, tasks.snapshot().getJSONArray("records").length());
        assertEquals(2, chat.conversations().size());
    }

    @Test public void runningOccurrenceIsNotOverlappedAndFinalEventSurvivesDefinitionDeletion() throws Exception {
        JSONObject task = tasks.save(input()).getJSONArray("tasks").getJSONObject(0);
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore chat = coordinator.store();
        ChatCoordinator.SessionRun active = coordinator.registerRun(chat.activeId(), null);
        JSONObject state = stored();
        state.getJSONArray("tasks").getJSONObject(0).put("nextRunAt", System.currentTimeMillis() - 1000);
        state.getJSONArray("runs").put(run("existing-run", task.getString("id"), active.conversationId));
        persist(state);
        tasks.onAlarm();
        JSONObject snapshot = tasks.snapshot();
        assertEquals(2, snapshot.getJSONArray("records").length());
        assertEquals("overlap", snapshot.getJSONArray("records").getJSONObject(0).getString("reason"));
        tasks.delete(task.getString("id"), 1);
        coordinator.finish(active, "completed", "");
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        snapshot = tasks.snapshot();
        assertEquals(0, snapshot.getJSONArray("tasks").length());
        assertEquals("completed", snapshot.getJSONArray("records").getJSONObject(1).getString("status"));
    }

    @Test public void interruptedReceiptsAndCorruptOrUntrustedInputsAreHandledWithoutErasingData() throws Exception {
        JSONObject task = tasks.save(input()).getJSONArray("tasks").getJSONObject(0);
        JSONObject state = stored();
        state.getJSONArray("runs").put(run("abandoned", task.getString("id"), "old-conversation"));
        persist(state);
        assertEquals("aborted", tasks.snapshot().getJSONArray("records").getJSONObject(0).getString("status"));
        assertThrows(IllegalArgumentException.class, () -> tasks.save(input().put("title", "   ")));
        assertThrows(IllegalArgumentException.class, () -> tasks.save(input().put("prompt", 12)));
        assertThrows(IllegalArgumentException.class, () -> tasks.save(input().put("repeat", "workday")));
        assertThrows(IllegalArgumentException.class, () -> tasks.save(input().put("repeat", "weekly").put("weekday", 2.5)));
        assertEquals(1, tasks.snapshot().getJSONArray("tasks").length());
        application.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE).edit().putString("state", "broken json").commit();
        assertThrows(Exception.class, () -> tasks.save(input()));
        assertEquals("broken json", application.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE).getString("state", ""));
    }

    @Test public void recordsAreBoundedButActiveRunsAreKept() throws Exception {
        tasks.save(input());
        JSONObject state = stored();
        JSONArray history = state.getJSONArray("runs");
        for (int i = 0; i < 105; i++) history.put(run("run-" + i, "old-task", "old-chat").put("status", "completed"));
        persist(state);
        tasks.save(input().put("title", "another"));
        JSONArray records = tasks.snapshot().getJSONArray("records");
        assertEquals(100, records.length());
        assertEquals("run-104", records.getJSONObject(0).getString("id"));
        assertEquals("run-5", records.getJSONObject(99).getString("id"));
    }

    private static JSONObject input() throws Exception {
        return new JSONObject().put("title", "早间简报").put("prompt", "整理今天的资讯")
                .put("repeat", "daily").put("time", "08:00").put("weekday", 1).put("monthDay", 1);
    }

    private static JSONObject run(String id, String taskId, String conversation) throws Exception {
        return new JSONObject().put("id", id).put("taskId", taskId).put("title", "早间简报")
                .put("status", "running").put("conversationId", conversation).put("scheduledAt", 1000)
                .put("startedAt", 1000).put("finishedAt", 0).put("reason", "").put("message", "");
    }

    private JSONObject stored() throws Exception {
        return new JSONObject(application.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE).getString("state", "{}"));
    }

    private void persist(JSONObject value) {
        application.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE).edit().putString("state", value.toString()).commit();
    }
}
