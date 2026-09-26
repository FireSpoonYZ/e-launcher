package com.example.launcherprobe;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;

/** Retires the old navigation takeover; never enables gestures or accessibility services. */
final class LegacyNavigationRecovery {
    private static final String PREFS = "gestures";
    private static final String PENDING = "pending_restore";
    private static final String NAVIGATION = "force_fsg_nav_bar";
    private static String failure = "";

    private LegacyNavigationRecovery() { }

    static synchronized boolean pending(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PENDING, false);
    }

    static synchronized String status(Context context) {
        if (!pending(context)) return "没有待恢复的旧导航接管";
        return failure.isEmpty() ? "旧导航接管尚待恢复；恢复系统三键后才会清除标记" : failure;
    }

    static synchronized void recover(Context context) {
        if (!pending(context)) return;
        if (context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
                != PackageManager.PERMISSION_GRANTED) {
            failure = "旧导航恢复需要写设置权限；请使用 Shizuku 显式重试或按 ADB 说明恢复";
            return;
        }
        try {
            // The old stop() contract restored three-button navigation to 0; it saved no prior value.
            if (!Settings.Global.putInt(context.getContentResolver(), NAVIGATION, 0)) {
                failure = "系统拒绝恢复三键；保留恢复标记，请重试";
                return;
            }
            if (Settings.Global.getInt(context.getContentResolver(), NAVIGATION, -1) != 0) {
                failure = "系统导航读回校验失败；保留恢复标记，请重试";
                return;
            }
        } catch (RuntimeException exception) {
            failure = "恢复系统导航失败；保留恢复标记：" + exception.getClass().getSimpleName();
            return;
        }
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!preferences.edit().putBoolean(PENDING, false).commit()) {
            // A failed commit can still change SharedPreferences' in-memory map. Keep retries enabled.
            preferences.edit().putBoolean(PENDING, true).commit();
            failure = "三键已恢复，但恢复标记保存失败；保留恢复责任，请重试";
            return;
        }
        failure = "";
    }
}
