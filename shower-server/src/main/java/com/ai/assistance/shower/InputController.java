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

    boolean injectKeyWithMeta(int keyCode, int metaState) {
        long now = SystemClock.uptimeMillis();
        KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0, metaState,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
        KeyEvent up = KeyEvent.changeAction(down, KeyEvent.ACTION_UP);
        return inject(down) && inject(up);
    }

    boolean inputText(String text) {
        KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
                .getEvents(text.toCharArray());
        if (events == null || events.length == 0) return false;
        for (KeyEvent event : events) if (!inject(event)) return false;
        return true;
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
        try {
            setDisplayIdMethod.invoke(event, displayId);
            return Boolean.TRUE.equals(injectInputEventMethod.invoke(inputManager, event, 0));
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
