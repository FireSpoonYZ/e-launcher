package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.util.concurrent.CancellationException;

/**
 * M15 本地 AI Host 前台服务：non-exported specialUse FGS，仅显式用户 START/STOP。
 * 无自动启动/粘性重启/空闲关闭。启动先 startForeground 再异步 start；
 * 停止/失败在 Manager 实际关闭后才移除前台与通知；未知/null action 绝不拉起 Runtime。
 */
public final class BotHostService extends Service {

    static final String ACTION_START = "com.example.launcherprobe.action.HOST_START";
    static final String ACTION_STOP = "com.example.launcherprobe.action.HOST_STOP";

    private static final String CHANNEL = "bot-host";
    private static final int NOTIFICATION_ID = 3150;
    private static final int ERROR_NOTIFICATION_ID = 3151;
    private static final int REQUEST_NOTIFICATIONS = 3109;

    private final Handler main = new Handler(Looper.getMainLooper());

    /** 显式可见用户入口：通知权限经前台 Activity 流程请求；FGS 启动失败向调用方传播。 */
    public static void startFromActivity(Activity activity) {
        if (activity == null || activity.isFinishing()) throw new IllegalArgumentException("需要前台 Activity");
        if (Build.VERSION.SDK_INT >= 33
                && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        }
        activity.startForegroundService(new Intent(activity, BotHostService.class).setAction(ACTION_START));
    }

    /** 显式用户停止入口：仅当服务运行（应用处前台）时才会真正投递 STOP。 */
    public static void stopFromUser(Context context) {
        try {
            context.startService(new Intent(context, BotHostService.class).setAction(ACTION_STOP));
        } catch (RuntimeException ignored) {
            // 服务未运行或受限：无需停止。
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "AI Host", NotificationManager.IMPORTANCE_LOW));
        BotHostManager.get(this).attachService(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (!ACTION_START.equals(action) && !ACTION_STOP.equals(action)) {
            // 拒绝 null/未知 action：不拉起 Runtime。
            return START_NOT_STICKY;
        }
        BotHostManager manager = BotHostManager.get(this);
        if (ACTION_STOP.equals(action)) {
            manager.stop().whenComplete((v, ex) -> main.post(() -> {
                if (!BotHostManager.get(this).isActiveService(this)) return;
                if (ex == null) getSystemService(NotificationManager.class).cancel(ERROR_NOTIFICATION_ID);
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf(startId);
            }));
            return START_NOT_STICKY;
        }
        // ACTION_START：先前台，再异步启动；ready 前绝不报告 running。
        startForeground(NOTIFICATION_ID, notification("正在启动"));
        manager.start().whenComplete((snapshot, ex) -> {
            if (ex != null) {
                main.post(() -> {
                    if (!BotHostManager.get(this).isActiveService(this)) return;
                    if (!(ex instanceof CancellationException)) showError("AI Host 启动失败");
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf(startId);
                });
            } else {
                main.post(() -> {
                    if (BotHostManager.get(this).isActiveService(this)) refreshNotification();
                });
            }
        });
        return START_NOT_STICKY;
    }

    /** Manager 状态变化（reader/control 线程回调，转主线程刷新通知）。 */
    void onManagerStateChanged() {
        main.post(this::refreshNotification);
    }

    /** Manager 实际关闭完成：移除前台与陈旧通知；失败时安全展示一次错误。 */
    void onManagerStopped(boolean failed, String code) {
        main.post(() -> {
            if (!BotHostManager.get(this).isActiveService(this)) return;
            if (failed && code != null && !code.isEmpty()) {
                showError("AI Host 已停止：" + code);
            } else if (!failed) {
                getSystemService(NotificationManager.class).cancel(ERROR_NOTIFICATION_ID);
            }
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        });
    }

    private void refreshNotification() {
        if (BotHostManager.get(this).snapshot().optString("phase").equals("running")) {
            getSystemService(NotificationManager.class).cancel(ERROR_NOTIFICATION_ID);
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification("本地 AI Host 正在运行"));
        }
    }

    private void showError(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                openHostIntent(),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        getSystemService(NotificationManager.class).notify(ERROR_NOTIFICATION_ID,
                new Notification.Builder(this, CHANNEL)
                        .setSmallIcon(android.R.drawable.stat_notify_error)
                        .setContentTitle("AI Host")
                        .setContentText(text)
                        .setContentIntent(open)
                        .setAutoCancel(true)
                        .build());
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 1,
                openHostIntent(),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 2,
                new Intent(this, BotHostService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("AI Host")
                .setContentText(text)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_close_clear_cancel, "停止", stop).build())
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
    }

    /** 打开宿主设置路由：UI lane 读取 assistant_open_host 进入 /settings/host。 */
    private Intent openHostIntent() {
        return new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("assistant_open_host", true);
    }

    @Override public void onDestroy() {
        BotHostManager manager = BotHostManager.get(this);
        manager.onServiceDestroyed(this);
        manager.detachService(this);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}
