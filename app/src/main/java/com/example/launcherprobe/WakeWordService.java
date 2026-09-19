package com.example.launcherprobe;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.util.Log;

/**
 * Fallback host for wake word detection when this app is not the default assistant: a microphone foreground
 * service with a persistent notification. As the default assistant, LauncherVoiceInteractionService hosts the
 * listener instead, kept running by the system without a notification.
 */
public final class WakeWordService extends Service {
    private static final String TAG = "WakeWordService";
    private static final String CHANNEL = "wake_word";
    private static final int NOTIFICATION = 7201;
    private static final String ACTION_RELOAD = "com.example.launcherprobe.WAKE_RELOAD";
    private static final String ACTION_DISABLE = "com.example.launcherprobe.WAKE_DISABLE";

    private static volatile String status = "";
    private static WakeWordService running;

    private WakeWordListener listener;

    /** Starts or stops wake word detection to match settings. Call while the app is in the foreground. */
    static void sync(Context context) { sync(context, false); }

    /** Also rebuilds the engine, after the wake words or sensitivity changed. */
    static void sync(Context context, boolean reload) {
        Context app = context.getApplicationContext();
        if (LauncherVoiceInteractionService.isDefaultAssistant(app)) {
            // The assistant service is kept running by the system; no notification is needed.
            app.stopService(new Intent(app, WakeWordService.class));
            LauncherVoiceInteractionService.sync(reload);
            return;
        }
        VoiceSettings settings = new VoiceSettings(app);
        if (!settings.wakeEnabled() || app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            app.stopService(new Intent(app, WakeWordService.class));
            return;
        }
        try { app.startForegroundService(new Intent(app, WakeWordService.class).setAction(reload ? ACTION_RELOAD : null)); }
        catch (RuntimeException notAllowed) {
            // Android 14 refuses microphone services started from the background; the next resume retries.
            Log.w(TAG, "Cannot start wake word service now", notAllowed);
        }
    }

    static boolean isRunning() { return running != null; }
    /** Last start or engine error for the settings page, or empty. */
    static String status() { return !status.isEmpty() ? status : WakeWordListener.status(); }

    /** Shows the voice pipeline's progress in the notification; null restores the idle text. Main thread. */
    static void showProgress(String text) {
        WakeWordService service = running;
        if (service != null) service.notifyText(text == null ? service.idleText() : text);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, UiText.get(this, "语音唤醒"), NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        notifications.createNotificationChannel(channel);
        running = this;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_DISABLE.equals(intent.getAction())) {
            new VoiceSettings(this).setWakeEnabled(false);
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                startForeground(NOTIFICATION, notification(idleText()), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else startForeground(NOTIFICATION, notification(idleText()));
            status = "";
        } catch (RuntimeException notAllowed) {
            Log.w(TAG, "Microphone foreground service refused", notAllowed);
            status = UiText.get(this, "系统拒绝在后台开启麦克风，请回到桌面后重试");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (listener == null) {
            listener = new WakeWordListener(this, new WakeWordListener.Host() {
                @Override public void onWake(String keyword) { VoiceManager.get(WakeWordService.this).onWake(keyword); }
                @Override public void onFailure(String message) { stopSelf(); }
            });
            listener.start();
        } else if (intent != null && ACTION_RELOAD.equals(intent.getAction())) listener.reload();
        // Not sticky: a microphone service restarted by the system from the background would be refused anyway.
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        if (listener != null) listener.stop();
        running = null;
        super.onDestroy();
    }

    private String idleText() {
        return UiText.get(this, "正在等待唤醒词：") + new VoiceSettings(this).wakeWords();
    }

    private void notifyText(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(text));
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent disable = PendingIntent.getService(this, 1, new Intent(this, WakeWordService.class)
                .setAction(ACTION_DISABLE), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle(UiText.get(this, "语音唤醒"))
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, UiText.get(this, "关闭唤醒"), disable).build())
                .build();
    }
}
