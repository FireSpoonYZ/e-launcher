package com.example.launcherprobe;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.os.PowerManager;

/** Keeps user-started agent turns alive while the app UI is in the background. */
public final class ChatExecutionService extends Service {
    private static final String CHANNEL = "chat-execution";
    private static final int NOTIFICATION_ID = 3107;
    private static final String EXTRA_COUNT = "activeCount";
    private static final String EXTRA_GENERATION = "generation";
    private static long generation;
    private static int activeCount;
    private static boolean foreground;
    private PowerManager.WakeLock executionWakeLock;

    static synchronized void setActiveCount(Context context, int count) {
        activeCount = Math.max(0, count);
        long next = ++generation;
        Intent service = new Intent(context, ChatExecutionService.class)
                .putExtra(EXTRA_COUNT, activeCount).putExtra(EXTRA_GENERATION, next);
        if (activeCount == 0) {
            // A pending start must reach onStartCommand and promote before it may stop.
            if (foreground) {
                foreground = false;
                context.stopService(service);
            }
        } else if (foreground) {
            context.getSystemService(NotificationManager.class).notify(NOTIFICATION_ID,
                    notification(context, activeCount));
        } else {
            context.startForegroundService(service);
        }
    }

    private static synchronized int countFor(long requestedGeneration) {
        return requestedGeneration == generation ? activeCount : -1;
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL, "Pi 后台任务",
                NotificationManager.IMPORTANCE_LOW));
        executionWakeLock = getSystemService(PowerManager.class).newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK, "launcherprobe:chat-execution");
        executionWakeLock.setReferenceCounted(false);
    }

    @SuppressLint("WakelockTimeout") // Bound to the foreground service; onDestroy always releases it.
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        long requestedGeneration = intent == null ? -1 : intent.getLongExtra(EXTRA_GENERATION, -1);
        synchronized (ChatExecutionService.class) {
            int count = countFor(requestedGeneration);
            // Each foreground-service start needs promotion, including stale commands
            // delivered to an already-created service after a rapid stop/restart.
            startForeground(NOTIFICATION_ID, notification(this, Math.max(1, activeCount)),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            if (count < 1) {
                if (activeCount == 0) {
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf(startId);
                }
                return START_NOT_STICKY;
            }
            if (!executionWakeLock.isHeld()) executionWakeLock.acquire();
            foreground = true;
        }
        return START_NOT_STICKY;
    }

    private static Notification notification(Context context, int count) {
        PendingIntent open = PendingIntent.getActivity(context, 0,
                new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Pi 正在处理任务")
                .setContentText(count == 1 ? "1 个会话正在运行" : count + " 个会话正在运行")
                .setContentIntent(open)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
    }

    /** Android 15+ dataSync budget expiry: release the FGS before fencing interrupted turns. */
    @Override public void onTimeout(int startId, int fgsType) {
        setActiveCount(this, 0);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf(startId);
        ChatCoordinator.get(this).foregroundServiceTimedOut();
    }

    @Override public void onDestroy() {
        if (executionWakeLock != null && executionWakeLock.isHeld()) executionWakeLock.release();
        synchronized (ChatExecutionService.class) { foreground = false; }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
