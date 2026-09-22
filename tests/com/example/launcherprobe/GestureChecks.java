package com.example.launcherprobe;

import java.util.ArrayList;
import java.util.List;

/** Runnable without Android or a test framework: java -ea ...GestureChecks. */
public final class GestureChecks {
    private static final class Clock implements SwipeDetector.Scheduler {
        long now;
        long due;
        Runnable pending;
        public void post(Runnable task, long delay) { pending = task; due = now + delay; }
        public void cancel(Runnable task) { if (pending == task) pending = null; }
        void advance(long ms) {
            now += ms;
            if (pending != null && now >= due) {
                Runnable task = pending;
                pending = null;
                task.run();
            }
        }
    }

    private static final class FeedbackRecorder implements SwipeDetector.Feedback {
        boolean visible;
        boolean crossed;
        float progress;
        SwipeDetector.Zone zone;
        int hides;
        public void show(SwipeDetector.Zone value, float x, float y, float valueProgress,
                boolean valueCrossed) {
            visible = true;
            zone = value;
            progress = valueProgress;
            crossed = valueCrossed;
        }
        public void hide() { visible = false; hides++; }
    }

    private static void gestures() {
        Clock clock = new Clock();
        List<String> actions = new ArrayList<>();
        FeedbackRecorder feedback = new FeedbackRecorder();
        SwipeDetector bottom = new SwipeDetector(SwipeDetector.Zone.BOTTOM, 1, clock,
                () -> actions.add("home"), () -> actions.add("recents"),
                samples -> actions.add("replay"), feedback);
        bottom.down(100, 200, 0);
        assert feedback.visible && feedback.zone == SwipeDetector.Zone.BOTTOM
                && feedback.progress == 0 && !feedback.crossed;
        bottom.move(100, 191, 20);
        assert feedback.visible && Math.abs(feedback.progress - .9f) < .001f
                && !feedback.crossed;
        bottom.up(100, 191, 40);
        assert actions.toString().equals("[replay]") : actions;
        actions.clear();
        bottom.down(100, 200, 50);
        bottom.move(100, 190, 70);
        assert feedback.visible && feedback.progress == 1 && feedback.crossed;
        bottom.up(100, 180, 90);
        clock.advance(400);
        assert actions.toString().equals("[home]") : actions;
        assert !feedback.visible;
        actions.clear();
        bottom.down(100, 200, clock.now);
        long pressedAt = clock.now;
        clock.advance(100);
        bottom.move(100, 180, clock.now);
        clock.advance(100);
        bottom.move(100, 160, clock.now); // Continued travel does not restart the timer.
        assert actions.isEmpty();
        clock.advance(1); // More than 200 ms since DOWN, without waiting for UP.
        assert !feedback.visible;
        bottom.move(100, 140, pressedAt + 220);
        assert !feedback.visible;
        bottom.up(100, 140, pressedAt + 240);
        assert actions.toString().equals("[recents]") : actions;
        actions.clear();

        bottom.down(100, 200, clock.now);
        clock.advance(200);
        assert actions.isEmpty();
        bottom.up(100, 190, clock.now); // Inclusive 200 ms boundary; no MOVE event.
        clock.advance(1);
        assert actions.toString().equals("[home]") : actions;
        actions.clear();

        bottom.down(100, 200, clock.now);
        clock.advance(201); // A resting finger without a pull is not the app list.
        assert actions.isEmpty() : actions;
        bottom.up(100, 200, clock.now);
        assert actions.toString().equals("[replay]") : actions;
        actions.clear();

        bottom.down(100, 200, clock.now);
        bottom.move(100, 168, clock.now); // Pulled past the hold distance, then held still.
        clock.advance(201);
        assert actions.toString().equals("[recents]") : actions;
        bottom.up(100, 168, clock.now);
        assert actions.toString().equals("[recents]") : actions;
        actions.clear();

        bottom.down(100, 200, 0);
        bottom.up(100, 190, 201); // Slow and short: neither a quick swipe nor a pulled hold.
        clock.advance(200);
        assert actions.toString().equals("[replay]") : actions;
        actions.clear();

        bottom.down(100, 200, 0);
        bottom.up(120, 190, 199); // A mostly horizontal quick swipe is not HOME.
        assert actions.toString().equals("[replay]") : actions;
        actions.clear();
        for (int i = 0; i < 3; i++) {
            bottom.down(100, 200, 0);
            bottom.move(100, 180, 20);
            // Android CANCEL, POINTER_DOWN and teardown/rotation share this reset.
            Runnable staleHold = clock.pending;
            bottom.cancel();
            assert !feedback.visible;
            staleHold.run(); // A late callback must also be inert.
            clock.advance(500);
            bottom.up(100, 180, 600);
        }
        assert actions.isEmpty();
        bottom.down(100, 200, 0);
        bottom.move(100, 160, 1001);
        assert !feedback.visible;
        bottom.up(100, 160, 1100);
        assert actions.toString().equals("[recents]");
        actions.clear();
        for (SwipeDetector.Zone zone : new SwipeDetector.Zone[]{
                SwipeDetector.Zone.LEFT, SwipeDetector.Zone.RIGHT}) {
            FeedbackRecorder sideFeedback = new FeedbackRecorder();
            SwipeDetector side = new SwipeDetector(zone, 1, clock,
                    () -> actions.add("back"), null, samples -> actions.add("replay"),
                    sideFeedback);
            int dx = zone == SwipeDetector.Zone.LEFT ? 40 : -40;
            side.down(100, 200, 0);
            side.move(100 - dx, 200, 20);
            side.up(100 - dx, 200, 30);
            side.down(100, 200, 0);
            side.move(100 + dx, 230, 20); // Vertical drift cannot veto side BACK.
            side.up(100 + dx, 230, 30);
            side.down(100, 200, 0);
            side.move(100 + dx, 200, 20);
            assert sideFeedback.visible && sideFeedback.zone == zone
                    && sideFeedback.progress == 1 && sideFeedback.crossed;
            side.move(100 + dx * 2, 200, 1100);
            assert sideFeedback.visible && sideFeedback.crossed;
            side.up(100 + dx * 2, 200, 1120);
            assert !sideFeedback.visible;
        }
        assert actions.toString().equals("[replay, back, back, replay, back, back]") : actions;
        actions.clear();

        for (SwipeDetector.Zone zone : new SwipeDetector.Zone[]{
                SwipeDetector.Zone.LEFT, SwipeDetector.Zone.RIGHT}) {
            for (int vertical : new int[]{-200, 200}) {
                FeedbackRecorder sideFeedback = new FeedbackRecorder();
                SwipeDetector side = new SwipeDetector(zone, 1, clock,
                        () -> actions.add("back"), null, samples -> actions.add("replay"),
                        sideFeedback);
                int inward = zone == SwipeDetector.Zone.LEFT ? 1 : -1;
                side.down(100, 300, 0);
                side.move(100 + inward * 39, 300 + vertical, 20);
                assert sideFeedback.visible && !sideFeedback.crossed;
                side.move(100, 300 + vertical, 1100); // Retract after animation: no scroll replay.
                side.up(100, 300 + vertical, 1120);
                assert actions.isEmpty() : actions;
                assert !sideFeedback.visible;

                side.down(100, 300, 0);
                side.move(100 + inward, 300 + vertical, 20);
                side.move(100 + inward * 40, 300 + vertical, 1100);
                assert sideFeedback.visible && sideFeedback.crossed;
                side.up(100 + inward * 40, 300 + vertical, 1120);
                assert actions.toString().equals("[back]") : actions;
                actions.clear();

                side.down(100, 300, 0);
                side.move(100 + inward * 60, 300 + vertical, 20);
                assert sideFeedback.crossed;
                side.move(100 + inward * 10, 300 + vertical, 40); // Pulled back under the threshold.
                assert !sideFeedback.crossed;
                side.up(100 + inward * 10, 300 + vertical, 60);
                assert actions.isEmpty() : actions;

                side.down(100, 300, 0);
                side.move(100 + inward * 40, 300 + vertical, 20);
                side.cancel();
                side.up(100 + inward * 40, 300 + vertical, 40);
                assert actions.isEmpty() : actions;
                // A fresh edge tap still passes through after cancellation.
                side.down(100, 300, 50);
                side.up(100, 300, 60);
                assert actions.toString().equals("[replay]") : actions;
                actions.clear();
            }
        }

        Clock slowClock = new Clock();
        SwipeDetector slowBottom = new SwipeDetector(SwipeDetector.Zone.BOTTOM, 1, slowClock,
                () -> actions.add("home"), () -> actions.add("recents"),
                samples -> actions.add("replay"), feedback);
        slowBottom.down(100, 200, 0);
        for (int step = 1; step <= 12; step++) {
            slowBottom.move(100, 200 - step * 14, 20 + (step - 1) * 100);
            slowClock.advance(100);
        }
        slowBottom.move(100, 20, 1220);
        slowBottom.up(100, 20, 1230);
        slowClock.advance(400);
        assert !feedback.visible;
        assert actions.toString().equals("[recents]") : actions;
    }

    private static void replaySamples() {
        for (SwipeDetector.Zone zone : SwipeDetector.Zone.values()) {
            List<List<SwipeDetector.Sample>> replays = new ArrayList<>();
            SwipeDetector detector = new SwipeDetector(zone, 1, new Clock(),
                    () -> { throw new AssertionError("Unexpected navigation"); }, null,
                    replays::add, null);
            detector.down(100, 200, 0);
            detector.move(100, 208, 20);
            detector.up(100, 200, 40);
            assert SwipeDetector.isTap(replays.getLast(), 8) : "Jitter within touch slop is a tap";

            detector.down(100, 200, 50);
            detector.move(100, 209, 70);
            detector.up(100, 200, 90);
            assert !SwipeDetector.isTap(replays.getLast(), 8) : "Returning to DOWN is still a drag";
            assert SwipeDetector.isTap(replays.getLast(), 24) : "Use the supplied scaled touch slop";

            detector.down(100, 200, 100);
            detector.up(100, 209, 120);
            assert !SwipeDetector.isTap(replays.getLast(), 8) : "Include the UP position";

            detector.down(100, 200, 0);
            for (int i = 1; i <= 450; i++) {
                detector.move(100, i == 399 ? 230 : i == 450 ? 240 : 200, i);
            }
            detector.move(100, 200, 451);
            detector.up(100, 201, 900);
            List<SwipeDetector.Sample> samples = replays.getLast();
            assert samples.size() == 400 : "Bound replay storage";
            SwipeDetector.Sample first = samples.getFirst(), last = samples.getLast();
            assert first.x == 100 && first.y == 200 && first.time == 0 : "Keep DOWN";
            assert last.x == 100 && last.y == 201 && last.time == 900 : "Keep actual UP and duration";
            assert !SwipeDetector.isTap(samples, 32) : "Keep excursions after the sample limit";
            assert samples.get(398).y == 240 : "Keep the tail's furthest point in the replay path";
            for (int i = 1; i < samples.size(); i++) {
                assert samples.get(i).time >= samples.get(i - 1).time : "Keep path order";
            }

            detector.down(100, 200, 0);
            detector.move(100, 240, 20);
            detector.cancel();
            int count = replays.size();
            detector.up(100, 200, 40);
            assert replays.size() == count : "Cancelled touches must not replay";
            detector.down(100, 200, 50);
            detector.up(100, 200, 650);
            assert replays.getLast().size() == 2 && SwipeDetector.isTap(replays.getLast(), 8)
                    : "A new stationary long press must not retain the old trajectory";
        }
    }

    private static void pager() {
        float width = 1000;
        float fling = 600;
        assert PagerState.endpoint(PagerState.Page.HOME, width) == 0;
        assert PagerState.endpoint(PagerState.Page.CHAT, width) == width;
        assert PagerState.clamp(-1, width) == 0 && PagerState.clamp(1001, width) == width;
        assert PagerState.settle(PagerState.Page.HOME, 100, width, 0, fling, false)
                == PagerState.Page.HOME; // Short slow drag springs back.
        assert PagerState.settle(PagerState.Page.HOME, 280, width, 0, fling, false)
                == PagerState.Page.CHAT;
        assert PagerState.settle(PagerState.Page.HOME, 20, width, fling, fling, false)
                == PagerState.Page.CHAT;
        assert PagerState.settle(PagerState.Page.HOME, 900, width, -fling, fling, false)
                == PagerState.Page.HOME; // Reversing the fling returns toward the release direction.
        assert PagerState.settle(PagerState.Page.CHAT, 100, width, fling, fling, false)
                == PagerState.Page.CHAT;
        assert PagerState.settle(PagerState.Page.CHAT, 900, width, 0, fling, false)
                == PagerState.Page.CHAT;
        assert PagerState.settle(PagerState.Page.CHAT, 720, width, 0, fling, false)
                == PagerState.Page.HOME;
        assert PagerState.settle(PagerState.Page.CHAT, 980, width, -fling, fling, false)
                == PagerState.Page.HOME;
        assert PagerState.settle(PagerState.Page.CHAT, 100, width, fling, fling, true)
                == PagerState.Page.CHAT; // CANCEL restores the page enum, not the pixels.
        assert PagerState.endpoint(PagerState.Page.CHAT, 700) == 700;
    }

    private static void fluidGeometry() {
        assert FluidGestureGeometry.depth(-10f, 1f) == 0f;
        assert FluidGestureGeometry.depth(0f, 1f) == 0f;
        float bottomThreshold = FluidGestureGeometry.depth(10f, 1f);
        float at20 = FluidGestureGeometry.depth(20f, 1f);
        float at30 = FluidGestureGeometry.depth(30f, 1f);
        float near = FluidGestureGeometry.depth(24f, 1f);
        float far = FluidGestureGeometry.depth(240f, 1f);
        assert bottomThreshold > 12f; // Recognized bottom gesture remains a visible edge shape.
        assert bottomThreshold > at20 - bottomThreshold;
        assert at20 - bottomThreshold > at30 - at20; // Equal pulls add progressively less depth.
        assert near > bottomThreshold && far > near && far < 40f : near + ", " + far;
        assert FluidGestureGeometry.halfWidth(40f) < 152f; // Fits the 304dp canvas.

        float[] flat = new float[14];
        FluidGestureGeometry.points(0f, flat);
        for (float value : flat) assert value == 0f;
        float[] curve = new float[14];
        FluidGestureGeometry.points(32f, curve);
        assert curve[1] == 0f && curve[3] == 0f && curve[11] == 0f && curve[13] == 0f;
        for (int i = 1; i < curve.length; i += 2) assert curve[i] >= 0f;
        assert curve[5] == curve[7] && curve[7] == curve[9]; // Horizontal, C1 apex.
        assert curve[0] < curve[2] && curve[2] <= curve[4] && curve[4] < curve[6];
        assert curve[6] < curve[8] && curve[8] <= curve[10] && curve[10] < curve[12];
    }

    private static final class Ports implements NavigationSession.Ports {
        final List<String> calls = new ArrayList<>();
        boolean allowed = true;
        boolean pending;
        boolean attached;
        boolean failAttach;
        boolean failHide;
        boolean failShow;
        boolean failSave;
        public boolean ready() { return allowed; }
        public boolean pending() { return pending; }
        public boolean save(boolean value) {
            calls.add("save:" + value);
            if (failSave) return false;
            pending = value;
            return true;
        }
        public void attach() {
            calls.add("attach");
            attached = true;
            if (failAttach) throw new IllegalStateException("partial attach");
        }
        public void detach() { calls.add("detach"); attached = false; }
        public boolean navigation(boolean hidden) {
            calls.add(hidden ? "hide" : "show");
            return hidden ? !failHide : !failShow;
        }
    }

    private static void lifecycle() {
        List<Integer> attempted = new ArrayList<>();
        assert !AttemptAll.run(java.util.Arrays.asList(0, 1, 2), value -> {
            attempted.add(value);
            if (value == 0) throw new IllegalStateException("first window failed");
        });
        assert attempted.toString().equals("[0, 1, 2]") : attempted;

        Ports p = new Ports();
        NavigationSession session = new NavigationSession(p);
        p.allowed = false;
        assert !session.start() && p.calls.isEmpty();
        p.allowed = true;
        p.failAttach = true;
        assert !session.start() && !session.running() && !p.attached;
        p.failAttach = false;
        p.calls.clear();
        assert session.start() && session.enabled();
        assert p.calls.toString().equals("[attach, save:true, hide]") : p.calls;
        assert session.start();
        assert p.calls.size() == 3;
        p.failShow = true;
        p.calls.clear();
        assert !session.failSafeStop() && session.running() && p.attached && p.pending;
        assert !session.enabled(); // Degraded fallback must not report normal ON.
        assert p.calls.toString().equals("[show]") : p.calls; // No detach before restoring buttons.
        p.failShow = false;
        p.calls.clear();
        assert session.stop();
        assert p.calls.toString().equals("[show, save:false, detach]") : p.calls;
        assert session.stop() && p.calls.size() == 3;
        p.failHide = true;
        p.calls.clear();
        assert !session.start() && !session.running() && !p.pending;
        assert p.calls.toString().equals("[attach, save:true, hide, show, save:false, detach]");
        p.failShow = true;
        assert !session.start() && session.running() && p.pending && p.attached;
        assert !session.enabled() && !session.start(); // Fallback navigation is not ON.
        p.failShow = false;
        p.failSave = true;
        assert !session.stop() && session.running() && p.pending && p.attached;
        p.failSave = false;
        assert session.stop();
        p.failHide = false;
        p.pending = true;
        p.attached = false;
        p.allowed = false;
        NavigationSession reconnected = new NavigationSession(p);
        p.calls.clear();
        assert reconnected.recover() && p.pending && p.calls.isEmpty();
        p.allowed = true;
        p.calls.clear();
        assert reconnected.recover() && reconnected.enabled();
        assert p.calls.toString().equals("[attach, save:true, hide]") : p.calls;
        p.calls.clear();
        reconnected.suspend();
        assert p.pending && !reconnected.running() && !p.attached;
        assert p.calls.toString().equals("[detach]") : p.calls;
        p.calls.clear();
        assert reconnected.recover() && reconnected.enabled();
        assert p.calls.toString().equals("[attach, save:true, hide]") : p.calls;
        p.calls.clear();
        assert reconnected.stop();
        assert p.calls.toString().equals("[show, save:false, detach]") : p.calls;
        p.failSave = true;
        p.calls.clear();
        assert !reconnected.start() && !reconnected.running() && !p.attached;
        assert !p.calls.contains("hide");
    }

    private static void appSearch() {
        assert AppSearch.matches("相机", "com.android.camera", "相机");
        assert AppSearch.matches("Camera", "com.android.camera", " CAMERA ");
        assert AppSearch.matches("相机", "com.android.camera", "android.camera");
        assert AppSearch.matches("相机", "com.android.camera", "  ");
        assert !AppSearch.matches("相机", "com.android.camera", "地图");
    }

    public static void main(String[] args) {
        gestures();
        replaySamples();
        pager();
        fluidGeometry();
        lifecycle();
        appSearch();
        System.out.println("PASS: gestures, replay samples/touch slop, pager settle/restore, fluid geometry, navigation fail-safe ordering and local app search");
    }
}
