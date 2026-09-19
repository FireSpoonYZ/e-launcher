package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.os.RemoteException;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

/**
 * Required by the assistant role. Selecting this app as assistant also makes this the system default recognizer,
 * so it forwards to the recognizer that was in use before (or another installed one) instead of doing its own work.
 */
public final class LauncherRecognitionService extends RecognitionService {
    private SpeechRecognizer delegate;

    @Override protected void onStartListening(Intent intent, Callback callback) {
        release();
        ComponentName target = SpeechInput.fallbackRecognizer(this);
        if (target == null) { send(() -> callback.error(SpeechRecognizer.ERROR_CLIENT)); return; }
        delegate = SpeechRecognizer.createSpeechRecognizer(this, target);
        delegate.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { send(() -> callback.readyForSpeech(params)); }
            @Override public void onBeginningOfSpeech() { send(callback::beginningOfSpeech); }
            @Override public void onRmsChanged(float db) { send(() -> callback.rmsChanged(db)); }
            @Override public void onBufferReceived(byte[] buffer) { send(() -> callback.bufferReceived(buffer)); }
            @Override public void onEndOfSpeech() { send(callback::endOfSpeech); }
            @Override public void onError(int error) { send(() -> callback.error(error)); release(); }
            @Override public void onResults(Bundle results) { send(() -> callback.results(results)); release(); }
            @Override public void onPartialResults(Bundle results) { send(() -> callback.partialResults(results)); }
            @Override public void onEvent(int type, Bundle params) { }
        });
        delegate.startListening(intent);
    }

    @Override protected void onStopListening(Callback callback) { if (delegate != null) delegate.stopListening(); }

    @Override protected void onCancel(Callback callback) {
        if (delegate != null) delegate.cancel();
        release();
    }

    @Override public void onDestroy() {
        release();
        super.onDestroy();
    }

    private void release() {
        if (delegate != null) delegate.destroy();
        delegate = null;
    }

    private interface Call { void run() throws RemoteException; }

    private static void send(Call call) {
        try { call.run(); } catch (RemoteException clientGone) { }
    }
}
