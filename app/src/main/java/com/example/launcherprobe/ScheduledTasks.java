package com.example.launcherprobe;

import android.app.AlarmManager;
import android.app.Application;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.ZoneId;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArraySet;

/** Private durable definitions and receipts, with one native alarm per delivery mode. */
final class ScheduledTasks {
    static final String ACTION_RUN = "com.example.launcherprobe.RUN_SCHEDULED_TASKS";
    private static final long MAX_LATENESS_MS = 15 * 60 * 1000L;
    private static ScheduledTasks instance;

    static synchronized ScheduledTasks get(Context context) {
        if (instance == null) instance = new ScheduledTasks((Application) context.getApplicationContext());
        return instance;
    }

    private final Application context;
    private final SharedPreferences preferences;
    private ScheduleCalendar calendar;
    private final ScheduleCalendarRefresh calendarRefresh;
    private final java.util.function.LongSupplier clock = System::currentTimeMillis;
    private final ChatCoordinator coordinator;
    private final Set<Runnable> listeners = new CopyOnWriteArraySet<>();
    private final String processId = UUID.randomUUID().toString();

    private ScheduledTasks(Application context) {
        this.context = context;
        calendar = ScheduleCalendar.load(context);
        calendarRefresh = new ScheduleCalendarRefresh(context, calendar);
        preferences = context.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE);
        coordinator = ChatCoordinator.get(context);
        coordinator.addListener((messages, event) -> onChatEvent(event));
    }

    void addListener(Runnable listener) { listeners.add(listener); }
    void removeListener(Runnable listener) { listeners.remove(listener); }
    private void changed() { for (Runnable listener : listeners) listener.run(); }

    void refreshCalendar(Runnable finished) {
        calendarRefresh.request(clock.getAsLong(), ZoneId.systemDefault(), this::calendarUpdated, finished);
    }

    synchronized boolean hasStatutoryTasks() throws JSONException {
        JSONArray tasks = read().getJSONArray("tasks");
        for (int i = 0; i < tasks.length(); i++)
            if (ScheduleRule.fromJson(tasks.getJSONObject(i)).isStatutory()) return true;
        return false;
    }

    private synchronized void calendarUpdated(ScheduleCalendar updated) {
        calendar = updated;
        try {
            JSONObject state = read();
            prepareOccurrences(state, false);
            write(state);
            scheduleAlarm(state);
        } catch (Exception failure) {
            Log.e("ScheduledTasks", "Unable to reschedule refreshed calendar", failure);
        }
        changed();
    }

    boolean exactAlarmGranted() {
        return Build.VERSION.SDK_INT < 31
                || context.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    /** Fresh definition snapshot only: searching must not recover runs or schedule execution. */
    synchronized JSONArray tasksForSearch() throws JSONException {
        return read().getJSONArray("tasks");
    }

    synchronized JSONObject snapshot() throws Exception {
        JSONObject state = read();
        if (recoverRuns(state)) write(state);
        Set<String> conversations = new HashSet<>();
        for (ChatStore.Conversation conversation : coordinator.store().conversations()) conversations.add(conversation.id);
        for (ChatStore.Conversation conversation : coordinator.store().archivedConversations()) conversations.add(conversation.id);
        JSONArray history = new JSONArray();
        JSONArray runs = state.getJSONArray("runs");
        for (int i = runs.length() - 1; i >= 0; i--) {
            JSONObject run = runs.getJSONObject(i);
            run.put("conversationAvailable", conversations.contains(run.optString("conversationId")));
            run.put("sourceConversationAvailable", conversations.contains(run.optString("sourceConversationId")));
            if (!run.has("sourceConversationId")) run.put("sourceConversationId", JSONObject.NULL);
            history.put(run);
        }
        JSONArray tasks = state.getJSONArray("tasks");
        long now = clock.getAsLong();
        ZoneId zone = ZoneId.systemDefault();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            ScheduleRule rule = ScheduleRule.fromJson(task);
            task.put("sourceConversationAvailable", conversations.contains(task.optString("sourceConversationId")));
            if (!task.has("sourceConversationId")) task.put("sourceConversationId", JSONObject.NULL);
            calendar.describe(task, rule, now, rule.nextAfter(now, zone, calendar), zone);
        }
        return new JSONObject().put("tasks", tasks).put("records", history)
                .put("exactAlarmGranted", exactAlarmGranted()).put("schedulingError", state.optString("schedulingError"))
                .put("timeZone", zone.getId()).put("now", now)
                .put("localNow", Instant.ofEpochMilli(now).atZone(zone).toOffsetDateTime().toString())
                .put("calendarVersion", calendar.version());
    }

    synchronized JSONObject preview(JSONObject input) throws Exception {
        ZoneId zone = ZoneId.systemDefault();
        long now = clock.getAsLong();
        if (input.has("id")) requireTask(read().getJSONArray("tasks"),
                ScheduleRule.text(input, "id"), ScheduleRule.integer(input, "revision"));
        ScheduleRule rule = ScheduleRule.fromJson(input);
        alarmMode(input, "alarmClock");
        long next = rule.nextAfter(now, zone, calendar);
        JSONObject result = new JSONObject().put("nextRunAt", next).put("timeZone", zone.getId());
        calendar.describe(result, rule, now, next, zone);
        return result;
    }

    synchronized JSONObject save(JSONObject input) throws Exception { return save(input, null); }

    private JSONObject save(JSONObject input, String sourceConversationId) throws Exception {
        String title = ScheduleRule.text(input, "title").trim();
        String prompt = ScheduleRule.text(input, "prompt").trim();
        if (title.isEmpty() || title.length() > 80) throw new IllegalArgumentException("备注需为 1–80 个字符");
        if (prompt.isEmpty() || prompt.length() > 8000) throw new IllegalArgumentException("任务内容需为 1–8000 个字符");
        JSONObject state = read();
        JSONArray tasks = state.getJSONArray("tasks");
        String id = input.has("id") ? ScheduleRule.text(input, "id") : UUID.randomUUID().toString();
        int index = indexOf(tasks, id);
        JSONObject previous = input.has("id") ? requireTask(tasks, id, ScheduleRule.integer(input, "revision")) : null;
        JSONObject ruleInput = new JSONObject(input.toString());
        if (previous != null && "weekly".equals(input.optString("repeat"))
                && "weekly".equals(previous.optString("repeat")) && !input.has("weekdays") && !input.has("weekday")
                && previous.has("weekdays")) ruleInput.put("weekdays", previous.getJSONArray("weekdays"));
        long now = clock.getAsLong();
        ScheduleRule rule = ScheduleRule.fromJson(ruleInput);
        boolean vibrate = ScheduleRule.bool(input, "vibrate", previous != null && previous.optBoolean("vibrate"));
        boolean deleteAfterRun = ScheduleRule.bool(input, "deleteAfterRun", previous != null && previous.optBoolean("deleteAfterRun"));
        String mode = alarmMode(input, previous == null ? "alarmClock" : previous.getString("alarmMode"));
        boolean enabled = previous == null || previous.getBoolean("enabled");
        JSONObject task = rule.json().put("id", id).put("title", title).put("prompt", prompt)
                .put("vibrate", vibrate).put("deleteAfterRun", deleteAfterRun).put("alarmMode", mode)
                .put("enabled", enabled).put("revision", previous == null ? 1 : previous.getInt("revision") + 1)
                .put("createdAt", previous == null ? now : previous.getLong("createdAt"))
                .put("sourceConversationId", previous == null
                        ? sourceConversationId == null || sourceConversationId.isEmpty() ? JSONObject.NULL : sourceConversationId
                        : previous.opt("sourceConversationId") == null ? JSONObject.NULL : previous.get("sourceConversationId"))
                .put("nextRunAt", enabled ? rule.nextAfter(now, ZoneId.systemDefault(), calendar) : 0);
        if (index < 0) tasks.put(task); else tasks.put(index, task);
        cancelQueued(state, id);
        write(state);
        scheduleAlarm(state);
        changed();
        return snapshot();
    }

    synchronized JSONObject setEnabled(String id, int revision, boolean enabled) throws Exception {
        JSONObject state = read();
        JSONObject task = requireTask(state.getJSONArray("tasks"), id, revision);
        ScheduleRule rule = ScheduleRule.fromJson(task);
        long now = clock.getAsLong();
        task.put("enabled", enabled).put("revision", revision + 1).put("nextRunAt", enabled
                ? rule.nextAfter(now, ZoneId.systemDefault(), calendar) : 0);
        cancelQueued(state, id);
        write(state);
        scheduleAlarm(state);
        changed();
        return snapshot();
    }

    synchronized JSONObject delete(String id, int revision) throws Exception {
        JSONObject state = read();
        JSONArray tasks = state.getJSONArray("tasks");
        requireTask(tasks, id, revision);
        tasks.remove(indexOf(tasks, id));
        cancelQueued(state, id);
        // Existing runs and their conversations belong to the user, not to the definition's lifetime.
        write(state);
        scheduleAlarm(state);
        changed();
        return snapshot();
    }

    /** Model tool actions. Partial updates merge under the task lock, then reuse save(). */
    synchronized JSONObject applyTool(JSONObject input) throws Exception { return applyTool(input, null); }

    synchronized JSONObject applyTool(JSONObject input, String sourceConversationId) throws Exception {
        if (input == null) throw new IllegalArgumentException("定时任务参数无效");
        if (input.has("sourceConversationId")) throw new IllegalArgumentException("任务来源只能由宿主绑定");
        String action = ScheduleRule.text(input, "action");
        if ("list".equals(action)) return snapshot();
        if ("create".equals(action)) {
            if (input.has("id") || input.has("revision")) throw new IllegalArgumentException("创建任务不能指定 id 或 revision");
            JSONObject created = new JSONObject(input.toString());
            created.remove("action");
            return save(created, sourceConversationId);
        }
        if ("update".equals(action)) return save(mergeUpdate(input));
        if ("delete".equals(action)) return delete(ScheduleRule.text(input, "id"), ScheduleRule.integer(input, "revision"));
        if ("setEnabled".equals(action)) {
            if (!input.has("enabled")) throw new IllegalArgumentException("必须提供 enabled");
            return setEnabled(ScheduleRule.text(input, "id"), ScheduleRule.integer(input, "revision"),
                    ScheduleRule.bool(input, "enabled", false));
        }
        throw new IllegalArgumentException("不支持的定时任务操作");
    }

    private JSONObject mergeUpdate(JSONObject input) throws Exception {
        String id = ScheduleRule.text(input, "id");
        int revision = ScheduleRule.integer(input, "revision");
        JSONObject current = requireTask(read().getJSONArray("tasks"), id, revision);
        String repeat = input.has("repeat") ? ScheduleRule.text(input, "repeat") : current.getString("repeat");
        boolean repeatChanged = !repeat.equals(current.getString("repeat"));
        JSONObject merged = new JSONObject().put("id", id).put("revision", revision)
                .put("title", input.has("title") ? ScheduleRule.text(input, "title") : current.getString("title"))
                .put("prompt", input.has("prompt") ? ScheduleRule.text(input, "prompt") : current.getString("prompt"))
                .put("repeat", repeat)
                .put("alarmMode", alarmMode(input, current.getString("alarmMode")))
                .put("time", input.has("time") ? ScheduleRule.text(input, "time") : current.getString("time"));
        if ("weekly".equals(repeat)) {
            if (input.has("weekdays")) merged.put("weekdays", input.get("weekdays"));
            else if (input.has("weekday")) merged.put("weekday", ScheduleRule.integer(input, "weekday"));
            else if (!repeatChanged && current.has("weekdays")) merged.put("weekdays", current.getJSONArray("weekdays"));
            else if (!repeatChanged) merged.put("weekday", current.getInt("weekday"));
            else throw new IllegalArgumentException("改为每周时必须提供 weekday 或 weekdays");
        }
        if ("monthly".equals(repeat)) {
            if (input.has("monthDay")) merged.put("monthDay", ScheduleRule.integer(input, "monthDay"));
            else if (!repeatChanged) merged.put("monthDay", current.getInt("monthDay"));
            else throw new IllegalArgumentException("改为每月时必须提供 monthDay");
        }
        for (String key : new String[]{"vibrate", "deleteAfterRun"})
            merged.put(key, ScheduleRule.bool(input, key, current.optBoolean(key)));
        return merged;
    }

    /** Recovery persists pending work and registers alarms, but never starts an agent or FGS. */
    synchronized void restore() throws Exception { restore(false); }

    synchronized void restore(boolean clockChanged) throws Exception {
        JSONObject state = read();
        prepareOccurrences(state, clockChanged);
        write(state);
        scheduleAlarm(state);
        changed();
    }

    private void prepareOccurrences(JSONObject state, boolean clockChanged) throws JSONException {
        recoverRuns(state);
        long now = clock.getAsLong();
        ZoneId zone = ZoneId.systemDefault();
        boolean recalculate = clockChanged || !zone.getId().equals(state.optString("timeZone", zone.getId()));
        JSONArray tasks = state.getJSONArray("tasks");
        JSONArray runs = state.getJSONArray("runs");
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            if (!"queued".equals(run.getString("status"))) continue;
            if (recalculate || !queuedDefinitionMatches(state, run))
                finishSkipped(run, "cancelled");
            else if (!withinLateness(run.getLong("scheduledAt"), now))
                finishSkipped(run, "missed");
        }
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            if (!task.getBoolean("enabled")) continue;
            ScheduleRule rule = ScheduleRule.fromJson(task);
            long due = task.getLong("nextRunAt");
            if (recalculate || due <= 0) {
                task.put("nextRunAt", rule.nextAfter(now, zone, calendar));
                continue;
            }
            if (due > now) {
                if (rule.isStatutory()) task.put("nextRunAt", rule.nextAfter(now, zone, calendar));
                continue;
            }
            if (rule.isStatutory() && calendar.isWorkday(Instant.ofEpochMilli(due).atZone(zone).toLocalDate(), zone)
                    != "statutoryWorkday".equals(rule.repeat)) {
                task.put("nextRunAt", rule.nextAfter(now, zone, calendar));
                continue;
            }
            // Automatic once-disable belongs to this occurrence, not to a user edit cancelling it.
            if ("once".equals(rule.repeat))
                task.put("enabled", false).put("nextRunAt", 0).put("revision", task.getInt("revision") + 1);
            else task.put("nextRunAt", rule.nextAfter(now, zone, calendar));
            if (!withinLateness(due, now)) addRecord(state, task, due, "skipped", "missed");
            else if (hasActiveTask(state, task.getString("id"))) addRecord(state, task, due, "skipped", "overlap");
            else {
                JSONObject run = addRecord(state, task, due, "queued", now > due ? "catch_up" : "");
                run.put("taskSnapshot", new JSONObject(task.toString())).put("nextAttemptAt", now);
            }
        }
        state.put("timeZone", zone.getId());
    }

    private static boolean withinLateness(long due, long now) {
        return now <= due + MAX_LATENESS_MS;
    }

    /** Both alarm modes claim through this lock and the same durable occurrence ledger. */
    synchronized void onAlarm() throws Exception {
        if (!exactAlarmGranted()) { restore(); return; }
        JSONObject state = read();
        prepareOccurrences(state, false);
        write(state);
        scheduleAlarm(state);
        JSONArray runs = state.getJSONArray("runs");
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            if ("queued".equals(run.getString("status")) && run.getLong("nextAttemptAt") <= clock.getAsLong())
                startQueuedRun(run.getString("id"));
        }
        changed();
    }

    private void startQueuedRun(String id) throws Exception {
        JSONObject state = read();
        JSONArray runs = state.getJSONArray("runs");
        int index = indexOf(runs, id);
        if (index < 0) return;
        JSONObject run = runs.getJSONObject(index);
        long now = clock.getAsLong();
        if (!"queued".equals(run.getString("status")) || run.getLong("nextAttemptAt") > now) return;
        JSONObject task = run.getJSONObject("taskSnapshot");
        if (!queuedDefinitionMatches(state, run)) finishSkipped(run, "cancelled");
        else if (!withinLateness(run.getLong("scheduledAt"), now)) finishSkipped(run, "missed");
        else {
            int attempt = run.getInt("attempt") + 1;
            run.put("status", "starting").put("reason", "").put("message", "")
                    .put("attempt", attempt).put("nextAttemptAt", 0)
                    .put("startedAt", now).put("finishedAt", 0).put("owner", processId)
                    .put("conversationId", UUID.randomUUID().toString()).put("requestId", JSONObject.NULL);
            write(state); // Never submit unless the starting fence has reached durable storage.
            String request = null;
            try {
                request = coordinator.sendScheduled(run.getString("conversationId"),
                        task.getString("title"), task.getString("prompt"));
                if (request == null || request.isEmpty()) throw new IllegalStateException("任务未成功发起");
            } catch (Exception failure) {
                long next = clock.getAsLong() + attempt * 60_000L;
                boolean retry = failure instanceof ChatCoordinator.ScheduledStartException
                        && attempt < 3 && withinLateness(run.getLong("scheduledAt"), next);
                run.put("status", retry ? "queued" : "error").put("reason", retry ? "startup_retry" : "")
                        .put("message", detail(failure)).put("nextAttemptAt", retry ? next : 0)
                        .put("finishedAt", retry ? 0 : clock.getAsLong());
            }
            if (request != null && !request.isEmpty())
                run.put("status", "running").put("requestId", request).put("message", "");
        }
        // A post-submission disk failure leaves starting, never a replayable queued occurrence.
        write(state);
        scheduleAlarm(state);
        if ("running".equals(run.getString("status")) && task.optBoolean("vibrate")) {
            try {
                Vibrator vibrator = context.getSystemService(Vibrator.class);
                if (vibrator != null && vibrator.hasVibrator())
                    vibrator.vibrate(VibrationEffect.createOneShot(200, VibrationEffect.DEFAULT_AMPLITUDE));
            } catch (RuntimeException failure) { Log.w("ScheduledTasks", "Unable to vibrate", failure); }
        }
    }

    private boolean recoverRuns(JSONObject state) throws JSONException {
        boolean modified = false;
        JSONArray runs = state.getJSONArray("runs");
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            String status = run.getString("status");
            if (("starting".equals(status) || "running".equals(status)) && !processId.equals(run.optString("owner"))) {
                run.put("status", "aborted").put("reason", "interrupted").put("finishedAt", clock.getAsLong())
                        .put("nextAttemptAt", 0);
                modified = true;
            }
        }
        return modified;
    }

    private static boolean activeStatus(String status) {
        return "queued".equals(status) || "starting".equals(status) || "running".equals(status);
    }

    private static boolean hasActiveTask(JSONObject state, String taskId) throws JSONException {
        JSONArray runs = state.getJSONArray("runs");
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            if (taskId.equals(run.getString("taskId")) && activeStatus(run.getString("status"))) return true;
        }
        return false;
    }

    private static boolean queuedDefinitionMatches(JSONObject state, JSONObject run) throws JSONException {
        JSONArray tasks = state.getJSONArray("tasks");
        int index = indexOf(tasks, run.getString("taskId"));
        return index >= 0 && tasks.getJSONObject(index).getInt("revision")
                == run.getJSONObject("taskSnapshot").getInt("revision");
    }

    private void cancelQueued(JSONObject state, String taskId) throws JSONException {
        JSONArray runs = state.getJSONArray("runs");
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            if (taskId.equals(run.getString("taskId")) && "queued".equals(run.getString("status")))
                finishSkipped(run, "cancelled");
        }
    }

    private void finishSkipped(JSONObject run, String reason) throws JSONException {
        run.put("status", "skipped").put("reason", reason).put("finishedAt", clock.getAsLong()).put("nextAttemptAt", 0);
    }

    private JSONObject addRecord(JSONObject state, JSONObject task, long due, String status,
            String reason) throws JSONException {
        JSONObject run = new JSONObject().put("id", UUID.randomUUID().toString())
                .put("taskId", task.getString("id")).put("title", task.getString("title"))
                .put("sourceConversationId", task.has("sourceConversationId") ? task.get("sourceConversationId") : JSONObject.NULL)
                .put("scheduledAt", due).put("startedAt", 0)
                .put("finishedAt", activeStatus(status) ? 0 : clock.getAsLong()).put("status", status)
                .put("reason", reason).put("message", "").put("owner", processId)
                .put("attempt", 0).put("nextAttemptAt", 0).put("conversationId", JSONObject.NULL);
        state.getJSONArray("runs").put(run);
        return run;
    }

    private synchronized void onChatEvent(JSONObject event) {
        String type = event.optString("type");
        if (!("end".equals(type) || "error".equals(type))) return;
        try {
            JSONObject state = read();
            JSONArray runs = state.getJSONArray("runs");
            JSONObject payload = event.optJSONObject("payload");
            if (payload == null) return;
            for (int i = 0; i < runs.length(); i++) {
                JSONObject run = runs.getJSONObject(i);
                String status = run.getString("status");
                // Synchronous failed-start events must not terminate a queued retry or its next attempt.
                if (!("starting".equals(status) || "running".equals(status))
                        || !processId.equals(run.optString("owner"))
                        || !event.optString("conversationId").equals(run.optString("conversationId"))
                        || (!run.isNull("requestId") && !run.getString("requestId").equals(event.optString("requestId"))))
                    continue;
                if ("error".equals(type)) run.put("message", payload.optString("message"));
                else {
                    String result = payload.optString("status");
                    run.put("status", "completed".equals(result) ? "completed" : "aborted".equals(result) ? "aborted" : "error")
                            .put("finishedAt", clock.getAsLong()).put("nextAttemptAt", 0);
                    JSONObject task = run.optJSONObject("taskSnapshot");
                    if ("completed".equals(result) && task != null && task.getBoolean("deleteAfterRun")) {
                        JSONArray tasks = state.getJSONArray("tasks");
                        int taskIndex = indexOf(tasks, run.getString("taskId"));
                        if (taskIndex >= 0 && tasks.getJSONObject(taskIndex).getInt("revision") == task.getInt("revision"))
                            tasks.remove(taskIndex);
                    }
                }
                write(state);
                if ("end".equals(type)) scheduleAlarm(state);
                changed();
                return;
            }
        } catch (Exception failure) { Log.e("ScheduledTasks", "Unable to save task result", failure); }
    }

    private JSONObject read() throws JSONException {
        String source = preferences.getString("state", null);
        if (source == null) return new JSONObject().put("version", 1).put("timeZone", ZoneId.systemDefault().getId())
                .put("tasks", new JSONArray()).put("runs", new JSONArray());
        JSONObject state = new JSONObject(source);
        if (state.getInt("version") != 1) throw new IllegalStateException("定时任务数据版本不受支持");
        JSONArray tasks = state.getJSONArray("tasks");
        state.getJSONArray("runs");
        boolean modified = false;
        long now = clock.getAsLong();
        ZoneId zone = ZoneId.systemDefault();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            // Legacy tasks stay exact; filled in memory so read-only queries (search) never write.
            task.put("alarmMode", alarmMode(task, "exact"));
            if (!task.has("runAt")) continue;
            // Retire the old absolute pin; keep overdue occurrences for normal missed-run recovery.
            task.remove("runAt");
            if (!task.getBoolean("enabled")) task.put("nextRunAt", 0);
            else if (task.optLong("nextRunAt") <= 0 || task.optLong("nextRunAt") > now)
                task.put("nextRunAt", ScheduleRule.fromJson(task).nextAfter(now, zone, calendar));
            modified = true;
        }
        if (modified) write(state);
        return state;
    }

    private void write(JSONObject state) throws JSONException {
        JSONArray runs = state.getJSONArray("runs");
        while (runs.length() > 100) {
            int oldestFinished = -1;
            for (int i = 0; i < runs.length(); i++) {
                if (!activeStatus(runs.getJSONObject(i).getString("status"))) { oldestFinished = i; break; }
            }
            if (oldestFinished < 0) break;
            runs.remove(oldestFinished);
        }
        if (!preferences.edit().putString("state", state.toString()).commit())
            throw new IllegalStateException("无法保存定时任务，请重试");
    }

    private void scheduleAlarm(JSONObject state) throws JSONException {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        String error = "";
        try {
            // Replace the pre-dual-mode requestCode 0 alarm on upgrade.
            alarms.cancel(alarmOperation(0));
            boolean granted = exactAlarmGranted();
            for (int modeIndex = 1; modeIndex <= 2; modeIndex++) {
                PendingIntent operation = alarmOperation(modeIndex);
                alarms.cancel(operation);
                if (!granted) continue;
                String mode = modeIndex == 1 ? "exact" : "alarmClock";
                long next = Long.MAX_VALUE;
                String taskId = null;
                JSONArray tasks = state.getJSONArray("tasks");
                for (int i = 0; i < tasks.length(); i++) {
                    JSONObject task = tasks.getJSONObject(i);
                    long due = task.getLong("nextRunAt");
                    if (task.getBoolean("enabled") && mode.equals(task.getString("alarmMode")) && due > 0 && due < next) {
                        next = due;
                        taskId = task.getString("id");
                    }
                }
                JSONArray runs = state.getJSONArray("runs");
                for (int i = 0; i < runs.length(); i++) {
                    JSONObject run = runs.getJSONObject(i);
                    if (!"queued".equals(run.getString("status"))) continue;
                    long due = run.getLong("nextAttemptAt");
                    if (mode.equals(run.getJSONObject("taskSnapshot").getString("alarmMode")) && due < next) {
                        next = due;
                        taskId = run.getString("taskId");
                    }
                }
                if (next == Long.MAX_VALUE) continue;
                if ("alarmClock".equals(mode)) {
                    PendingIntent show = PendingIntent.getActivity(context, 2,
                            new Intent(context, MainActivity.class).setAction(ACTION_RUN + ".SHOW")
                                    .putExtra(MainActivity.EXTRA_OPEN_SCHEDULE, taskId)
                                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(next, show), operation);
                } else alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, operation);
            }
        } catch (RuntimeException failure) {
            error = detail(failure);
            Log.e("ScheduledTasks", "Unable to schedule alarm", failure);
        }
        if (!error.equals(state.optString("schedulingError"))) {
            state.put("schedulingError", error);
            write(state);
        }
    }

    private PendingIntent alarmOperation(int requestCode) {
        return PendingIntent.getBroadcast(context, requestCode,
                new Intent(context, ScheduledTaskReceiver.class).setAction(ACTION_RUN),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String alarmMode(JSONObject input, String fallback) {
        String mode = input.has("alarmMode") ? ScheduleRule.text(input, "alarmMode") : fallback;
        if (!("alarmClock".equals(mode) || "exact".equals(mode)))
            throw new IllegalArgumentException("alarmMode 必须是 alarmClock 或 exact");
        return mode;
    }

    private static int indexOf(JSONArray tasks, String id) throws JSONException {
        for (int i = 0; i < tasks.length(); i++) if (id.equals(tasks.getJSONObject(i).getString("id"))) return i;
        return -1;
    }

    private static JSONObject requireTask(JSONArray tasks, String id, int revision) throws JSONException {
        int index = indexOf(tasks, id);
        if (index < 0) throw new IllegalArgumentException("此定时任务已删除");
        JSONObject task = tasks.getJSONObject(index);
        if (task.getInt("revision") != revision) throw new IllegalStateException("任务已更改，请刷新后重试");
        return task;
    }

    private static String detail(Exception failure) {
        return failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage();
    }
}
