package com.ai.assistance.shower.wrappers;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.os.Bundle;
import android.os.IBinder;
import android.os.IInterface;

import com.ai.assistance.shower.shell.FakeContext;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/** Hidden activity-manager calls adapted from Operit Shower. */
@SuppressLint("PrivateApi,DiscouragedPrivateApi")
public final class ActivityManager {
    private final IInterface manager;
    private Method startActivityAsUserMethod;

    static ActivityManager create() {
        try {
            Class<?> type = Class.forName("android.app.ActivityManagerNative");
            IInterface value = (IInterface) type.getDeclaredMethod("getDefault").invoke(null);
            return new ActivityManager(value);
        } catch (ReflectiveOperationException exception) {
            throw new IllegalStateException("Unable to obtain ActivityManager", exception);
        }
    }

    private ActivityManager(IInterface manager) {
        this.manager = manager;
    }

    public int startActivity(Intent intent, Bundle options) {
        try {
            if (startActivityAsUserMethod == null) {
                Class<?> applicationThread = Class.forName("android.app.IApplicationThread");
                Class<?> profilerInfo = Class.forName("android.app.ProfilerInfo");
                startActivityAsUserMethod = manager.getClass().getMethod("startActivityAsUser",
                        applicationThread, String.class, Intent.class, String.class, IBinder.class,
                        String.class, int.class, int.class, profilerInfo, Bundle.class, int.class);
            }
            return (int) startActivityAsUserMethod.invoke(manager, null, FakeContext.PACKAGE_NAME,
                    intent, null, null, null, 0, 0, null, options, -2);
        } catch (InvocationTargetException exception) {
            Throwable cause = exception.getCause() == null ? exception : exception.getCause();
            throw new IllegalStateException("Activity launch failed: " + cause, cause);
        } catch (ReflectiveOperationException exception) {
            throw new IllegalStateException("Activity launch API unavailable", exception);
        }
    }
}
