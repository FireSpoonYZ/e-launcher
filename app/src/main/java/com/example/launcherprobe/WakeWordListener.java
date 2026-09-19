package com.example.launcherprobe;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.util.List;

/**
 * Runs the wake word engine on a background thread. It owns the microphone only while the voice pipeline is idle
 * and keeps a partial wake lock so detection continues with the screen off.
 */
final class WakeWordListener {
    interface Host {
        /** Main thread. The microphone is already released and VoiceManager holds it for the hand-off. */
        void onWake(String keyword);
        /** Main thread. The engine could not start; the listener has stopped. */
        void onFailure(String message);
    }

    private static final String TAG = "WakeWordListener";
    private static final long RESUME_DELAY_MS = 800;
    private static volatile String status = "";

    private final Context context;
    private final Host host;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final PowerManager.WakeLock wakeLock;
    private volatile boolean stopRequested, reload = true;
    private Thread worker;

    WakeWordListener(Context context, Host host) {
        this.context = context.getApplicationContext();
        this.host = host;
        wakeLock = this.context.getSystemService(PowerManager.class)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "launcherprobe:wake-word");
        wakeLock.setReferenceCounted(false);
    }

    /** Last engine error for the settings page, or empty. */
    static String status() { return status; }

    void start() {
        if (worker != null) return;
        wakeLock.acquire();
        worker = new Thread(this::listen, "wake-word");
        worker.start();
    }

    /** Rebuilds the engine after wake words or sensitivity changed. */
    void reload() { reload = true; }

    void stop() {
        stopRequested = true;
        if (worker != null) worker.interrupt();
        worker = null;
        if (wakeLock.isHeld()) wakeLock.release();
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
                    VoiceSettings settings = new VoiceSettings(context);
                    try {
                        List<String> words = WakeWords.split(settings.wakeWords());
                        engine = new WakeWordEngine(context, words, settings.wakeSensitivity());
                        status = "";
                    } catch (Exception failure) {
                        Log.e(TAG, "Wake word engine failed", failure);
                        status = UiText.get(context, "唤醒模型加载失败：") + failure.getMessage();
                        String message = status;
                        main.post(() -> { stop(); host.onFailure(message); });
                        return;
                    }
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
                    main.post(() -> { if (!stopRequested) host.onWake(keyword); else VoiceManager.releaseWakeHold(); });
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
}
