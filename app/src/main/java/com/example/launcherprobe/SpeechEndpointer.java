package com.example.launcherprobe;

/** Energy-based end-of-utterance detection for self-recorded audio. Feed fixed-size frames in order. */
final class SpeechEndpointer {
    enum State { WAITING, SPEAKING, DONE, NO_SPEECH, TOO_LONG }

    static final int FRAME_MS = 50;
    private static final int CALIBRATION_MS = 300, END_SILENCE_MS = 1_400, NO_SPEECH_MS = 8_000, MAX_MS = 60_000;
    private static final double MIN_SPEECH_RMS = 350, NOISE_FACTOR = 2.6;

    private double noise = -1;
    private int elapsed, silence, voiced;
    private State state = State.WAITING;
    private float level;

    State state() { return state; }
    /** 0..1 loudness of the last frame, for the listening indicator. */
    float level() { return level; }
    boolean heardSpeech() { return state == State.SPEAKING || state == State.DONE || state == State.TOO_LONG; }

    State feed(short[] frame, int count) {
        if (state != State.WAITING && state != State.SPEAKING) return state;
        double sum = 0;
        for (int i = 0; i < count; i++) sum += (double) frame[i] * frame[i];
        double rms = count == 0 ? 0 : Math.sqrt(sum / count);
        level = (float) Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1, rms)) - 30) / 45));
        elapsed += FRAME_MS;
        if (elapsed <= CALIBRATION_MS) {
            noise = noise < 0 ? rms : Math.min(noise, rms) * .5 + rms * .5;
            return state;
        }
        boolean speech = rms > Math.max(MIN_SPEECH_RMS, noise * NOISE_FACTOR);
        if (!speech && state == State.WAITING) noise = noise * .95 + rms * .05;
        if (state == State.WAITING) {
            voiced = speech ? voiced + FRAME_MS : 0;
            // Two consecutive voiced frames avoid starting on a single click.
            if (voiced >= FRAME_MS * 2) state = State.SPEAKING;
            else if (elapsed >= NO_SPEECH_MS) state = State.NO_SPEECH;
        } else {
            silence = speech ? 0 : silence + FRAME_MS;
            if (silence >= END_SILENCE_MS) state = State.DONE;
        }
        if (elapsed >= MAX_MS && (state == State.WAITING || state == State.SPEAKING))
            state = state == State.SPEAKING ? State.TOO_LONG : State.NO_SPEECH;
        return state;
    }
}
