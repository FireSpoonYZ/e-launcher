package com.ai.assistance.shower.wrappers;

import android.os.IInterface;
import android.os.SystemClock;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

public final class PowerManager {

    private static final int USER_ACTIVITY_EVENT_OTHER = 0;

    private final IInterface manager;
    private final Method userActivityMethod;

    static PowerManager create() {
        try {
            IInterface manager = ServiceManager.getService("power", "android.os.IPowerManager");
            if (manager == null) {
                throw new IllegalStateException("Power service is unavailable");
            }
            Method method = manager.getClass().getMethod("userActivity",
                    int.class, long.class, int.class, int.class);
            return new PowerManager(manager, method);
        } catch (ReflectiveOperationException | RuntimeException | AssertionError exception) {
            // ServiceManager.getService wraps Binder lookup failures in AssertionError.
            throw new IllegalStateException(
                    "Unable to obtain PowerManager userActivity(int displayId, long time, int event, int flags)",
                    exception);
        }
    }

    private PowerManager(IInterface manager, Method userActivityMethod) {
        this.manager = manager;
        this.userActivityMethod = userActivityMethod;
    }

    public void userActivity(int displayId) {
        if (displayId <= 0) {
            throw new IllegalStateException("PowerManager.userActivity requires displayId > 0: " + displayId);
        }
        try {
            userActivityMethod.invoke(manager, displayId, SystemClock.uptimeMillis(), USER_ACTIVITY_EVENT_OTHER, 0);
        } catch (InvocationTargetException exception) {
            Throwable cause = exception.getCause() == null ? exception : exception.getCause();
            throw new IllegalStateException("PowerManager.userActivity failed for displayId=" + displayId + ": " + cause, cause);
        } catch (ReflectiveOperationException | RuntimeException exception) {
            throw new IllegalStateException("PowerManager.userActivity failed for displayId=" + displayId, exception);
        }
    }
}
