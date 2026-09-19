package com.example.launcherprobe;

import android.annotation.SuppressLint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import java.util.Arrays;

/**
 * One microphone kept open for a whole voice conversation. A single recording thread feeds the endpointer, so the
 * stream can hear the user start talking while a reply is still playing. Callbacks arrive on the main thread.
 *
 * <p>Echo from our own playback is handled by the platform canceller plus a short grace window after playback
 * starts; without a canceller on the device the grace window alone is not enough, so hosts should route read-aloud
 * through the earpiece or accept that loud speaker output can trigger a false interruption.
 */
final class VoiceStream {
    interface Listener {
        /** 0..1 loudness of the last frame, for the listening indicator. */
        void onLevel(float level);
        void onSpeechActivity(boolean speaking);
        /** The user started talking. While a reply is playing this is the interruption signal. */
        void onSpeechStart();
        /** A complete utterance, already WAV-encoded for transcription. */
        void onUtterance(byte[] wav);
        /** Nobody has said anything for a long time; the host decides whether to close the session. */
        void onIdle();
        void onError(String message);
    }

    /** Playback leaks into the microphone for a moment after it starts; ignore that much audio. */
    private static final long PLAYBACK_GRACE_MS = 400;
    private static final long IDLE_TIMEOUT_MS = 120_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private volatile boolean stopRequested, muted;
    private volatile long playingSince = -1;
    private Thread worker;

    VoiceStream(Listener listener) { this.listener = listener; }

    void start() {
        if (worker != null) return;
        worker = new Thread(this::run, "voice-stream");
        worker.start();
    }

    void stop() {
        stopRequested = true;
        Thread current = worker;
        worker = null;
        if (current != null) current.interrupt();
    }

    /** Tells the stream that read-aloud is playing, so it can discount its own echo. Any thread. */
    void setPlaying(boolean playing) { playingSince = playing ? SystemClock.elapsedRealtime() : -1; }

    /** Drops every frame while muted; the microphone stays open so unmuting is instant. Any thread. */
    void setMuted(boolean value) { muted = value; }

    boolean muted() { return muted; }

    @SuppressLint("MissingPermission")
    private void run() {
        int frame = RemoteVoiceApi.SAMPLE_RATE * SpeechEndpointer.FRAME_MS / 1000;
        int minBuffer = AudioRecord.getMinBufferSize(RemoteVoiceApi.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord record;
        try {
            record = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RemoteVoiceApi.SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuffer, frame * 16));
        } catch (RuntimeException failure) { post(() -> listener.onError("无法打开麦克风")); return; }
        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            record.release();
            post(() -> listener.onError("无法打开麦克风"));
            return;
        }
        AcousticEchoCanceler canceller = attachCanceller(record.getAudioSessionId());
        NoiseSuppressor suppressor = attachSuppressor(record.getAudioSessionId());
        SpeechEndpointer endpointer = new SpeechEndpointer();
        short[] samples = new short[RemoteVoiceApi.SAMPLE_RATE * 4];
        short[] buffer = new short[frame];
        int count = 0;
        boolean announced = false;
        long quietSince = SystemClock.elapsedRealtime();
        try {
            record.startRecording();
            while (!stopRequested) {
                int read = record.read(buffer, 0, frame);
                if (read < 0) { post(() -> listener.onError("麦克风录音失败")); return; }
                if (muted || withinPlaybackGrace()) {
                    post(() -> listener.onSpeechActivity(false));
                    count = 0; announced = false; endpointer = new SpeechEndpointer(); continue;
                }
                if (count + read > samples.length) samples = Arrays.copyOf(samples, samples.length * 2);
                System.arraycopy(buffer, 0, samples, count, read);
                count += read;
                SpeechEndpointer.State state = endpointer.feed(buffer, read);
                float level = endpointer.level();
                post(() -> listener.onLevel(level));
                if (!announced && state == SpeechEndpointer.State.SPEAKING) {
                    announced = true;
                    post(listener::onSpeechStart);
                }
                boolean speechActive = endpointer.speechActive();
                post(() -> listener.onSpeechActivity(speechActive));
                if (state == SpeechEndpointer.State.DONE || state == SpeechEndpointer.State.TOO_LONG) {
                    byte[] wav = RemoteVoiceApi.wav(samples, count);
                    post(() -> listener.onUtterance(wav));
                    quietSince = SystemClock.elapsedRealtime();
                } else if (state != SpeechEndpointer.State.NO_SPEECH) {
                    if (announced) quietSince = SystemClock.elapsedRealtime();
                    continue;
                } else if (SystemClock.elapsedRealtime() - quietSince >= IDLE_TIMEOUT_MS) {
                    post(listener::onIdle);
                    quietSince = SystemClock.elapsedRealtime();
                }
                // DONE, TOO_LONG and NO_SPEECH all end a cycle; listen again without reopening the microphone.
                count = 0;
                announced = false;
                endpointer = new SpeechEndpointer();
            }
        } catch (RuntimeException failure) {
            if (!stopRequested) post(() -> listener.onError("麦克风录音失败"));
        } finally {
            release(canceller, suppressor);
            try { record.stop(); } catch (IllegalStateException ignored) { }
            record.release();
        }
    }

    private boolean withinPlaybackGrace() {
        long started = playingSince;
        return started >= 0 && SystemClock.elapsedRealtime() - started < PLAYBACK_GRACE_MS;
    }

    private void post(Runnable callback) {
        main.post(() -> { if (!stopRequested) callback.run(); });
    }

    private static AcousticEchoCanceler attachCanceller(int session) {
        if (!AcousticEchoCanceler.isAvailable()) return null;
        try {
            AcousticEchoCanceler canceller = AcousticEchoCanceler.create(session);
            if (canceller != null) canceller.setEnabled(true);
            return canceller;
        } catch (RuntimeException unavailable) { return null; }
    }

    private static NoiseSuppressor attachSuppressor(int session) {
        if (!NoiseSuppressor.isAvailable()) return null;
        try {
            NoiseSuppressor suppressor = NoiseSuppressor.create(session);
            if (suppressor != null) suppressor.setEnabled(true);
            return suppressor;
        } catch (RuntimeException unavailable) { return null; }
    }

    private static void release(AcousticEchoCanceler canceller, NoiseSuppressor suppressor) {
        try { if (canceller != null) canceller.release(); } catch (RuntimeException ignored) { }
        try { if (suppressor != null) suppressor.release(); } catch (RuntimeException ignored) { }
    }
}
