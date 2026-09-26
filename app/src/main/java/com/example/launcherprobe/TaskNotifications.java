package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

/** Reminders never control execution; one replaceable notification per conversation. */
final class TaskNotifications {
    static final String CHANNEL = "task-attention";
    static final int ID = 1;
    private final Context context;

    TaskNotifications(Context context) { this.context = context; }

    static void requestPermission(Activity activity) {
        if (Build.VERSION.SDK_INT < 33 || activity == null || activity.isFinishing()
                || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            return;
        android.content.SharedPreferences preferences = activity.getSharedPreferences("task_notifications", Context.MODE_PRIVATE);
        if (preferences.getBoolean("permission_requested", false)) return;
        preferences.edit().putBoolean("permission_requested", true).apply();
        activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 3108);
    }

    void show(String id, String title, boolean question, String status) {
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "任务提醒", NotificationManager.IMPORTANCE_DEFAULT));
            if (!manager.areNotificationsEnabled()) return;
            String text = question ? "需要你回答" : "error".equals(status) ? "执行失败"
                    : "aborted".equals(status) ? "任务已中断" : "任务已完成";
            Intent intent = new Intent(context, TaskDetailActivity.class)
                    .setData(new Uri.Builder().scheme("launcher-task").authority("conversation").appendPath(id).build())
                    .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id);
            PendingIntent open = PendingIntent.getActivity(context, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            manager.notify(id, ID, new Notification.Builder(context, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(text)
                    .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true)
                    .setVisibility(Notification.VISIBILITY_PRIVATE).setCategory(Notification.CATEGORY_STATUS).build());
        } catch (SecurityException ignored) { /* Revoking permission must not interrupt a task. */ }
    }

    void cancel(String id) {
        try { context.getSystemService(NotificationManager.class).cancel(id, ID); }
        catch (SecurityException ignored) { }
    }
}
