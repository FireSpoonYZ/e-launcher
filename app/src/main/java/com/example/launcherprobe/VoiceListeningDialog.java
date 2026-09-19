package com.example.launcherprobe;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Bottom panel shown while one SpeechInput runs: live transcript, input level, cancel and done. */
final class VoiceListeningDialog {
    private final Activity activity;
    private final SpeechInput input;
    private final SpeechInput.Listener target;
    private final Runnable dismissed;
    private final Dialog dialog;
    private TextView status, transcript, finish;
    private View level;
    private boolean ended;

    VoiceListeningDialog(Activity activity, SpeechInput input, SpeechInput.Listener target, Runnable dismissed) {
        this.activity = activity; this.input = input; this.target = target; this.dismissed = dismissed;
        dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(content());
        dialog.setCanceledOnTouchOutside(true);
        dialog.setOnCancelListener(ignored -> cancelInput());
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(0));
            window.setGravity(Gravity.BOTTOM);
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT);
        }
    }

    void show() {
        dialog.show();
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

    void cancelInput() {
        if (ended) return;
        input.cancel();
        end();
    }

    private void end() {
        if (ended) return;
        ended = true;
        if (dialog.isShowing() && !activity.isDestroyed()) dialog.dismiss();
        dismissed.run();
    }

    private View content() {
        AppAppearance appearance = AppAppearance.read(activity);
        float density = activity.getResources().getDisplayMetrics().density;
        int pad = Math.round(20 * density);
        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(pad, pad, pad, pad);
        GradientDrawable background = new GradientDrawable();
        background.setColor(appearance.surface);
        background.setCornerRadii(new float[]{24 * density, 24 * density, 24 * density, 24 * density, 0, 0, 0, 0});
        panel.setBackground(background);

        status = new TextView(activity);
        status.setText(t("正在聆听…"));
        status.setTextSize(18);
        status.setTextColor(appearance.ink);
        panel.addView(status);

        transcript = new TextView(activity);
        transcript.setHint(t("请说话，停顿后自动结束"));
        transcript.setTextSize(16);
        transcript.setTextColor(appearance.ink);
        transcript.setHintTextColor(appearance.muted);
        transcript.setMinHeight(Math.round(56 * density));
        transcript.setPadding(0, Math.round(12 * density), 0, Math.round(12 * density));
        panel.addView(transcript);

        FrameLayout track = new FrameLayout(activity);
        GradientDrawable trackShape = new GradientDrawable();
        trackShape.setColor(appearance.border);
        trackShape.setCornerRadius(3 * density);
        track.setBackground(trackShape);
        level = new View(activity);
        GradientDrawable levelShape = new GradientDrawable();
        levelShape.setColor(appearance.accent);
        levelShape.setCornerRadius(3 * density);
        level.setBackground(levelShape);
        level.setPivotX(0);
        level.setScaleX(.15f);
        track.addView(level, new FrameLayout.LayoutParams(-1, -1));
        panel.addView(track, new LinearLayout.LayoutParams(-1, Math.round(6 * density)));

        LinearLayout actions = new LinearLayout(activity);
        actions.setGravity(Gravity.END);
        actions.setPadding(0, Math.round(16 * density), 0, 0);
        TextView cancel = action(t("取消"), appearance.muted, density);
        cancel.setOnClickListener(view -> cancelInput());
        finish = action(t("完成"), appearance.accent, density);
        finish.setOnClickListener(view -> input.finish());
        actions.addView(cancel);
        actions.addView(finish);
        panel.addView(actions);
        return panel;
    }

    private TextView action(String label, int color, float density) {
        TextView view = new TextView(activity);
        view.setText(label);
        view.setTextSize(16);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        view.setMinWidth(Math.round(72 * density));
        view.setMinHeight(Math.round(48 * density));
        view.setPadding(Math.round(12 * density), 0, Math.round(12 * density), 0);
        view.setClickable(true);
        view.setFocusable(true);
        return view;
    }

    private String t(String literal) { return UiText.get(activity, literal); }
}
