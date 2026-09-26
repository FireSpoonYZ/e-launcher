package com.example.launcherprobe;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE, shadows = LegacyNavigationRecoveryTest.NavigationSettings.class)
public class LegacyNavigationRecoveryTest {
    private Context context;
    private SharedPreferences preferences;
    private boolean permitted;

    @Before public void prepare() {
        Context app = RuntimeEnvironment.getApplication();
        context = new ContextWrapper(app) {
            @Override public int checkSelfPermission(String permission) {
                assertEquals(Manifest.permission.WRITE_SECURE_SETTINGS, permission);
                return permitted ? PackageManager.PERMISSION_GRANTED : PackageManager.PERMISSION_DENIED;
            }
        };
        preferences = app.getSharedPreferences("gestures", Context.MODE_PRIVATE);
        preferences.edit().clear().commit();
        permitted = true;
        NavigationSettings.writes.clear();
        NavigationSettings.reads = 0;
        NavigationSettings.writeAccepted = true;
        NavigationSettings.readback = 0;
        NavigationSettings.throwOnWrite = false;
        NavigationSettings.throwOnRead = false;
    }

    @Test public void noMarkerNeverTouchesNavigationEvenIfTheCurrentSettingIsHidden() {
        NavigationSettings.readback = 1;
        LegacyNavigationRecovery.recover(context);
        assertFalse(LegacyNavigationRecovery.pending(context));
        assertTrue(NavigationSettings.writes.isEmpty());
        assertEquals(0, NavigationSettings.reads);
    }

    @Test public void successfulReadbackClearsMarkerWithoutChangingAccessibilityOrOtherPreferences() {
        markPending();
        preferences.edit().putString("unrelated", "keep").commit();
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                "other/.Service:com.example.launcherprobe/.GestureService");
        Settings.Secure.putInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 1);
        LegacyNavigationRecovery.recover(context);
        assertEquals(List.of(0), NavigationSettings.writes);
        assertEquals(1, NavigationSettings.reads);
        assertFalse(LegacyNavigationRecovery.pending(context));
        assertEquals("keep", preferences.getString("unrelated", ""));
        assertEquals("other/.Service:com.example.launcherprobe/.GestureService", Settings.Secure.getString(
                context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES));
        assertEquals(1, Settings.Secure.getInt(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, -1));
        LegacyNavigationRecovery.recover(context);
        assertEquals(List.of(0), NavigationSettings.writes);
    }

    @Test public void permissionDenialKeepsMarkerAndAllowsAuthorizedRetry() {
        markPending();
        permitted = false;
        LegacyNavigationRecovery.recover(context);
        assertTrue(LegacyNavigationRecovery.pending(context));
        assertTrue(LegacyNavigationRecovery.status(context).contains("权限"));
        assertTrue(NavigationSettings.writes.isEmpty());
        permitted = true;
        LegacyNavigationRecovery.recover(context);
        assertFalse(LegacyNavigationRecovery.pending(context));
    }

    @Test public void rejectedWriteAndExceptionsKeepMarker() {
        markPending();
        NavigationSettings.writeAccepted = false;
        LegacyNavigationRecovery.recover(context);
        assertTrue(LegacyNavigationRecovery.pending(context));
        assertEquals(0, NavigationSettings.reads);
        NavigationSettings.throwOnWrite = true;
        LegacyNavigationRecovery.recover(context);
        assertTrue(LegacyNavigationRecovery.pending(context));
        assertEquals(List.of(0, 0), NavigationSettings.writes);
    }

    @Test public void mismatchedOrFailedReadbackNeverClearsMarker() {
        markPending();
        NavigationSettings.readback = 1;
        LegacyNavigationRecovery.recover(context);
        assertTrue(LegacyNavigationRecovery.pending(context));
        NavigationSettings.throwOnRead = true;
        LegacyNavigationRecovery.recover(context);
        assertTrue(LegacyNavigationRecovery.pending(context));
        assertEquals(List.of(0, 0), NavigationSettings.writes);
        assertEquals(2, NavigationSettings.reads);
    }

    @Test public void failedCommitRestoresInMemoryMarkerAndRetryDoesNotSkipRecovery() {
        markPending();
        SharedPreferences failing = (SharedPreferences) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[] {SharedPreferences.class}, (proxy, method, args) -> {
                    if (!method.getName().equals("edit")) return method.invoke(preferences, args);
                    SharedPreferences.Editor editor = preferences.edit();
                    return Proxy.newProxyInstance(getClass().getClassLoader(),
                            new Class<?>[] {SharedPreferences.Editor.class}, (editorProxy, edit, values) -> {
                                Object result = edit.invoke(editor, values);
                                // Android can mutate memory even when the disk commit fails.
                                if (edit.getName().equals("commit")) return false;
                                return result == editor ? editorProxy : result;
                            });
                });
        Context failedStorage = new ContextWrapper(context) {
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return failing; }
        };
        LegacyNavigationRecovery.recover(failedStorage);
        assertTrue(LegacyNavigationRecovery.pending(failedStorage));
        assertTrue(preferences.getBoolean("pending_restore", false));
        assertTrue(LegacyNavigationRecovery.status(context).contains("保存失败"));
        LegacyNavigationRecovery.recover(context);
        assertFalse(LegacyNavigationRecovery.pending(context));
        assertEquals(List.of(0, 0), NavigationSettings.writes);
    }

    private void markPending() {
        assertTrue(preferences.edit().putBoolean("pending_restore", true).commit());
    }

    @Implements(Settings.Global.class)
    public static class NavigationSettings {
        static final List<Integer> writes = new ArrayList<>();
        static int reads, readback;
        static boolean writeAccepted, throwOnWrite, throwOnRead;

        @Implementation public static boolean putInt(ContentResolver resolver, String name, int value) {
            assertEquals("force_fsg_nav_bar", name);
            assertEquals(0, value);
            writes.add(value);
            if (throwOnWrite) throw new SecurityException("Write denied");
            return writeAccepted;
        }

        @Implementation public static int getInt(ContentResolver resolver, String name, int fallback) {
            assertEquals("force_fsg_nav_bar", name);
            reads++;
            if (throwOnRead) throw new SecurityException("Read denied");
            return readback;
        }
    }
}
