/* Derived from Ogesture SwipeDetector.kt and data/Models.kt (AGPL-3.0).
 * Upstream: 404fb0a27a5e3122b153a4a97a150f31c3c04804. See THIRD_PARTY_NOTICES.md.
 * Java adaptation: platform-independent scheduling; hold increased 100 -> 300 ms;
 * explicit cancellation also used by service teardown/rotation.
 */
package com.example.launcherprobe;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

final class SwipeDetector {
    enum Zone { BOTTOM, LEFT, RIGHT }

    interface Scheduler {
        void post(Runnable task, long delay);
        void cancel(Runnable task);
    }

    interface Feedback {
        void show(Zone zone, float x, float y, float progress, boolean crossed);
        void hide();
    }

    static final class Sample {
        final float x;
        final float y;
        final long time;
        Sample(float x, float y, long time) { this.x = x; this.y = y; this.time = time; }
    }

    private final Zone zone;
    private final float minDistance;
    private final float stillness;
    private final Scheduler scheduler;
    private final Runnable shortSwipe;
    private final Runnable longSwipe;
    private final Consumer<List<Sample>> unusedTouch;
    private final Feedback feedback;
    private final List<Sample> samples = new ArrayList<>(64);
    private float startX, startY, anchorX, anchorY;
    private long startTime;
    private boolean tracking, crossed, longFired, replayable;
    private final Runnable hold = this::fireHold;

    SwipeDetector(Zone zone, float density, Scheduler scheduler, Runnable shortSwipe,
            Runnable longSwipe, Consumer<List<Sample>> unusedTouch, Feedback feedback) {
        this.zone = zone;
        minDistance = (zone == Zone.BOTTOM ? 10 : 24) * density;
        stillness = 12 * density;
        this.scheduler = scheduler;
        this.shortSwipe = shortSwipe;
        this.longSwipe = longSwipe;
        this.unusedTouch = unusedTouch;
        this.feedback = feedback;
    }

    private void fireHold() {
        if (!tracking || !crossed || longFired) return;
        longFired = true;
        hideFeedback();
        longSwipe.run();
    }

    void down(float x, float y, long time) {
        cancel();
        startX = x;
        startY = y;
        startTime = time;
        tracking = true;
        replayable = unusedTouch != null;
        sample(x, y, time);
        showFeedback(x, y, 0);
    }

    void move(float x, float y, long time) {
        sample(x, y, time);
        if (!tracking) return;
        float dx = x - startX;
        float dy = y - startY;
        if (!crossed) {
            if (time - startTime > 1000) {
                tracking = false;
                hideFeedback();
                return;
            }
            boolean triggered = zone == Zone.BOTTOM ? -dy >= minDistance && Math.abs(dx) <= -dy
                    : zone == Zone.LEFT ? dx >= minDistance && Math.abs(dy) <= dx
                    : -dx >= minDistance && Math.abs(dy) <= -dx;
            if (triggered) {
                crossed = true;
                if (longSwipe != null) arm(x, y);
            }
        } else if (!longFired && longSwipe != null
                && (Math.abs(x - anchorX) > stillness || Math.abs(y - anchorY) > stillness)) {
            arm(x, y);
        }
        float distance = zone == Zone.BOTTOM ? -dy : zone == Zone.LEFT ? dx : -dx;
        showFeedback(x, y, Math.max(0, Math.min(1, distance / minDistance)));
    }

    private void arm(float x, float y) {
        anchorX = x;
        anchorY = y;
        scheduler.cancel(hold);
        scheduler.post(hold, 300);
    }

    void up(float x, float y, long time) {
        sample(x, y, time);
        scheduler.cancel(hold);
        boolean fires = tracking && crossed && !longFired;
        tracking = false;
        hideFeedback();
        if (fires) shortSwipe.run();
        if (!fires && !longFired && replayable && !samples.isEmpty()) {
            unusedTouch.accept(new ArrayList<>(samples));
        }
        cancel();
    }

    void cancel() {
        scheduler.cancel(hold);
        hideFeedback();
        tracking = false;
        crossed = false;
        longFired = false;
        replayable = false;
        samples.clear();
    }

    private void showFeedback(float x, float y, float progress) {
        if (feedback != null && !longFired) feedback.show(zone, x, y, progress, crossed);
    }

    private void hideFeedback() {
        if (feedback != null) feedback.hide();
    }

    private void sample(float x, float y, long time) {
        if (replayable && samples.size() < 400) samples.add(new Sample(x, y, time));
    }
}
