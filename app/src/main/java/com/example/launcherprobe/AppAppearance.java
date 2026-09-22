package com.example.launcherprobe;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.view.View;

/** Android appearance preferences, separate from Pi's terminal theme. */
final class AppAppearance {
    final boolean dark;
    private final boolean desktop;
    final int background, surface, ink, muted, accent, panel, border, error;

    private AppAppearance(boolean dark, boolean desktop) {
        this.dark = dark;
        this.desktop = desktop;
        background = desktop ? (dark ? 0xff10272f : 0xffeffbfc) : (dark ? 0xff121614 : 0xfff6f5f0);
        surface = desktop ? (dark ? 0xff193640 : 0xfff8fdff) : (dark ? 0xff191e1b : 0xffffffff);
        ink = desktop ? (dark ? 0xffe5f5f8 : 0xff092e40) : (dark ? 0xffe5eee9 : 0xff202521);
        muted = desktop ? (dark ? 0xff9dbac5 : 0xff547589) : (dark ? 0xffa5b1aa : 0xff656d69);
        accent = desktop ? (dark ? 0xff70d4df : 0xff0098ad) : (dark ? 0xff75c3af : 0xff267a69);
        panel = desktop ? (dark ? 0xff254651 : 0xffdef3f6) : (dark ? 0xff242b27 : 0xfff1f1f2);
        border = desktop ? (dark ? 0xff365763 : 0xffdceef2) : (dark ? 0xff39423c : 0xffe8e8ea);
        error = dark ? 0xffffb4ab : desktop ? 0xffec4350 : 0xffb3261e;
    }

    /** Neutral surfaces for the task workbench; follows the desktop's light/dark preference. */
    private AppAppearance(AppAppearance desktopColors) {
        dark = desktopColors.dark; desktop = false;
        background = dark ? 0xff142126 : 0xfff4f7f8;
        surface = dark ? 0xff1d2d33 : 0xffffffff;
        ink = dark ? 0xffe4eef1 : 0xff183039;
        muted = dark ? 0xffa1b4bb : 0xff657b84;
        accent = dark ? 0xff70d4df : 0xff087f8c;
        panel = dark ? 0xff273c44 : 0xffe8eff1;
        border = dark ? 0xff385059 : 0xffdce5e9;
        error = desktopColors.error;
    }

    static AppAppearance readWorkbench(Context context) { return new AppAppearance(readDesktop(context)); }

    static AppAppearance read(Context context) {
        String value = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("theme", "system");
        boolean systemDark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        return new AppAppearance(value.equals("dark") || (value.equals("system") && systemDark), false);
    }

    static AppAppearance readDesktop(Context context) {
        String theme = new DesktopPreferences(context).theme();
        boolean systemDark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        return new AppAppearance(theme.equals("dark") || (theme.equals("system") && systemDark), true);
    }

    View desktopWallpaper(Context context) {
        boolean system = new DesktopPreferences(context).wallpaper().equals("system");
        View view = new View(context) {
            private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
            private final android.graphics.Path fold = new android.graphics.Path();
            private final android.graphics.Path light = new android.graphics.Path();
            private final android.graphics.Shader base = new android.graphics.LinearGradient(0, 0, 800, 2000,
                    dark ? new int[]{0xff183e4e, 0xff164a55, 0xff102c39}
                            : new int[]{0xffdef6fa, 0xff9cdae2, 0xff65becb}, null, android.graphics.Shader.TileMode.CLAMP);
            private final android.graphics.Shader glow = new android.graphics.RadialGradient(780, 290, 1050,
                    dark ? 0x303f9eae : 0xaaffffff, 0x00ffffff, android.graphics.Shader.TileMode.CLAMP);
            private final android.graphics.Shader foldLight = new android.graphics.LinearGradient(100, 0, 1100, 1400,
                    new int[]{0x00ffffff, dark ? 0x104bb5c4 : 0x26ffffff, 0x00ffffff}, null, android.graphics.Shader.TileMode.CLAMP);
            {
                fold.moveTo(1070, -100); fold.cubicTo(620, 400, 1020, 650, 380, 1100);
                fold.cubicTo(-170, 1480, 660, 1540, 1120, 2100); fold.lineTo(800, 2100);
                fold.cubicTo(350, 1640, -350, 1460, 190, 1020); fold.cubicTo(740, 590, 520, 320, 840, -100); fold.close();
                light.moveTo(-120, 500); light.cubicTo(480, 640, 190, 1010, 800, 1280);
                light.cubicTo(1300, 1500, 630, 1650, 270, 2100); light.lineTo(170, 2100);
                light.cubicTo(500, 1600, 1050, 1460, 710, 1320); light.cubicTo(90, 1060, 360, 790, -120, 680); light.close();
            }
            @Override protected void onDraw(android.graphics.Canvas canvas) {
                if (system) return;
                int save = canvas.save(); canvas.scale(getWidth() / 1000f, getHeight() / 2000f);
                paint.setShader(base); canvas.drawRect(0, 0, 1000, 2000, paint);
                paint.setShader(glow); canvas.drawRect(0, 0, 1000, 2000, paint);
                paint.setShader(foldLight); canvas.drawPath(fold, paint); canvas.drawPath(light, paint);
                paint.setShader(null); canvas.restoreToCount(save);
            }
        };
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return view;
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
        outline.setColor(desktop ? android.graphics.Color.TRANSPARENT : surface);
        outline.setCornerRadius(radiusDp * density);
        frame.setBackground(outline);
        frame.setClipToOutline(true);
        frame.setElevation((desktop ? 1 : 3) * density);
        frame.setOutlineAmbientShadowColor(dark ? 0xff000000 : 0xff365348);
        frame.setOutlineSpotShadowColor(dark ? 0xff000000 : 0xff365348);
        frame.addView(backdrop, new android.widget.FrameLayout.LayoutParams(-1, 0));
        View tint = new View(context);
        android.graphics.drawable.GradientDrawable finish = new android.graphics.drawable.GradientDrawable(
                android.graphics.drawable.GradientDrawable.Orientation.TL_BR,
                desktop ? (dark ? new int[]{0xeb1b3b47, 0xe6264652} : new int[]{0xf5fbfeff, 0xe3f2fcff})
                        : (dark ? new int[]{0xc02a352e, 0xb01c2520, 0xc0242c26}
                        : new int[]{0xa6ffffff, 0x85e7efe6, 0xb8fcfcf7}));
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
