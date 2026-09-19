package com.example.launcherprobe;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;

/**
 * Lowercase e cut out of the desktop Horizon material, rendered by GLES 3 on supported devices.
 * A Canvas preview remains available for software rendering.
 */
final class VoiceOrbView extends android.opengl.GLSurfaceView {
    enum State { LISTENING, THINKING, SPEAKING, MUTED }

    // Display-sRGB. Shader uploads the same ints as 0-1 RGB and mixes in that space.
    static final int DEEP = 0xFF0052CC, MID = 0xFF0181FE, LIGHT = 0xFFA4EFFF, WHITE = 0xFFFFFDEF;

    private final Path letter = letter();
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Matrix transform = new Matrix();
    private final Shader base = new LinearGradient(12, 8, 80, 96,
            new int[]{DEEP, MID, LIGHT, WHITE}, new float[]{0f, .22f, .46f, 1f}, Shader.TileMode.CLAMP);
    private final Shader[] colours = { field(WHITE), field(LIGHT), field(MID) };
    private VoiceFluidShader fluid;
    private boolean rendererStarted;
    private float elapsed;
    private State state = State.LISTENING;
    private boolean userSpeaking;
    private float level, activity, amplitude, phase;
    private long lastFrame;

    VoiceOrbView(Context context) {
        super(context);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        setEGLContextClientVersion(3);
        setEGLConfigChooser(8, 8, 8, 8, 0, 0);
        getHolder().setFormat(android.graphics.PixelFormat.TRANSLUCENT);
        setZOrderOnTop(true);
        setWillNotDraw(false);
    }

    void setState(State value) {
        if (state == value) return;
        state = value;
        if (value != State.LISTENING) { userSpeaking = false; level = 0; }
        invalidate();
    }

    /** A recognizer/VAD decision, not raw microphone volume. Noise alone must not speed up the colour flow. */
    void setUserSpeaking(boolean speaking) {
        userSpeaking = speaking;
        invalidate();
    }

    /** Volume controls only the small expansion and extra warp, independently of the speech-driven flow speed. */
    void setLevel(float value) { level = Math.max(0, Math.min(1, value)); }

    boolean fluidShaderReady() { return fluid != null; }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        long now = SystemClock.uptimeMillis();
        float seconds = lastFrame == 0 ? 0 : Math.min(.05f, (now - lastFrame) / 1000f);
        lastFrame = now;
        if (ValueAnimator.areAnimatorsEnabled()) advance(seconds);

        float side = Math.min(getWidth(), getHeight());
        float breath = state == State.MUTED ? 0 : .006f * (float) Math.sin(phase * 1.4f);
        float scale = side / 106f * (1 + amplitude * .04f + breath);
        canvas.save();
        canvas.translate(getWidth() / 2f, getHeight() / 2f);
        canvas.scale(scale, scale);
        canvas.translate(-48, -51);
        if (fluid != null && canvas.isHardwareAccelerated()) {
            fluid.apply(phase, elapsed, activity, amplitude);
            requestRender();
        } else drawFallback(canvas);
        canvas.restore();
        if (isAttachedToWindow() && isShown() && getWindowVisibility() == VISIBLE
                && ValueAnimator.areAnimatorsEnabled()) postInvalidateDelayed(33);
    }

    /** Time-based easing: 160ms speech attack, 600ms return to rest. */
    void advance(float seconds) {
        boolean active = state == State.LISTENING && userSpeaking;
        float target = active ? 1f : 0f;
        activity += (target - activity) * (1 - (float) Math.exp(-seconds / (active ? .16f : .6f)));
        float volume = active || state == State.SPEAKING ? level : 0;
        amplitude += (volume - amplitude) * (1 - (float) Math.exp(-seconds / .12f));
        phase += seconds * flowSpeed();
        elapsed += seconds;
    }

    float flowSpeed() {
        if (state == State.MUTED) return .25f;
        if (state == State.SPEAKING) return 1 + amplitude * 3.6f;
        return 1 + activity * 3.6f;
    }

    @Override protected void onAttachedToWindow() {
        if (!rendererStarted) {
            fluid = new VoiceFluidShader(getContext(), letter);
            setRenderer(fluid);
            setRenderMode(RENDERMODE_WHEN_DIRTY);
            rendererStarted = true;
        }
        super.onAttachedToWindow();
        lastFrame = 0;
        invalidate();
    }

    @Override protected void onDetachedFromWindow() {
        lastFrame = 0;
        super.onDetachedFromWindow();
    }

    @Override protected void onWindowVisibilityChanged(int visibility) {
        super.onWindowVisibilityChanged(visibility);
        lastFrame = 0;
        if (visibility == VISIBLE) invalidate();
    }

    @Override protected void onVisibilityChanged(View changedView, int visibility) {
        super.onVisibilityChanged(changedView, visibility);
        lastFrame = 0;
        if (visibility == VISIBLE) invalidate();
    }

    private void drawFallback(Canvas canvas) {
        boolean muted = state == State.MUTED;
        paint.setAlpha(muted ? 170 : 255);
        paint.setShader(base);
        canvas.drawPath(letter, paint);
        for (int i = 0; i < colours.length; i++) {
            float offset = i * 1.71f;
            float t = phase * (1 + i * .09f);
            float x = 48 + 34 * (float) Math.sin(t + offset);
            float y = 49 + 39 * (float) Math.cos(t * .79f + offset);
            float radius = 45 + 10 * (float) Math.sin(t * .61f + offset);
            transform.setScale(radius, radius * (.7f + .2f * (float) Math.sin(t + offset)));
            transform.postRotate(24 * (float) Math.sin(t * .47f + offset));
            transform.postTranslate(x, y);
            colours[i].setLocalMatrix(transform);
            paint.setShader(colours[i]);
            paint.setAlpha(muted ? 55 : i == 0 ? 170 : i == 1 ? 205 : 150);
            canvas.drawPath(letter, paint);
        }
    }

    private static Shader field(int colour) {
        return new RadialGradient(0, 0, 1, new int[]{colour, colour & 0x00FFFFFF}, null, Shader.TileMode.CLAMP);
    }

    /** A font-independent outline: open mouth and rounded upper counter stay crisp while colours move inside. */
    private static Path letter() {
        Path p = new Path();
        p.setFillType(Path.FillType.EVEN_ODD);
        p.moveTo(86, 56);
        p.lineTo(28, 56);
        p.cubicTo(30, 72, 48, 83, 64, 74);
        p.cubicTo(68, 72, 72, 69, 75, 67);
        p.quadTo(78, 65, 80, 69);
        p.lineTo(85, 77);
        p.quadTo(87, 80, 83, 83);
        p.cubicTo(74, 91, 62, 96, 49, 96);
        p.cubicTo(23, 96, 5, 77, 5, 51);
        p.cubicTo(5, 25, 24, 6, 49, 6);
        p.cubicTo(73, 6, 91, 24, 91, 48);
        p.lineTo(91, 51);
        p.quadTo(91, 56, 86, 56);
        p.close();
        p.moveTo(29, 40);
        p.cubicTo(32, 29, 39, 24, 49, 24);
        p.cubicTo(60, 24, 68, 29, 71, 40);
        p.close();
        return p;
    }
}
