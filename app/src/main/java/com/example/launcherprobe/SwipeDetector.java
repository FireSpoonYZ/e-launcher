/* Derived from Ogesture SwipeDetector.kt and data/Models.kt (AGPL-3.0).
 * Upstream: 404fb0a27a5e3122b153a4a97a150f31c3c04804. See THIRD_PARTY_NOTICES.md.
 * Java adaptation: platform-independent scheduling; bottom hold measured from DOWN (over 200 ms);
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
        double distanceFrom(Sample other) { return Math.hypot(x - other.x, y - other.y); }
    }

    private final Zone zone;
    private final float minDistance;
    private final float holdDistance;
    private static final long QUICK_SWIPE_MS = 200;
    private static final long HOLD_RETRY_MS = 40;
    private final Scheduler scheduler;
    private final Runnable shortSwipe;
    private final Runnable longSwipe;
    private final Consumer<List<Sample>> unusedTouch;
    private final Feedback feedback;
    private final List<Sample> samples = new ArrayList<>(64);
    private float startX, startY;
    private long startTime;
    private boolean tracking, crossed, longFired, replayable, sideClaimed;
    private float inward;
    private final Runnable hold = this::fireHold;

    SwipeDetector(Zone zone, float density, Scheduler scheduler, Runnable shortSwipe,
            Runnable longSwipe, Consumer<List<Sample>> unusedTouch, Feedback feedback) {
        this.zone = zone;
        minDistance = (zone == Zone.BOTTOM ? 10 : 40) * density;
        holdDistance = 32 * density;
        this.scheduler = scheduler;
        this.shortSwipe = shortSwipe;
        this.longSwipe = longSwipe;
        this.unusedTouch = unusedTouch;
        this.feedback = feedback;
    }

    private void fireHold() {
        if (!tracking || zone != Zone.BOTTOM || longSwipe == null || longFired) return;
        // The app list needs a real pull, not just a finger resting on the edge.
        if (inward < holdDistance) {
            scheduler.post(hold, HOLD_RETRY_MS);
            return;
        }
        longFired = true;
        hideFeedback();
        longSwipe.run();
    }

    void down(float x, float y, long time) {
        cancel();
        startX = x;
        startY = y;
        startTime = time;
        inward = 0;
        tracking = true;
        replayable = unusedTouch != null;
        sample(x, y, time);
        showFeedback(x, y, 0);
        if (zone == Zone.BOTTOM && longSwipe != null) {
            // A release at exactly 200 ms still belongs to the quick-swipe window.
            scheduler.post(hold, QUICK_SWIPE_MS + 1);
        }
    }

    void move(float x, float y, long time) {
        sample(x, y, time);
        if (!tracking) return;
        float dx = x - startX;
        float dy = y - startY;
        float distance = zone == Zone.BOTTOM ? -dy : zone == Zone.LEFT ? dx : -dx;
        inward = distance;
        if (time - startTime > QUICK_SWIPE_MS) fireHold();
        // Once the side animation extends inward, never replay this touch as a scroll.
        if (zone != Zone.BOTTOM && distance > 0) {
            sideClaimed = true;
            replayable = false;
        }
        if (!crossed && zone != Zone.BOTTOM && !sideClaimed && time - startTime > 1000) {
            tracking = false;
            hideFeedback();
            return;
        }
        // Not sticky: pulling back under the threshold cancels the gesture, like HyperOS.
        crossed = distance >= minDistance && (zone != Zone.BOTTOM || Math.abs(dx) <= -dy);
        showFeedback(x, y, Math.max(0, Math.min(1, distance / minDistance)));
    }

    void up(float x, float y, long time) {
        // UP carries the distance that decides the gesture, on every edge.
        move(x, y, time);
        scheduler.cancel(hold);
        boolean fires = tracking && crossed && !longFired
                && (zone != Zone.BOTTOM || time - startTime <= QUICK_SWIPE_MS);
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
        sideClaimed = false;
        inward = 0;
        samples.clear();
    }

    private void showFeedback(float x, float y, float progress) {
        if (feedback != null && !longFired) feedback.show(zone, x, y, progress, crossed);
    }

    private void hideFeedback() {
        if (feedback != null) feedback.hide();
    }

    static boolean isTap(List<Sample> samples, float touchSlop) {
        Sample first = samples.get(0);
        for (Sample sample : samples) {
            if (sample.distanceFrom(first) > touchSlop) return false;
        }
        return true;
    }

    private void sample(float x, float y, long time) {
        if (!replayable) return;
        Sample next = new Sample(x, y, time);
        if (samples.size() < 400) {
            samples.add(next);
        } else {
            // ponytail: keep the first 398 points, then the tail's furthest point and latest end.
            // This simplifies long paths; use bounded resampling if replay fidelity needs improving.
            Sample first = samples.get(0), previous = samples.get(399);
            if (previous.distanceFrom(first) > samples.get(398).distanceFrom(first)) {
                samples.set(398, previous);
            }
            samples.set(399, next);
        }
    }
}
