package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.ColorUtils;
import androidx.core.view.WindowCompat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Independent app-cover switcher. Launch history is not a claim about running system tasks. */
public final class AppSwitcherActivity extends ComponentActivity {
    private final ExecutorService loader = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private AppSwitcherView page;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().setStatusBarContrastEnforced(false);
        getWindow().setNavigationBarContrastEnforced(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(false);
        if (new DesktopPreferences(this).wallpaper().equals("system")) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
            getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        }
        page = new AppSwitcherView(this, this::openApp, this::finish, this::home);
        setContentView(page);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { page.close(); }
        });
        String selected = state == null ? null : state.getString("selected_app");
        loader.execute(() -> {
            try {
                List<AppSwitcherView.App> apps = loadApps();
                main.post(() -> {
                    if (!isDestroyed() && !isFinishing()) page.showApps(apps, selected);
                });
            } catch (RuntimeException failure) {
                main.post(() -> {
                    if (!isDestroyed() && !isFinishing()) page.showError();
                });
            }
        });
    }

    private List<AppSwitcherView.App> loadApps() {
        List<AppSwitcherView.App> result = new ArrayList<>();
        DesktopIconPack icons = new DesktopIconPack(this);
        int size = Math.min(384, Math.round(96 * getResources().getDisplayMetrics().density));
        for (ResolveInfo info : AppLaunchHistory.recent(this)) {
            if (Thread.currentThread().isInterrupted()) break;
            ComponentName component = new ComponentName(info.activityInfo.packageName, info.activityInfo.name);
            Drawable drawable = icons.icon(component, info.loadIcon(getPackageManager()));
            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(new Canvas(bitmap));
            result.add(new AppSwitcherView.App(component, info.loadLabel(getPackageManager()).toString(),
                    bitmap, coverColor(bitmap)));
        }
        return result;
    }

    private static int coverColor(Bitmap icon) {
        long red = 0, green = 0, blue = 0, count = 0;
        for (int y = 0; y < icon.getHeight(); y += 8) {
            for (int x = 0; x < icon.getWidth(); x += 8) {
                int pixel = icon.getPixel(x, y);
                if (Color.alpha(pixel) < 128) continue;
                red += Color.red(pixel); green += Color.green(pixel); blue += Color.blue(pixel); count++;
            }
        }
        int tint = count == 0 ? 0xff70b5be : Color.rgb((int) (red / count), (int) (green / count), (int) (blue / count));
        return ColorUtils.blendARGB(0xfff5faf8, tint, .24f);
    }

    private void openApp(AppSwitcherView.App app) {
        try {
            DeviceActions.launch(this, app.component().getPackageName(), app.component().getClassName());
            finish();
            overridePendingTransition(0, 0);
        } catch (RuntimeException failure) {
            page.restoreAfterOpen();
            Toast.makeText(this, "暂时无法打开 " + app.label() + "，应用可能已停用或卸载", Toast.LENGTH_LONG).show();
        }
    }

    private void home() {
        startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                .setClass(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_NO_ANIMATION));
        finish();
        overridePendingTransition(0, 0);
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        // The opening finger still belongs to the edge overlay, never to an app card.
        return GestureService.isGestureHeld() || super.dispatchTouchEvent(event);
    }

    @Override public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("selected_app", page.selectedComponent());
    }

    @Override protected void onStop() {
        page.stopAnimations();
        super.onStop();
    }

    @Override protected void onDestroy() {
        loader.shutdownNow();
        main.removeCallbacksAndMessages(null);
        page.stopAnimations();
        super.onDestroy();
    }
}
