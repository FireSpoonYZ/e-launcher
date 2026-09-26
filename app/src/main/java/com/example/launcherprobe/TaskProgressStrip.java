package com.example.launcherprobe;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.List;
import org.json.JSONObject;

/** Task timeline for the detail pane and expanded workbench. */
final class TaskProgressStrip extends HorizontalScrollView {
    TaskProgressStrip(Context context, AppAppearance colors, List<JSONObject> tasks, String model) {
        super(context);
        setHorizontalScrollBarEnabled(false);
        setOverScrollMode(OVER_SCROLL_NEVER);
        setTag("todo-strip");
        LinearLayout track = new LinearLayout(context) {
            private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
            { setWillNotDraw(false); }
            @Override protected void onDraw(Canvas canvas) {
                super.onDraw(canvas);
                line.setStrokeWidth(dp(1));
                for (int i = 0; i + 1 < getChildCount(); i++) {
                    View a = getChildAt(i), b = getChildAt(i + 1);
                    line.setColor("completed".equals(tasks.get(i).optString("status")) ? colors.accent : colors.border);
                    canvas.drawLine(a.getLeft() + a.getWidth() / 2f + dp(13), dp(19),
                            b.getLeft() + b.getWidth() / 2f - dp(13), dp(19), line);
                }
            }
        };
        int width = dp(58);
        for (JSONObject task : tasks) {
            String status = task.optString("status");
            LinearLayout node = new LinearLayout(context);
            node.setOrientation(LinearLayout.VERTICAL);
            node.setGravity(Gravity.CENTER_HORIZONTAL);
            node.setPadding(dp(2), dp(2), dp(2), dp(2));
            node.addView(new TaskStepMarker(context, status, model, colors.accent, colors), new LinearLayout.LayoutParams(dp(34), dp(34)));
            TextView subject = new TextView(context);
            subject.setText(task.optString("subject")); subject.setTextSize(11); subject.setIncludeFontPadding(false);
            subject.setMaxLines(1); subject.setEllipsize(TextUtils.TruncateAt.END);
            subject.setTextColor("in_progress".equals(status) ? colors.ink : colors.muted);
            if ("in_progress".equals(status)) subject.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            subject.setGravity(Gravity.CENTER); subject.setPadding(0, dp(4), 0, 0);
            node.addView(subject);
            boolean chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
            String state = "completed".equals(status) ? (chinese ? "已完成" : "Completed")
                    : "in_progress".equals(status) ? (chinese ? "进行中" : "In progress") : (chinese ? "待开始" : "Pending");
            node.setContentDescription(task.optString("subject") + ", " + state);
            track.addView(node, new LinearLayout.LayoutParams(width, -2));
        }
        addView(track);
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        LinearLayout track = (LinearLayout) getChildAt(0);
        int count = track.getChildCount();
        int width = Math.max(dp(58), (MeasureSpec.getSize(widthSpec) - getPaddingLeft() - getPaddingRight()) / Math.max(1, Math.min(5, count)));
        for (int i = 0; i < count; i++) track.getChildAt(i).getLayoutParams().width = width;
        super.onMeasure(widthSpec, heightSpec);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
