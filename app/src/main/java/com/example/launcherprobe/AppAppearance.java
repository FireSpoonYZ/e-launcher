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

    static AppAppearance read(Context context) {
        String value = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("theme", "system");
        boolean systemDark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        return new AppAppearance(value.equals("dark") || (value.equals("system") && systemDark));
    }

    void apply(Activity activity) {
        activity.setTheme(dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
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

    static String revision(Context context) {
        android.content.SharedPreferences preferences = context.getSharedPreferences("ui", Context.MODE_PRIVATE);
        return preferences.getString("theme", "system") + ":" + preferences.getString("background", "circles")
                + ":" + preferences.getLong("backgroundVersion", 0) + ":" + maskStrength(context) + ":" + preferences.getString("language", "system");
    }
}
