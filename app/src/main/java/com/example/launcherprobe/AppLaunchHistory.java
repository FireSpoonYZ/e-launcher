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

    /** Removing an entry only forgets this launcher's own record of the launch. */
    static void forget(Context context, ComponentName component) {
        preferences(context).edit().remove(component.flattenToString()).apply();
    }

    static void clear(Context context) {
        preferences(context).edit().clear().apply();
    }

    public static long lastLaunch(Context context, ComponentName component) {
        return preferences(context).getLong(component.flattenToString(), 0);
    }

    /** A snapshot of launchable, personally used apps, never a system task list. */
    static java.util.List<android.content.pm.ResolveInfo> recent(Context context) {
        java.util.Map<String, ?> history = preferences(context).getAll();
        java.util.List<android.content.pm.ResolveInfo> apps = DeviceActions.apps(context);
        apps.removeIf(app -> app.activityInfo.packageName.equals(context.getPackageName())
                || !(history.get(key(app)) instanceof Long time) || time <= 0);
        apps.sort(java.util.Comparator.comparingLong(
                (android.content.pm.ResolveInfo app) -> (Long) history.get(key(app))).reversed());
        return apps;
    }

    private static String key(android.content.pm.ResolveInfo app) {
        return new ComponentName(app.activityInfo.packageName, app.activityInfo.name).flattenToString();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("launcher_app_launches", Context.MODE_PRIVATE);
    }
}
