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

    private static void gestures() {
        Clock clock = new Clock();
        List<String> actions = new ArrayList<>();
        SwipeDetector bottom = new SwipeDetector(SwipeDetector.Zone.BOTTOM, 1, clock,
                () -> actions.add("home"), () -> actions.add("recents"),
                samples -> actions.add("replay"));
        bottom.down(100, 200, 0);
        bottom.move(100, 191, 20);
        bottom.up(100, 191, 40);
        assert actions.toString().equals("[replay]") : actions;
        actions.clear();
        bottom.down(100, 200, 50);
        bottom.move(100, 190, 70);
        bottom.up(100, 180, 90);
        clock.advance(400);
        assert actions.toString().equals("[home]") : actions;
        actions.clear();
        bottom.down(100, 200, 100);
        bottom.move(100, 180, 120);
        clock.advance(250);
        bottom.move(100, 160, 370);
        clock.advance(250);
        assert actions.isEmpty();
        clock.advance(50);
        bottom.up(100, 160, 700);
        assert actions.toString().equals("[recents]") : actions;
        actions.clear();
        for (int i = 0; i < 3; i++) {
            bottom.down(100, 200, 0);
            bottom.move(100, 180, 20);
            // Android CANCEL, POINTER_DOWN and teardown/rotation share this reset.
            Runnable staleHold = clock.pending;
            bottom.cancel();
            staleHold.run(); // A late callback must also be inert.
            clock.advance(500);
            bottom.up(100, 180, 600);
        }
        assert actions.isEmpty();
        bottom.down(100, 200, 0);
        bottom.move(100, 180, 1001);
        bottom.up(100, 180, 1100);
        assert actions.toString().equals("[replay]");
        actions.clear();
        for (SwipeDetector.Zone zone : new SwipeDetector.Zone[]{
                SwipeDetector.Zone.LEFT, SwipeDetector.Zone.RIGHT}) {
            SwipeDetector side = new SwipeDetector(zone, 1, clock,
                    () -> actions.add("back"), null, samples -> actions.add("replay"));
            int dx = zone == SwipeDetector.Zone.LEFT ? 24 : -24;
            side.down(100, 200, 0);
            side.move(100 - dx, 200, 20);
            side.up(100 - dx, 200, 30);
            side.down(100, 200, 0);
            side.move(100 + dx, 230, 20); // Too diagonal.
            side.up(100 + dx, 230, 30);
            side.down(100, 200, 0);
            side.move(100 + dx, 200, 20);
            side.up(100 + dx, 200, 30);
        }
        assert actions.toString().equals("[replay, replay, back, replay, replay, back]");
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
        p.pending = true; // Interrupted process: new coordinator, no live overlays.
        NavigationSession reconnected = new NavigationSession(p);
        p.calls.clear();
        p.failShow = true;
        assert !reconnected.recover() && p.pending;
        assert !reconnected.start() && !p.calls.contains("attach");
        p.failShow = false;
        p.calls.clear();
        assert reconnected.recover();
        assert p.calls.toString().equals("[show, save:false, detach]");
        p.failHide = false;
        p.failSave = true;
        assert !reconnected.start() && !reconnected.running() && !p.attached;
        assert !p.calls.contains("hide");
    }

    public static void main(String[] args) {
        gestures();
        lifecycle();
        System.out.println("PASS: gestures/cancellation, all-window attempts and navigation fail-safe ordering");
    }
}
