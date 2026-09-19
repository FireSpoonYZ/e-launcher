package com.example.launcherprobe;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Reads text aloud with the system TTS engine or an OpenAI-compatible speech endpoint. A new speak() replaces the old one. */
final class SpeechOutput {
    private static final int SYSTEM_CHUNK = 3_000, REMOTE_CHUNK = 400;
    private static final AudioAttributes ATTRIBUTES = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();

    private final Context context;
    private final VoiceSettings settings;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService remote = Executors.newCachedThreadPool();
    private final AtomicInteger generation = new AtomicInteger();
    private final AudioManager audio;
    private AudioFocusRequest focus;
    private TextToSpeech tts;
    private boolean ttsReady, ttsFailed;
    private final List<Runnable> waitingForTts = new ArrayList<>();
    private volatile MediaPlayer player;
    private volatile PcmSpeech pcm;
    private volatile okhttp3.Call remoteCall;
    private volatile boolean speaking;
    private java.util.concurrent.BlockingQueue<String> streamQueue = new java.util.concurrent.LinkedBlockingQueue<>();
    private volatile boolean streamEnded;
    private int streamToken = -1, streamPending;
    private Runnable streamDrained;
    interface PlaybackListener { void onPlayback(boolean active, float level); }
    private PlaybackListener playbackListener;
    private android.media.audiofx.Visualizer meter;
    private int ttsAudioSession;

    SpeechOutput(Context context, VoiceSettings settings) {
        this.context = context.getApplicationContext();
        this.settings = settings;
        audio = this.context.getSystemService(AudioManager.class);
    }

    boolean speaking() { return speaking; }

    /** Optional voice-mode animation feedback. Call on the main thread. */
    void setPlaybackListener(PlaybackListener listener) {
        playbackListener = listener;
        if (listener == null) stopMeter();
    }

    /** Loads the system engine ahead of time so the first utterance does not pay the cold start. */
    void prewarm() { main.post(() -> withTts(() -> { })); }

    /**
     * Starts reading a reply that is still being generated. Sentences arrive through offer(); endStream() marks the
     * last one and drained runs on the main thread once everything has played. stop() abandons the stream.
     */
    void beginStream(Runnable drained) {
        stop();
        streamQueue = new java.util.concurrent.LinkedBlockingQueue<>();
        streamEnded = false;
        streamPending = 0;
        streamDrained = drained;
        streamToken = generation.get();
        speaking = true;
        requestFocus();
        if (VoiceSettings.REMOTE.equals(settings.ttsEngine())) {
            int token = streamToken;
            VoiceSettings.Remote config = settings.remote(VoiceSettings.TTS);
            java.util.concurrent.BlockingQueue<String> queue = streamQueue;
            remote.execute(() -> streamRemote(token, config, queue));
        }
    }

    /** One more piece of the reply to read, in Markdown. Main thread. */
    void offer(String markdown) {
        String text = SpeechText.plain(markdown);
        if (text.isEmpty() || streamToken != generation.get()) return;
        if (VoiceSettings.REMOTE.equals(settings.ttsEngine())) {
            for (String chunk : SpeechText.chunks(text, REMOTE_CHUNK)) streamQueue.offer(chunk);
        }
        else speakStreamChunk(streamToken, text);
    }

    /** No more sentences will be offered. Main thread. */
    void endStream() {
        if (streamToken != generation.get()) return;
        streamEnded = true;
        if (VoiceSettings.REMOTE.equals(settings.ttsEngine())) streamQueue.offer(STREAM_END);
        else if (streamPending == 0) finishStream(streamToken);
    }

    private static final String STREAM_END = "\u0000end";

    void speak(String markdown) {
        String text = SpeechText.plain(markdown);
        stop();
        if (text.isEmpty()) return;
        int token = generation.get();
        speaking = true;
        requestFocus();
        if (VoiceSettings.REMOTE.equals(settings.ttsEngine())) {
            VoiceSettings.Remote config = settings.remote(VoiceSettings.TTS);
            if ("kokoro".equalsIgnoreCase(config.model)) {
                java.util.concurrent.BlockingQueue<String> queue = new java.util.concurrent.LinkedBlockingQueue<>();
                queue.addAll(SpeechText.chunks(text, REMOTE_CHUNK));
                queue.add(STREAM_END);
                remote.execute(() -> streamPcm(token, config, queue, false));
            } else remote.execute(() -> speakRemote(token, config, SpeechText.chunks(text, REMOTE_CHUNK), text));
        } else speakSystem(token, text);
    }

    /** Wake acknowledgements use the selected voice; remote audio is generated once per configuration. */
    void speakGreeting(Runnable drained) {
        String text = UiText.get(context, "我在");
        if (!VoiceSettings.REMOTE.equals(settings.ttsEngine())) {
            beginStream(drained);
            offer(text);
            endStream();
            return;
        }
        stop();
        int token = generation.get();
        streamToken = token;
        streamDrained = drained;
        speaking = true;
        requestFocus();
        VoiceSettings.Remote config = settings.remote(VoiceSettings.TTS);
        float rate = settings.speechRate();
        remote.execute(() -> {
            PcmSpeech owned = null;
            String problem = null;
            try {
                boolean rawPcm = "kokoro".equalsIgnoreCase(config.model);
                File cached = GreetingAudioCache.file(new File(context.getCacheDir(), "voice-greetings"), config, rate, text);
                GreetingAudioCache.get(cached, () -> {
                    okhttp3.Call call = RemoteVoiceApi.speechCall(config, text, rate);
                    synchronized (this) {
                        if (token != generation.get()) throw new java.io.IOException("已取消");
                        remoteCall = call;
                    }
                    // A failed service must not leave the microphone muted for its full read timeout.
                    call.timeout().timeout(10, TimeUnit.SECONDS);
                    try (okhttp3.Response response = RemoteVoiceApi.speechResponse(call)) {
                        okhttp3.MediaType type = response.body().contentType();
                        if (rawPcm && (type == null || !"audio".equals(type.type()) || !"pcm".equals(type.subtype())))
                            throw new java.io.IOException("Kokoro 必须返回 PCM 音频");
                        byte[] bytes = response.body().bytes();
                        if (rawPcm && (bytes.length & 1) != 0) throw new java.io.IOException("PCM 音频不完整");
                        if (token != generation.get()) throw new java.io.IOException("已取消");
                        return bytes;
                    } finally {
                        if (remoteCall == call) remoteCall = null;
                    }
                });
                if (token != generation.get()) return;
                if (rawPcm) {
                    owned = new PcmSpeech(ATTRIBUTES);
                    synchronized (this) {
                        if (token != generation.get()) return;
                        pcm = owned;
                    }
                    try (java.io.FileInputStream input = new java.io.FileInputStream(cached)) {
                        owned.append(input, () -> token == generation.get());
                        owned.drain(() -> token == generation.get());
                    }
                } else play(token, cached);
            } catch (Exception failure) {
                problem = failure.getMessage();
            } finally {
                synchronized (this) { if (pcm == owned) pcm = null; }
                if (owned != null) owned.close();
                String message = problem;
                main.post(() -> {
                    if (token != generation.get()) return;
                    if (message != null) Toast.makeText(context, "唤醒问候播放失败：" + message, Toast.LENGTH_SHORT).show();
                    finishStream(token);
                });
            }
        });
    }

    synchronized void stop() {
        generation.incrementAndGet();
        streamQueue.clear();
        streamDrained = null;
        okhttp3.Call call = remoteCall;
        if (call != null) call.cancel();
        PcmSpeech currentPcm = pcm;
        if (currentPcm != null) currentPcm.stop();
        MediaPlayer current = player;
        if (current != null) main.post(() -> { try { current.stop(); } catch (IllegalStateException ignored) { } });
        if (Looper.myLooper() == Looper.getMainLooper()) {
            stopMeter();
            if (tts != null && ttsReady) tts.stop();
        } else main.post(() -> { stopMeter(); if (tts != null && ttsReady) tts.stop(); });
        done(-1);
    }

    void shutdown() {
        stop();
        main.post(() -> { if (tts != null) tts.shutdown(); tts = null; });
        remote.shutdownNow();
    }

    private void speakSystem(int token, String text) {
        main.post(() -> withTts(() -> {
            if (token != generation.get()) return;
            if (ttsFailed) { failed(token, "系统语音合成不可用，请在系统设置中安装或启用 TTS 引擎"); return; }
            tts.setSpeechRate(settings.speechRate());
            String language = settings.language();
            if (!language.isEmpty()) tts.setLanguage(Locale.forLanguageTag(language));
            List<String> chunks = SpeechText.chunks(text, Math.min(SYSTEM_CHUNK, TextToSpeech.getMaxSpeechInputLength() - 1));
            for (int i = 0; i < chunks.size(); i++) {
                android.os.Bundle params = new android.os.Bundle();
                params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
                params.putInt(TextToSpeech.Engine.KEY_PARAM_SESSION_ID, ttsAudioSession);
                String id = token + ":" + (i == chunks.size() - 1 ? "last" : String.valueOf(i));
                tts.speak(chunks.get(i), i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, params, id);
            }
        }));
    }

    private void withTts(Runnable action) {
        if (tts != null && (ttsReady || ttsFailed)) { action.run(); return; }
        waitingForTts.add(action);
        if (tts != null) return;
        tts = new TextToSpeech(context, status -> main.post(() -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            ttsFailed = !ttsReady;
            if (ttsReady) {
                tts.setAudioAttributes(ATTRIBUTES);
                ttsAudioSession = audio == null ? 0 : audio.generateAudioSessionId();
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {
                        main.post(() -> { if (tokenOf(id) == generation.get()) startMeter(tokenOf(id), ttsAudioSession); });
                    }
                    @Override public void onDone(String id) { finished(id); }
                    @Override public void onError(String id) { finished(id); }
                    private void finished(String id) {
                        main.post(() -> {
                            if (tokenOf(id) != generation.get()) return;
                            stopMeter();
                            if (id.endsWith(":stream")) streamChunkDone(tokenOf(id));
                            else if (id.endsWith(":last")) done(tokenOf(id));
                        });
                    }
                });
            }
            List<Runnable> pending = new ArrayList<>(waitingForTts);
            waitingForTts.clear();
            for (Runnable run : pending) run.run();
            if (ttsFailed) tts = null;
        }));
    }

    /** Queues one streamed sentence on the system engine without flushing what is already playing. */
    private void speakStreamChunk(int token, String text) {
        streamPending++;
        withTts(() -> {
            if (token != generation.get()) return;
            if (ttsFailed) { failed(token, "系统语音合成不可用，请在系统设置中安装或启用 TTS 引擎"); return; }
            tts.setSpeechRate(settings.speechRate());
            String language = settings.language();
            if (!language.isEmpty()) tts.setLanguage(Locale.forLanguageTag(language));
            android.os.Bundle params = new android.os.Bundle();
            params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
            params.putInt(TextToSpeech.Engine.KEY_PARAM_SESSION_ID, ttsAudioSession);
            if (tts.speak(text, TextToSpeech.QUEUE_ADD, params, token + ":stream") == TextToSpeech.ERROR)
                streamChunkDone(token);
        });
    }

    private void streamChunkDone(int token) {
        if (token != streamToken || token != generation.get()) return;
        if (--streamPending <= 0 && streamEnded) finishStream(token);
    }

    /** Kokoro sends PCM directly; other endpoints retain compressed-file compatibility. */
    private void streamRemote(int token, VoiceSettings.Remote config, java.util.concurrent.BlockingQueue<String> queue) {
        if ("kokoro".equalsIgnoreCase(config.model)) {
            streamPcm(token, config, queue, true);
            return;
        }
        File dir = new File(context.getCacheDir(), "voice");
        dir.mkdirs();
        int index = 0;
        try {
            while (token == generation.get()) {
                String text = queue.poll(200, TimeUnit.MILLISECONDS);
                if (text == null) continue;
                if (STREAM_END.equals(text)) break;
                File file = new File(dir, "tts-" + token + "-" + index++ + ".mp3");
                try {
                    synthesize(token, config, text, file).get(150, TimeUnit.SECONDS);
                    if (token != generation.get()) return;
                    play(token, file);
                } finally { file.delete(); }
            }
            main.post(() -> finishStream(token));
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (Exception failure) {
            if (token != generation.get()) return;
            Throwable cause = failure instanceof java.util.concurrent.ExecutionException && failure.getCause() != null ? failure.getCause() : failure;
            String message = cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
            main.post(() -> {
                if (token != generation.get()) return;
                Toast.makeText(context, UiText.get(context, "远程朗读失败：") + message, Toast.LENGTH_LONG).show();
                finishStream(token);
            });
        }
    }

    /** A single track spans the reply; subsequent requests start while buffered samples still play. */
    private void streamPcm(int token, VoiceSettings.Remote config,
            java.util.concurrent.BlockingQueue<String> queue, boolean streaming) {
        PcmSpeech owned = null;
        String problem = null;
        try {
            owned = new PcmSpeech(ATTRIBUTES);
            synchronized (this) {
                if (token != generation.get()) return;
                pcm = owned;
            }
            boolean received = false;
            while (token == generation.get()) {
                String text = queue.poll(200, TimeUnit.MILLISECONDS);
                if (text == null) continue;
                if (STREAM_END.equals(text)) break;
                okhttp3.Call call = RemoteVoiceApi.speechCall(config, text, settings.speechRate());
                remoteCall = call;
                if (token != generation.get()) { call.cancel(); break; }
                try (okhttp3.Response response = RemoteVoiceApi.speechResponse(call)) {
                    okhttp3.MediaType type = response.body().contentType();
                    if (type == null || !"audio".equals(type.type()) || !"pcm".equals(type.subtype()))
                        throw new java.io.IOException("Kokoro 必须返回 24 kHz 单声道 PCM 音频");
                    if (!received) {
                        int session = owned.sessionId();
                        main.post(() -> { if (token == generation.get()) startMeter(token, session); });
                    }
                    received = true;
                    owned.append(response.body().byteStream(), () -> token == generation.get());
                } finally {
                    if (remoteCall == call) remoteCall = null;
                }
            }
            if (received) owned.drain(() -> token == generation.get());
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (Exception failure) {
            problem = failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage();
        } finally {
            synchronized (this) {
                if (pcm == owned) pcm = null;
            }
            if (owned != null) owned.close();
            String message = problem;
            main.post(() -> {
                if (token != generation.get()) return;
                stopMeter();
                if (message != null) Toast.makeText(context, "远程朗读失败：" + message, Toast.LENGTH_LONG).show();
                // Do not switch speakers or replay the reply when a partially played stream fails.
                if (streaming) finishStream(token);
                else done(token);
            });
        }
    }

    private void finishStream(int token) {
        if (token != streamToken || token != generation.get()) return;
        Runnable drained = streamDrained;
        streamDrained = null;
        streamToken = -1;
        done(token);
        if (drained != null) drained.run();
    }

    /** Synthesizes the next chunk while the current one plays. */
    private void speakRemote(int token, VoiceSettings.Remote config, List<String> chunks, String fullText) {
        File dir = new File(context.getCacheDir(), "voice");
        dir.mkdirs();
        Future<File> next = null;
        try {
            for (int i = 0; i < chunks.size() && token == generation.get(); i++) {
                Future<File> current = next != null ? next : synthesize(token, config, chunks.get(i), new File(dir, "tts-" + token + "-" + i + ".mp3"));
                next = i + 1 < chunks.size() ? synthesize(token, config, chunks.get(i + 1), new File(dir, "tts-" + token + "-" + (i + 1) + ".mp3")) : null;
                File file = current.get(150, TimeUnit.SECONDS);
                if (token != generation.get()) return;
                play(token, file);
                file.delete();
            }
            done(token);
        } catch (Exception failure) {
            if (token != generation.get()) return;
            Throwable cause = failure instanceof java.util.concurrent.ExecutionException && failure.getCause() != null ? failure.getCause() : failure;
            String message = cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
            main.post(() -> {
                if (token != generation.get()) return;
                Toast.makeText(context, UiText.get(context, "远程朗读失败，已改用系统朗读：") + message, Toast.LENGTH_LONG).show();
                speakSystem(token, fullText);
            });
        } finally {
            if (next != null) next.cancel(true);
        }
    }

    private Future<File> synthesize(int token, VoiceSettings.Remote config, String text, File target) {
        return remote.submit(() -> {
            okhttp3.Call call = RemoteVoiceApi.speechCall(config, text, settings.speechRate());
            remoteCall = call;
            if (token != generation.get()) call.cancel();
            byte[] bytes = RemoteVoiceApi.audio(call);
            try (FileOutputStream output = new FileOutputStream(target)) { output.write(bytes); }
            return target;
        });
    }

    private void play(int token, File file) throws Exception {
        CountDownLatch finished = new CountDownLatch(1);
        String[] error = new String[1];
        MediaPlayer[] owned = new MediaPlayer[1];
        main.post(() -> {
            if (token != generation.get()) { finished.countDown(); return; }
            MediaPlayer media = new MediaPlayer();
            owned[0] = media;
            try {
                media.setAudioAttributes(ATTRIBUTES);
                media.setDataSource(file.getAbsolutePath());
                media.setOnCompletionListener(done -> {
                    if (token == generation.get()) stopMeter();
                    finished.countDown();
                });
                media.setOnErrorListener((failed, what, extra) -> {
                    if (token == generation.get()) stopMeter();
                    error[0] = "音频无法播放（" + what + "）"; finished.countDown(); return true;
                });
                media.prepare();
                player = media;
                media.start();
                startMeter(token, media.getAudioSessionId());
            } catch (Exception failure) { error[0] = "音频无法播放"; finished.countDown(); }
        });
        while (!finished.await(200, TimeUnit.MILLISECONDS)) if (token != generation.get()) break;
        main.post(() -> {
            MediaPlayer media = owned[0];
            if (player == media) player = null;
            if (media != null) media.release();
        });
        if (error[0] != null && token == generation.get()) throw new java.io.IOException(error[0]);
    }

    private void startMeter(int token, int sessionId) {
        stopMeter();
        if (playbackListener == null) return;
        playbackListener.onPlayback(true, 0);
        // Some devices/TTS engines do not expose a session meter. Keep the quiet flow in that case.
        if (sessionId <= 0) return;
        try {
            meter = new android.media.audiofx.Visualizer(sessionId);
            meter.setCaptureSize(android.media.audiofx.Visualizer.getCaptureSizeRange()[0]);
            meter.setDataCaptureListener(new android.media.audiofx.Visualizer.OnDataCaptureListener() {
                @Override public void onWaveFormDataCapture(android.media.audiofx.Visualizer source, byte[] wave, int rate) {
                    double sum = 0;
                    for (byte sample : wave) { double value = ((sample & 255) - 128) / 128.0; sum += value * value; }
                    float level = wave.length == 0 ? 0 : (float) Math.min(1, Math.sqrt(sum / wave.length) * 3);
                    main.post(() -> {
                        if (token == generation.get() && source == meter && playbackListener != null)
                            playbackListener.onPlayback(true, level);
                    });
                }
                @Override public void onFftDataCapture(android.media.audiofx.Visualizer source, byte[] fft, int rate) { }
            }, Math.min(20_000, android.media.audiofx.Visualizer.getMaxCaptureRate()), true, false);
            meter.setEnabled(true);
        } catch (RuntimeException unavailable) { stopMeter(); }
    }

    private void stopMeter() {
        if (meter != null) { meter.release(); meter = null; }
        if (playbackListener != null) playbackListener.onPlayback(false, 0);
    }

    private void failed(int token, String message) {
        Toast.makeText(context, UiText.get(context, message), Toast.LENGTH_LONG).show();
        if (token == streamToken) finishStream(token);
        else done(token);
    }

    /** token -1 always ends; otherwise only the current generation ends. */
    private void done(int token) {
        if (token != -1 && token != generation.get()) return;
        speaking = false;
        main.post(this::abandonFocus);
    }

    private void requestFocus() {
        if (audio == null) return;
        if (focus == null) focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(ATTRIBUTES).build();
        audio.requestAudioFocus(focus);
    }

    private void abandonFocus() {
        if (audio != null && focus != null && !speaking) { audio.abandonAudioFocusRequest(focus); focus = null; }
    }

    private static int tokenOf(String id) {
        try { return Integer.parseInt(id.substring(0, id.indexOf(':'))); } catch (RuntimeException invalid) { return -2; }
    }
}
