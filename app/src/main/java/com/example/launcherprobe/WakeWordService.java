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
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.util.List;

/**
 * Microphone foreground service that runs the wake word engine on the CPU. Third-party apps cannot use the
 * DSP hotword path, so this keeps a partial wake lock and releases the microphone whenever the voice
 * pipeline (dictation or read-aloud) needs it.
 */
public final class WakeWordService extends Service {
    private static final String TAG = "WakeWordService";
    private static final String CHANNEL = "wake_word";
    private static final int NOTIFICATION = 7201;
    private static final String ACTION_RELOAD = "com.example.launcherprobe.WAKE_RELOAD";
    private static final String ACTION_DISABLE = "com.example.launcherprobe.WAKE_DISABLE";
    private static final long RESUME_DELAY_MS = 800;

    private static volatile String status = "";
    private static WakeWordService running;

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean stopRequested, reload;
    private Thread worker;
    private PowerManager.WakeLock wakeLock;

    /** Starts or stops the service to match settings. Call while the app is in the foreground. */
    static void sync(Context context) { sync(context, false); }

    /** Also rebuilds the engine, after the wake words or sensitivity changed. */
    static void sync(Context context, boolean reload) {
        VoiceSettings settings = new VoiceSettings(context);
        Context app = context.getApplicationContext();
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
    /** Last engine state for the settings page, such as a model error. */
    static String status() { return status; }

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
        } catch (RuntimeException notAllowed) {
            Log.w(TAG, "Microphone foreground service refused", notAllowed);
            status = UiText.get(this, "系统拒绝在后台开启麦克风，请回到桌面后重试");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "launcherprobe:wake-word");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        if (worker == null || (intent != null && ACTION_RELOAD.equals(intent.getAction()))) reload = true;
        if (worker == null) {
            worker = new Thread(this::listen, "wake-word");
            worker.start();
        }
        // Not sticky: a microphone service restarted by the system from the background would be refused anyway.
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        stopRequested = true;
        if (worker != null) worker.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        running = null;
        super.onDestroy();
    }

    @android.annotation.SuppressLint("MissingPermission")
    private void listen() {
        WakeWordEngine engine = null;
        AudioRecord record = null;
        int frame = WakeWordEngine.SAMPLE_RATE / 10;
        short[] pcm = new short[frame];
        float[] samples = new float[frame];
        long resumeAt = 0;
        try {
            while (!stopRequested) {
                if (reload) {
                    reload = false;
                    if (engine != null) { engine.close(); engine = null; }
                    VoiceSettings settings = new VoiceSettings(this);
                    try {
                        List<String> words = WakeWords.split(settings.wakeWords());
                        engine = new WakeWordEngine(this, words, settings.wakeSensitivity());
                        status = "";
                    } catch (Exception failure) {
                        Log.e(TAG, "Wake word engine failed", failure);
                        status = UiText.get(this, "唤醒模型加载失败：") + failure.getMessage();
                        main.post(this::stopSelf);
                        return;
                    }
                    main.post(() -> notifyText(idleText()));
                }
                if (VoiceManager.busy()) {
                    // Give the microphone to dictation and keep our own read-aloud out of the detector.
                    if (record != null) { release(record); record = null; }
                    resumeAt = System.currentTimeMillis() + RESUME_DELAY_MS;
                    Thread.sleep(200);
                    continue;
                }
                if (System.currentTimeMillis() < resumeAt) { Thread.sleep(100); continue; }
                if (record == null) {
                    record = open(frame);
                    if (record == null) { Thread.sleep(2_000); continue; }
                }
                int read = record.read(pcm, 0, frame);
                if (read <= 0) { release(record); record = null; Thread.sleep(500); continue; }
                for (int i = 0; i < read; i++) samples[i] = pcm[i] / 32768f;
                String keyword = engine.accept(samples, read);
                if (keyword != null) {
                    // Release before handing over so the recognizer gets the microphone immediately.
                    release(record); record = null;
                    VoiceManager.holdForWake();
                    main.post(() -> VoiceManager.get(this).onWake(keyword));
                }
            }
        } catch (InterruptedException stopping) {
            Thread.currentThread().interrupt();
        } finally {
            if (record != null) release(record);
            if (engine != null) engine.close();
        }
    }

    @android.annotation.SuppressLint("MissingPermission")
    private AudioRecord open(int frame) {
        int min = AudioRecord.getMinBufferSize(WakeWordEngine.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        try {
            AudioRecord record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, WakeWordEngine.SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, frame * 4));
            if (record.getState() != AudioRecord.STATE_INITIALIZED) { record.release(); return null; }
            record.startRecording();
            return record;
        } catch (RuntimeException failure) {
            Log.w(TAG, "Cannot open microphone", failure);
            return null;
        }
    }

    private static void release(AudioRecord record) {
        try { record.stop(); } catch (IllegalStateException ignored) { }
        record.release();
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
