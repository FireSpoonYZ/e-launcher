package com.ai.assistance.shower.wrappers;

import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.IInterface;
import android.util.Log;

import java.lang.reflect.Method;

public final class WindowManager {

    public static final int DISPLAY_IME_POLICY_LOCAL = 0;
    public static final int DISPLAY_IME_POLICY_FALLBACK_DISPLAY = 1;
    public static final int DISPLAY_IME_POLICY_HIDE = 2;

    private static final String TAG = "ShowerWindowManager";

    private final IInterface manager;
    private Method setDisplayImePolicyMethod;

    private WindowManager(IInterface manager) {
        this.manager = manager;
    }

    public static WindowManager create() {
        IInterface manager = ServiceManager.getService("window", "android.view.IWindowManager");
        return new WindowManager(manager);
    }

    /** Captures on API 34+; the caller owns the returned software bitmap. */
    public Bitmap captureDisplay(int displayId, float frameScale) throws ReflectiveOperationException {
        Class<?> screenCaptureClass = Class.forName("android.window.ScreenCapture");
        Class<?> captureArgsClass = Class.forName("android.window.ScreenCapture$CaptureArgs");
        Class<?> builderClass = Class.forName("android.window.ScreenCapture$CaptureArgs$Builder");
        Class<?> listenerClass = Class.forName("android.window.ScreenCapture$ScreenCaptureListener");
        Class<?> syncListenerClass = Class.forName("android.window.ScreenCapture$SynchronousScreenCaptureListener");
        Class<?> bufferClass = Class.forName("android.window.ScreenCapture$ScreenshotHardwareBuffer");
        Method getBuffer = syncListenerClass.getMethod("getBuffer");
        Method getHardwareBuffer = bufferClass.getMethod("getHardwareBuffer");
        Method asBitmap = bufferClass.getMethod("asBitmap");

        Object builder = builderClass.getConstructor().newInstance();
        builderClass.getMethod("setFrameScale", float.class).invoke(builder, frameScale);
        builderClass.getMethod("setCaptureSecureLayers", boolean.class).invoke(builder, false);
        builderClass.getMethod("setAllowProtected", boolean.class).invoke(builder, false);
        Object args = builderClass.getMethod("build").invoke(builder);
        Object listener = screenCaptureClass.getMethod("createSyncCaptureListener").invoke(null);
        manager.getClass().getMethod("captureDisplay", int.class, captureArgsClass, listenerClass)
                .invoke(manager, displayId, args, listener);
        // Reflect on the public base class; getBuffer uses the framework's bounded wait.
        Object screenshot = getBuffer.invoke(listener);
        if (screenshot == null) {
            throw new IllegalStateException("WindowManager capture failed or timed out for display " + displayId);
        }
        Bitmap bitmap = null;
        try (HardwareBuffer hardwareBuffer = (HardwareBuffer) getHardwareBuffer.invoke(screenshot)) {
            if (hardwareBuffer == null) {
                throw new IllegalStateException("No screenshot hardware buffer for display " + displayId);
            }
            bitmap = (Bitmap) asBitmap.invoke(screenshot);
            if (bitmap == null) {
                throw new IllegalStateException("No screenshot bitmap for display " + displayId);
            }
            Bitmap copy = bitmap.copy(Bitmap.Config.ARGB_8888, false);
            if (copy == null) {
                throw new IllegalStateException("Screenshot bitmap copy failed for display " + displayId);
            }
            return copy;
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    private Method getSetDisplayImePolicyMethod() throws NoSuchMethodException {
        if (setDisplayImePolicyMethod == null) {
            Class<?> cls = manager.getClass();
            if (Build.VERSION.SDK_INT >= 31) {
                setDisplayImePolicyMethod = cls.getMethod("setDisplayImePolicy", int.class, int.class);
            } else {
                setDisplayImePolicyMethod = cls.getMethod("setShouldShowIme", int.class, boolean.class);
            }
        }
        return setDisplayImePolicyMethod;
    }

    public void setDisplayImePolicy(int displayId, int displayImePolicy) {
        if (displayId < 0) {
            return;
        }
        try {
            Method method = getSetDisplayImePolicyMethod();
            if (Build.VERSION.SDK_INT >= 31) {
                method.invoke(manager, displayId, displayImePolicy);
            } else if (displayImePolicy != DISPLAY_IME_POLICY_HIDE) {
                boolean shouldShowIme = displayImePolicy == DISPLAY_IME_POLICY_LOCAL;
                method.invoke(manager, displayId, shouldShowIme);
            } else {
                Log.w(TAG, "DISPLAY_IME_POLICY_HIDE is not supported before Android 12");
            }
        } catch (NoSuchMethodException e) {
            Log.e(TAG, "setDisplayImePolicy method not found", e);
        } catch (Exception e) {
            Log.e(TAG, "setDisplayImePolicy failed", e);
        }
    }
}
