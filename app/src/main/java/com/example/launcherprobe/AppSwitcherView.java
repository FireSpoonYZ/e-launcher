package com.example.launcherprobe;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ArgbEvaluator;
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
import android.view.HapticFeedbackConstants;
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

/**
 * App covers and a touch-driven carousel. Covers carry screens the launcher captured itself and
 * are filled in only around the visible window, the way Quickstep loads task thumbnails.
 */
final class AppSwitcherView extends FrameLayout {
    record App(ComponentName component, String label) { }

    /** Everything expensive about one app: its icon, the cover tint, and the captured screen. */
    record Art(Bitmap icon, int color, Bitmap snapshot) { }

    interface Host {
        void open(App app);
        void close();
        void home();
        void forget(App app);
        /** Loads art off the main thread; the callback arrives on the main thread, or never. */
        void load(App app, java.util.function.Consumer<Art> ready);
        void cancel(App app);
    }

    private static final int INK = 0xffe5f5f8, MUTED = 0xffa9c7d1, PLACEHOLDER = 0xff20414d;
    // One card ahead of the passed edge, five behind it: everything the stack can actually show.
    private static final int WINDOW_BEFORE = 1, WINDOW_AFTER = 5;
    private final Host host;
    private final View wallpaper, scrim;
    private final LinearLayout content;
    private final FrameLayout stage;
    private final TextView counter, clear;
    private Carousel carousel;
    private ValueAnimator transition;
    private View expandingCover;
    private boolean busy;

    AppSwitcherView(Context context, Host host) {
        super(context);
        this.host = host;
        wallpaper = AppAppearance.readDesktop(context).desktopWallpaper(context);
        wallpaper.setScaleX(1.08f); wallpaper.setScaleY(1.08f);
        if (Build.VERSION.SDK_INT >= 31) wallpaper.setRenderEffect(android.graphics.RenderEffect.createBlurEffect(
                dp(24), dp(24), android.graphics.Shader.TileMode.CLAMP));
        addView(wallpaper, new LayoutParams(-1, -1));
        scrim = new View(context);
        scrim.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(scrim, new LayoutParams(-1, -1));
        glass(false);
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
        content.addView(counter, new LinearLayout.LayoutParams(-1, dp(46)));
        clear = text("清除全部", 15, INK); clear.setGravity(Gravity.CENTER);
        clear.setPadding(dp(24), 0, dp(24), 0); clear.setBackground(pill());
        clear.setFocusable(true); clear.setContentDescription("清除全部应用");
        clear.setOnClickListener(v -> clearAll()); Motion.press(clear);
        FrameLayout footer = new FrameLayout(context);
        footer.addView(clear, new LayoutParams(-2, dp(44), Gravity.CENTER));
        content.addView(footer, new LinearLayout.LayoutParams(-1, dp(72)));
        empty("正在载入应用…", null);
        setFocusableInTouchMode(true);
        setAccessibilityPaneTitle("应用切换");
        requestApplyInsets();
    }

    /** Window-level blur already frosts everything behind; the local wallpaper copy would double it. */
    void glass(boolean windowBlur) {
        wallpaper.setVisibility(windowBlur ? GONE : VISIBLE);
        scrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.TR_BL, windowBlur
                ? new int[]{0x3308303e, 0x59081e28, 0x4c06242e}
                : new int[]{0xc408303e, 0xec081e28, 0xeb06242e}));
    }

    void showApps(List<App> apps, String selected) {
        if (busy) return;
        stage.removeAllViews();
        if (apps.isEmpty()) {
            empty("还没有最近打开的应用", "从桌面打开应用后，会显示在这里");
            return;
        }
        clear.setVisibility(VISIBLE);
        carousel = new Carousel(apps, selected);
        stage.addView(carousel, new LayoutParams(-1, -1));
        carousel.post(carousel::enter);
    }

    void showError() {
        if (!busy) empty("暂时无法读取应用", "请返回桌面后重试");
    }

    private void empty(String title, String description) {
        stage.removeAllViews();
        carousel = null;
        LinearLayout box = new LinearLayout(getContext()); box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER); box.setPadding(dp(28), dp(16), dp(28), dp(16));
        TextView heading = text(title, 20, INK); heading.setGravity(Gravity.CENTER); box.addView(heading);
        if (description != null) {
            TextView detail = text(description, 14, MUTED); detail.setGravity(Gravity.CENTER);
            detail.setPadding(0, dp(14), 0, dp(24)); box.addView(detail);
            TextView back = text("回到桌面", 15, INK); back.setGravity(Gravity.CENTER);
            back.setPadding(dp(24), 0, dp(24), 0); back.setBackground(shape(0xff294e5c, 24));
            back.setFocusable(true); back.setOnClickListener(v -> host.home()); Motion.press(back);
            box.addView(back, new LinearLayout.LayoutParams(-2, dp(48)));
        }
        stage.addView(box, new LayoutParams(-1, -1));
        Motion.enter(box, dp(24));
        counter.setText(""); clear.setVisibility(INVISIBLE);
    }

    String selectedComponent() {
        return carousel == null || carousel.cards.isEmpty() ? null
                : carousel.cards.get(carousel.selected).app.component().flattenToString();
    }

    void close() {
        if (busy) return;
        busy = true;
        stopAnimations();
        if (!Motion.enabled()) { host.close(); return; }
        transition = ValueAnimator.ofFloat(0, 1);
        transition.setDuration(220); transition.setInterpolator(Motion.EASE);
        transition.addUpdateListener(a -> {
            float value = (float) a.getAnimatedValue();
            content.setAlpha(1 - value); content.setTranslationY(dp(64) * value);
            content.setScaleX(1 - .05f * value); content.setScaleY(1 - .05f * value);
            scrim.setAlpha(1 - .35f * value);
        });
        onTransitionEnd(host::close);
        transition.start();
    }

    private void clearAll() {
        if (busy || carousel == null || carousel.cards.isEmpty()) return;
        carousel.clearAll();
    }

    private void expand(Card card) {
        if (busy) return;
        busy = true;
        stopAnimations();
        if (!Motion.enabled()) { host.open(card.app); return; }
        Rect bounds = new Rect();
        card.cover.getDrawingRect(bounds);
        offsetDescendantRectToMyCoords(card.cover, bounds);
        // The selected card is at scale 1; translate its cover into this full-window layer.
        expandingCover = cover(card.app, card.art);
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
        onTransitionEnd(() -> host.open(card.app));
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

    /** Cover layers are fixed: the captured screen on top, the icon identity underneath. */
    private FrameLayout cover(App app, Art art) {
        FrameLayout cover = new FrameLayout(getContext());
        cover.setBackground(plate(art == null ? PLACEHOLDER : art.color()));
        cover.setClipToOutline(true);
        ImageView shot = new ImageView(getContext());
        shot.setScaleType(ImageView.ScaleType.CENTER_CROP);
        cover.addView(shot, new LayoutParams(-1, -1));
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
        ImageView icon = new ImageView(getContext());
        identity.addView(icon, new LinearLayout.LayoutParams(dp(96), dp(96)));
        boolean known = art != null;
        TextView title = text(app.label(), 26, known ? 0xff102f3a : INK); title.setTypeface(null, Typeface.BOLD);
        title.setGravity(Gravity.CENTER); title.setMaxLines(2); title.setEllipsize(TextUtils.TruncateAt.END);
        title.setPadding(0, dp(20), 0, dp(8)); identity.addView(title);
        TextView caption = text(known ? "点击打开" : "正在载入…", 14, known ? 0xff526f79 : MUTED);
        caption.setGravity(Gravity.CENTER); identity.addView(caption);
        cover.addView(identity, new LayoutParams(-1, -2, Gravity.CENTER));
        cover.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        if (known) paint(cover, art, false);
        return cover;
    }

    /** Fills a built cover with real art, either instantly or as a reveal over the placeholder. */
    private void paint(FrameLayout cover, Art art, boolean animated) {
        ImageView shot = (ImageView) cover.getChildAt(0);
        LinearLayout identity = (LinearLayout) cover.getChildAt(1);
        ImageView icon = (ImageView) identity.getChildAt(0);
        boolean captured = art.snapshot() != null && !art.snapshot().isRecycled();
        icon.setImageBitmap(art.icon());
        ((TextView) identity.getChildAt(1)).setTextColor(0xff102f3a);
        TextView caption = (TextView) identity.getChildAt(2);
        caption.setText("点击打开"); caption.setTextColor(0xff526f79);
        if (captured) shot.setImageBitmap(art.snapshot());
        shot.setAlpha(captured ? 1f : 0f);
        identity.setAlpha(captured ? 0f : 1f);
        identity.setVisibility(captured ? INVISIBLE : VISIBLE);
        GradientDrawable plate = (GradientDrawable) cover.getBackground();
        if (!animated || !Motion.enabled()) {
            plate.setColors(plateColors(captured ? 0xff0b1b21 : art.color()));
            return;
        }
        // The cover keeps its placeholder shape and only its content materialises.
        View revealed = captured ? shot : identity;
        revealed.setAlpha(0f); revealed.setScaleX(1.05f); revealed.setScaleY(1.05f);
        revealed.animate().alpha(1f).scaleX(1f).scaleY(1f)
                .setDuration(280).setInterpolator(Motion.EASE).start();
        ValueAnimator tint = ValueAnimator.ofObject(new ArgbEvaluator(),
                PLACEHOLDER, captured ? 0xff0b1b21 : art.color());
        tint.setDuration(280); tint.setInterpolator(Motion.EASE);
        tint.addUpdateListener(a -> plate.setColors(plateColors((int) a.getAnimatedValue())));
        tint.start();
    }

    private final class Card extends FrameLayout {
        final App app;
        final LinearLayout body;
        final FrameLayout cover;
        final ImageView badge;
        Art art;
        boolean pending;
        float slot, lift;

        Card(App app, int index) {
            super(AppSwitcherView.this.getContext());
            this.app = app;
            this.slot = index;
            setClipChildren(false); setClipToPadding(false); setFocusable(true);
            setCameraDistance(dp(1800));
            body = new LinearLayout(getContext()); body.setOrientation(LinearLayout.VERTICAL);
            body.setClipChildren(false); body.setClipToPadding(false);
            LinearLayout label = new LinearLayout(getContext()); label.setGravity(Gravity.CENTER_VERTICAL);
            label.setPadding(dp(14), 0, dp(18), 0); label.setBackground(pill());
            badge = new ImageView(getContext()); badge.setAlpha(0f);
            label.addView(badge, new LinearLayout.LayoutParams(dp(22), dp(22)));
            TextView name = text(app.label(), 15, INK); name.setMaxLines(1); name.setEllipsize(TextUtils.TruncateAt.END);
            name.setPadding(dp(8), 0, 0, 0); label.addView(name);
            label.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            LinearLayout header = new LinearLayout(getContext()); header.setGravity(Gravity.CENTER);
            header.addView(label, new LinearLayout.LayoutParams(-2, dp(36)));
            header.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            body.addView(header, new LinearLayout.LayoutParams(-1, dp(48)));
            cover = cover(app, null); cover.setElevation(dp(10));
            cover.setOutlineAmbientShadowColor(0xff00121a); cover.setOutlineSpotShadowColor(0xff00121a);
            body.addView(cover, new LinearLayout.LayoutParams(-1, 0, 1));
            addView(body, new LayoutParams(-1, -1));
            setOnClickListener(v -> {
                if (busy || carousel == null) return;
                int position = carousel.cards.indexOf(this);
                if (position < 0) return;
                if (carousel.selected != position || Math.abs(carousel.track - slot * carousel.stride) > dp(1))
                    carousel.settle(position, 0);
                else expand(this);
            });
        }

        void bind(Art loaded) {
            pending = false;
            if (loaded == null || art != null) return;
            art = loaded;
            paint(cover, loaded, true);
            badge.setImageBitmap(loaded.icon());
            if (!Motion.enabled()) { badge.setAlpha(1f); return; }
            badge.setAlpha(0f); badge.setScaleX(.7f); badge.setScaleY(.7f);
            badge.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(240)
                    .setInterpolator(Motion.EASE).start();
        }

        /** Far outside the window a card keeps its frame but drops every bitmap it referenced. */
        void unbind() {
            if (art == null) return;
            art = null;
            badge.animate().cancel(); badge.setImageDrawable(null); badge.setAlpha(0f);
            ImageView shot = (ImageView) cover.getChildAt(0);
            LinearLayout identity = (LinearLayout) cover.getChildAt(1);
            shot.animate().cancel(); shot.setImageDrawable(null); shot.setAlpha(0f);
            identity.animate().cancel(); identity.setAlpha(1f); identity.setVisibility(VISIBLE);
            ((ImageView) identity.getChildAt(0)).setImageDrawable(null);
            ((TextView) identity.getChildAt(1)).setTextColor(INK);
            TextView caption = (TextView) identity.getChildAt(2);
            caption.setText("正在载入…"); caption.setTextColor(MUTED);
            ((GradientDrawable) cover.getBackground()).setColors(plateColors(PLACEHOLDER));
        }

        @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(info);
            info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_DISMISS);
        }

        @Override public boolean performAccessibilityAction(int action, Bundle arguments) {
            if (action == AccessibilityNodeInfo.ACTION_DISMISS && !busy && carousel != null) {
                carousel.remove(this, 0);
                return true;
            }
            return super.performAccessibilityAction(action, arguments);
        }
    }

    private final class Carousel extends FrameLayout {
        final List<Card> cards = new ArrayList<>();
        final int slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
        final int maxVelocity = ViewConfiguration.get(getContext()).getScaledMaximumFlingVelocity();
        final float minVelocity = Math.max(ViewConfiguration.get(getContext()).getScaledMinimumFlingVelocity(), dp(450));
        int selected, startSelected, displayed = -1, windowFirst = -1, windowLast = -1;
        float stride, track, downX, downY, startTrack;
        boolean dragging, lifting, rejected, touched;
        VelocityTracker velocity;
        SpringAnimation spring, dropSpring;
        ValueAnimator collapse;

        Carousel(List<App> apps, String selection) {
            super(AppSwitcherView.this.getContext());
            setClipChildren(false); setClipToPadding(false); setFocusable(true); setClickable(true);
            for (int i = 0; i < apps.size(); i++) {
                if (apps.get(i).component().flattenToString().equals(selection)) selected = i;
                Card card = new Card(apps.get(i), i); cards.add(card); addView(card);
            }
            setAccessibilityDelegate(new AccessibilityDelegate() {
                @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(host, info);
                    info.setClassName("android.widget.HorizontalScrollView");
                    info.setScrollable(cards.size() > 1);
                    if (selected > 0) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD);
                    if (selected < cards.size() - 1) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD);
                }
                @Override public boolean performAccessibilityAction(View host, int action, Bundle arguments) {
                    if (!busy && action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD && selected < cards.size() - 1) {
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
            // A cover is a scale model of the display, so captured screens keep their proportions.
            float ratio = displayRatio();
            int header = dp(48);
            int coverWidth = Math.min(dp(440), Math.round(width * .72f));
            int coverHeight = Math.round(coverWidth * ratio);
            int room = Math.max(1, Math.round(height * .94f) - header);
            if (coverHeight > room) {
                coverHeight = room;
                coverWidth = Math.max(1, Math.round(coverHeight / ratio));
            }
            int cardWidth = coverWidth, cardHeight = coverHeight + header;
            for (Card card : cards) card.measure(MeasureSpec.makeMeasureSpec(cardWidth, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(cardHeight, MeasureSpec.EXACTLY));
        }

        private float displayRatio() {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Rect bounds = getContext().getSystemService(android.view.WindowManager.class)
                        .getMaximumWindowMetrics().getBounds();
                if (bounds.width() > 0 && bounds.height() > 0) return bounds.height() / (float) bounds.width();
            }
            android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
            return metrics.widthPixels > 0 ? metrics.heightPixels / (float) metrics.widthPixels : 2f;
        }

        @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
            for (Card card : cards) {
                int x = (getWidth() - card.getMeasuredWidth()) / 2;
                int y = (getHeight() - card.getMeasuredHeight()) / 2;
                card.layout(x, y, x + card.getMeasuredWidth(), y + card.getMeasuredHeight());
            }
            if (cards.isEmpty()) return;
            // A screen-wide drag traverses several cards, independently of cover width.
            float nextStride = cards.get(0).getMeasuredWidth() * .42f;
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
            Card front = front();
            // A lifted card already vacates its slot, so the stack starts closing the gap under it.
            float vacated = front == null || front.getHeight() == 0 ? 0
                    : Math.min(1, -front.lift / (front.getHeight() * .8f));
            float frontSlot = front == null ? 0 : front.slot;
            for (int i = 0; i < cards.size(); i++) {
                Card card = cards.get(i);
                float relative = (card.slot * stride - track) / stride;
                if (card != front && card.slot > frontSlot) relative -= vacated * .35f;
                // Older covers nest behind the foreground; passed covers slide off to the left.
                float depth = Math.max(0, relative);
                float passed = Math.max(0, -relative);
                float width = card.getWidth();
                float offset = relative >= 0 ? width * .24f * depth / (1 + .45f * depth)
                        : -width * .95f * passed;
                float scale = 1 - .065f * Math.min(depth, 4) - .025f * Math.min(passed, 2);
                float alpha = Math.max(0, 1 - Math.max(0, depth - 3))
                        * Math.max(0, 1 - Math.max(0, passed - .6f) / .4f);
                float raised = card == front ? vacated : 0;
                card.setVisibility(alpha == 0 && card.lift == 0 ? INVISIBLE : VISIBLE);
                card.setTranslationX(offset - width * .04f);
                card.setTranslationY(dp(10) * Math.min(depth, 4) + card.lift);
                card.setScaleX(scale * (1 - .08f * raised)); card.setScaleY(scale * (1 - .08f * raised));
                card.setTranslationZ(card.lift < 0 ? dp(40) : dp(20) - relative * dp(2));
                card.setAlpha(alpha * (1 - .8f * raised));
                card.body.getChildAt(0).setAlpha(Math.max(0, 1 - Math.abs(relative)));
                card.setContentDescription((i == selected ? "打开 " : "切换到 ") + card.app.label());
                card.setSelected(i == selected);
            }
            int nearest = Math.max(0, Math.min(cards.size() - 1, Math.round(track / stride)));
            if (nearest != displayed) {
                displayed = nearest;
                counter.setText((nearest + 1) + " / " + cards.size());
            }
            refreshWindow(nearest);
            wallpaper.setTranslationX(-dp(12) * track / Math.max(stride, (cards.size() - 1) * stride));
        }

        /** Art is requested for the cards the stack can show and cancelled the moment they leave. */
        void refreshWindow(int centre) {
            int first = Math.max(0, centre - WINDOW_BEFORE);
            int last = Math.min(cards.size() - 1, centre + WINDOW_AFTER);
            if (first == windowFirst && last == windowLast) return;
            for (int i = 0; i < cards.size(); i++) {
                Card card = cards.get(i);
                if (i >= first && i <= last) {
                    if (card.art != null || card.pending) continue;
                    card.pending = true;
                    host.load(card.app, card::bind);
                } else if (card.pending || card.art != null) {
                    if (card.pending) { card.pending = false; host.cancel(card.app); }
                    card.unbind();
                }
            }
            windowFirst = first; windowLast = last;
        }

        @Override public boolean dispatchTouchEvent(MotionEvent event) {
            if (collapse != null) return true;
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                stop(); touched = true; dragging = lifting = rejected = false;
                // Catch an in-flight stack at the visible card, not its old destination.
                if (stride > 0) selected = Math.max(0, Math.min(cards.size() - 1, Math.round(track / stride)));
                downX = event.getX(); downY = event.getY(); startTrack = track; startSelected = selected;
                velocity = VelocityTracker.obtain();
            }
            if (!touched) return true;
            if (action == MotionEvent.ACTION_POINTER_DOWN) {
                MotionEvent cancel = MotionEvent.obtain(event); cancel.setAction(MotionEvent.ACTION_CANCEL);
                super.dispatchTouchEvent(cancel); cancel.recycle();
                rejected = true; touched = false; dragging = false;
                if (lifting) { lifting = false; drop(front(), 0); }
                recycleVelocity(); settle(startSelected, 0);
                return true;
            }
            if (velocity != null) velocity.addMovement(event);
            boolean result = super.dispatchTouchEvent(event);
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                touched = false; recycleVelocity();
                if (!dragging && !lifting && Math.abs(track - selected * stride) > .5f) settle(selected, 0);
                dragging = lifting = false;
            }
            return result;
        }

        @Override public boolean onInterceptTouchEvent(MotionEvent event) {
            if (event.getActionMasked() != MotionEvent.ACTION_MOVE || rejected) return false;
            float dx = event.getX() - downX, dy = event.getY() - downY;
            if (Math.abs(dy) > slop && Math.abs(dy) >= Math.abs(dx)) {
                // Up is "remove this card"; down keeps belonging to whatever is underneath.
                if (dy >= 0 || front() == null) { rejected = true; return false; }
                lifting = true;
                getParent().requestDisallowInterceptTouchEvent(true);
                lift(dy);
                return true;
            }
            if (Math.abs(dx) > slop && Math.abs(dx) > Math.abs(dy)) {
                dragging = true;
                getParent().requestDisallowInterceptTouchEvent(true);
                drag(dx);
                return true;
            }
            return false;
        }

        private Card front() {
            return cards.isEmpty() ? null : cards.get(Math.max(0, Math.min(cards.size() - 1, selected)));
        }

        private void drag(float dx) {
            float next = startTrack - dx, max = (cards.size() - 1) * stride;
            // Resist at the ends while keeping the card physically attached to the finger.
            if (next < 0) next = Math.max(-stride * .22f, next * .22f);
            if (next > max) next = max + Math.min(stride * .22f, (next - max) * .22f);
            apply(next);
        }

        private void lift(float dy) {
            Card card = front();
            if (card == null) return;
            card.lift = Math.min(0, dy);
            apply(track);
        }

        /** Release below the removal threshold: the card springs back into the stack. */
        private void drop(Card card, float speed) {
            cancelDrop();
            if (card == null || card.lift == 0) return;
            dropSpring = Motion.spring(new FloatValueHolder(card.lift), card.lift, 0, speed,
                    (animation, value, v) -> { card.lift = value; apply(track); },
                    (animation, cancelled, value, v) -> { if (!cancelled) dropSpring = null; });
        }

        @Override public boolean onTouchEvent(MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_MOVE:
                    // Gestures can also start in the space around the stack.
                    if (!dragging && !lifting && !rejected) onInterceptTouchEvent(event);
                    if (lifting && !rejected) lift(event.getY() - downY);
                    else if (dragging && !rejected) drag(event.getX() - downX);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (lifting) { release(event); return true; }
                    if (!dragging) { if (event.getActionMasked() == MotionEvent.ACTION_UP && !rejected) performClick(); return true; }
                    float speed = 0;
                    if (velocity != null) { velocity.computeCurrentVelocity(1000, maxVelocity); speed = -velocity.getXVelocity(); }
                    int target = startSelected;
                    if (!rejected && event.getActionMasked() != MotionEvent.ACTION_CANCEL && stride > 0) {
                        drag(event.getX() - downX);
                        target = Math.round(track / stride);
                        if (Math.abs(speed) >= minVelocity)
                            target = Math.round((track + speed * .22f) / stride);
                    }
                    settle(target, rejected || event.getActionMasked() == MotionEvent.ACTION_CANCEL ? 0 : speed);
                    return true;
                default: return true;
            }
        }

        private void release(MotionEvent event) {
            Card card = front();
            lifting = false;
            if (card == null) return;
            float speed = 0;
            if (velocity != null) { velocity.computeCurrentVelocity(1000, maxVelocity); speed = velocity.getYVelocity(); }
            boolean cancelled = rejected || event.getActionMasked() == MotionEvent.ACTION_CANCEL;
            if (!cancelled) card.lift = Math.min(0, event.getY() - downY);
            boolean removes = !cancelled
                    && (-card.lift > card.getHeight() * .2f || speed <= -minVelocity);
            if (removes) remove(card, speed); else drop(card, speed);
        }

        @Override public boolean performClick() { return super.performClick(); }

        /** One animator flies the card out, closes the gap behind it, and re-centres the stack. */
        void remove(Card card, float speed) {
            int index = cards.indexOf(card);
            if (index < 0 || collapse != null) return;
            performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            cancelDrop();
            host.cancel(card.app);
            host.forget(card.app);
            cards.remove(index);
            selected = Math.max(0, Math.min(cards.size() - 1, selected));
            displayed = -1; windowFirst = windowLast = -1;
            if (cards.isEmpty()) {
                removeView(card);
                empty("已清除全部应用", "从桌面打开应用后，会再次显示在这里");
                return;
            }
            float[] from = new float[cards.size()];
            for (int i = 0; i < cards.size(); i++) from[i] = cards.get(i).slot;
            float liftFrom = card.lift, liftTo = -2f * card.getHeight();
            float trackFrom = track, trackTo = selected * stride;
            if (!Motion.enabled()) {
                removeView(card);
                for (int i = 0; i < cards.size(); i++) cards.get(i).slot = i;
                apply(trackTo);
                return;
            }
            card.lift = 0;
            collapse = ValueAnimator.ofFloat(0, 1);
            collapse.setDuration(300); collapse.setInterpolator(Motion.EASE);
            collapse.addUpdateListener(a -> {
                float value = (float) a.getAnimatedValue();
                card.setTranslationY(liftFrom + (liftTo - liftFrom) * value);
                // Quickstep fades a dismissed task over the first half of its travel.
                card.setAlpha(Math.max(0, 1 - value * 2f));
                for (int i = 0; i < cards.size(); i++) cards.get(i).slot = from[i] + (i - from[i]) * value;
                apply(trackFrom + (trackTo - trackFrom) * value);
            });
            collapse.addListener(new AnimatorListenerAdapter() {
                @Override public void onAnimationEnd(Animator animation) {
                    collapse = null;
                    removeView(card);
                    for (int i = 0; i < cards.size(); i++) cards.get(i).slot = i;
                    apply(selected * stride);
                }
            });
            collapse.start();
        }

        void clearAll() {
            List<Card> leaving = new ArrayList<>(cards);
            for (Card card : leaving) { host.cancel(card.app); host.forget(card.app); }
            cards.clear();
            if (!Motion.enabled()) {
                removeAllViews();
                empty("已清除全部应用", "从桌面打开应用后，会再次显示在这里");
                return;
            }
            performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            stop();
            for (int i = 0; i < leaving.size(); i++) {
                Card card = leaving.get(i);
                if (card.getVisibility() != VISIBLE) continue;
                card.animate().translationY(-2f * card.getHeight()).alpha(0)
                        .setStartDelay(Math.min(6, i) * 36L).setDuration(260)
                        .setInterpolator(Motion.EASE).start();
            }
            counter.setText("");
            postDelayed(() -> {
                if (carousel != Carousel.this) return;
                empty("已清除全部应用", "从桌面打开应用后，会再次显示在这里");
            }, 300);
        }

        void settle(int target, float speed) {
            cancelSpring();
            if (cards.isEmpty()) return;
            selected = Math.max(0, Math.min(cards.size() - 1, target));
            float end = selected * stride;
            if (!Motion.enabled() || Math.abs(track - end) < .5f) { apply(end); return; }
            spring = Motion.spring(new FloatValueHolder(track), track, end, speed,
                    (animation, value, v) -> apply(value),
                    (animation, cancelled, value, v) -> {
                        if (!cancelled) { spring = null; apply(end); }
                    });
            // Long throws retain momentum; short corrections settle more firmly.
            spring.getSpring().setDampingRatio(1f)
                    .setStiffness(Math.abs(speed) >= minVelocity ? 110f : 420f);
            spring.setMinValue(-stride * .22f);
            spring.setMaxValue((cards.size() - 1.0f + .22f) * stride);
        }

        @Override public boolean dispatchKeyEvent(KeyEvent event) {
            if (!busy && !cards.isEmpty() && event.getAction() == KeyEvent.ACTION_DOWN) {
                if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_LEFT) { settle(selected - 1, 0); return true; }
                if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_RIGHT) { settle(selected + 1, 0); return true; }
                if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER || event.getKeyCode() == KeyEvent.KEYCODE_ENTER)
                    return cards.get(selected).performClick();
            }
            return super.dispatchKeyEvent(event);
        }

        void stop() {
            cancelSpring(); cancelDrop(); recycleVelocity();
            if (collapse != null) { ValueAnimator old = collapse; collapse = null; old.cancel(); }
            for (Card card : cards) {
                card.animate().cancel();
                card.body.animate().cancel(); card.body.setAlpha(1); card.body.setTranslationY(0);
            }
        }

        private void cancelSpring() {
            if (spring != null) { SpringAnimation old = spring; spring = null; old.cancel(); }
        }

        private void cancelDrop() {
            if (dropSpring != null) { SpringAnimation old = dropSpring; dropSpring = null; old.cancel(); }
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

    /** Covers are lit from the top, which keeps the stack readable when several overlap. */
    private GradientDrawable plate(int color) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, plateColors(color));
        drawable.setCornerRadius(dp(28));
        return drawable;
    }

    private static int[] plateColors(int color) {
        return new int[]{androidx.core.graphics.ColorUtils.blendARGB(color, 0xffffffff, .12f), color};
    }

    /** Frosted chip: translucent fill with a hairline edge, readable over the blurred backdrop. */
    private GradientDrawable pill() {
        GradientDrawable drawable = shape(0x2bffffff, 22);
        drawable.setStroke(Math.max(1, dp(.6f)), 0x33ffffff);
        return drawable;
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
