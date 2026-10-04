package com.example.launcherprobe;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import rikka.shizuku.Shizuku;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = CapabilityReadinessTest.ShizukuState.class)
public class CapabilityReadinessTest {
    private Context context;
    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        ShizukuState.running = false; ShizukuState.granted = false; ShizukuState.denied = false;
    }
    @Test public void missingNodeExecutableNeverReportsPiInstalled() throws Exception {
        java.io.File directory = java.nio.file.Files.createTempDirectory(context.getCacheDir().toPath(), "readiness-libraries").toFile();
        assertTrue(new java.io.File(directory, "libnode.so").createNewFile());
        assertTrue(new java.io.File(directory, "liblauncher_node.so").createNewFile());
        String previous = context.getApplicationInfo().nativeLibraryDir;
        try {
            context.getApplicationInfo().nativeLibraryDir = directory.getAbsolutePath();
            assertFalse(CapabilityReadiness.runtimeLibrariesPresent(directory.getAbsolutePath()));
            assertFalse(CapabilityReadiness.device(context).getBoolean("piInstalled"));
            assertTrue(new java.io.File(directory, "libnode_launcher.so").createNewFile());
            assertTrue(CapabilityReadiness.runtimeLibrariesPresent(directory.getAbsolutePath()));
        } finally { context.getApplicationInfo().nativeLibraryDir = previous; }
    }

    @Test public void installedDoesNotImplyRunningGrantedOrTested() throws Exception {
        JSObject missing = CapabilityReadiness.device(context);
        assertFalse(missing.getBoolean("shizukuInstalled"));
        PackageInfo info = new PackageInfo(); info.packageName = "moe.shizuku.privileged.api";
        shadowOf(context.getPackageManager()).installPackage(info);
        JSObject installed = CapabilityReadiness.device(context);
        assertTrue(installed.getBoolean("shizukuInstalled"));
        assertFalse(installed.getBoolean("shizukuRunning"));
        assertEquals("unknown", installed.getString("shizukuPermission"));
        assertFalse(installed.getBoolean("showerDisplayActive"));
    }
    @Test public void deniedAndDisconnectedRemainDistinctWithoutGrantOrSystemMutation() throws Exception {
        Settings.Global.putInt(context.getContentResolver(), "force_fsg_nav_bar", 1);
        ShizukuState.running = true;
        assertEquals("notGranted", CapabilityReadiness.device(context).getString("shizukuPermission"));
        ShizukuState.denied = true;
        assertEquals("denied", CapabilityReadiness.device(context).getString("shizukuPermission"));
        ShizukuState.granted = true;
        assertEquals("granted", CapabilityReadiness.device(context).getString("shizukuPermission"));
        ShizukuState.running = false;
        JSObject disconnected = CapabilityReadiness.device(context);
        assertFalse(disconnected.getBoolean("shizukuRunning"));
        assertEquals("unknown", disconnected.getString("shizukuPermission"));
        assertFalse(disconnected.getBoolean("showerDisplayActive"));
        assertEquals(1, Settings.Global.getInt(context.getContentResolver(), "force_fsg_nav_bar"));
        java.lang.reflect.Field attempted = PiAgentBridge.class.getDeclaredField("attempted");
        attempted.setAccessible(true); assertFalse(attempted.getBoolean(null));
    }
    @Implements(value = Shizuku.class, isInAndroidSdk = false)
    public static class ShizukuState {
        static boolean running, granted, denied;
        @Implementation protected static boolean pingBinder() { return running; }
        @Implementation protected static int checkSelfPermission() { return granted ? PackageManager.PERMISSION_GRANTED : PackageManager.PERMISSION_DENIED; }
        @Implementation protected static boolean shouldShowRequestPermissionRationale() { return denied; }
        @Implementation protected static void requestPermission(int code) { throw new AssertionError("Readiness must not request permission"); }
    }
}
