package com.example.launcherprobe;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** Daily WorkManager entry that permanently deletes expired archives through ChatCoordinator. */
public final class ArchiveCleanupWorker extends Worker {
    public ArchiveCleanupWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull @Override public Result doWork() {
        ChatCoordinator.get(getApplicationContext()).purgeExpiredArchives();
        return Result.success();
    }
}
