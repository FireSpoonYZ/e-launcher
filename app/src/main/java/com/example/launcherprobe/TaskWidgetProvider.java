package com.example.launcherprobe;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.RemoteViews;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Original task-card presentation over a private snapshot; host callbacks never initialize the engine. */
public final class TaskWidgetProvider extends AppWidgetProvider {
    private static final String ACTION_PREVIOUS = "com.example.launcherprobe.widget.PREVIOUS";
    private static final String ACTION_NEXT = "com.example.launcherprobe.widget.NEXT";
    private static final String ACTION_ARCHIVE = "com.example.launcherprobe.widget.ARCHIVE";
    private static final String ACTION_STOP = "com.example.launcherprobe.widget.STOP";
    private static final String EXTRA_TARGET = "widget_conversation";
    private static final long REFRESH_INTERVAL_MS = 1000;
    // ponytail: 100 cards, 20 nodes around the active step; page the snapshot only if these ceilings matter.
    private static final int MAX_CARDS = 100, MAX_STEPS = 20;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Map<Integer, String> rendered = new HashMap<>();
    private static long lastRefresh = -REFRESH_INTERVAL_MS;
    private static boolean scheduled;
    private static Context refreshContext;
    private static final Runnable REFRESH = TaskWidgetProvider::refresh;

    /** Merge events before reading cards; urgent transitions supersede the pending trailing refresh. */
    public static synchronized void requestRefresh(Context context, boolean immediate) {
        refreshContext = context.getApplicationContext();
        if (immediate) {
            MAIN.removeCallbacks(REFRESH);
            scheduled = true;
            MAIN.post(REFRESH);
        } else if (!scheduled) {
            scheduled = true;
            MAIN.postDelayed(REFRESH, Math.max(0, lastRefresh + REFRESH_INTERVAL_MS - SystemClock.uptimeMillis()));
        }
    }

    private static void refresh() {
        Context context;
        synchronized (TaskWidgetProvider.class) {
            context = refreshContext;
            refreshContext = null;
            scheduled = false;
            lastRefresh = SystemClock.uptimeMillis();
        }
        if (context == null) return;
        JSONArray snapshot = saveSnapshot(context, ChatCoordinator.get(context).taskCards());
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        for (int id : manager.getAppWidgetIds(new ComponentName(context, TaskWidgetProvider.class)))
            render(context, manager, id, snapshot, false);
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        JSONArray snapshot = readSnapshot(context);
        for (int id : ids) if (ownsWidget(context, manager, id)) render(context, manager, id, snapshot, true);
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        if (ownsWidget(context, manager, id)) render(context, manager, id, readSnapshot(context), true);
    }

    @Override public void onRestored(Context context, int[] oldIds, int[] newIds) {
        SharedPreferences prefs = preferences(context);
        SharedPreferences.Editor edit = prefs.edit();
        Map<Integer, String> selections = new HashMap<>();
        for (int i = 0; i < Math.min(oldIds.length, newIds.length); i++) {
            selections.put(newIds[i], prefs.getString(selectionKey(oldIds[i]), ""));
            edit.remove(selectionKey(oldIds[i]));
            rendered.remove(oldIds[i]);
        }
        for (Map.Entry<Integer, String> entry : selections.entrySet()) {
            edit.putString(selectionKey(entry.getKey()), entry.getValue());
            rendered.remove(entry.getKey());
        }
        edit.apply();
        onUpdate(context, AppWidgetManager.getInstance(context), newIds);
    }

    @Override public void onDeleted(Context context, int[] ids) {
        SharedPreferences.Editor edit = preferences(context).edit();
        for (int id : ids) {
            edit.remove(selectionKey(id));
            rendered.remove(id);
        }
        edit.apply();
    }

    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean operation = ACTION_ARCHIVE.equals(action) || ACTION_STOP.equals(action);
        if (!operation && !ACTION_PREVIOUS.equals(action) && !ACTION_NEXT.equals(action)) {
            super.onReceive(context, intent);
            return;
        }
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            if (!ownsWidget(context, manager, id)) return;
            JSONArray snapshot = readSnapshot(context);
            if (snapshot.length() == 0) return;
            int index = selectedIndex(context, id, snapshot);
            if (operation) {
                String target = intent.getStringExtra(EXTRA_TARGET);
                // A stale button must never act on whichever conversation later became selected.
                if (target == null || !validId(target)
                        || !target.equals(preferences(context).getString(selectionKey(id), ""))
                        || !target.equals(snapshot.optJSONObject(index).optString("conversationId"))) return;
                ChatCoordinator coordinator = ChatCoordinator.get(context);
                JSONObject live = coordinator.taskCard(target);
                if (live != null) {
                    if (ACTION_STOP.equals(action)) coordinator.cancel(target);
                    else if ("idle".equals(live.optString("modelState"))) coordinator.archiveConversation(target);
                }
                requestRefresh(context, true);
            } else {
                JSONObject next = snapshot.optJSONObject(Math.floorMod(index + (ACTION_NEXT.equals(action) ? 1 : -1), snapshot.length()));
                preferences(context).edit().putString(selectionKey(id), next.optString("conversationId")).apply();
                render(context, manager, id, snapshot, false);
            }
        } catch (RuntimeException exception) {
            // User operations can race deletion/storage failures; a receiver must not crash the process.
            Toast.makeText(context, R.string.task_widget_action_failed, Toast.LENGTH_LONG).show();
        }
    }

    private static boolean ownsWidget(Context context, AppWidgetManager manager, int id) {
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return false;
        for (int ownId : manager.getAppWidgetIds(new ComponentName(context, TaskWidgetProvider.class)))
            if (id == ownId) return true;
        return false;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("task_widget", Context.MODE_PRIVATE);
    }

    private static String selectionKey(int id) { return "selected:" + id; }

    private static JSONArray readSnapshot(Context context) {
        String stored = preferences(context).getString("snapshot", "[]");
        JSONArray result = new JSONArray();
        if (stored.length() > 512_000) return result;
        try {
            JSONArray values = new JSONArray(stored);
            for (int i = 0; i < Math.min(MAX_CARDS, values.length()); i++) {
                JSONObject card = values.optJSONObject(i);
                if (card != null && validId(card.optString("conversationId"))) result.put(card);
            }
        } catch (JSONException ignored) { /* An unreadable snapshot is an empty state, not a reason to start Pi. */ }
        return result;
    }

    private static boolean validId(String id) { return !id.isBlank() && id.length() <= 128; }

    private static JSONArray saveSnapshot(Context context, JSONArray cards) {
        Map<String, JSONObject> old = new HashMap<>();
        JSONArray previous = readSnapshot(context);
        for (int i = 0; i < previous.length(); i++) {
            JSONObject card = previous.optJSONObject(i);
            old.put(card.optString("conversationId"), card);
        }
        JSONArray snapshot = new JSONArray();
        Set<String> seen = new HashSet<>();
        long now = System.currentTimeMillis();
        int storedLength = 2;
        for (int i = 0; i < cards.length() && snapshot.length() < MAX_CARDS; i++) {
            JSONObject card = cards.optJSONObject(i);
            if (card == null) continue;
            String id = card.optString("conversationId");
            if (!validId(id) || !seen.add(id)) continue;
            try {
                List<JSONObject> tasks = TaskCardModel.tasks(card);
                int active = 0, completed = 0;
                for (int step = 0; step < tasks.size(); step++) {
                    String state = tasks.get(step).optString("status");
                    if ("completed".equals(state)) completed++;
                    if ("in_progress".equals(state)) active = step;
                }
                int start = Math.max(0, Math.min(active - MAX_STEPS / 2, tasks.size() - MAX_STEPS));
                JSONArray nodes = new JSONArray();
                for (int step = start; step < Math.min(tasks.size(), start + MAX_STEPS); step++) {
                    JSONObject task = tasks.get(step);
                    String state = task.optString("status");
                    nodes.put(new JSONObject().put("subject", TaskCardModel.shortText(task.optString("subject"), 64))
                            .put("status", "completed".equals(state) || "in_progress".equals(state) ? state : "pending"));
                }
                JSONObject display = new JSONObject().put("conversationId", id)
                        .put("title", TaskCardModel.shortText(card.optString("title"), 80))
                        .put("status", TaskCardModel.status(card))
                        .put("modelState", TaskCardModel.shortText(card.optString("modelState", "idle"), 16))
                        .put("runStatus", TaskCardModel.shortText(card.optString("runStatus"), 16))
                        .put("unreadResult", card.optBoolean("unreadResult"))
                        .put("taskCount", tasks.size()).put("completedCount", completed).put("tasks", nodes);
                JSONObject prior = old.get(id);
                long savedAt = now;
                if (prior != null) {
                    long priorTime = prior.optLong("savedAt", now);
                    prior.remove("savedAt");
                    if (display.toString().equals(prior.toString())) savedAt = priorTime;
                }
                display.put("savedAt", savedAt);
                storedLength += display.toString().length() + 1;
                if (storedLength > 512_000) break;
                snapshot.put(display);
            } catch (JSONException exception) { throw new IllegalStateException(exception); }
        }
        String value = snapshot.toString();
        if (!value.equals(preferences(context).getString("snapshot", "[]")))
            preferences(context).edit().putString("snapshot", value).apply();
        return snapshot;
    }

    private static int selectedIndex(Context context, int id, JSONArray snapshot) {
        String selected = preferences(context).getString(selectionKey(id), "");
        for (int i = 0; i < snapshot.length(); i++)
            if (selected.equals(snapshot.optJSONObject(i).optString("conversationId"))) return i;
        return 0;
    }

    private static void render(Context context, AppWidgetManager manager, int id, JSONArray snapshot, boolean force) {
        int index = selectedIndex(context, id, snapshot);
        JSONObject card = snapshot.optJSONObject(index);
        String conversation = card == null ? "" : card.optString("conversationId");
        SharedPreferences prefs = preferences(context);
        if (!conversation.equals(prefs.getString(selectionKey(id), "")))
            prefs.edit().putString(selectionKey(id), conversation).apply();
        Bundle options = manager.getAppWidgetOptions(id);
        int width = Math.max(1, Math.min(1200, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 350)));
        int landscapeWidth = Math.max(width, Math.min(1200, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width)));
        AppAppearance colors = AppAppearance.readTaskWidget(context);
        String signature = String.valueOf(card) + ":" + index + ":" + snapshot.length() + ":" + width + ":" + landscapeWidth + ":" + colors.dark
                + ":" + context.getResources().getConfiguration();
        if (!force && signature.equals(rendered.get(id))) return;
        RemoteViews views = cardViews(context, id, snapshot, index, card, colors, width);
        if (landscapeWidth != width)
            views = new RemoteViews(cardViews(context, id, snapshot, index, card, colors, landscapeWidth), views);
        manager.updateAppWidget(id, views);
        rendered.put(id, signature);
    }

    private static RemoteViews cardViews(Context context, int id, JSONArray snapshot, int index,
            JSONObject card, AppAppearance colors, int width) {
        String conversation = card == null ? "" : card.optString("conversationId");
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.task_widget);
        style(context, views, colors, Math.max(0, Math.min(2, snapshot.length() - 1)));
        for (int view : new int[]{R.id.task_widget_status, R.id.task_widget_position, R.id.task_widget_body, R.id.task_widget_actions})
            views.setViewVisibility(view, card == null ? View.GONE : View.VISIBLE);
        for (int view : new int[]{R.id.task_widget_empty_icon, R.id.task_widget_start})
            views.setViewVisibility(view, card == null ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.task_widget_switch, snapshot.length() > 1 ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.task_widget_position, context.getString(R.string.task_widget_position, index + 1, snapshot.length()));
        views.setOnClickPendingIntent(R.id.task_widget_folder, activity(context, id, "archived", ""));
        views.setOnClickPendingIntent(R.id.task_widget_start, activity(context, id, "new", ""));
        views.setOnClickPendingIntent(R.id.task_widget_heading, null);
        if (card != null) {
            String title = TaskCardModel.shortText(card.optString("title"), 80);
            String status = TaskCardModel.shortText(card.optString("status"), 40)
                    + (card.optBoolean("unreadResult") ? context.getString(R.string.task_widget_unread) : "");
            views.setTextViewText(R.id.task_widget_title, title);
            views.setTextViewText(R.id.task_widget_status, status);
            int count = Math.max(0, card.optInt("taskCount"));
            String countText = count == 0 ? context.getString(R.string.task_widget_detail_hint)
                    : context.getString(R.string.task_widget_count, Math.max(0, Math.min(count, card.optInt("completedCount"))), count);
            views.setTextViewText(R.id.task_widget_count, countText);
            List<JSONObject> tasks = snapshotTasks(card);
            views.setViewVisibility(R.id.task_widget_steps, tasks.isEmpty() ? View.GONE : View.VISIBLE);
            if (!tasks.isEmpty()) views.setImageViewBitmap(R.id.task_widget_steps, progressBitmap(context, colors, tasks, width - 28));
            String steps = stepDescription(tasks);
            views.setContentDescription(R.id.task_widget_steps, steps);
            long savedAt = card.optLong("savedAt");
            String updated = savedAt <= 0 ? context.getString(R.string.task_widget_snapshot_hint)
                    : context.getString(R.string.task_widget_updated,
                            DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date(savedAt)));
            views.setContentDescription(R.id.task_widget_body, title + ". "
                    + context.getString(R.string.task_widget_last_status, status) + ". " + countText + ". " + steps + ". " + updated);
            views.setContentDescription(R.id.task_widget_status, context.getString(R.string.task_widget_last_status, status) + ". " + updated);
            // Legacy six-field snapshots have no modelState: never infer a destructive action from translated text.
            String model = card.optString("modelState", "idle");
            boolean busy = !"idle".equals(model), stopping = "stopping".equals(model);
            views.setTextViewText(R.id.task_widget_archive, context.getString(stopping ? R.string.task_widget_stopping
                    : busy ? R.string.task_widget_stop : R.string.task_widget_archive));
            views.setBoolean(R.id.task_widget_archive, "setEnabled", !stopping);
            views.setOnClickPendingIntent(R.id.task_widget_archive, operation(context, id, busy ? ACTION_STOP : ACTION_ARCHIVE, conversation));
            views.setOnClickPendingIntent(R.id.task_widget_chat, activity(context, id, "chat", conversation));
            PendingIntent detail = activity(context, id, "detail", conversation);
            for (int view : new int[]{R.id.task_widget_heading, R.id.task_widget_body, R.id.task_widget_title})
                views.setOnClickPendingIntent(view, detail);
        }
        for (int button : new int[]{R.id.task_widget_previous, R.id.task_widget_next}) {
            views.setBoolean(button, "setEnabled", snapshot.length() > 1);
            views.setOnClickPendingIntent(button, switchTask(context, id, button == R.id.task_widget_previous, conversation));
        }
        return views;
    }

    private static void style(Context context, RemoteViews views, AppAppearance colors, int layers) {
        views.setViewPadding(R.id.task_widget_front, 0, 0, 0, dp(context, layers * 4));
        views.setViewVisibility(R.id.task_widget_back_one, layers > 0 ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.task_widget_back_two, layers > 1 ? View.VISIBLE : View.GONE);
        int[][] backgrounds = {
                {R.id.task_widget_panel, R.drawable.task_widget_background, R.drawable.task_widget_background_dark},
                {R.id.task_widget_back_one, R.drawable.task_widget_back, R.drawable.task_widget_back_dark},
                {R.id.task_widget_back_two, R.drawable.task_widget_back, R.drawable.task_widget_back_dark},
                {R.id.task_widget_status, R.drawable.task_widget_status, R.drawable.task_widget_status_dark},
                {R.id.task_widget_archive, R.drawable.task_widget_archive, R.drawable.task_widget_archive_dark},
                {R.id.task_widget_chat, R.drawable.task_widget_chat, R.drawable.task_widget_chat_dark},
                {R.id.task_widget_start, R.drawable.task_widget_start, R.drawable.task_widget_start_dark}};
        for (int[] background : backgrounds) views.setInt(background[0], "setBackgroundResource", background[colors.dark ? 2 : 1]);
        for (int view : new int[]{R.id.task_widget_title, R.id.task_widget_brand}) views.setTextColor(view, colors.ink);
        for (int view : new int[]{R.id.task_widget_count, R.id.task_widget_position}) views.setTextColor(view, colors.muted);
        views.setTextColor(R.id.task_widget_status, colors.accent);
        views.setTextColor(R.id.task_widget_archive, colors.error);
        views.setImageViewBitmap(R.id.task_widget_brand_icon, icon(context, "sparkles", colors.accent, 22));
        views.setImageViewBitmap(R.id.task_widget_empty_icon, icon(context, "sparkles", colors.accent, 56));
        views.setImageViewBitmap(R.id.task_widget_folder, icon(context, "folder", colors.muted, 22));
        views.setImageViewBitmap(R.id.task_widget_previous, icon(context, "up", colors.muted, 16));
        views.setImageViewBitmap(R.id.task_widget_next, icon(context, "down", colors.muted, 16));
    }

    private static Bitmap icon(Context context, String name, int color, int size) {
        int pixels = dp(context, size);
        Bitmap bitmap = Bitmap.createBitmap(pixels, pixels, Bitmap.Config.ARGB_8888);
        bitmap.setDensity(context.getResources().getDisplayMetrics().densityDpi);
        ChatIcon drawable = new ChatIcon(name, color);
        drawable.setBounds(0, 0, pixels, pixels);
        drawable.draw(new Canvas(bitmap));
        return bitmap;
    }

    private static List<JSONObject> snapshotTasks(JSONObject card) {
        List<JSONObject> tasks = new ArrayList<>();
        JSONArray nodes = card.optJSONArray("tasks");
        if (nodes != null) for (int i = 0; i < Math.min(MAX_STEPS, nodes.length()); i++) {
            JSONObject task = nodes.optJSONObject(i);
            if (task != null) tasks.add(task);
        }
        return tasks;
    }

    private static String stepDescription(List<JSONObject> tasks) {
        StringBuilder description = new StringBuilder();
        for (JSONObject task : tasks) {
            if (description.length() > 0) description.append("; ");
            description.append(TaskCardModel.shortText(task.optString("subject"), 64)).append(", ")
                    .append("completed".equals(task.optString("status")) ? "已完成"
                            : "in_progress".equals(task.optString("status")) ? "进行中" : "待开始");
        }
        return description.toString();
    }

    /** Draw the existing strip off-window: original geometry, no animator or pretend horizontal scrolling. */
    private static Bitmap progressBitmap(Context context, AppAppearance colors, List<JSONObject> tasks, int widthDp) {
        TaskProgressStrip strip = new TaskProgressStrip(context, colors, tasks, "idle");
        int width = dp(context, Math.max(1, widthDp));
        strip.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        strip.layout(0, 0, width, strip.getMeasuredHeight());
        LinearLayout track = (LinearLayout) strip.getChildAt(0);
        int active = 0;
        for (int i = 0; i < tasks.size(); i++) if ("in_progress".equals(tasks.get(i).optString("status"))) { active = i; break; }
        View node = track.getChildAt(active);
        int offset = Math.max(0, Math.min(node.getLeft() + node.getWidth() / 2 - width / 2, track.getWidth() - width));
        Bitmap bitmap = Bitmap.createBitmap(width, Math.max(1, strip.getMeasuredHeight()), Bitmap.Config.ARGB_8888);
        bitmap.setDensity(context.getResources().getDisplayMetrics().densityDpi);
        Canvas canvas = new Canvas(bitmap);
        canvas.translate(-offset, 0);
        track.draw(canvas);
        return bitmap;
    }

    private static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    private static Uri data(Context context, int id, String action, String conversation) {
        return new Uri.Builder().scheme("assistant-widget").authority(context.getPackageName())
                .appendPath(String.valueOf(id)).appendPath(action).appendPath(conversation).build();
    }

    private static PendingIntent activity(Context context, int id, String action, String conversation) {
        Intent intent;
        if ("detail".equals(action)) {
            intent = new Intent(context, TaskDetailActivity.class)
                    .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, conversation);
        } else {
            intent = new Intent(context, MainActivity.class);
            if ("chat".equals(action)) intent.putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, conversation);
            else if ("archived".equals(action)) intent.putExtra(MainActivity.EXTRA_OPEN_ARCHIVED, true);
            else intent.putExtra(MainActivity.EXTRA_NEW_CHAT, true);
        }
        intent.setData(data(context, id, action, conversation));
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent operation(Context context, int id, String action, String conversation) {
        Intent intent = new Intent(context, TaskWidgetProvider.class).setAction(action)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id).putExtra(EXTRA_TARGET, conversation)
                .setData(data(context, id, action, conversation));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent switchTask(Context context, int id, boolean previous, String conversation) {
        Intent intent = new Intent(context, TaskWidgetProvider.class).setAction(previous ? ACTION_PREVIOUS : ACTION_NEXT)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .setData(data(context, id, previous ? "previous" : "next", conversation));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
