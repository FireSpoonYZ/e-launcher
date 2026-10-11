package com.ai.assistance.shower.wrappers;

import com.ai.assistance.shower.AndroidVersions;

import android.annotation.SuppressLint;
import android.graphics.Rect;
import android.os.Build;
import android.os.IBinder;
import android.system.Os;
import android.view.Surface;

import java.lang.reflect.Method;

@SuppressLint("PrivateApi")
public final class SurfaceControl {

    private static final Class<?> CLASS;

    static {
        try {
            CLASS = Class.forName("android.view.SurfaceControl");
        } catch (ClassNotFoundException e) {
            throw new AssertionError(e);
        }
    }

    private static Method getBuiltInDisplayMethod;
    private static Class<?> displayControlClass;

    private SurfaceControl() {
    }

    public static void setDisplaySurface(IBinder displayToken, Surface surface, Rect source,
            Rect target, int layerStack) throws ReflectiveOperationException {
        try (android.view.SurfaceControl.Transaction transaction = new android.view.SurfaceControl.Transaction()) {
            Class<?> clazz = android.view.SurfaceControl.Transaction.class;
            clazz.getMethod("setDisplaySurface", IBinder.class, Surface.class)
                    .invoke(transaction, displayToken, surface);
            clazz.getMethod("setDisplayProjection", IBinder.class, int.class, Rect.class, Rect.class)
                    .invoke(transaction, displayToken, 0, source, target);
            clazz.getMethod("setDisplayLayerStack", IBinder.class, int.class)
                    .invoke(transaction, displayToken, layerStack);
            transaction.apply();
        }
    }

    private static synchronized Class<?> getDisplayControlClass() throws ReflectiveOperationException {
        if (displayControlClass == null) {
            Class<?> factory = Class.forName("com.android.internal.os.ClassLoaderFactory");
            Method createClassLoader = factory.getDeclaredMethod("createClassLoader", String.class,
                    String.class, String.class, ClassLoader.class, int.class, boolean.class, String.class);
            ClassLoader loader = (ClassLoader) createClassLoader.invoke(null,
                    Os.getenv("SYSTEMSERVERCLASSPATH"), null, null,
                    ClassLoader.getSystemClassLoader(), 0, true, null);
            Class<?> clazz = loader.loadClass("com.android.server.display.DisplayControl");
            Method loadLibrary = Runtime.class.getDeclaredMethod("loadLibrary0", Class.class, String.class);
            loadLibrary.setAccessible(true);
            loadLibrary.invoke(Runtime.getRuntime(), clazz, "android_servers");
            displayControlClass = clazz;
        }
        return displayControlClass;
    }

    public static IBinder createDisplay(String name, boolean secure) throws Exception {
        if (Build.VERSION.SDK_INT >= 34) {
            Class<?> clazz = getDisplayControlClass();
            if (Build.VERSION.SDK_INT >= 36) {
                // Avoid depending on another display to render while the main display is off.
                return (IBinder) clazz.getMethod("createVirtualDisplay", String.class, boolean.class,
                        boolean.class, String.class, float.class).invoke(null, name, secure, false, "", 0.0f);
            }
            String method = Build.VERSION.SDK_INT >= 35 ? "createVirtualDisplay" : "createDisplay";
            return (IBinder) clazz.getMethod(method, String.class, boolean.class).invoke(null, name, secure);
        }
        return (IBinder) CLASS.getMethod("createDisplay", String.class, boolean.class).invoke(null, name, secure);
    }

    private static Method getGetBuiltInDisplayMethod() throws NoSuchMethodException {
        if (getBuiltInDisplayMethod == null) {
            if (Build.VERSION.SDK_INT < AndroidVersions.API_29_ANDROID_10) {
                getBuiltInDisplayMethod = CLASS.getMethod("getBuiltInDisplay", int.class);
            } else {
                getBuiltInDisplayMethod = CLASS.getMethod("getInternalDisplayToken");
            }
        }
        return getBuiltInDisplayMethod;
    }

    public static IBinder getBuiltInDisplay() {
        try {
            Method method = getGetBuiltInDisplayMethod();
            if (Build.VERSION.SDK_INT < AndroidVersions.API_29_ANDROID_10) {
                return (IBinder) method.invoke(null, 0);
            }
            return (IBinder) method.invoke(null);
        } catch (ReflectiveOperationException e) {
            return null;
        }
    }

    public static void destroyDisplay(IBinder displayToken) {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                String method = Build.VERSION.SDK_INT >= 35 ? "destroyVirtualDisplay" : "destroyDisplay";
                getDisplayControlClass().getMethod(method, IBinder.class).invoke(null, displayToken);
            } else {
                CLASS.getMethod("destroyDisplay", IBinder.class).invoke(null, displayToken);
            }
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
