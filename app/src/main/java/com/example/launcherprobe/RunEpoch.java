package com.example.launcherprobe;

/** Fences persistence/UI callbacks from retired Activity instances. */
public final class RunEpoch {
    private long current;

    public synchronized long acquire() { return ++current; }
    public synchronized boolean owns(long value) { return current == value; }
    public synchronized void retire(long value) { if (current == value) current++; }
    public synchronized boolean runIfOwned(long value, Runnable action) {
        if (current != value) return false;
        action.run();
        return true;
    }
}
