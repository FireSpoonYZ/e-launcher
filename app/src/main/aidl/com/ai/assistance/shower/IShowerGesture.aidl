package com.ai.assistance.shower;

/** Per-call cancellation state, queried independently of the blocking swipe transaction. */
interface IShowerGesture {
    boolean isCancelled();
}
