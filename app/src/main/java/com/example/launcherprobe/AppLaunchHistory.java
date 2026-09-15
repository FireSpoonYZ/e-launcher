package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;

/** Launcher-observed successful launches only; no usage-access permission or fabricated recents. */
public final class AppLaunchHistory {
    private AppLaunchHistory() { }

    public static void record(Context context, ComponentName component) {
        if (component == null) return;
        preferences(context).edit().putLong(component.flattenToString(), System.currentTimeMillis()).apply();
    }

    public static long lastLaunch(Context context, ComponentName component) {
        return preferences(context).getLong(component.flattenToString(), 0);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("launcher_app_launches", Context.MODE_PRIVATE);
    }
}
