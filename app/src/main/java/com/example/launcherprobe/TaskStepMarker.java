package com.example.launcherprobe;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** Step indicator for task details and the virtual-screen workbench. */
final class TaskStepMarker extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final AppAppearance colors;
    private final String status, model;
    private final int completedColor;
    private ValueAnimator animator;
    private float angle;

    TaskStepMarker(Context context, String status, String model, int completedColor) {
        super(context);
        this.status = status; this.model = model; this.completedColor = completedColor;
        colors = AppAppearance.readWorkbench(context);
        setContentDescription("completed".equals(status) ? "已完成"
                : "in_progress".equals(status) ? ("working".equals(model) ? "进行中" : "未完成") : "等待中");
    }
    @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); updateAnimation(); }
    @Override protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(visibility); updateAnimation();
    }
    @Override protected void onVisibilityChanged(View changed, int visibility) {
        super.onVisibilityChanged(changed, visibility); updateAnimation();
    }
    private void updateAnimation() {
        if (animator != null) { animator.cancel(); animator = null; }
        if (isAttachedToWindow() && isShown() && getWindowVisibility() == VISIBLE
                && TaskCardModel.animateNode(model, status, ValueAnimator.areAnimatorsEnabled())) {
            animator = ValueAnimator.ofFloat(0, 360);
            animator.setDuration(1200); animator.setRepeatCount(ValueAnimator.INFINITE);
            animator.setInterpolator(new LinearInterpolator());
            animator.addUpdateListener(value -> { angle = (float) value.getAnimatedValue(); invalidate(); });
            animator.start();
        }
    }
    @Override protected void onDetachedFromWindow() {
        if (animator != null) { animator.cancel(); animator = null; }
        super.onDetachedFromWindow();
    }
    @Override protected void onDraw(Canvas canvas) {
        float x = getWidth() / 2f, y = getHeight() / 2f;
        boolean completed = "completed".equals(status), active = "in_progress".equals(status);
        paint.setAlpha(255); paint.setStrokeCap(Paint.Cap.ROUND);
        if (completed) {
            paint.setColor(completedColor); paint.setStyle(Paint.Style.FILL);
            canvas.drawCircle(x, y, dp(11), paint);
            paint.setColor(colors.dark ? colors.background : 0xffffffff); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2));
            canvas.drawLine(x - dp(5), y, x - dp(1), y + dp(4), paint);
            canvas.drawLine(x - dp(1), y + dp(4), x + dp(5), y - dp(4), paint);
        } else if (active) {
            paint.setColor(colors.accent); paint.setStyle(Paint.Style.FILL);
            canvas.drawCircle(x, y, dp(7), paint);
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(1)); paint.setAlpha(50);
            canvas.drawCircle(x, y, dp(14), paint); paint.setAlpha(255); paint.setStrokeWidth(dp(2));
            if (animator != null) canvas.drawArc(new RectF(x - dp(14), y - dp(14), x + dp(14), y + dp(14)), angle, 85, false, paint);
        } else {
            paint.setColor(colors.dark ? 0xff7898a4 : 0xffb8cdd5);
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(1.5f)); canvas.drawCircle(x, y, dp(11), paint);
        }
    }
    private float dp(float value) { return value * getResources().getDisplayMetrics().density; }
}
