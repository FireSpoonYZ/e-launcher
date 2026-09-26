package com.example.launcherprobe;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.ServiceConnection;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.IBinder;
import android.provider.Settings;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowBinder;
import org.robolectric.util.ReflectionHelpers;
import rikka.shizuku.Shizuku;
import static org.junit.Assert.*;

/** The filename is retained while the old HOME tests become assistant/Shower permission boundaries. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE, shadows = ShizukuHomeTest.ShizukuState.class)
public class ShizukuHomeTest {
    private Context context;

    @Before public void prepare() {
        context = new ContextWrapper(RuntimeEnvironment.getApplication()) {
            @Override public Context getApplicationContext() { return this; }
            @Override public int checkSelfPermission(String permission) {
                if (Manifest.permission.WRITE_SECURE_SETTINGS.equals(permission)) return PackageManager.PERMISSION_DENIED;
                return super.checkSelfPermission(permission);
            }
        };
        context.getSharedPreferences("gestures", Context.MODE_PRIVATE).edit().clear().commit();
        ShizukuState.running = true;
        ShizukuState.authorized = false;
        ShizukuState.requests = 0;
        ShizukuState.binds = 0;
    }

    @Test public void privilegedOperationsRejectAnotherAppBeforeCommandsOrTokenValidation() {
        ShadowBinder.setCallingUid(12345);
        Context other = new ContextWrapper(context) {
            @Override public ApplicationInfo getApplicationInfo() {
                ApplicationInfo info = new ApplicationInfo(super.getApplicationInfo());
                info.uid = Binder.getCallingUid() + 1;
                return info;
            }
        };
        OwnPermissionService service = new OwnPermissionService(other);
        assertThrows(SecurityException.class, service::grantOwnWriteSecureSettings);
        assertThrows(SecurityException.class, service::setOwnDefaultAssistant);
        assertThrows(SecurityException.class, () -> service.startShowerServer(null));
        assertThrows(SecurityException.class, service::stopShowerServer);
        assertThrows(SecurityException.class, service::destroy);
    }

    @Test public void retainedBinderMethodsKeepTheirTransactionIdsAndHomeIsAbsent() throws Exception {
        String[] methods = {"grantOwnWriteSecureSettings", "startShowerServer", "stopShowerServer",
                "setOwnDefaultAssistant", "destroy"};
        int[] ids = {1, 3, 4, 5, 16777114};
        for (int i = 0; i < methods.length; i++) {
            assertEquals(IBinder.FIRST_CALL_TRANSACTION + ids[i], (int) ReflectionHelpers.getStaticField(
                    IOwnPermissionService.Stub.class, "TRANSACTION_" + methods[i]));
        }
        assertThrows(NoSuchMethodException.class, () -> IOwnPermissionService.class.getMethod("setOwnDefaultHome"));
        OwnPermissionService service = new OwnPermissionService(new ContextWrapper(context) {
            @Override public ApplicationInfo getApplicationInfo() {
                ApplicationInfo info = new ApplicationInfo(super.getApplicationInfo());
                info.uid = Binder.getCallingUid();
                return info;
            }
        });
        assertEquals("Invalid Shower handoff token", service.startShowerServer("not-a-token"));
    }

    @Test public void resumeNeverRequestsShizukuPermissionOrBindsForAutomaticGrant() {
        context.getSharedPreferences("gestures", Context.MODE_PRIVATE).edit().putBoolean("pending_restore", true).commit();
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, "other/.Service");
        Settings.Secure.putInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 0);
        ShizukuRepair repair = new ShizukuRepair(context, () -> { });
        try {
            repair.resume();
            ShizukuState.authorized = true;
            repair.resume();
            assertEquals(0, ShizukuState.requests);
            assertEquals(0, ShizukuState.binds);
            assertTrue(LegacyNavigationRecovery.pending(context));
            assertEquals("other/.Service", Settings.Secure.getString(
                    context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES));
            assertEquals(0, Settings.Secure.getInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, -1));
        } finally { repair.destroy(); }
    }

    @Test public void explicitShizukuCheckWithoutMigrationDoesNotGrantWritePermission() {
        ShizukuRepair repair = new ShizukuRepair(context, () -> { });
        try {
            repair.repairFromButton();
            assertEquals(1, ShizukuState.requests);
            ShizukuState.authorized = true;
            repair.resume();
            repair.repairFromButton();
            assertEquals(0, ShizukuState.binds);
            assertTrue(ShizukuRepair.statusText().contains("Shower"));
        } finally { repair.destroy(); }
    }

    @Test public void explicitMarkedRecoveryAndAssistantRequestCanBind() {
        ShizukuState.authorized = true;
        context.getSharedPreferences("gestures", Context.MODE_PRIVATE).edit().putBoolean("pending_restore", true).commit();
        ShizukuRepair repair = new ShizukuRepair(context, () -> { });
        try {
            repair.repairFromButton();
            assertEquals(1, ShizukuState.binds);
            assertEquals("NAVIGATION", ReflectionHelpers.getField(repair, "requested").toString());
            repair.pause();
            repair.requestAssistantFromButton();
            assertEquals(2, ShizukuState.binds);
            assertEquals("ASSISTANT", ReflectionHelpers.getField(repair, "requested").toString());
        } finally { repair.destroy(); }
    }

    @Test public void unavailableShizukuDoesNotQueueAssistantChangeAndIntentionalDisconnectKeepsStatus() {
        ShizukuState.running = false;
        ShizukuRepair repair = new ShizukuRepair(context, () -> { });
        try {
            repair.requestAssistantFromButton();
            assertTrue(ShizukuRepair.statusText().contains("未运行"));
            assertNull(ReflectionHelpers.getField(repair, "requested"));
            repair.resume();
            assertNull(ReflectionHelpers.getField(repair, "requested"));
            ReflectionHelpers.callInstanceMethod(repair, "setStatus",
                    ReflectionHelpers.ClassParameter.from(String.class, "助手设置已完成"));
            ServiceConnection connection = ReflectionHelpers.getField(repair, "connection");
            connection.onServiceDisconnected(new ComponentName(context, OwnPermissionService.class));
            assertEquals("助手设置已完成", ShizukuRepair.statusText());
        } finally { repair.destroy(); }
    }

    @Implements(value = Shizuku.class, isInAndroidSdk = false)
    public static class ShizukuState {
        static boolean running, authorized;
        static int requests, binds;
        @Implementation public static boolean pingBinder() { return running; }
        @Implementation public static int checkSelfPermission() {
            return authorized ? PackageManager.PERMISSION_GRANTED : PackageManager.PERMISSION_DENIED;
        }
        @Implementation public static boolean shouldShowRequestPermissionRationale() { return false; }
        @Implementation public static void requestPermission(int code) { requests++; }
        @Implementation public static void bindUserService(Shizuku.UserServiceArgs args, ServiceConnection connection) { binds++; }
        @Implementation public static void unbindUserService(Shizuku.UserServiceArgs args, ServiceConnection connection,
                boolean remove) { }
    }
}
