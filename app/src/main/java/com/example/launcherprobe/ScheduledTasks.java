package com.example.launcherprobe;

import android.app.AlarmManager;
import android.app.Application;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
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
    private final ChatCoordinator coordinator;
    private final Set<Runnable> listeners = new CopyOnWriteArraySet<>();
    private final String processId = UUID.randomUUID().toString();
    private String schedulingError = "";

    private ScheduledTasks(Application context) {
        this.context = context;
        preferences = context.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE);
        coordinator = ChatCoordinator.get(context);
        coordinator.addListener((messages, event) -> onChatEvent(event));
    }

    void addListener(Runnable listener) { listeners.add(listener); }
    void removeListener(Runnable listener) { listeners.remove(listener); }
    private void changed() { for (Runnable listener : listeners) listener.run(); }

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
        return new JSONObject().put("tasks", state.getJSONArray("tasks")).put("records", history)
                .put("exactAlarmGranted", exactAlarmGranted()).put("schedulingError", schedulingError)
                .put("timeZone", ZoneId.systemDefault().getId());
    }

    static JSONObject preview(JSONObject input) throws Exception {
        ZoneId zone = ZoneId.systemDefault();
        return new JSONObject().put("nextRunAt", ScheduleRule.fromJson(input)
                .nextAfter(System.currentTimeMillis(), zone)).put("timeZone", zone.getId());
    }

    synchronized JSONObject save(JSONObject input) throws Exception {
        ScheduleRule rule = ScheduleRule.fromJson(input);
        String title = ScheduleRule.text(input, "title").trim();
        String prompt = ScheduleRule.text(input, "prompt").trim();
        if (title.isEmpty() || title.length() > 80) throw new IllegalArgumentException("任务名称需为 1–80 个字符");
        if (prompt.isEmpty() || prompt.length() > 8000) throw new IllegalArgumentException("任务内容需为 1–8000 个字符");
        JSONObject state = read();
        JSONArray tasks = state.getJSONArray("tasks");
        String id = input.has("id") ? ScheduleRule.text(input, "id") : UUID.randomUUID().toString();
        int index = indexOf(tasks, id);
        JSONObject previous = input.has("id") ? requireTask(tasks, id, ScheduleRule.integer(input, "revision")) : null;
        long now = System.currentTimeMillis();
        boolean enabled = previous == null || previous.getBoolean("enabled");
        JSONObject task = rule.json().put("id", id).put("title", title).put("prompt", prompt)
                .put("enabled", enabled).put("revision", previous == null ? 1 : previous.getInt("revision") + 1)
                .put("createdAt", previous == null ? now : previous.getLong("createdAt"))
                .put("nextRunAt", enabled ? rule.nextAfter(now, ZoneId.systemDefault()) : 0);
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
                ? ScheduleRule.fromJson(task).nextAfter(System.currentTimeMillis(), ZoneId.systemDefault()) : 0);
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
            if (input.has("weekday")) merged.put("weekday", ScheduleRule.integer(input, "weekday"));
            else if (!repeatChanged) merged.put("weekday", current.getInt("weekday"));
            else throw new IllegalArgumentException("改为每周时必须提供 weekday");
        }
        if ("monthly".equals(repeat)) {
            if (input.has("monthDay")) merged.put("monthDay", ScheduleRule.integer(input, "monthDay"));
            else if (!repeatChanged) merged.put("monthDay", current.getInt("monthDay"));
            else throw new IllegalArgumentException("改为每月时必须提供 monthDay");
        }
        return merged;
    }

    /** Boot, clock changes and foreground recovery only schedule future work; they do not start agents. */
    synchronized void restore() throws Exception { restore(false); }

    synchronized void restore(boolean clockChanged) throws Exception {
        JSONObject state = read();
        boolean modified = recoverRuns(state);
        long now = System.currentTimeMillis();
        ZoneId zone = ZoneId.systemDefault();
        boolean zoneChanged = !zone.getId().equals(state.optString("timeZone", zone.getId()));
        boolean recalculate = zoneChanged || clockChanged;
        JSONArray tasks = state.getJSONArray("tasks");
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            if (!task.getBoolean("enabled")) continue;
            long due = task.getLong("nextRunAt");
            if (due <= now || recalculate) {
                if (due > 0 && due <= now && !recalculate)
                    addRecord(state, task, due, "skipped", "missed", null);
                task.put("nextRunAt", ScheduleRule.fromJson(task).nextAfter(now, zone));
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
        recoverRuns(state);
        long now = System.currentTimeMillis();
        JSONArray tasks = state.getJSONArray("tasks");
        JSONArray pending = new JSONArray();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            long due = task.getLong("nextRunAt");
            if (!task.getBoolean("enabled") || due <= 0 || due > now) continue;
            task.put("nextRunAt", ScheduleRule.fromJson(task).nextAfter(now, ZoneId.systemDefault()));
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
            try {
                String request = coordinator.sendScheduled(run.getString("conversationId"),
                        task.getString("title"), task.getString("prompt"));
                updateRecord(run.getString("id"), "running", "", "", request);
            } catch (Exception failure) {
                updateRecord(run.getString("id"), "error", "", detail(failure), null);
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
                run.put("status", "aborted").put("reason", "interrupted").put("finishedAt", System.currentTimeMillis());
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
        long now = System.currentTimeMillis();
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
                            .put("finishedAt", System.currentTimeMillis());
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
            run.put("status", status).put("reason", reason).put("message", message)
                    .put("requestId", requestId == null ? JSONObject.NULL : requestId)
                    .put("finishedAt", "running".equals(status) ? 0 : System.currentTimeMillis());
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
