package com.example.launcherprobe;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.drawable.ColorDrawable;
import android.view.Gravity;
import android.view.Window;
import android.view.WindowManager;

/** Shows a VoiceListeningPanel as a bottom dialog over an activity. */
final class VoiceListeningDialog implements VoiceManager.Presented {
    private final Activity activity;
    private final Dialog dialog;
    private final VoiceListeningPanel panel;

    VoiceListeningDialog(Activity activity, SpeechInput input, SpeechInput.Listener target, Runnable dismissed) {
        this.activity = activity;
        dialog = new Dialog(activity);
        panel = new VoiceListeningPanel(activity, input, target, () -> {
            if (dialog.isShowing() && !activity.isDestroyed()) dialog.dismiss();
            dismissed.run();
        });
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(panel.view());
        dialog.setCanceledOnTouchOutside(true);
        dialog.setOnCancelListener(ignored -> panel.cancelInput());
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(0));
            window.setGravity(Gravity.BOTTOM);
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT);
        }
    }

    void show() {
        dialog.show();
        panel.start();
    }

    @Override public void cancelInput() { panel.cancelInput(); }
}
