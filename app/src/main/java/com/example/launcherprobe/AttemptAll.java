package com.example.launcherprobe;

import java.util.List;
import java.util.function.Consumer;

/** Runs every cleanup/update attempt even when one target rejects it. */
final class AttemptAll {
    private AttemptAll() { }

    static <T> boolean run(List<T> targets, Consumer<T> attempt) {
        boolean succeeded = true;
        for (T target : targets) {
            try {
                attempt.accept(target);
            } catch (RuntimeException exception) {
                succeeded = false;
            }
        }
        return succeeded;
    }
}
