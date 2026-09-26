package com.example.launcherprobe;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** A text-only, persisted task projection. Host callbacks never initialize the task engine. */
public final class TaskWidgetProvider extends AppWidgetProvider {
    private static final String ACTION_PREVIOUS = "com.example.launcherprobe.widget.PREVIOUS";
    private static final String ACTION_NEXT = "com.example.launcherprobe.widget.NEXT";
    private static final long REFRESH_INTERVAL_MS = 1000;
    // ponytail: retain at most 100 display cards; use a paged snapshot only if this ceiling matters.
    private static final int MAX_CARDS = 100;
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
        if (!ACTION_PREVIOUS.equals(action) && !ACTION_NEXT.equals(action)) {
            super.onReceive(context, intent);
            return;
        }
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (!ownsWidget(context, manager, id)) return;
        JSONArray snapshot = readSnapshot(context);
        if (snapshot.length() == 0) return;
        int index = selectedIndex(context, id, snapshot);
        JSONObject next = snapshot.optJSONObject(Math.floorMod(index + (ACTION_NEXT.equals(action) ? 1 : -1), snapshot.length()));
        preferences(context).edit().putString(selectionKey(id), next.optString("conversationId")).apply();
        render(context, manager, id, snapshot, false);
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
        for (int i = 0; i < cards.length() && snapshot.length() < MAX_CARDS; i++) {
            JSONObject card = cards.optJSONObject(i);
            if (card == null) continue;
            String id = card.optString("conversationId");
            if (!validId(id) || !seen.add(id)) continue;
            String result = "error".equals(card.optString("runStatus")) && !card.optString("error").isEmpty()
                    ? card.optString("error") : card.optString("result");
            try {
                JSONObject display = new JSONObject().put("conversationId", id)
                        .put("title", TaskCardModel.shortText(card.optString("title"), 80))
                        .put("status", TaskCardModel.status(card))
                        .put("step", TaskCardModel.currentStep(card))
                        .put("result", TaskCardModel.shortText(result, 240));
                JSONObject prior = old.get(id);
                long savedAt = now;
                if (prior != null) {
                    long priorTime = prior.optLong("savedAt", now);
                    prior.remove("savedAt");
                    if (display.toString().equals(prior.toString())) savedAt = priorTime;
                }
                snapshot.put(display.put("savedAt", savedAt));
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
        int height = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT);
        boolean compact = height > 0 && height < 220;
        String signature = String.valueOf(card) + ":" + index + ":" + snapshot.length() + ":" + compact;
        if (!force && signature.equals(rendered.get(id))) return;
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.task_widget);
        String title = card == null ? "" : card.optString("title");
        views.setTextViewText(R.id.task_widget_title, title.isEmpty() ? context.getString(R.string.task_widget_name) : title);
        String status = card == null ? context.getString(R.string.task_widget_empty)
                : context.getString(R.string.task_widget_last_status, card.optString("status"));
        views.setTextViewText(R.id.task_widget_status, status);
        String step = card == null ? "" : card.optString("step");
        String stepText = card == null ? context.getString(R.string.task_widget_empty_hint)
                : step.isEmpty() ? context.getString(R.string.task_widget_detail_hint) : context.getString(R.string.task_widget_step, step);
        views.setTextViewText(R.id.task_widget_step, stepText);
        String result = card == null ? "" : card.optString("result");
        views.setTextViewText(R.id.task_widget_result, result);
        views.setViewVisibility(R.id.task_widget_result, result.isEmpty() ? View.GONE : View.VISIBLE);
        views.setInt(R.id.task_widget_result, "setMaxLines", compact ? 1 : 3);
        views.setInt(R.id.task_widget_step, "setMaxLines", compact ? 1 : 2);
        long savedAt = card == null ? 0 : card.optLong("savedAt");
        String updated = savedAt <= 0 ? context.getString(R.string.task_widget_snapshot_hint)
                : context.getString(R.string.task_widget_updated,
                        DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date(savedAt)));
        views.setTextViewText(R.id.task_widget_updated, updated);
        views.setContentDescription(R.id.task_widget_body, title + ". " + status + ". " + stepText + ". " + result + ". " + updated);
        views.setTextViewText(R.id.task_widget_position, card == null ? "" : (index + 1) + "/" + snapshot.length());
        PendingIntent detail = activity(context, id, card == null ? "new" : "detail", conversation);
        views.setOnClickPendingIntent(R.id.task_widget_root, detail);
        views.setOnClickPendingIntent(R.id.task_widget_body, detail);
        views.setOnClickPendingIntent(R.id.task_widget_title, detail);
        views.setOnClickPendingIntent(R.id.task_widget_new_chat, activity(context, id, "new", conversation));
        views.setOnClickPendingIntent(R.id.task_widget_voice, activity(context, id, "voice", conversation));
        for (int button : new int[]{R.id.task_widget_previous, R.id.task_widget_next}) {
            boolean previous = button == R.id.task_widget_previous;
            views.setBoolean(button, "setEnabled", snapshot.length() > 1);
            views.setOnClickPendingIntent(button, switchTask(context, id, previous, conversation));
        }
        manager.updateAppWidget(id, views);
        rendered.put(id, signature);
    }

    private static Uri data(Context context, int id, String action, String conversation) {
        return new Uri.Builder().scheme("assistant-widget").authority(context.getPackageName())
                .appendPath(String.valueOf(id)).appendPath(action).appendPath(conversation).build();
    }

    private static PendingIntent activity(Context context, int id, String action, String conversation) {
        Intent intent;
        if ("detail".equals(action)) {
            intent = new Intent(context, TaskDetailActivity.class)
                    .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, conversation);
        } else if ("voice".equals(action)) {
            intent = new Intent(context, VoiceSessionActivity.class)
                    .putExtra(LauncherVoiceInteractionService.EXTRA_WAKE, false);
            if (!conversation.isEmpty()) intent.putExtra(VoiceSessionActivity.EXTRA_CONVERSATION_ID, conversation);
        } else {
            intent = new Intent(context, MainActivity.class).putExtra(MainActivity.EXTRA_NEW_CHAT, true);
        }
        intent.setData(data(context, id, action, conversation));
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent switchTask(Context context, int id, boolean previous, String conversation) {
        Intent intent = new Intent(context, TaskWidgetProvider.class).setAction(previous ? ACTION_PREVIOUS : ACTION_NEXT)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .setData(data(context, id, previous ? "previous" : "next", conversation));
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
