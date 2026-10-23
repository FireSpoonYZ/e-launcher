package com.example.launcherprobe;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "ScheduledTasks")
public final class ScheduledTasksPlugin extends Plugin {
    private ScheduledTasks tasks;
    private final Runnable changed = () -> notifyListeners("scheduleEvent", new JSObject(), true);
    private volatile boolean destroyed;

    @Override public void load() {
        // Host-only cold starts defer schedule restore to the first actual legacy business call.
        if (!(getActivity() instanceof MainActivity activity) || !activity.hostOnly()) tasks();
    }

    private ScheduledTasks tasks() {
        synchronized (this) {
            if (tasks == null) {
                if (destroyed) throw new IllegalStateException("定时任务页面已关闭");
                tasks = ScheduledTasks.get(getContext());
                tasks.addListener(changed);
                restore();
            }
        }
        if (getActivity() instanceof MainActivity activity) activity.resumeLegacyIfHost();
        return tasks;
    }

    @Override protected void handleOnResume() { restore(); }
    @Override protected void handleOnDestroy() {
        synchronized (this) {
            destroyed = true;
            if (tasks != null) tasks.removeListener(changed);
        }
    }

    private void restore() {
        if (tasks == null) return;
        try { tasks.restore(); }
        catch (Exception failure) { Log.e("ScheduledTasks", "Unable to restore schedules", failure); }
    }

    @PluginMethod public void snapshot(PluginCall call) {
        try {
            ScheduledTasks tasks = tasks();
            resolve(call, tasks.snapshot());
            if (tasks.hasStatutoryTasks()) tasks.refreshCalendar(null);
        }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void preview(PluginCall call) {
        try {
            ScheduledTasks tasks = tasks();
            resolve(call, tasks.preview(call.getData()));
            if ("statutoryWorkday".equals(call.getData().optString("repeat"))
                    || "statutoryHoliday".equals(call.getData().optString("repeat"))) tasks.refreshCalendar(null);
        }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void save(PluginCall call) {
        try {
            ScheduledTasks tasks = tasks();
            resolve(call, tasks.save(call.getData()));
            if ("statutoryWorkday".equals(call.getData().optString("repeat"))
                    || "statutoryHoliday".equals(call.getData().optString("repeat"))) tasks.refreshCalendar(null);
        }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void setEnabled(PluginCall call) {
        try {
            Object enabled = call.getData().opt("enabled");
            if (!(enabled instanceof Boolean)) throw new IllegalArgumentException("enabled 必须是布尔值");
            resolve(call, tasks().setEnabled(ScheduleRule.text(call.getData(), "id"),
                    ScheduleRule.integer(call.getData(), "revision"), (Boolean) enabled));
        } catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void delete(PluginCall call) {
        try { resolve(call, tasks().delete(ScheduleRule.text(call.getData(), "id"),
                ScheduleRule.integer(call.getData(), "revision"))); }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void retryScheduling(PluginCall call) {
        try { tasks().restore(); resolve(call, tasks().snapshot()); }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void requestExactAlarm(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 31 && !tasks().exactAlarmGranted()) {
                    getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                            Uri.parse("package:" + getContext().getPackageName())));
                }
                call.resolve();
            } catch (Exception failure) { reject(call, failure); }
        });
    }

    private static void resolve(PluginCall call, JSONObject result) throws org.json.JSONException {
        call.resolve(JSObject.fromJSONObject(result));
    }
    private static void reject(PluginCall call, Exception failure) { call.reject(failure.getMessage(), failure); }
}
