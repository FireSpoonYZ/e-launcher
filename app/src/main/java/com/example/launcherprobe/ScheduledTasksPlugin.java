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

    @Override public void load() {
        tasks = ScheduledTasks.get(getContext());
        tasks.addListener(changed);
        restore();
    }

    @Override protected void handleOnResume() { restore(); }
    @Override protected void handleOnDestroy() { if (tasks != null) tasks.removeListener(changed); }

    private void restore() {
        if (tasks == null) return;
        try { tasks.restore(); }
        catch (Exception failure) { Log.e("ScheduledTasks", "Unable to restore schedules", failure); }
    }

    @PluginMethod public void snapshot(PluginCall call) {
        try { resolve(call, tasks.snapshot()); }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void preview(PluginCall call) {
        try { resolve(call, ScheduledTasks.preview(call.getData())); }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void save(PluginCall call) {
        try { resolve(call, tasks.save(call.getData())); }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void setEnabled(PluginCall call) {
        try {
            Object enabled = call.getData().opt("enabled");
            if (!(enabled instanceof Boolean)) throw new IllegalArgumentException("enabled 必须是布尔值");
            resolve(call, tasks.setEnabled(ScheduleRule.text(call.getData(), "id"),
                    ScheduleRule.integer(call.getData(), "revision"), (Boolean) enabled));
        } catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void delete(PluginCall call) {
        try { resolve(call, tasks.delete(ScheduleRule.text(call.getData(), "id"),
                ScheduleRule.integer(call.getData(), "revision"))); }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void retryScheduling(PluginCall call) {
        try { tasks.restore(); resolve(call, tasks.snapshot()); }
        catch (Exception failure) { reject(call, failure); }
    }

    @PluginMethod public void requestExactAlarm(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 31 && !tasks.exactAlarmGranted()) {
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
