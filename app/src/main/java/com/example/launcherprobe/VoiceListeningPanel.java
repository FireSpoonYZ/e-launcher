package com.example.launcherprobe;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Listening panel for one SpeechInput: live transcript, input level, cancel and done. Hosts (an activity dialog or
 * the assistant session window) only place view() and remove it when {@code ended} runs.
 */
final class VoiceListeningPanel implements VoiceManager.Presented {
    private final Context context;
    private final SpeechInput input;
    private final SpeechInput.Listener target;
    private final Runnable ended;
    private final View view;
    private TextView status, transcript, finish;
    private View level;
    private boolean done;

    VoiceListeningPanel(Context context, SpeechInput input, SpeechInput.Listener target, Runnable ended) {
        this.context = context; this.input = input; this.target = target; this.ended = ended;
        view = build();
    }

    View view() { return view; }

    void start() {
        input.start(new SpeechInput.Listener() {
            @Override public void onLevel(float value) { level.setScaleX(.15f + .85f * value); }
            @Override public void onPartial(String text) { transcript.setText(text); }
            @Override public void onProcessing() {
                status.setText(t("正在识别…")); finish.setEnabled(false); finish.setAlpha(.4f); level.setScaleX(.15f);
            }
            @Override public void onResult(String text) { target.onResult(text); end(); }
            @Override public void onError(String message) { target.onError(message); end(); }
        });
    }

    @Override public void cancelInput() {
        if (done) return;
        input.cancel();
        end();
    }

    private void end() {
        if (done) return;
        done = true;
        ended.run();
    }

    private View build() {
        AppAppearance appearance = AppAppearance.read(context);
        float density = context.getResources().getDisplayMetrics().density;
        int pad = Math.round(20 * density);
        LinearLayout panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(pad, pad, pad, pad);
        GradientDrawable background = new GradientDrawable();
        background.setColor(appearance.surface);
        background.setCornerRadii(new float[]{24 * density, 24 * density, 24 * density, 24 * density, 0, 0, 0, 0});
        panel.setBackground(background);
        panel.setClickable(true);

        status = new TextView(context);
        status.setText(t("正在聆听…"));
        status.setTextSize(18);
        status.setTextColor(appearance.ink);
        panel.addView(status);

        transcript = new TextView(context);
        transcript.setHint(t("请说话，停顿后自动结束"));
        transcript.setTextSize(16);
        transcript.setTextColor(appearance.ink);
        transcript.setHintTextColor(appearance.muted);
        transcript.setMinHeight(Math.round(56 * density));
        transcript.setPadding(0, Math.round(12 * density), 0, Math.round(12 * density));
        panel.addView(transcript);

        FrameLayout track = new FrameLayout(context);
        GradientDrawable trackShape = new GradientDrawable();
        trackShape.setColor(appearance.border);
        trackShape.setCornerRadius(3 * density);
        track.setBackground(trackShape);
        level = new View(context);
        GradientDrawable levelShape = new GradientDrawable();
        levelShape.setColor(appearance.accent);
        levelShape.setCornerRadius(3 * density);
        level.setBackground(levelShape);
        level.setPivotX(0);
        level.setScaleX(.15f);
        track.addView(level, new FrameLayout.LayoutParams(-1, -1));
        panel.addView(track, new LinearLayout.LayoutParams(-1, Math.round(6 * density)));

        LinearLayout actions = new LinearLayout(context);
        actions.setGravity(Gravity.END);
        actions.setPadding(0, Math.round(16 * density), 0, 0);
        TextView cancel = action(t("取消"), appearance.muted, density);
        cancel.setOnClickListener(clicked -> cancelInput());
        finish = action(t("完成"), appearance.accent, density);
        finish.setOnClickListener(clicked -> input.finish());
        actions.addView(cancel);
        actions.addView(finish);
        panel.addView(actions);
        return panel;
    }

    private TextView action(String label, int color, float density) {
        TextView button = new TextView(context);
        button.setText(label);
        button.setTextSize(16);
        button.setTextColor(color);
        button.setGravity(Gravity.CENTER);
        button.setMinWidth(Math.round(72 * density));
        button.setMinHeight(Math.round(48 * density));
        button.setPadding(Math.round(12 * density), 0, Math.round(12 * density), 0);
        button.setClickable(true);
        button.setFocusable(true);
        return button;
    }

    private String t(String literal) { return UiText.get(context, literal); }
}
