package com.example.launcherprobe;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;

import java.io.IOException;
import java.io.InputStream;
import java.util.function.BooleanSupplier;

/** OpenAI/Kokoro raw PCM: signed little-endian 16-bit, mono, 24 kHz. Owned by one worker. */
final class PcmSpeech implements AutoCloseable {
    private final AudioTrack track;
    private long frames;
    private boolean stopped;

    PcmSpeech(AudioAttributes attributes) throws IOException {
        int minimum = AudioTrack.getMinBufferSize(24_000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new IOException("设备不支持 24 kHz PCM 播放");
        track = new AudioTrack.Builder().setAudioAttributes(attributes)
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(24_000)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(Math.max(minimum, 9_600)).setTransferMode(AudioTrack.MODE_STREAM).build();
        if (track.getState() != AudioTrack.STATE_INITIALIZED) {
            track.release();
            throw new IOException("无法初始化音频输出");
        }
    }

    int sessionId() { return track.getAudioSessionId(); }

    void append(InputStream input, BooleanSupplier active) throws IOException, InterruptedException {
        byte[] buffer = new byte[4_800];
        int count;
        while (active.getAsBoolean() && (count = readFrames(input, buffer)) != -1) {
            int offset = 0;
            while (offset < count && active.getAsBoolean()) {
                int written;
                synchronized (this) {
                    if (stopped) return;
                    // Nonblocking writes let stop() pause/flush immediately, even if the device stalls.
                    written = track.write(buffer, offset, count - offset, AudioTrack.WRITE_NON_BLOCKING);
                    if (written > 0 && track.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) track.play();
                }
                if (written < 0) throw new IOException("PCM 播放失败：" + written);
                offset += written;
                frames += written / 2;
                if (written == 0) Thread.sleep(10);
            }
        }
    }

    /** Network packets may end between the two bytes of a sample. Never discard that byte. */
    static int readFrames(InputStream input, byte[] buffer) throws IOException {
        int count = input.read(buffer, 0, buffer.length - 1);
        if (count < 0) return -1;
        if ((count & 1) != 0) {
            int last = input.read();
            if (last < 0) throw new IOException("PCM 音频在采样中途结束");
            buffer[count++] = (byte) last;
        }
        return count;
    }

    void drain(BooleanSupplier active) throws IOException, InterruptedException {
        if (frames == 0 && active.getAsBoolean()) throw new IOException("语音合成返回了空音频");
        long previous = -1, lastProgress = System.nanoTime();
        while (active.getAsBoolean()) {
            long played = Integer.toUnsignedLong(track.getPlaybackHeadPosition());
            if (played >= frames) return;
            if (played != previous) { previous = played; lastProgress = System.nanoTime(); }
            if (System.nanoTime() - lastProgress > 5_000_000_000L) throw new IOException("音频播放停止响应");
            Thread.sleep(10);
        }
    }

    synchronized void stop() {
        if (stopped) return;
        stopped = true;
        track.pause();
        track.flush();
    }

    @Override public synchronized void close() {
        stop();
        track.release();
    }
}
