package com.example.launcherprobe;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

/** Prevents queued device actions from starting after cancellation, timeout, or service replacement. */
public final class ActionFence {
    private static final int PENDING = 0;
    private static final int STARTED = 1;
    private static final int EXPIRED = 2;
    private final AgentLoop.Cancellation cancellation;
    private final BooleanSupplier identityCurrent;
    private final AtomicInteger state = new AtomicInteger(PENDING);

    public ActionFence(AgentLoop.Cancellation cancellation, BooleanSupplier identityCurrent) {
        this.cancellation = cancellation;
        this.identityCurrent = identityCurrent;
    }

    public boolean tryStart() {
        if (cancellation.cancelled() || !identityCurrent.getAsBoolean()
                || !state.compareAndSet(PENDING, STARTED)) return false;
        return !cancellation.cancelled() && identityCurrent.getAsBoolean();
    }

    public void expire() { state.compareAndSet(PENDING, EXPIRED); }
    public boolean started() { return state.get() == STARTED; }
}
