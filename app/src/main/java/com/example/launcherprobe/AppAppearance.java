package com.example.launcherprobe;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.view.View;

/** Android appearance preferences, separate from Pi's terminal theme. */
final class AppAppearance {
    final boolean dark;
    final int background, surface, ink, muted, accent, panel, border, error;

    private AppAppearance(boolean dark) {
        this.dark = dark;
        background = dark ? 0xff121614 : 0xfff6f5f0;
        surface = dark ? 0xff191e1b : 0xffffffff;
        ink = dark ? 0xffe5eee9 : 0xff202521;
        muted = dark ? 0xffa5b1aa : 0xff656d69;
        accent = dark ? 0xff75c3af : 0xff267a69;
        panel = dark ? 0xff242b27 : 0xfff1f1f2;
        border = dark ? 0xff39423c : 0xffe8e8ea;
        error = dark ? 0xffffb4ab : 0xffb3261e;
    }

    /** Neutral task surfaces follow the assistant's light/dark preference. */
    private AppAppearance(AppAppearance colors) {
        dark = colors.dark;
        background = dark ? 0xff142126 : 0xfff4f7f8;
        surface = dark ? 0xff1d2d33 : 0xffffffff;
        ink = dark ? 0xffe4eef1 : 0xff183039;
        muted = dark ? 0xffa1b4bb : 0xff657b84;
        accent = dark ? 0xff70d4df : 0xff087f8c;
        panel = dark ? 0xff273c44 : 0xffe8eff1;
        border = dark ? 0xff385059 : 0xffdce5e9;
        error = colors.error;
    }

    static AppAppearance readWorkbench(Context context) { return new AppAppearance(read(context)); }

    static AppAppearance read(Context context) {
        String value = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("theme", "system");
        boolean systemDark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        return new AppAppearance(value.equals("dark") || (value.equals("system") && systemDark));
    }

    void apply(Activity activity) {
        activity.setTheme(dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
    }

    void applySystemBars(Activity activity, int color) {
        activity.getWindow().setStatusBarColor(color);
        activity.getWindow().setNavigationBarColor(color);
        activity.getWindow().setStatusBarContrastEnforced(false);
        activity.getWindow().setNavigationBarContrastEnforced(false);
        activity.getWindow().getDecorView().setSystemUiVisibility(systemBarFlags());
    }

    int systemBarFlags() {
        return dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    }

    static int maskStrength(Context context) {
        return Math.max(20, Math.min(100, context.getSharedPreferences("ui", Context.MODE_PRIVATE).getInt("backgroundMask", 63)));
    }

    int maskColor(Context context) {
        return (Math.round(maskStrength(context) * 255f / 100) << 24) | (background & 0xffffff);
    }

    View wallpaper(Context context) {
        String mode = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("background", "circles");
        if (mode.equals("image")) {
            android.graphics.Bitmap bitmap = android.graphics.BitmapFactory.decodeFile(new java.io.File(context.getFilesDir(), "appearance/background.png").getPath());
            if (bitmap != null) {
                android.widget.ImageView image = new android.widget.ImageView(context);
                image.setImageBitmap(bitmap); image.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
                image.setColorFilter(maskColor(context), android.graphics.PorterDuff.Mode.SRC_ATOP);
                image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                return image;
            }
        }
        View view = new View(context) {
            private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
            @Override protected void onDraw(android.graphics.Canvas canvas) {
                canvas.drawColor(background);
                if (!mode.equals("circles")) return;
                paint.setColor(0x12267A69);
                canvas.drawCircle(getWidth() * .78f, getHeight() * .13f, getWidth() * .24f, paint);
                paint.setColor(0x0D92B7A2);
                canvas.drawCircle(getWidth() * .93f, getHeight() * .29f, getWidth() * .32f, paint);
            }
        };
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return view;
    }

    android.widget.FrameLayout glass(Context context, View wallpaper, int radiusDp) {
        float density = context.getResources().getDisplayMetrics().density;
        View backdrop = new View(context) {
            private final int[] source = new int[2], destination = new int[2];
            @Override protected void onDraw(android.graphics.Canvas canvas) {
                // Draw only the wallpaper into the blurred layer; controls stay sharp.
                wallpaper.getLocationInWindow(source);
                getLocationInWindow(destination);
                int saved = canvas.save();
                canvas.translate(source[0] - destination[0], source[1] - destination[1]);
                wallpaper.draw(canvas);
                canvas.restoreToCount(saved);
            }
        };
        backdrop.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            backdrop.setRenderEffect(android.graphics.RenderEffect.createBlurEffect(
                    18 * density, 18 * density, android.graphics.Shader.TileMode.CLAMP));
        }
        android.widget.FrameLayout frame = new android.widget.FrameLayout(context) {
            @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
                super.onLayout(changed, left, top, right, bottom);
                // Decorative layers follow content height without contributing to measurement.
                for (int i = 0; i < 2; i++) getChildAt(i).layout(0, 0, right - left, bottom - top);
                backdrop.invalidate();
            }
        };
        android.graphics.drawable.GradientDrawable outline = new android.graphics.drawable.GradientDrawable();
        outline.setColor(surface);
        outline.setCornerRadius(radiusDp * density);
        frame.setBackground(outline);
        frame.setClipToOutline(true);
        frame.setElevation(3 * density);
        frame.setOutlineAmbientShadowColor(dark ? 0xff000000 : 0xff365348);
        frame.setOutlineSpotShadowColor(dark ? 0xff000000 : 0xff365348);
        frame.addView(backdrop, new android.widget.FrameLayout.LayoutParams(-1, 0));
        View tint = new View(context);
        android.graphics.drawable.GradientDrawable finish = new android.graphics.drawable.GradientDrawable(
                android.graphics.drawable.GradientDrawable.Orientation.TL_BR,
                dark ? new int[]{0xc02a352e, 0xb01c2520, 0xc0242c26}
                        : new int[]{0xa6ffffff, 0x85e7efe6, 0xb8fcfcf7});
        finish.setDither(true);
        finish.setCornerRadius(radiusDp * density);
        finish.setStroke(Math.max(1, Math.round(density * .5f)), dark ? 0x405f8b9b : 0xb3ffffff);
        tint.setBackground(finish);
        tint.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        frame.addView(tint, new android.widget.FrameLayout.LayoutParams(-1, 0));
        return frame;
    }

    static String revision(Context context) {
        android.content.SharedPreferences preferences = context.getSharedPreferences("ui", Context.MODE_PRIVATE);
        return preferences.getString("theme", "system") + ":" + preferences.getString("background", "circles")
                + ":" + preferences.getLong("backgroundVersion", 0) + ":" + maskStrength(context) + ":" + preferences.getString("language", "system");
    }
}
