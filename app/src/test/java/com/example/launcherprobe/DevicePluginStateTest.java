package com.example.launcherprobe;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = DevicePluginStateTest.PluginHost.class)
public class DevicePluginStateTest {
    private DevicePlugin plugin;

    @Before public void attachPluginWithoutStartingWebViewOrPermissionServices() {
        PluginHost.activity = Robolectric.buildActivity(AppCompatActivity.class).get();
        plugin = new DevicePlugin();
    }

    @After public void releaseWorker() { plugin.handleOnDestroy(); }

    @Test public void stateExposesMigrationAndShizukuWithoutWritingSystemSettings() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        Settings.Global.putInt(context.getContentResolver(), "force_fsg_nav_bar", 1);
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, "other/service");
        shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(Manifest.permission.WRITE_SECURE_SETTINGS);
        for (boolean pending : new boolean[]{false, true}) {
            context.getSharedPreferences("gestures", 0).edit().putBoolean("pending_restore", pending).commit();
            RecordingCall call = new RecordingCall("state", new JSObject());
            plugin.state(call);
            assertNull(call.error);
            assertEquals(pending, call.result.getBoolean("legacyNavigationPending"));
            assertEquals(LegacyNavigationRecovery.status(context), call.result.getString("legacyNavigationStatus"));
            assertEquals(ShizukuRepair.statusText(), call.result.getString("shizukuStatus"));
            assertEquals("/chat", call.result.getString("launchRoute"));
            assertFalse(call.result.getBoolean("canWriteSecureSettings"));
            for (String removed : new String[]{"homeRole", "gestureStatus", "accessibilityConnected"}) assertFalse(call.result.has(removed));
            assertEquals(1, Settings.Global.getInt(context.getContentResolver(), "force_fsg_nav_bar"));
            assertEquals("other/service", Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES));
            assertEquals(pending, context.getSharedPreferences("gestures", 0).getBoolean("pending_restore", false));
        }
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.WRITE_SECURE_SETTINGS);
        RecordingCall granted = new RecordingCall("state", new JSObject());
        plugin.state(granted);
        assertTrue(granted.result.getBoolean("canWriteSecureSettings"));
    }

    @Test public void onlyAssistantAndNormalSystemSettingsTargetsAreAvailable() throws Exception {
        for (String removed : new String[]{"requestHome", "enableGestures", "disableGestures"}) {
            assertThrows(NoSuchMethodException.class, () -> DevicePlugin.class.getMethod(removed, PluginCall.class));
        }
        for (String target : new String[]{"home", "accessibility", "unknown"}) {
            RecordingCall call = new RecordingCall("openSystemSettings", new JSObject().put("target", target));
            plugin.openSystemSettings(call);
            assertNotNull(call.error);
            assertFalse(call.resolved);
            assertNull(shadowOf(PluginHost.activity).getNextStartedActivity());
        }
        String[][] targets = {{"settings", Settings.ACTION_SETTINGS}, {"app", Settings.ACTION_APPLICATION_DETAILS_SETTINGS},
                {"assistant", Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS}};
        for (String[] target : targets) {
            RecordingCall call = new RecordingCall("openSystemSettings", new JSObject().put("target", target[0]));
            plugin.openSystemSettings(call);
            assertTrue(call.resolved);
            assertNull(call.error);
            Intent intent = shadowOf(PluginHost.activity).getNextStartedActivity();
            assertEquals(target[1], intent.getAction());
            assertFalse(intent.hasCategory(Intent.CATEGORY_HOME));
        }
    }

    @Test public void closeFinishesTheActivityWithoutLaunchingHome() {
        PluginHost.activity = Robolectric.buildActivity(MainActivity.class).get();
        RecordingCall call = new RecordingCall("close", new JSObject());
        plugin.close(call);
        shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(call.resolved);
        assertTrue(PluginHost.activity.isFinishing());
        assertNull(shadowOf(PluginHost.activity).getNextStartedActivity());
    }

    @Implements(Plugin.class)
    public static class PluginHost {
        static AppCompatActivity activity;
        @Implementation protected Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Implementation protected AppCompatActivity getActivity() { return activity; }
    }

    private static class RecordingCall extends PluginCall {
        JSObject result;
        boolean resolved;
        String error;
        RecordingCall(String method, JSObject data) { super(null, "Device", "test", method, data); }
        @Override public void resolve(JSObject value) { result = value; resolved = true; }
        @Override public void resolve() { resolved = true; }
        @Override public void reject(String message, Exception exception) { error = message; }
    }
}
