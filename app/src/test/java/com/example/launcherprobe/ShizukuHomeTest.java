package com.example.launcherprobe;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.ApplicationInfo;
import android.os.Binder;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ShizukuHomeTest {
    @Test public void privilegedOperationsRejectAnotherAppBeforeRunningCommands() {
        Context context = new ContextWrapper(RuntimeEnvironment.getApplication()) {
            @Override public ApplicationInfo getApplicationInfo() {
                ApplicationInfo info = new ApplicationInfo(super.getApplicationInfo());
                info.uid = Binder.getCallingUid() + 1;
                return info;
            }
        };
        OwnPermissionService service = new OwnPermissionService(context);
        assertThrows(SecurityException.class, service::setOwnDefaultHome);
        assertThrows(SecurityException.class, service::grantOwnWriteSecureSettings);
    }

    @Test public void intentionalDisconnectDoesNotOverwriteOperationResult() {
        ShizukuRepair repair = new ShizukuRepair(RuntimeEnvironment.getApplication(), () -> { });
        try {
            repair.resume();
            ReflectionHelpers.callInstanceMethod(repair, "setStatus",
                    ReflectionHelpers.ClassParameter.from(String.class, "默认桌面设置成功"));
            android.content.ServiceConnection connection = ReflectionHelpers.getField(repair, "connection");
            connection.onServiceDisconnected(new android.content.ComponentName(
                    RuntimeEnvironment.getApplication(), OwnPermissionService.class));
            assertEquals("默认桌面设置成功", ShizukuRepair.statusText());
        } finally {
            repair.destroy();
        }
    }

    @Test public void unavailableShizukuDoesNotLeaveDefaultHomeChangeQueued() {
        ShizukuRepair repair = new ShizukuRepair(RuntimeEnvironment.getApplication(), () -> { });
        try {
            repair.requestHomeFromButton();
            assertTrue(ShizukuRepair.statusText().contains("未运行"));
            assertFalse(ReflectionHelpers.<Boolean>getField(repair, "homeRequested"));
            repair.resume();
            assertFalse(ReflectionHelpers.<Boolean>getField(repair, "homeRequested"));
        } finally {
            repair.destroy();
        }
    }
}
