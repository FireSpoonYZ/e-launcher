package com.example.launcherprobe;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import okhttp3.OkHttpClient;
import okhttp3.Request;

/** One bounded background attempt per day; the receiver can own its completion via goAsync(). */
final class ScheduleCalendarRefresh {
    private static final long DAY = TimeUnit.DAYS.toMillis(1);
    private final Context context;
    private final SharedPreferences preferences;
    private final Executor worker = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "schedule-calendar");
        thread.setDaemon(true);
        return thread;
    });
    // Two sequential requests have at most 5s of HTTP budget, below the receiver's 10s budget.
    private final OkHttpClient http = SettingsCatalog.HTTP.newBuilder()
            .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS)
            .callTimeout(2500, TimeUnit.MILLISECONDS).build();
    private final List<Runnable> completions = new ArrayList<>();
    private boolean inFlight;
    private ScheduleCalendar calendar;

    ScheduleCalendarRefresh(Context context, ScheduleCalendar calendar) {
        this.context = context;
        this.calendar = calendar;
        preferences = context.getSharedPreferences("schedule_calendar", Context.MODE_PRIVATE);
    }

    static String url(int year) {
        return "https://api.github.com/repos/NateScarlet/holiday-cn/contents/" + year + ".json?ref=master";
    }

    void request(long now, ZoneId zone, Consumer<ScheduleCalendar> updated, Runnable finished) {
        synchronized (this) {
            if (inFlight) {
                if (finished != null) completions.add(finished);
                return;
            }
            long last = preferences.getLong("lastAttempt", 0);
            if (!ScheduleCalendar.supports(zone) || (last > 0 && now >= last && now - last < DAY)) {
                if (finished != null) finished.run();
                return;
            }
            inFlight = true;
            if (finished != null) completions.add(finished);
            preferences.edit().putLong("lastAttempt", now).commit();
        }
        try {
            worker.execute(() -> {
                try {
                    int year = Instant.ofEpochMilli(now).atZone(zone).getYear();
                    boolean changed = false;
                    for (int current = year; current <= year + 1; current++) {
                        try {
                            JSONObject response = SettingsCatalog.read(http.newCall(new Request.Builder()
                                    .url(url(current)).header("Accept", "application/vnd.github+json").build()), false);
                            JSONObject entry = downloadedYear(response, current, now);
                            ScheduleCalendar candidate = calendar.withYear(entry);
                            PiConfigStore.write(new File(context.getFilesDir(), "schedule-calendar/" + current + ".json"),
                                    entry.toString());
                            changed |= !candidate.version().equals(calendar.version());
                            calendar = candidate;
                        } catch (Exception failure) {
                            Log.w("ScheduledTasks", "Holiday refresh unavailable for " + current + "; keeping last valid data", failure);
                        }
                    }
                    if (changed) updated.accept(calendar);
                } catch (Exception failure) {
                    Log.e("ScheduledTasks", "Unable to apply holiday refresh", failure);
                } finally { finish(); }
            });
        } catch (RuntimeException failure) {
            Log.e("ScheduledTasks", "Unable to start holiday refresh", failure);
            finish();
        }
    }

    static JSONObject downloadedYear(JSONObject response, int year, long now) throws Exception {
        if (!"file".equals(response.optString("type")) || !(year + ".json").equals(response.optString("path"))
                || !"base64".equals(response.optString("encoding")))
            throw new IllegalArgumentException("Invalid annual calendar response");
        String sha = ScheduleRule.text(response, "sha");
        if (!sha.matches("[a-f0-9]{40}")) throw new IllegalArgumentException("Invalid calendar blob SHA");
        String content = ScheduleRule.text(response, "content").replaceAll("\\s", "");
        JSONObject entry = new JSONObject(new String(java.util.Base64.getDecoder().decode(content), StandardCharsets.UTF_8));
        if (ScheduleRule.integer(entry, "year") != year) throw new IllegalArgumentException("Calendar year mismatch");
        entry.remove("sourceCommit"); // GitHub contents SHA identifies a blob, never a commit.
        entry.put("sourceUrl", url(year)).put("sourceBlobSha", sha).put("fetchedAt", now);
        ScheduleCalendar.EMPTY.withYear(entry); // Same date/coverage/boolean validation as assets and cache.
        return entry;
    }

    private void finish() {
        List<Runnable> pending;
        synchronized (this) {
            inFlight = false;
            pending = new ArrayList<>(completions);
            completions.clear();
        }
        for (Runnable completion : pending) {
            try { completion.run(); }
            catch (RuntimeException failure) { Log.e("ScheduledTasks", "Calendar completion failed", failure); }
        }
    }
}
