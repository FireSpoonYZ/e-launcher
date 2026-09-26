package com.example.launcherprobe;

import android.Manifest;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;

import java.util.Objects;

/** Exercises the one-time navigation recovery against real settings, restoring the fixture afterward. */
final class AssistantMigrationChecks {
    static String run(Instrumentation test) {
        Context context = test.getTargetContext();
        require(context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
                == PackageManager.PERMISSION_GRANTED, "Grant WRITE_SECURE_SETTINGS before this device check");
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        require(context.getPackageManager().queryIntentActivities(home, PackageManager.MATCH_DEFAULT_ONLY).stream()
                .noneMatch(item -> context.getPackageName().equals(item.activityInfo.packageName)),
                "assistant does not advertise HOME");
        SharedPreferences gestures = context.getSharedPreferences("gestures", Context.MODE_PRIVATE);
        boolean hadMarker = gestures.contains("pending_restore");
        boolean previousMarker = gestures.getBoolean("pending_restore", false);
        String previousNavigation = Settings.Global.getString(context.getContentResolver(), "force_fsg_nav_bar");
        String previousServices = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        try {
            require(gestures.edit().remove("pending_restore").commit(), "clear fixture marker");
            require(Settings.Global.putInt(context.getContentResolver(), "force_fsg_nav_bar", 1), "seed navigation fixture");
            LegacyNavigationRecovery.recover(context);
            require(Settings.Global.getInt(context.getContentResolver(), "force_fsg_nav_bar", -1) == 1,
                    "without an ownership marker, recovery leaves navigation untouched");
            require(gestures.edit().putBoolean("pending_restore", true).commit(), "seed owned recovery marker");
            LegacyNavigationRecovery.recover(context);
            require(Settings.Global.getInt(context.getContentResolver(), "force_fsg_nav_bar", -1) == 0,
                    "owned navigation is restored and read back");
            require(!LegacyNavigationRecovery.pending(context), "successful restoration clears responsibility");
            require(Settings.Global.putInt(context.getContentResolver(), "force_fsg_nav_bar", 1), "seed user's later navigation choice");
            LegacyNavigationRecovery.recover(context);
            require(Settings.Global.getInt(context.getContentResolver(), "force_fsg_nav_bar", -1) == 1,
                    "completed migration never overrides a later user choice");
            require(Objects.equals(previousServices, Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)), "other accessibility services remain unchanged");
            return "PASS: no HOME registration; real navigation settings stay unchanged without ownership, restore with ownership, and stay unchanged afterward; accessibility service list untouched";
        } finally {
            require(Settings.Global.putString(context.getContentResolver(), "force_fsg_nav_bar", previousNavigation),
                    "restore original navigation fixture");
            SharedPreferences.Editor restore = gestures.edit();
            if (hadMarker) restore.putBoolean("pending_restore", previousMarker);
            else restore.remove("pending_restore");
            require(restore.commit(), "restore original recovery marker");
        }
    }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
}
