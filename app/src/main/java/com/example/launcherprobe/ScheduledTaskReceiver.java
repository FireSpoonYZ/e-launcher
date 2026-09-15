package com.example.launcherprobe;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Explicit alarm and system recovery broadcasts only; no service is launched from boot. */
public final class ScheduledTaskReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        try {
            if (ScheduledTasks.ACTION_RUN.equals(action)) ScheduledTasks.get(context).onAlarm();
            else if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                    || Intent.ACTION_TIME_CHANGED.equals(action) || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                    || AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
                ScheduledTasks.get(context).restore(Intent.ACTION_TIME_CHANGED.equals(action)
                        || Intent.ACTION_TIMEZONE_CHANGED.equals(action));
            }
        } catch (Exception failure) { Log.e("ScheduledTasks", "Scheduled task delivery failed", failure); }
    }
}
