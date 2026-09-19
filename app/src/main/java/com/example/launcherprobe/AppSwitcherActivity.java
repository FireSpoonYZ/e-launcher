package com.example.launcherprobe;

import android.app.ActivityManager;
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
import android.util.LruCache;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.ColorUtils;
import androidx.core.view.WindowCompat;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.Consumer;

/** Independent app-cover switcher. Launch history is not a claim about running system tasks. */
public final class AppSwitcherActivity extends ComponentActivity implements AppSwitcherView.Host {
    private final ExecutorService loader = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    // Written and read only on the loader thread, so art tasks always see the catalogue they need.
    private final Map<String, ResolveInfo> catalog = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, Future<?>> pending = new HashMap<>();
    private LruCache<String, AppSwitcherView.Art> arts;
    private DesktopIconPack icons;
    private AppSwitcherView page;
    private int iconSize, coverWidth;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().setStatusBarContrastEnforced(false);
        getWindow().setNavigationBarContrastEnforced(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(false);
        boolean blur = frostWindow();
        if (!blur && new DesktopPreferences(this).wallpaper().equals("system")) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
            getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        }
        iconSize = Math.min(192, Math.round(48 * getResources().getDisplayMetrics().density));
        coverWidth = Math.round(getResources().getDisplayMetrics().widthPixels * .72f);
        // Bitmaps are held by byte count, the way Quickstep bounds its task thumbnail cache.
        int budget = (int) Math.min(24L << 20, Runtime.getRuntime().maxMemory() / 8);
        arts = new LruCache<>(budget) {
            @Override protected int sizeOf(String key, AppSwitcherView.Art art) {
                return art.icon().getByteCount()
                        + (art.snapshot() == null ? 0 : art.snapshot().getByteCount());
            }
        };
        page = new AppSwitcherView(this, this);
        page.glass(blur);
        setContentView(page);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { page.close(); }
        });
        String selected = state == null ? null : state.getString("selected_app");
        loader.execute(() -> {
            try {
                List<ResolveInfo> recent = AppLaunchHistory.recent(this);
                List<AppSwitcherView.App> apps = new ArrayList<>(recent.size());
                for (ResolveInfo info : recent) {
                    if (Thread.currentThread().isInterrupted()) return;
                    ComponentName component = new ComponentName(info.activityInfo.packageName, info.activityInfo.name);
                    catalog.put(component.flattenToString(), info);
                    apps.add(new AppSwitcherView.App(component, info.loadLabel(getPackageManager()).toString()));
                }
                main.post(() -> {
                    if (isDestroyed() || isFinishing()) return;
                    page.showApps(apps, selected);
                });
            } catch (RuntimeException failure) {
                main.post(() -> {
                    if (!isDestroyed() && !isFinishing()) page.showError();
                });
            }
        });
    }

    /** Real frosted glass needs the compositor; without cross-window blur we fall back to a wallpaper copy. */
    private boolean frostWindow() {
        if (android.os.Build.VERSION.SDK_INT < 31
                || !getSystemService(WindowManager.class).isCrossWindowBlurEnabled()) return false;
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND
                | WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        attributes.setBlurBehindRadius(Math.round(48 * getResources().getDisplayMetrics().density));
        attributes.dimAmount = .35f;
        getWindow().setAttributes(attributes);
        return true;
    }

    @Override public void load(AppSwitcherView.App app, Consumer<AppSwitcherView.Art> ready) {
        String key = app.component().flattenToString();
        AppSwitcherView.Art cached = arts.get(key);
        if (cached != null) { ready.accept(cached); return; }
        if (pending.containsKey(key)) return;
        pending.put(key, loader.submit(() -> {
            AppSwitcherView.Art art = buildArt(app);
            main.post(() -> {
                pending.remove(key);
                if (isDestroyed() || isFinishing()) return;
                if (art != null) arts.put(key, art);
                // A failed load still reports back, otherwise the card waits for art forever.
                ready.accept(art);
            });
        }));
    }

    @Override public void cancel(AppSwitcherView.App app) {
        Future<?> task = pending.remove(app.component().flattenToString());
        if (task != null) task.cancel(false);
    }

    private AppSwitcherView.Art buildArt(AppSwitcherView.App app) {
        ResolveInfo info = catalog.get(app.component().flattenToString());
        if (info == null) return null;
        try {
            if (icons == null) icons = new DesktopIconPack(this);
            Drawable drawable = icons.icon(app.component(), info.loadIcon(getPackageManager()));
            Bitmap bitmap = Bitmap.createBitmap(iconSize, iconSize, Bitmap.Config.ARGB_8888);
            drawable.setBounds(0, 0, iconSize, iconSize);
            drawable.draw(new Canvas(bitmap));
            return new AppSwitcherView.Art(bitmap, coverColor(bitmap),
                    AppSnapshots.load(this, app.component().getPackageName(), coverWidth));
        } catch (RuntimeException failure) {
            android.util.Log.w("AppSwitcher", "Art unavailable for " + app.component(), failure);
            return null;
        }
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

    @Override public void open(AppSwitcherView.App app) {
        try {
            DeviceActions.launch(this, app.component().getPackageName(), app.component().getClassName());
            finish();
            overridePendingTransition(0, 0);
        } catch (RuntimeException failure) {
            page.restoreAfterOpen();
            Toast.makeText(this, "暂时无法打开 " + app.label() + "，应用可能已停用或卸载", Toast.LENGTH_LONG).show();
        }
    }

    /** Forgetting a card drops this launcher's record and asks the system to drop idle processes. */
    @Override public void forget(AppSwitcherView.App app) {
        String packageName = app.component().getPackageName();
        AppLaunchHistory.forget(this, app.component());
        arts.remove(app.component().flattenToString());
        loader.execute(() -> {
            AppSnapshots.forget(this, packageName);
            try {
                getSystemService(ActivityManager.class).killBackgroundProcesses(packageName);
            } catch (RuntimeException ignored) {
                // Only the system can end a foreground task; the card is removed either way.
            }
        });
    }

    @Override public void close() { finish(); }

    @Override public void home() {
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
        pending.clear();
        arts.evictAll();
        main.removeCallbacksAndMessages(null);
        page.stopAnimations();
        super.onDestroy();
    }
}
