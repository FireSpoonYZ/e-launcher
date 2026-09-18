package com.example.launcherprobe;

import android.content.Context;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/** Enqueues the unique daily archive purge. Tests without WorkManager skip scheduling. */
final class ArchiveCleanupScheduler {
    static final String UNIQUE_WORK_NAME = "archive-cleanup";

    private ArchiveCleanupScheduler() { }

    static void schedule(Context context) {
        try {
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                    ArchiveCleanupWorker.class, 1, TimeUnit.DAYS).build();
            WorkManager.getInstance(context.getApplicationContext())
                    .enqueueUniquePeriodicWork(UNIQUE_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);
        } catch (IllegalStateException ignored) {
            // Robolectric unit tests may not initialize WorkManager.
        }
    }
}
