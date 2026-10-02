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

import java.time.ZoneId;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArraySet;

/** Private durable definitions and receipts, driven by one native alarm for the next due time. */
final class ScheduledTasks {
    static final String ACTION_RUN = "com.example.launcherprobe.RUN_SCHEDULED_TASKS";
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
    private String schedulingError = "";

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
            JSONArray tasks = state.getJSONArray("tasks");
            long now = clock.getAsLong();
            ZoneId zone = ZoneId.systemDefault();
            for (int i = 0; i < tasks.length(); i++) {
                JSONObject task = tasks.getJSONObject(i);
                ScheduleRule rule = ScheduleRule.fromJson(task);
                if (rule.isStatutory() && task.getBoolean("enabled"))
                    task.put("nextRunAt", rule.nextAfter(now, zone, calendar));
            }
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
            history.put(run);
        }
        JSONArray tasks = state.getJSONArray("tasks");
        long now = clock.getAsLong();
        ZoneId zone = ZoneId.systemDefault();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            ScheduleRule rule = ScheduleRule.fromJson(task);
            calendar.describe(task, rule, now, rule.nextAfter(now, zone, calendar), zone);
        }
        return new JSONObject().put("tasks", tasks).put("records", history)
                .put("exactAlarmGranted", exactAlarmGranted()).put("schedulingError", schedulingError)
                .put("timeZone", ZoneId.systemDefault().getId()).put("calendarVersion", calendar.version());
    }

    synchronized JSONObject preview(JSONObject input) throws Exception {
        ZoneId zone = ZoneId.systemDefault();
        long now = clock.getAsLong();
        ScheduleRule rule = ScheduleRule.fromJson(input);
        long next = rule.nextAfter(now, zone, calendar);
        JSONObject result = new JSONObject().put("nextRunAt", next).put("timeZone", zone.getId());
        calendar.describe(result, rule, now, next, zone);
        return result;
    }

    synchronized JSONObject save(JSONObject input) throws Exception {
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
        ScheduleRule rule = ScheduleRule.fromJson(ruleInput);
        boolean vibrate = ScheduleRule.bool(input, "vibrate", previous != null && previous.optBoolean("vibrate"));
        boolean deleteAfterRun = ScheduleRule.bool(input, "deleteAfterRun", previous != null && previous.optBoolean("deleteAfterRun"));
        long now = clock.getAsLong();
        boolean enabled = previous == null || previous.getBoolean("enabled");
        JSONObject task = rule.json().put("id", id).put("title", title).put("prompt", prompt)
                .put("vibrate", vibrate).put("deleteAfterRun", deleteAfterRun)
                .put("enabled", enabled).put("revision", previous == null ? 1 : previous.getInt("revision") + 1)
                .put("createdAt", previous == null ? now : previous.getLong("createdAt"))
                .put("nextRunAt", enabled ? rule.nextAfter(now, ZoneId.systemDefault(), calendar) : 0);
        if (index < 0) tasks.put(task); else tasks.put(index, task);
        write(state);
        scheduleAlarm(state);
        changed();
        return snapshot();
    }

    synchronized JSONObject setEnabled(String id, int revision, boolean enabled) throws Exception {
        JSONObject state = read();
        JSONObject task = requireTask(state.getJSONArray("tasks"), id, revision);
        task.put("enabled", enabled).put("revision", revision + 1).put("nextRunAt", enabled
                ? ScheduleRule.fromJson(task).nextAfter(clock.getAsLong(), ZoneId.systemDefault(), calendar) : 0);
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
        // Existing runs and their conversations belong to the user, not to the definition's lifetime.
        write(state);
        scheduleAlarm(state);
        changed();
        return snapshot();
    }

    /** Model tool actions. Partial updates merge under the task lock, then reuse save(). */
    synchronized JSONObject applyTool(JSONObject input) throws Exception {
        if (input == null) throw new IllegalArgumentException("定时任务参数无效");
        String action = ScheduleRule.text(input, "action");
        if ("list".equals(action)) return snapshot();
        if ("create".equals(action)) {
            if (input.has("id") || input.has("revision")) throw new IllegalArgumentException("创建任务不能指定 id 或 revision");
            JSONObject created = new JSONObject(input.toString());
            created.remove("action");
            return save(created);
        }
        if ("update".equals(action)) return save(mergeUpdate(input));
        if ("delete".equals(action)) return delete(ScheduleRule.text(input, "id"), ScheduleRule.integer(input, "revision"));
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

    /** Boot, clock changes and foreground recovery only schedule future work; they do not start agents. */
    synchronized void restore() throws Exception { restore(false); }

    synchronized void restore(boolean clockChanged) throws Exception {
        JSONObject state = read();
        boolean modified = recoverRuns(state);
        long now = clock.getAsLong();
        ZoneId zone = ZoneId.systemDefault();
        boolean zoneChanged = !zone.getId().equals(state.optString("timeZone", zone.getId()));
        boolean recalculate = zoneChanged || clockChanged;
        JSONArray tasks = state.getJSONArray("tasks");
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            if (!task.getBoolean("enabled")) continue;
            long due = task.getLong("nextRunAt");
            if (due <= now || recalculate || ScheduleRule.fromJson(task).isStatutory()) {
                if (due > 0 && due <= now && !recalculate)
                    addRecord(state, task, due, "skipped", "missed", null);
                if ("once".equals(task.getString("repeat")) && due > 0 && due <= now && !recalculate)
                    task.put("enabled", false).put("nextRunAt", 0).put("revision", task.getInt("revision") + 1);
                else task.put("nextRunAt", ScheduleRule.fromJson(task).nextAfter(now, zone, calendar));
                modified = true;
            }
        }
        if (modified || zoneChanged) {
            state.put("timeZone", zone.getId());
            write(state);
        }
        scheduleAlarm(state);
        changed();
    }

    /** Claim every due occurrence durably before submitting any prompt; stale/duplicate alarms are harmless. */
    synchronized void onAlarm() throws Exception {
        if (!exactAlarmGranted()) { restore(); return; }
        JSONObject state = read();
        if (!ZoneId.systemDefault().getId().equals(state.optString("timeZone", ZoneId.systemDefault().getId()))) {
            restore(true);
            return;
        }
        recoverRuns(state);
        long now = clock.getAsLong();
        JSONArray tasks = state.getJSONArray("tasks");
        JSONArray pending = new JSONArray();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            long due = task.getLong("nextRunAt");
            if (!task.getBoolean("enabled") || due <= 0 || due > now) continue;
            ScheduleRule rule = ScheduleRule.fromJson(task);
            ZoneId zone = ZoneId.systemDefault();
            if (rule.isStatutory() && calendar.isWorkday(java.time.Instant.ofEpochMilli(due).atZone(zone).toLocalDate(), zone)
                    != "statutoryWorkday".equals(rule.repeat)) {
                task.put("nextRunAt", rule.nextAfter(now, zone, calendar));
                continue;
            }
            if ("once".equals(task.getString("repeat")))
                task.put("enabled", false).put("nextRunAt", 0).put("revision", task.getInt("revision") + 1);
            else task.put("nextRunAt", ScheduleRule.fromJson(task).nextAfter(now, ZoneId.systemDefault(), calendar));
            if (hasRunningTask(state, task.getString("id"))) {
                addRecord(state, task, due, "skipped", "overlap", null);
            } else {
                String conversationId = UUID.randomUUID().toString();
                JSONObject run = addRecord(state, task, due, "running", "", conversationId);
                pending.put(new JSONObject().put("task", task).put("run", run));
            }
        }
        write(state);
        scheduleAlarm(state);
        for (int i = 0; i < pending.length(); i++) {
            JSONObject item = pending.getJSONObject(i);
            JSONObject task = item.getJSONObject("task");
            JSONObject run = item.getJSONObject("run");
            String request;
            try {
                request = coordinator.sendScheduled(run.getString("conversationId"),
                        task.getString("title"), task.getString("prompt"));
                if (request == null || request.isEmpty()) throw new IllegalStateException("任务未成功发起");
            } catch (Exception failure) {
                updateRecord(run.getString("id"), "error", "", detail(failure), null);
                continue;
            }
            // Submission, not completion, is the boundary: failed starts must never delete definitions.
            updateRecord(run.getString("id"), "running", "", "", request);
            if (task.optBoolean("deleteAfterRun")) {
                JSONObject latest = read();
                JSONArray definitions = latest.getJSONArray("tasks");
                int index = indexOf(definitions, task.getString("id"));
                if (index >= 0) {
                    definitions.remove(index);
                    write(latest);
                    scheduleAlarm(latest);
                }
            }
            if (task.optBoolean("vibrate")) {
                try {
                    Vibrator vibrator = context.getSystemService(Vibrator.class);
                    if (vibrator != null && vibrator.hasVibrator())
                        vibrator.vibrate(VibrationEffect.createOneShot(200, VibrationEffect.DEFAULT_AMPLITUDE));
                } catch (RuntimeException failure) { Log.w("ScheduledTasks", "Unable to vibrate", failure); }
            }
        }
        changed();
    }

    private boolean recoverRuns(JSONObject state) throws JSONException {
        boolean modified = false;
        JSONArray runs = state.getJSONArray("runs");
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            if ("running".equals(run.getString("status")) && !processId.equals(run.optString("owner"))
                    && !coordinator.running(run.optString("conversationId"))) {
                run.put("status", "aborted").put("reason", "interrupted").put("finishedAt", clock.getAsLong());
                modified = true;
            }
        }
        return modified;
    }

    private static boolean hasRunningTask(JSONObject state, String taskId) throws JSONException {
        JSONArray runs = state.getJSONArray("runs");
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            if (taskId.equals(run.getString("taskId")) && "running".equals(run.getString("status"))) return true;
        }
        return false;
    }

    private JSONObject addRecord(JSONObject state, JSONObject task, long due, String status,
            String reason, String conversationId) throws JSONException {
        long now = clock.getAsLong();
        JSONObject run = new JSONObject().put("id", UUID.randomUUID().toString())
                .put("taskId", task.getString("id")).put("title", task.getString("title"))
                .put("scheduledAt", due).put("startedAt", "running".equals(status) ? now : 0)
                .put("finishedAt", "running".equals(status) ? 0 : now).put("status", status)
                .put("reason", reason).put("message", "").put("owner", processId)
                .put("conversationId", conversationId == null ? JSONObject.NULL : conversationId);
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
                if (!"running".equals(run.getString("status"))
                        || !event.optString("conversationId").equals(run.optString("conversationId"))) continue;
                if ("error".equals(type)) run.put("message", payload.optString("message"));
                else {
                    String status = payload.optString("status");
                    run.put("status", "completed".equals(status) ? "completed" : "aborted".equals(status) ? "aborted" : "error")
                            .put("finishedAt", clock.getAsLong());
                }
                write(state);
                changed();
                return;
            }
        } catch (Exception failure) { Log.e("ScheduledTasks", "Unable to save task result", failure); }
    }

    private void updateRecord(String id, String status, String reason, String message, String requestId) throws Exception {
        JSONObject state = read();
        JSONArray runs = state.getJSONArray("runs");
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            if (!id.equals(run.getString("id"))) continue;
            run.put("requestId", requestId == null ? JSONObject.NULL : requestId);
            if (!"running".equals(status) || "running".equals(run.getString("status")))
                run.put("status", status).put("reason", reason).put("message", message)
                        .put("finishedAt", "running".equals(status) ? 0 : clock.getAsLong());
            write(state);
            return;
        }
    }

    private JSONObject read() throws JSONException {
        String source = preferences.getString("state", null);
        if (source == null) return new JSONObject().put("version", 1).put("timeZone", ZoneId.systemDefault().getId())
                .put("tasks", new JSONArray()).put("runs", new JSONArray());
        JSONObject state = new JSONObject(source);
        if (state.getInt("version") != 1) throw new IllegalStateException("定时任务数据版本不受支持");
        state.getJSONArray("tasks");
        state.getJSONArray("runs");
        return state;
    }

    private void write(JSONObject state) throws JSONException {
        JSONArray runs = state.getJSONArray("runs");
        while (runs.length() > 100) {
            int oldestFinished = -1;
            for (int i = 0; i < runs.length(); i++) {
                if (!"running".equals(runs.getJSONObject(i).getString("status"))) { oldestFinished = i; break; }
            }
            if (oldestFinished < 0) break;
            runs.remove(oldestFinished);
        }
        if (!preferences.edit().putString("state", state.toString()).commit())
            throw new IllegalStateException("无法保存定时任务，请重试");
    }

    private void scheduleAlarm(JSONObject state) throws JSONException {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        PendingIntent operation = PendingIntent.getBroadcast(context, 0,
                new Intent(context, ScheduledTaskReceiver.class).setAction(ACTION_RUN),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        schedulingError = "";
        try {
            alarms.cancel(operation);
            if (!exactAlarmGranted()) return;
            long next = Long.MAX_VALUE;
            JSONArray tasks = state.getJSONArray("tasks");
            for (int i = 0; i < tasks.length(); i++) {
                JSONObject task = tasks.getJSONObject(i);
                if (task.getBoolean("enabled") && task.getLong("nextRunAt") > 0)
                    next = Math.min(next, task.getLong("nextRunAt"));
            }
            if (next != Long.MAX_VALUE) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, operation);
        } catch (RuntimeException failure) {
            schedulingError = detail(failure);
            Log.e("ScheduledTasks", "Unable to schedule alarm", failure);
        }
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
