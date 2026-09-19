package com.example.launcherprobe;

import android.content.Context;
import android.graphics.Color;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;

/** Creates the assistant session shown for a wake word or the system assist gesture (long-press power or home). */
public final class LauncherVoiceSessionService extends VoiceInteractionSessionService {
    @Override public VoiceInteractionSession onNewSession(Bundle args) { return new Session(this); }

    /** Shows the listening panel over the current app and sends the request to the active conversation. */
    static final class Session extends VoiceInteractionSession {
        private FrameLayout root;
        private VoiceManager.Presented presented;

        Session(Context context) { super(context); }

        @Override public View onCreateContentView() {
            root = new FrameLayout(getContext());
            root.setBackgroundColor(Color.argb(72, 0, 0, 0));
            root.setOnClickListener(tapped -> finishSession());
            return root;
        }

        @Override public void onShow(Bundle args, int showFlags) {
            super.onShow(args, showFlags);
            boolean fromWake = args != null && args.getBoolean(LauncherVoiceInteractionService.EXTRA_WAKE);
            VoiceManager.get(getContext()).listenInSession(this, fromWake);
        }

        @Override public void onHide() {
            if (presented != null) presented.cancelInput();
            presented = null;
            super.onHide();
        }

        /** Called by VoiceManager: places the panel at the bottom of the session window. */
        VoiceManager.Presented present(SpeechInput input, SpeechInput.Listener target, Runnable dismissed) {
            if (root == null) onCreateContentView();
            VoiceListeningPanel panel = new VoiceListeningPanel(getContext(), input, target, () -> {
                root.removeAllViews();
                presented = null;
                dismissed.run();
                hide();
            });
            root.removeAllViews();
            root.addView(panel.view(), new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
            presented = panel;
            panel.start();
            return panel;
        }

        private void finishSession() {
            if (presented != null) presented.cancelInput();
            else hide();
        }
    }
}
