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

    /** Shows voice mode over the current app; a fresh topic is created only after recognition. */
    static final class Session extends VoiceInteractionSession implements VoiceSession.Host {
        private FrameLayout root;
        private VoiceManager.Presented presented;
        private VoiceSession conversation;

        Session(Context context) { super(context); }

        @Override public Context context() { return getContext(); }

        @Override public void closed() {
            conversation = null;
            hide();
        }

        @Override public View onCreateContentView() {
            root = new FrameLayout(getContext());
            root.setBackgroundColor(Color.argb(72, 0, 0, 0));
            root.setOnClickListener(tapped -> finishSession());
            return root;
        }

        @Override public void onShow(Bundle args, int showFlags) {
            super.onShow(args, showFlags);
            VoiceSession.applyGlass(getWindow().getWindow());
            boolean fromWake = args != null && args.getBoolean(LauncherVoiceInteractionService.EXTRA_WAKE);
            if (VoiceSession.supported(getContext())) { startConversation(fromWake); return; }
            VoiceManager.get(getContext()).listenInSession(this, fromWake);
        }

        @Override public void onHide() {
            if (conversation != null) { VoiceSession ending = conversation; conversation = null; ending.close(); }
            if (presented != null) presented.cancelInput();
            presented = null;
            super.onHide();
        }

        /** The continuous spoken conversation, filling the session window. */
        private void startConversation(boolean fromWake) {
            if (root == null) onCreateContentView();
            conversation = VoiceManager.get(getContext()).openSession(this);
            root.setBackgroundColor(Color.TRANSPARENT);
            root.setOnClickListener(null);
            root.removeAllViews();
            root.addView(conversation.view(), new FrameLayout.LayoutParams(-1, -1));
            conversation.start(fromWake);
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
            if (conversation != null) conversation.close();
            else if (presented != null) presented.cancelInput();
            else hide();
        }
    }
}
