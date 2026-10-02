package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.AlarmManager;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
import org.robolectric.android.util.concurrent.PausedExecutorService;
import org.robolectric.shadows.ShadowBroadcastPendingResult;
import org.robolectric.util.ReflectionHelpers;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Base64;
import java.util.TimeZone;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class ScheduleCalendarRefreshTest {
    private Application app;
    private ScheduledTasks tasks;
    private ScheduleCalendarRefresh refresh;
    private PausedExecutorService worker;
    private TimeZone previousZone;
    private final long now = Instant.parse("2027-01-01T00:00:00Z").toEpochMilli();
    private final AtomicInteger calls = new AtomicInteger();
    private String currentResponse;
    private boolean fail;

    @Before public void setup() throws Exception {
        app = RuntimeEnvironment.getApplication();
        previousZone = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"));
        app.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE).edit().clear().commit();
        app.getSharedPreferences("schedule_calendar", Context.MODE_PRIVATE).edit().clear().commit();
        File[] cache = new File(app.getFilesDir(), "schedule-calendar").listFiles();
        if (cache != null) for (File file : cache) assertTrue(file.delete());
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        Shadows.shadowOf(app.getSystemService(AlarmManager.class)).setCanScheduleExactAlarms(true);
        tasks = ScheduledTasks.get(app);
        ReflectionHelpers.setField(tasks, "clock", (java.util.function.LongSupplier) () -> now);
        refresh = ReflectionHelpers.getField(tasks, "calendarRefresh");
        worker = new PausedExecutorService();
        ReflectionHelpers.setField(refresh, "worker", worker);
        currentResponse = response(2027, annual(2027)).toString();
        String placeholder = response(2028, new JSONObject().put("year", 2028)
                .put("papers", new JSONArray()).put("days", new JSONArray())).toString();
        assertEquals(2500, ReflectionHelpers.<OkHttpClient>getField(refresh, "http").callTimeoutMillis());
        ReflectionHelpers.setField(refresh, "http", new OkHttpClient.Builder().addInterceptor(chain -> {
            calls.incrementAndGet();
            if (fail) throw new java.io.IOException("offline fixture");
            String body = chain.request().url().encodedPath().endsWith("2027.json")
                    ? currentResponse : placeholder;
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200)
                    .message("fixture").body(ResponseBody.create(MediaType.parse("application/json"), body)).build();
        }).build());
    }

    @After public void cleanup() {
        worker.shutdownNow();
        TimeZone.setDefault(previousZone);
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    @Test public void publishedYearUpdatesCoverageAndReschedulesAndRestartLoadsTheAtomicCache() throws Exception {
        JSONObject input = input();
        JSONObject before = tasks.save(input).getJSONArray("tasks").getJSONObject(0);
        assertTrue(before.getString("calendarNotice").contains("2027"));
        assertEquals(Instant.parse("2027-01-04T00:00:00Z").toEpochMilli(), before.getLong("nextRunAt"));
        AtomicInteger events = new AtomicInteger(), completed = new AtomicInteger();
        tasks.addListener(events::incrementAndGet);
        tasks.refreshCalendar(completed::incrementAndGet);
        assertEquals(0, calls.get()); // No HTTP on preview/alarm/caller thread.
        assertTrue(tasks.preview(input).has("calendarNotice"));
        worker.runAll();
        assertEquals(2, calls.get());
        assertEquals(1, completed.get());
        assertEquals(1, events.get());
        JSONObject after = tasks.snapshot().getJSONArray("tasks").getJSONObject(0);
        assertFalse(after.has("calendarNotice"));
        assertEquals(Instant.parse("2027-01-02T00:00:00Z").toEpochMilli(), after.getLong("nextRunAt"));
        assertEquals(before.getString("repeat"), after.getString("repeat"));
        assertEquals(before.getString("prompt"), after.getString("prompt"));
        String stored = new String(Files.readAllBytes(cache().toPath()), StandardCharsets.UTF_8);
        JSONObject source = new JSONObject(stored);
        assertFalse(source.has("sourceCommit"));
        assertEquals(ScheduleCalendarRefresh.url(2027), source.getString("sourceUrl"));
        assertEquals("1111111111111111111111111111111111111111", source.getString("sourceBlobSha"));
        assertEquals(now, source.getLong("fetchedAt"));
        assertFalse(new File(cache().getParentFile(), "2028.json").exists());
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
        ScheduledTasks restarted = ScheduledTasks.get(app);
        ReflectionHelpers.setField(restarted, "clock", (java.util.function.LongSupplier) () -> now);
        assertFalse(restarted.preview(input).has("calendarNotice"));
        assertEquals(tasks.snapshot().getString("calendarVersion"), restarted.snapshot().getString("calendarVersion"));
    }

    @Test public void invalidOrOfflineResponsesNeverReplaceLastGoodCacheAndAttemptsAreDailyAndNonReentrant() throws Exception {
        AtomicInteger completed = new AtomicInteger(), updated = new AtomicInteger();
        refresh.request(now, ZoneId.of("Asia/Shanghai"), value -> updated.incrementAndGet(), completed::incrementAndGet);
        refresh.request(now, ZoneId.of("Asia/Shanghai"), value -> fail("duplicate job"), completed::incrementAndGet);
        worker.runAll();
        assertEquals(2, calls.get());
        assertEquals(2, completed.get());
        assertEquals(1, updated.get());
        String good = new String(Files.readAllBytes(cache().toPath()), StandardCharsets.UTF_8);
        refresh.request(now + 1000, ZoneId.of("Asia/Shanghai"), value -> fail("daily throttle"), completed::incrementAndGet);
        worker.runAll();
        assertEquals(2, calls.get());
        assertEquals(3, completed.get());

        JSONObject empty = annual(2027).put("papers", new JSONArray());
        JSONObject badDate = annual(2027);
        badDate.getJSONArray("days").getJSONObject(0).put("date", "2027-02-30");
        JSONObject badBoolean = annual(2027);
        badBoolean.getJSONArray("days").getJSONObject(0).put("isOffDay", "true");
        JSONObject wrongYear = annual(2027).put("year", 2028);
        int day = 1;
        for (JSONObject bad : new JSONObject[]{empty, annual(2027).put("days", new JSONArray()), badDate, badBoolean, wrongYear}) {
            currentResponse = response(2027, bad).toString();
            refresh.request(now + day++ * 86400000L, ZoneId.of("Asia/Shanghai"), value -> fail("bad data applied"), completed::incrementAndGet);
            worker.runAll();
            assertEquals(good, new String(Files.readAllBytes(cache().toPath()), StandardCharsets.UTF_8));
        }
        fail = true;
        refresh.request(now + day++ * 86400000L, ZoneId.of("Asia/Shanghai"), value -> fail("offline data applied"), completed::incrementAndGet);
        worker.runAll();
        assertEquals(good, new String(Files.readAllBytes(cache().toPath()), StandardCharsets.UTF_8));
        assertEquals(1, updated.get());
        ScheduleCalendarRefresh restarted = new ScheduleCalendarRefresh(app, ScheduleCalendar.load(app));
        PausedExecutorService restartedWorker = new PausedExecutorService();
        ReflectionHelpers.setField(restarted, "worker", restartedWorker);
        restarted.request(now + (day - 1) * 86400000L, ZoneId.of("Asia/Shanghai"), value -> fail("restart throttle"), completed::incrementAndGet);
        assertEquals(0, restartedWorker.runAll());
        restartedWorker.shutdownNow();
    }

    @Test public void statutoryAlarmDoesNotWaitForHttpAndFinishesReceiverResultOnFailureAndThrottle() throws Exception {
        tasks.save(input());
        JSONObject state = new JSONObject(app.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE).getString("state", "{}"));
        state.getJSONArray("tasks").getJSONObject(0).put("nextRunAt", now);
        app.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE).edit().putString("state", state.toString()).commit();
        ScheduledTaskReceiver receiver = new ScheduledTaskReceiver();
        app.registerReceiver(receiver, new IntentFilter(ScheduledTasks.ACTION_RUN), Context.RECEIVER_NOT_EXPORTED);
        try {
            fail = true;
            app.sendBroadcast(new Intent(ScheduledTasks.ACTION_RUN).setPackage(app.getPackageName()));
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals(0, calls.get());
            assertEquals(1, tasks.snapshot().getJSONArray("records").length());
            assertTrue(Shadows.shadowOf(receiver).wentAsync());
            android.content.BroadcastReceiver.PendingResult pending = Shadows.shadowOf(receiver).getOriginalPendingResult();
            ShadowBroadcastPendingResult shadow = org.robolectric.shadow.api.Shadow.extract(pending);
            assertFalse(shadow.getFuture().isDone());
            worker.runAll();
            assertTrue(shadow.getFuture().isDone());

            app.sendBroadcast(new Intent(ScheduledTasks.ACTION_RUN).setPackage(app.getPackageName()));
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            pending = Shadows.shadowOf(receiver).getOriginalPendingResult();
            shadow = org.robolectric.shadow.api.Shadow.extract(pending);
            assertTrue(shadow.getFuture().isDone());
            assertEquals(2, calls.get()); // Two failed annual attempts; no retry in the same day.
        } finally { app.unregisterReceiver(receiver); }
    }

    @Test public void cachedSameYearReplacesTheBundledAnnualDataWithoutClaimingUnknownCoverage() throws Exception {
        ScheduleCalendar before = ScheduleCalendar.load(app);
        assertFalse(before.isWorkday(java.time.LocalDate.of(2026, 1, 2), ZoneId.of("Asia/Shanghai")));
        JSONObject entry = ScheduleCalendarRefresh.downloadedYear(response(2026, annual(2026)), 2026, now);
        PiConfigStore.write(new File(app.getFilesDir(), "schedule-calendar/2026.json"), entry.toString());
        ScheduleCalendar after = ScheduleCalendar.load(app);
        assertTrue(after.isWorkday(java.time.LocalDate.of(2026, 1, 2), ZoneId.of("Asia/Shanghai")));
        assertFalse(before.version().equals(after.version()));
        assertThrows(Exception.class, () -> ScheduleCalendarRefresh.downloadedYear(response(2027, annual(2027)).put("sha", "invalid"), 2027, now));
        assertThrows(Exception.class, () -> ScheduleCalendarRefresh.downloadedYear(response(2027, annual(2027)).put("path", "2028.json"), 2027, now));
    }

    @Test public void unsupportedZonesNeverDownloadAndRejectedDispatchAlwaysCompletes() {
        AtomicInteger completed = new AtomicInteger();
        refresh.request(now, ZoneId.of("Asia/Singapore"), value -> fail("unsupported"), completed::incrementAndGet);
        assertEquals(1, completed.get());
        assertEquals(0, calls.get());
        ReflectionHelpers.setField(refresh, "worker", (java.util.concurrent.Executor) runnable -> {
            throw new java.util.concurrent.RejectedExecutionException("fixture rejected");
        });
        refresh.request(now, ZoneId.of("Asia/Shanghai"), value -> fail("rejected"), completed::incrementAndGet);
        assertEquals(2, completed.get());
        assertFalse(ReflectionHelpers.<Boolean>getField(refresh, "inFlight"));
    }

    private File cache() { return new File(app.getFilesDir(), "schedule-calendar/2027.json"); }
    private static JSONObject input() throws Exception {
        return new JSONObject().put("title", "调休提醒").put("prompt", "保留任务内容")
                .put("repeat", "statutoryWorkday").put("time", "08:00");
    }
    private static JSONObject annual(int year) throws Exception {
        return new JSONObject().put("year", year).put("papers", new JSONArray().put("https://www.gov.cn/fixture"))
                .put("days", new JSONArray()
                        .put(new JSONObject().put("date", year + "-01-01").put("isOffDay", true))
                        .put(new JSONObject().put("date", year + "-01-02").put("isOffDay", false)));
    }
    private static JSONObject response(int year, JSONObject data) throws Exception {
        return new JSONObject().put("type", "file").put("path", year + ".json").put("encoding", "base64")
                .put("sha", "1111111111111111111111111111111111111111")
                .put("content", Base64.getEncoder().encodeToString(data.toString().getBytes(StandardCharsets.UTF_8)));
    }
}
