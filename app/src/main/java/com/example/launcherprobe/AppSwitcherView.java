package com.example.launcherprobe;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.dynamicanimation.animation.FloatValueHolder;
import androidx.dynamicanimation.animation.SpringAnimation;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** App covers and a touch-driven carousel; no screenshots or fabricated task state. */
final class AppSwitcherView extends FrameLayout {
    record App(ComponentName component, String label, Bitmap icon, int color) { }

    private static final int INK = 0xffe5f5f8, MUTED = 0xffa9c7d1;
    private final Consumer<App> open;
    private final Runnable dismiss, home;
    private final View wallpaper, scrim;
    private final LinearLayout content;
    private final FrameLayout stage;
    private final TextView counter, hint;
    private Carousel carousel;
    private ValueAnimator transition;
    private View expandingCover;
    private boolean busy;

    AppSwitcherView(Context context, Consumer<App> open, Runnable dismiss, Runnable home) {
        super(context);
        this.open = open;
        this.dismiss = dismiss;
        this.home = home;
        wallpaper = AppAppearance.readDesktop(context).desktopWallpaper(context);
        wallpaper.setScaleX(1.08f); wallpaper.setScaleY(1.08f);
        if (Build.VERSION.SDK_INT >= 31) wallpaper.setRenderEffect(android.graphics.RenderEffect.createBlurEffect(
                dp(24), dp(24), android.graphics.Shader.TileMode.CLAMP));
        addView(wallpaper, new LayoutParams(-1, -1));
        scrim = new View(context);
        scrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.TR_BL,
                new int[]{0xc408303e, 0xec081e28, 0xeb06242e}));
        scrim.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(scrim, new LayoutParams(-1, -1));
        content = new LinearLayout(context); content.setOrientation(LinearLayout.VERTICAL);
        addView(content, new LayoutParams(-1, -1));
        ViewCompat.setOnApplyWindowInsetsListener(this, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            content.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        LinearLayout toolbar = new LinearLayout(context); toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(24), 0, dp(12), 0);
        LinearLayout titles = new LinearLayout(context); titles.setOrientation(LinearLayout.VERTICAL);
        TextView heading = text("应用切换", 24, INK); heading.setTypeface(null, Typeface.BOLD);
        ViewCompat.setAccessibilityHeading(heading, true);
        titles.addView(heading); titles.addView(text("最近从桌面打开", 12, MUTED));
        toolbar.addView(titles, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView close = new ImageView(context); close.setImageDrawable(new ChatIcon("close", INK));
        close.setPadding(dp(14), dp(14), dp(14), dp(14)); close.setFocusable(true);
        close.setContentDescription("关闭应用切换"); close.setOnClickListener(v -> close()); Motion.press(close);
        toolbar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        content.addView(toolbar, new LinearLayout.LayoutParams(-1, dp(72)));
        stage = new FrameLayout(context); stage.setClipChildren(false); stage.setClipToPadding(false);
        content.addView(stage, new LinearLayout.LayoutParams(-1, 0, 1));
        counter = text("", 14, MUTED); counter.setGravity(Gravity.CENTER);
        counter.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        content.addView(counter, new LinearLayout.LayoutParams(-1, dp(40)));
        hint = text("左右滑动切换 · 点击打开", 13, MUTED); hint.setGravity(Gravity.CENTER);
        hint.setPadding(dp(16), 0, dp(16), dp(8));
        content.addView(hint, new LinearLayout.LayoutParams(-1, dp(56)));
        empty("正在载入应用…", null, home);
        setFocusableInTouchMode(true);
        setAccessibilityPaneTitle("应用切换");
        requestApplyInsets();
    }

    void showApps(List<App> apps, String selected) {
        if (busy) return;
        stage.removeAllViews();
        if (apps.isEmpty()) {
            empty("还没有最近打开的应用", "从桌面打开应用后，会显示在这里", home);
            return;
        }
        hint.setVisibility(VISIBLE);
        carousel = new Carousel(apps, selected);
        stage.addView(carousel, new LayoutParams(-1, -1));
        carousel.post(carousel::enter);
    }

    void showError() {
        if (!busy) empty("暂时无法读取应用", "请返回桌面后重试", home);
    }

    private void empty(String title, String description, Runnable action) {
        stage.removeAllViews();
        LinearLayout box = new LinearLayout(getContext()); box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER); box.setPadding(dp(28), dp(16), dp(28), dp(16));
        TextView heading = text(title, 20, INK); heading.setGravity(Gravity.CENTER); box.addView(heading);
        if (description != null) {
            TextView detail = text(description, 14, MUTED); detail.setGravity(Gravity.CENTER);
            detail.setPadding(0, dp(14), 0, dp(24)); box.addView(detail);
            TextView back = text("回到桌面", 15, INK); back.setGravity(Gravity.CENTER);
            back.setPadding(dp(24), 0, dp(24), 0); back.setBackground(shape(0xff294e5c, 24));
            back.setFocusable(true); back.setOnClickListener(v -> action.run()); Motion.press(back);
            box.addView(back, new LinearLayout.LayoutParams(-2, dp(48)));
        }
        stage.addView(box, new LayoutParams(-1, -1));
        counter.setText(""); hint.setVisibility(INVISIBLE);
    }

    String selectedComponent() {
        return carousel == null ? null : carousel.apps.get(carousel.selected).component().flattenToString();
    }

    void close() {
        if (busy) return;
        busy = true;
        stopAnimations();
        if (!Motion.enabled()) { dismiss.run(); return; }
        transition = ValueAnimator.ofFloat(0, 1);
        transition.setDuration(220); transition.setInterpolator(Motion.EASE);
        transition.addUpdateListener(a -> {
            float value = (float) a.getAnimatedValue();
            content.setAlpha(1 - value); content.setTranslationY(dp(64) * value);
            content.setScaleX(1 - .05f * value); content.setScaleY(1 - .05f * value);
            scrim.setAlpha(1 - .35f * value);
        });
        onTransitionEnd(dismiss);
        transition.start();
    }

    private void expand(Card card) {
        if (busy) return;
        busy = true;
        stopAnimations();
        if (!Motion.enabled()) { open.accept(card.app); return; }
        Rect bounds = new Rect();
        card.cover.getDrawingRect(bounds);
        offsetDescendantRectToMyCoords(card.cover, bounds);
        // The selected card is at scale 1; translate its cover into this full-window layer.
        expandingCover = cover(card.app);
        LayoutParams params = new LayoutParams(bounds.width(), bounds.height());
        params.leftMargin = bounds.left; params.topMargin = bounds.top;
        addView(expandingCover, params);
        GradientDrawable background = (GradientDrawable) expandingCover.getBackground();
        transition = ValueAnimator.ofFloat(0, 1);
        transition.setDuration(260); transition.setInterpolator(Motion.EASE);
        transition.addUpdateListener(a -> {
            float value = (float) a.getAnimatedValue();
            LayoutParams frame = (LayoutParams) expandingCover.getLayoutParams();
            frame.width = Math.round(bounds.width() + (getWidth() - bounds.width()) * value);
            frame.height = Math.round(bounds.height() + (getHeight() - bounds.height()) * value);
            frame.leftMargin = Math.round(bounds.left * (1 - value));
            frame.topMargin = Math.round(bounds.top * (1 - value));
            expandingCover.setLayoutParams(frame);
            background.setCornerRadius(dp(28) * (1 - value));
            content.setAlpha(1 - value);
        });
        onTransitionEnd(() -> open.accept(card.app));
        transition.start();
    }

    private void onTransitionEnd(Runnable action) {
        ValueAnimator active = transition;
        active.addListener(new AnimatorListenerAdapter() {
            @Override public void onAnimationEnd(Animator animation) {
                if (transition != active) return;
                transition = null;
                action.run();
            }
        });
    }

    void restoreAfterOpen() {
        stopAnimations();
        if (expandingCover != null) { removeView(expandingCover); expandingCover = null; }
        content.setAlpha(1); content.setTranslationY(0); content.setScaleX(1); content.setScaleY(1);
        scrim.setAlpha(1); busy = false;
    }

    void stopAnimations() {
        if (transition != null) { ValueAnimator old = transition; transition = null; old.cancel(); }
        if (carousel != null) carousel.stop();
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        return busy || super.dispatchTouchEvent(event);
    }

    @Override protected void onDetachedFromWindow() {
        stopAnimations();
        super.onDetachedFromWindow();
    }

    private FrameLayout cover(App app) {
        FrameLayout cover = new FrameLayout(getContext());
        cover.setBackground(shape(app.color(), 28)); cover.setClipToOutline(true);
        ImageView watermark = new ImageView(getContext()); watermark.setImageBitmap(app.icon());
        watermark.setAlpha(.07f);
        watermark.setTranslationX(dp(44)); watermark.setTranslationY(dp(48));
        LayoutParams waterParams = new LayoutParams(dp(224), dp(224), Gravity.BOTTOM | Gravity.RIGHT);
        cover.addView(watermark, waterParams);
        LinearLayout identity = new LinearLayout(getContext()) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                boolean compact = MeasureSpec.getSize(heightSpec) < dp(240);
                View image = getChildAt(0);
                image.getLayoutParams().width = image.getLayoutParams().height = dp(compact ? 36 : 96);
                TextView title = (TextView) getChildAt(1);
                title.setTextSize(compact ? 18 : 26); title.setMaxLines(compact ? 1 : 2);
                title.setPadding(0, dp(compact ? 6 : 20), 0, dp(compact ? 0 : 8));
                getChildAt(2).setVisibility(compact ? GONE : VISIBLE);
                setPadding(dp(20), dp(compact ? 0 : 16), dp(20), dp(compact ? 0 : 16));
                super.onMeasure(widthSpec, heightSpec);
            }
        };
        identity.setOrientation(LinearLayout.VERTICAL); identity.setGravity(Gravity.CENTER);
        ImageView icon = new ImageView(getContext()); icon.setImageBitmap(app.icon());
        identity.addView(icon, new LinearLayout.LayoutParams(dp(96), dp(96)));
        TextView title = text(app.label(), 26, 0xff102f3a); title.setTypeface(null, Typeface.BOLD);
        title.setGravity(Gravity.CENTER); title.setMaxLines(2); title.setEllipsize(TextUtils.TruncateAt.END);
        title.setPadding(0, dp(20), 0, dp(8)); identity.addView(title);
        TextView caption = text("点击打开", 14, 0xff526f79); caption.setGravity(Gravity.CENTER); identity.addView(caption);
        cover.addView(identity, new LayoutParams(-1, -2, Gravity.CENTER));
        cover.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        return cover;
    }

    private final class Card extends FrameLayout {
        final App app;
        final LinearLayout body;
        final FrameLayout cover;
        Card(App app, int index) {
            super(AppSwitcherView.this.getContext());
            this.app = app;
            setClipChildren(false); setClipToPadding(false); setFocusable(true);
            setCameraDistance(dp(1800));
            body = new LinearLayout(getContext()); body.setOrientation(LinearLayout.VERTICAL);
            body.setClipChildren(false); body.setClipToPadding(false);
            LinearLayout label = new LinearLayout(getContext()); label.setGravity(Gravity.CENTER);
            ImageView icon = new ImageView(getContext()); icon.setImageBitmap(app.icon());
            label.addView(icon, new LinearLayout.LayoutParams(dp(24), dp(24)));
            TextView name = text(app.label(), 16, INK); name.setMaxLines(1); name.setEllipsize(TextUtils.TruncateAt.END);
            name.setPadding(dp(8), 0, 0, 0); label.addView(name);
            label.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            body.addView(label, new LinearLayout.LayoutParams(-1, dp(48)));
            cover = cover(app); cover.setElevation(dp(10));
            cover.setOutlineAmbientShadowColor(0xff00121a); cover.setOutlineSpotShadowColor(0xff00121a);
            body.addView(cover, new LinearLayout.LayoutParams(-1, 0, 1));
            addView(body, new LayoutParams(-1, -1));
            setOnClickListener(v -> {
                if (busy) return;
                if (carousel.selected != index || Math.abs(carousel.track - index * carousel.stride) > dp(1))
                    carousel.settle(index, 0);
                else expand(this);
            });
        }
    }

    private final class Carousel extends FrameLayout {
        final List<App> apps;
        final List<Card> cards = new ArrayList<>();
        final int slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
        final int maxVelocity = ViewConfiguration.get(getContext()).getScaledMaximumFlingVelocity();
        final float minVelocity = Math.max(ViewConfiguration.get(getContext()).getScaledMinimumFlingVelocity(), dp(450));
        int selected, startSelected, displayed = -1;
        float stride, track, downX, downY, startTrack;
        boolean dragging, rejected, touched;
        VelocityTracker velocity;
        SpringAnimation spring;

        Carousel(List<App> apps, String selection) {
            super(AppSwitcherView.this.getContext());
            this.apps = List.copyOf(apps);
            setClipChildren(false); setClipToPadding(false); setFocusable(true); setClickable(true);
            for (int i = 0; i < apps.size(); i++) {
                if (apps.get(i).component().flattenToString().equals(selection)) selected = i;
                Card card = new Card(apps.get(i), i); cards.add(card); addView(card);
            }
            setAccessibilityDelegate(new AccessibilityDelegate() {
                @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(host, info);
                    info.setClassName("android.widget.HorizontalScrollView");
                    info.setScrollable(apps.size() > 1);
                    if (selected > 0) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD);
                    if (selected < apps.size() - 1) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD);
                }
                @Override public boolean performAccessibilityAction(View host, int action, Bundle arguments) {
                    if (!busy && action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD && selected < apps.size() - 1) {
                        settle(selected + 1, 0); return true;
                    }
                    if (!busy && action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD && selected > 0) {
                        settle(selected - 1, 0); return true;
                    }
                    return super.performAccessibilityAction(host, action, arguments);
                }
            });
        }

        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int width = MeasureSpec.getSize(widthSpec), height = MeasureSpec.getSize(heightSpec);
            setMeasuredDimension(width, height);
            int cardWidth = Math.min(dp(440), Math.round(width * .66f));
            int cardHeight = Math.max(1, Math.round(height * .9f));
            for (Card card : cards) card.measure(MeasureSpec.makeMeasureSpec(cardWidth, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(cardHeight, MeasureSpec.EXACTLY));
        }

        @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
            for (Card card : cards) {
                int x = (getWidth() - card.getMeasuredWidth()) / 2;
                int y = (getHeight() - card.getMeasuredHeight()) / 2;
                card.layout(x, y, x + card.getMeasuredWidth(), y + card.getMeasuredHeight());
            }
            float nextStride = cards.get(0).getMeasuredWidth() + dp(14);
            if (stride != nextStride) {
                stop(); stride = nextStride; track = selected * stride;
            }
            apply(track);
        }

        void enter() {
            if (busy || !isAttachedToWindow()) return;
            apply(selected * stride);
            if (!Motion.enabled()) return;
            for (int i = 0; i < cards.size(); i++) {
                Card card = cards.get(i);
                if (card.getVisibility() != VISIBLE) continue;
                card.body.setAlpha(0); card.body.setTranslationY(dp(56));
                card.body.animate().alpha(1).translationY(0).setDuration(320)
                        .setStartDelay(Math.abs(i - selected) * 32L).setInterpolator(Motion.EASE).start();
            }
        }

        void apply(float value) {
            track = value;
            if (stride == 0) return;
            for (int i = 0; i < cards.size(); i++) {
                Card card = cards.get(i);
                float relative = (i * stride - track) / stride;
                float distance = Math.min(1.5f, Math.abs(relative));
                card.setVisibility(Math.abs(relative) > 1.8f ? INVISIBLE : VISIBLE);
                card.setTranslationX(i * stride - track);
                card.setTranslationY(dp(14) * distance);
                card.setScaleX(1 - .1f * distance); card.setScaleY(1 - .1f * distance);
                card.setRotationY(-5 * Math.max(-1, Math.min(1, relative)));
                card.setAlpha(1 - .25f * distance);
                card.setContentDescription((i == selected ? "打开 " : "切换到 ") + card.app.label());
                card.setSelected(i == selected);
            }
            int nearest = Math.max(0, Math.min(apps.size() - 1, Math.round(track / stride)));
            if (nearest != displayed) {
                displayed = nearest;
                counter.setText((nearest + 1) + " / " + apps.size());
            }
            wallpaper.setTranslationX(-dp(12) * track / Math.max(stride, (apps.size() - 1) * stride));
        }

        @Override public boolean dispatchTouchEvent(MotionEvent event) {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                stop(); touched = true; dragging = rejected = false;
                downX = event.getX(); downY = event.getY(); startTrack = track; startSelected = selected;
                velocity = VelocityTracker.obtain();
            }
            if (!touched) return true;
            if (action == MotionEvent.ACTION_POINTER_DOWN) {
                MotionEvent cancel = MotionEvent.obtain(event); cancel.setAction(MotionEvent.ACTION_CANCEL);
                super.dispatchTouchEvent(cancel); cancel.recycle();
                rejected = true; touched = false; dragging = false;
                recycleVelocity(); settle(startSelected, 0);
                return true;
            }
            if (velocity != null) velocity.addMovement(event);
            boolean result = super.dispatchTouchEvent(event);
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                touched = false; recycleVelocity();
                if (!dragging && Math.abs(track - selected * stride) > .5f) settle(selected, 0);
                dragging = false;
            }
            return result;
        }

        @Override public boolean onInterceptTouchEvent(MotionEvent event) {
            if (event.getActionMasked() != MotionEvent.ACTION_MOVE || rejected) return false;
            float dx = event.getX() - downX, dy = event.getY() - downY;
            if (Math.abs(dy) > slop && Math.abs(dy) >= Math.abs(dx)) { rejected = true; return false; }
            if (Math.abs(dx) > slop && Math.abs(dx) > Math.abs(dy)) {
                dragging = true;
                getParent().requestDisallowInterceptTouchEvent(true);
                drag(dx);
                return true;
            }
            return false;
        }

        private void drag(float dx) {
            float next = startTrack - dx, max = (apps.size() - 1) * stride;
            // Resist at the ends while keeping the card physically attached to the finger.
            if (next < 0) next = Math.max(-stride * .22f, next * .22f);
            if (next > max) next = max + Math.min(stride * .22f, (next - max) * .22f);
            apply(next);
        }

        @Override public boolean onTouchEvent(MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_MOVE:
                    if (dragging && !rejected) drag(event.getX() - downX);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (!dragging) { if (event.getActionMasked() == MotionEvent.ACTION_UP && !rejected) performClick(); return true; }
                    float speed = 0;
                    if (velocity != null) { velocity.computeCurrentVelocity(1000, maxVelocity); speed = -velocity.getXVelocity(); }
                    int target = startSelected;
                    if (!rejected && event.getActionMasked() != MotionEvent.ACTION_CANCEL && stride > 0) {
                        target = Math.round(track / stride);
                        if (Math.abs(speed) >= minVelocity)
                            target = speed > 0 ? (int) Math.floor(track / stride) + 1 : (int) Math.ceil(track / stride) - 1;
                    }
                    settle(target, rejected || event.getActionMasked() == MotionEvent.ACTION_CANCEL ? 0 : speed);
                    return true;
                default: return true;
            }
        }

        @Override public boolean performClick() { return super.performClick(); }

        void settle(int target, float speed) {
            cancelSpring();
            selected = Math.max(0, Math.min(apps.size() - 1, target));
            float end = selected * stride;
            if (!Motion.enabled() || Math.abs(track - end) < .5f) { apply(end); return; }
            spring = Motion.spring(new FloatValueHolder(track), track, end, speed,
                    (animation, value, v) -> apply(value),
                    (animation, cancelled, value, v) -> {
                        if (!cancelled) { spring = null; apply(end); }
                    });
            spring.getSpring().setDampingRatio(.84f).setStiffness(420f);
        }

        @Override public boolean dispatchKeyEvent(KeyEvent event) {
            if (!busy && event.getAction() == KeyEvent.ACTION_DOWN) {
                if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_LEFT) { settle(selected - 1, 0); return true; }
                if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_RIGHT) { settle(selected + 1, 0); return true; }
                if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER || event.getKeyCode() == KeyEvent.KEYCODE_ENTER)
                    return cards.get(selected).performClick();
            }
            return super.dispatchKeyEvent(event);
        }

        void stop() {
            cancelSpring(); recycleVelocity();
            for (Card card : cards) {
                card.body.animate().cancel(); card.body.setAlpha(1); card.body.setTranslationY(0);
            }
        }

        private void cancelSpring() {
            if (spring != null) { SpringAnimation old = spring; spring = null; old.cancel(); }
        }

        private void recycleVelocity() { if (velocity != null) { velocity.recycle(); velocity = null; } }
    }

    private TextView text(String value, float size, int color) {
        TextView text = new TextView(getContext()); text.setText(value); text.setTextSize(size); text.setTextColor(color);
        return text;
    }

    private GradientDrawable shape(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
