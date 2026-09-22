package com.ai.assistance.shower;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.function.BooleanSupplier;

/**
 * Display-scoped input injection adapted from Operit Shower.
 * This version is deterministic and reports injection failures to the caller.
 */
final class InputController {
    private final Object inputManager;
    private final Method injectInputEventMethod;
    private final Method setDisplayIdMethod;
    private final int displayId;
    private MotionEvent lastTouch;

    InputController(int displayId) {
        if (displayId <= 0) throw new IllegalArgumentException("A virtual display id is required");
        this.displayId = displayId;
        try {
            Class<?> type = Class.forName("android.hardware.input.InputManager");
            Method getInstance = type.getDeclaredMethod("getInstance");
            getInstance.setAccessible(true);
            inputManager = getInstance.invoke(null);
            injectInputEventMethod = type.getDeclaredMethod("injectInputEvent", InputEvent.class, int.class);
            injectInputEventMethod.setAccessible(true);
            setDisplayIdMethod = InputEvent.class.getMethod("setDisplayId", int.class);
        } catch (ReflectiveOperationException exception) {
            throw new IllegalStateException("Unable to initialize display input", exception);
        }
    }

    boolean touch(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) cancelTouch();
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        boolean result = inject(event);
        if (lastTouch != null) lastTouch.recycle();
        lastTouch = MotionEvent.obtain(event);
        if (!result) cancelTouch();
        else if (event.getActionMasked() == MotionEvent.ACTION_UP
                || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            lastTouch.recycle();
            lastTouch = null;
        }
        return result;
    }

    void cancelTouch() {
        if (lastTouch == null) return;
        lastTouch.setAction(MotionEvent.ACTION_CANCEL);
        try { inject(lastTouch); }
        finally { lastTouch.recycle(); lastTouch = null; }
    }

    boolean injectKeyWithMeta(int keyCode, int metaState) {
        long now = SystemClock.uptimeMillis();
        KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0, metaState,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
        KeyEvent up = KeyEvent.changeAction(down, KeyEvent.ACTION_UP);
        // Wait for dispatch so select-all has taken effect before the subsequent paste/delete.
        return inject(down, 2) && inject(up, 2);
    }

    boolean tap(float x, float y) {
        long now = SystemClock.uptimeMillis();
        long downTime = Math.max(0, now - 40);
        MotionEvent down = motion(downTime, downTime, MotionEvent.ACTION_DOWN, x, y);
        MotionEvent up = motion(downTime, now, MotionEvent.ACTION_UP, x, y);
        try {
            if (!inject(down)) return false;
            boolean injected = inject(up);
            if (!injected) cancel(downTime, x, y);
            return injected;
        } finally {
            down.recycle();
            up.recycle();
        }
    }

    boolean swipe(float x1, float y1, float x2, float y2, long durationMs,
            BooleanSupplier isCancelled) {
        if (isCancelled.getAsBoolean()) return false;
        long duration = Math.max(1, durationMs);
        long start = SystemClock.uptimeMillis();
        MotionEvent down = motion(start, start, MotionEvent.ACTION_DOWN, x1, y1);
        try {
            if (!inject(down)) return false;
        } finally {
            down.recycle();
        }
        float lastX = x1;
        float lastY = y1;
        for (int step = 1; step <= 10; step++) {
            long target = start + duration * step / 10;
            while (true) {
                if (isCancelled.getAsBoolean()) {
                    cancel(start, lastX, lastY);
                    Main.logToFile("Swipe cancelled on display " + displayId + " after "
                            + (SystemClock.uptimeMillis() - start) + "ms", null);
                    return false;
                }
                long remaining = target - SystemClock.uptimeMillis();
                if (remaining <= 0) break;
                SystemClock.sleep(Math.min(remaining, 25));
            }
            float progress = step / 10f;
            float eased = progress * progress * (3f - 2f * progress);
            MotionEvent move = motion(start, SystemClock.uptimeMillis(),
                    MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * eased, y1 + (y2 - y1) * eased);
            try {
                if (!inject(move)) {
                    cancel(start, x1 + (x2 - x1) * eased, y1 + (y2 - y1) * eased);
                    return false;
                }
            } finally {
                move.recycle();
            }
            lastX = x1 + (x2 - x1) * eased;
            lastY = y1 + (y2 - y1) * eased;
        }
        if (isCancelled.getAsBoolean()) {
            cancel(start, lastX, lastY);
            return false;
        }
        MotionEvent up = motion(start, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x2, y2);
        try {
            boolean injected = inject(up);
            if (!injected) cancel(start, x2, y2);
            return injected;
        } finally {
            up.recycle();
        }
    }

    private void cancel(long downTime, float x, float y) {
        MotionEvent cancel = motion(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, x, y);
        try { inject(cancel); }
        finally { cancel.recycle(); }
    }

    private static MotionEvent motion(long downTime, long eventTime, int action, float x, float y) {
        MotionEvent event = MotionEvent.obtain(downTime, eventTime, action, x, y, 1f, 1f,
                0, 1f, 1f, 0, 0);
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        return event;
    }

    private boolean inject(InputEvent event) {
        return inject(event, 0);
    }

    private boolean inject(InputEvent event, int mode) {
        try {
            setDisplayIdMethod.invoke(event, displayId);
            return Boolean.TRUE.equals(injectInputEventMethod.invoke(inputManager, event, mode));
        } catch (InvocationTargetException exception) {
            Throwable cause = exception.getCause() == null ? exception : exception.getCause();
            Main.logToFile("Input injection failed on display " + displayId + ": " + cause, cause);
            return false;
        } catch (ReflectiveOperationException | RuntimeException exception) {
            Main.logToFile("Input injection failed on display " + displayId + ": " + exception, exception);
            return false;
        }
    }
}
