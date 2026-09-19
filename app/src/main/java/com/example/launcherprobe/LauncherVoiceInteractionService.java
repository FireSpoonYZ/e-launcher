package com.example.launcherprobe;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.voice.VoiceInteractionService;
import android.util.Log;

/**
 * Present when the user picks this app as the default digital assistant. The system keeps the selected service
 * bound with foreground priority and the binder's while-in-use capabilities, so it can run the CPU wake word
 * listener without a foreground service notification. The DSP hotword APIs remain limited to preinstalled apps.
 */
public final class LauncherVoiceInteractionService extends VoiceInteractionService {
    static final String EXTRA_WAKE = "wake";
    private static final String TAG = "LauncherVoiceInteraction";
    private static volatile LauncherVoiceInteractionService ready;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WakeWordListener listener;

    static boolean isDefaultAssistant(Context context) {
        try { return isActiveService(context, new ComponentName(context, LauncherVoiceInteractionService.class)); }
        catch (RuntimeException unavailable) { return false; }
    }

    /** True while the system has this service bound and ready. */
    static boolean isReady() { return ready != null; }

    /** True while the assistant service is listening for wake words. */
    static boolean isListening() {
        LauncherVoiceInteractionService service = ready;
        return service != null && service.listener != null;
    }

    static void sync(boolean reload) {
        LauncherVoiceInteractionService service = ready;
        if (service != null) service.main.post(() -> service.apply(reload));
    }

    @Override public void onReady() {
        super.onReady();
        ready = this;
        apply(false);
        // A leftover foreground service from the fallback mode is no longer needed.
        WakeWordService.sync(this);
    }

    @Override public void onShutdown() {
        ready = null;
        stopListening();
        super.onShutdown();
    }

    private void apply(boolean reload) {
        VoiceSettings settings = new VoiceSettings(this);
        boolean wanted = settings.wakeEnabled()
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (!wanted) { stopListening(); return; }
        if (listener == null) {
            listener = new WakeWordListener(this, new WakeWordListener.Host() {
                @Override public void onWake(String keyword) { wake(keyword); }
                @Override public void onFailure(String message) { listener = null; }
            });
            listener.start();
        } else if (reload) listener.reload();
    }

    private void stopListening() {
        if (listener != null) listener.stop();
        listener = null;
    }

    private void wake(String keyword) {
        Bundle args = new Bundle();
        args.putBoolean(EXTRA_WAKE, true);
        try {
            // The session window appears over whatever app is in front, like other assistants.
            showSession(args, 0);
        } catch (RuntimeException failure) {
            Log.w(TAG, "Cannot show assistant session", failure);
            VoiceManager.get(this).onWake(keyword);
        }
    }
}
