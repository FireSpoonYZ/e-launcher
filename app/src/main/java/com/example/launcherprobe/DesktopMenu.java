package com.example.launcherprobe;

import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.view.KeyEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;

import androidx.core.graphics.PathParser;

import java.util.ArrayList;
import java.util.List;

/** One window-local surface: compact menu, sharp selected icon, and dismissible backdrop. */
final class DesktopMenu extends FrameLayout {
    private final FrameLayout host;
    private final View anchor;
    private final View preview;
    private final ScrollView panel;
    private final Runnable onDismiss;
    private final List<Background> background = new ArrayList<>();
    private final Rect safe = new Rect();
    private final Rect anchorBounds = new Rect();
    private final int[] origin = new int[2];

    DesktopMenu(FrameLayout host, View anchor, View preview, LinearLayout content, Runnable onDismiss) {
        super(host.getContext());
        this.host = host;
        this.anchor = anchor;
        this.preview = preview;
        this.onDismiss = onDismiss;
        AppAppearance colors = AppAppearance.read(getContext());
        setBackgroundColor(colors.dark ? 0x50000000 : 0x24eceee8);
        setClickable(true);
        setFocusableInTouchMode(true);
        setOnClickListener(view -> onDismiss.run());
        setContentDescription(UiText.isEnglish(getContext()) ? "Close app menu" : "关闭应用菜单");

        for (int index = 0; index < host.getChildCount(); index++) {
            View child = host.getChildAt(index);
            background.add(new Background(child, child.getImportantForAccessibility()));
            child.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            if (Build.VERSION.SDK_INT >= 31) {
                child.setRenderEffect(RenderEffect.createBlurEffect(dp(10), dp(10), Shader.TileMode.CLAMP));
            }
        }
        panel = new ScrollView(getContext());
        panel.setVerticalScrollBarEnabled(false);
        panel.setOverScrollMode(OVER_SCROLL_NEVER);
        panel.setClickable(true);
        panel.setBackground(surface(colors.dark ? colors.surface : 0xfffafaf8, dp(24)));
        panel.setClipToOutline(true);
        panel.setElevation(dp(10));
        panel.addView(content, new ScrollView.LayoutParams(-1, -2));
        addView(panel);
        preview.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        preview.setElevation(dp(12));
        addView(preview);
        host.addView(this, new FrameLayout.LayoutParams(-1, -1));
        requestFocus();
    }

    void dismiss() {
        for (Background entry : background) {
            entry.view.setImportantForAccessibility(entry.accessibility);
            if (Build.VERSION.SDK_INT >= 31) entry.view.setRenderEffect(null);
        }
        background.clear();
        host.removeView(this);
        anchor.requestFocus();
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP) onDismiss.run();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int width = MeasureSpec.getSize(widthSpec);
        int height = MeasureSpec.getSize(heightSpec);
        setMeasuredDimension(width, height);
        getLocationOnScreen(origin);
        host.getWindowVisibleDisplayFrame(safe);
        safe.offset(-origin[0], -origin[1]);
        if (!safe.intersect(0, 0, width, height)) safe.set(0, 0, width, height);
        safe.inset(dp(12), dp(12));
        int iconSize = dp(56);
        preview.measure(MeasureSpec.makeMeasureSpec(iconSize, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(iconSize, MeasureSpec.EXACTLY));
        panel.measure(MeasureSpec.makeMeasureSpec(Math.min(dp(244), safe.width()), MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(Math.max(0, safe.height() - iconSize - dp(8)), MeasureSpec.AT_MOST));
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        anchor.getGlobalVisibleRect(anchorBounds);
        anchorBounds.offset(-origin[0], -origin[1]);
        int iconWidth = preview.getMeasuredWidth();
        int iconHeight = preview.getMeasuredHeight();
        int iconLeft = clamp(anchorBounds.centerX() - iconWidth / 2, safe.left, safe.right - iconWidth);
        int iconTop = clamp(anchorBounds.top + dp(8), safe.top, safe.bottom - iconHeight);
        int panelWidth = panel.getMeasuredWidth();
        int panelHeight = panel.getMeasuredHeight();
        // Align to the nearest outside edge, leaving the selected icon visibly separate.
        int panelLeft = anchorBounds.centerX() < getWidth() / 2
                ? iconLeft : iconLeft + iconWidth - panelWidth;
        panelLeft = clamp(panelLeft, safe.left, safe.right - panelWidth);
        int panelTop = iconTop + iconHeight + dp(8);
        if (panelTop + panelHeight > safe.bottom) {
            int above = iconTop - panelHeight - dp(8);
            if (above >= safe.top) panelTop = above;
            else {
                panelTop = safe.bottom - panelHeight;
                iconTop = panelTop - iconHeight - dp(8);
            }
        }
        panel.layout(panelLeft, panelTop, panelLeft + panelWidth, panelTop + panelHeight);
        preview.layout(iconLeft, iconTop, iconLeft + iconWidth, iconTop + iconHeight);
    }

    static Drawable ripple(int color) {
        return new RippleDrawable(ColorStateList.valueOf(color), null, surface(0xffffffff, 0));
    }

    private static GradientDrawable surface(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        return drawable;
    }

    enum Glyph {
        INFO("M12,3 A9,9 0,1 0,12 21 A9,9 0,1 0,12 3 M12,8 L12,8.1 M12,11 L12,16"),
        DELETE("M4,6 H20 M9,6 V3 H15 V6 M6,6 L7,21 H17 L18,6 M10,10 V17 M14,10 V17"),
        REMOVE("M12,3 A9,9 0,1 0,12 21 A9,9 0,1 0,12 3 M8,12 H16"),
        REPLACE("M4,12 H20 M14,6 L20,12 L14,18"),
        FOLDER("M3,6 Q3,4 5,4 H10 L12,7 H19 Q21,7 21,9 V19 Q21,20 19,20 H5 Q3,20 3,18 Z"),
        RENAME("M4,16 L15,5 L19,9 L8,20 H4 Z M13,7 L17,11"),
        ADD("M12,4 V20 M4,12 H20"),
        PIN("M9,3 H15 L14,9 L18,14 H6 L10,9 Z M12,14 V21"),
        CHEVRON("M9,6 L15,12 L9,18");

        final String path;
        Glyph(String path) { this.path = path; }
    }

    static Drawable icon(Glyph glyph, int color) {
        return new Drawable() {
            final Path path = PathParser.createPathFromPathData(glyph.path);
            final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            {
                paint.setColor(color);
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(1.7f);
                paint.setStrokeCap(Paint.Cap.ROUND);
                paint.setStrokeJoin(Paint.Join.ROUND);
            }
            @Override public void draw(Canvas canvas) {
                int save = canvas.save();
                canvas.translate(getBounds().left, getBounds().top);
                canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
                canvas.drawPath(path, paint);
                canvas.restoreToCount(save);
            }
            @Override public int getIntrinsicWidth() { return 24; }
            @Override public int getIntrinsicHeight() { return 24; }
            @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); invalidateSelf(); }
            @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); invalidateSelf(); }
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        };
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static int clamp(int value, int min, int max) { return Math.max(min, Math.min(max, value)); }
    private record Background(View view, int accessibility) { }
}
