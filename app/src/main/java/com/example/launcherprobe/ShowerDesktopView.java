package com.example.launcherprobe;

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/** Compositor-backed, display-scoped viewport. Binder work never runs on the main thread. */
final class ShowerDesktopView extends FrameLayout implements TextureView.SurfaceTextureListener {
    interface Listener { void changed(boolean available, boolean live, boolean manual, String status); }
    private final Supplier<ShowerController> source;
    private final Listener listener;
    private final TextureView texture;
    private final TextView message;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> polling;
    private volatile boolean started;
    private boolean disposed;
    private ShowerController.Preview uiPreview;
    private volatile int generation;
    // Worker-thread-owned resources.
    private SurfaceTexture output;
    private Surface surface;
    private ShowerController controller;
    private ShowerController.Preview preview;
    // UI-thread state.
    private boolean available, attached, live, manual, changingControl, seenDisplay;
    private int displayWidth = 1, displayHeight = 1;
    private MotionEvent lastTouch;
    private String status = "正在连接虚拟桌面…";

    ShowerDesktopView(Context context, AppAppearance colors, Supplier<ShowerController> source, Listener listener) {
        super(context);
        this.source = source;
        this.listener = listener;
        setBackgroundColor(colors.surface);
        texture = new TextureView(context);
        texture.setSurfaceTextureListener(this);
        texture.setContentDescription("虚拟桌面画面，接管后可触摸操作");
        texture.setOnTouchListener((view, event) -> handleTouch(event));
        addView(texture, new LayoutParams(-1, -1, Gravity.CENTER));
        message = new TextView(context);
        message.setGravity(Gravity.CENTER);
        message.setTextColor(colors.muted);
        message.setTextSize(15);
        message.setPadding(24, 24, 24, 24);
        message.setText(status);
        message.setBackgroundColor(colors.surface);
        addView(message, new LayoutParams(-1, -1));
    }

    void start() {
        if (started) return;
        started = true;
        generation++;
        polling = worker.scheduleWithFixedDelay(this::poll, 0, 1, TimeUnit.SECONDS);
    }

    void stop() {
        if (!started) return;
        cancelGesture();
        started = false;
        generation++;
        if (polling != null) polling.cancel(false);
        attached = live = manual = changingControl = false;
        texture.setAlpha(0f);
        message.setVisibility(VISIBLE);
        worker.execute(this::detach);
    }

    void dispose() {
        stop();
        disposed = true;
        if (!texture.isAvailable()) worker.shutdown();
    }

    private void poll() {
        if (!started) return;
        int run = generation;
        try {
            ShowerController next = source.get();
            if (preview != null && (controller != next || !controller.keepPreviewAlive(preview))) detach();
            boolean exists = next != null && next.hasDisplay();
            if (!exists) {
                detach();
                publish(run, () -> {
                    available = seenDisplay;
                    attached = live = manual = false;
                    setStatus(seenDisplay ? "虚拟桌面已结束" : "");
                });
                return;
            }
            publish(run, () -> {
                available = seenDisplay = true;
                if (!attached) setStatus("正在连接虚拟桌面…");
            });
            if (output == null || preview != null) return;
            controller = next;
            surface = new Surface(output);
            preview = controller.openPreview(surface);
            output.setDefaultBufferSize(preview.width, preview.height);
            int width = preview.width, height = preview.height;
            ShowerController.Preview previewForUi = preview;
            publish(run, () -> {
                displayWidth = width; displayHeight = height;
                uiPreview = previewForUi;
                attached = true; live = false; manual = false;
                requestLayout();
                setStatus("正在等待实时画面…");
            });
        } catch (Exception exception) {
            detach();
            publish(run, () -> {
                attached = live = manual = false;
                available = seenDisplay;
                setStatus("画面连接失败，正在重试\n" + error(exception));
            });
        }
    }

    private void detach() {
        if (preview != null) {
            try { controller.closePreview(preview); }
            catch (Exception ignored) { /* A dead/released display needs no further detachment. */ }
        }
        preview = null;
        controller = null;
        if (surface != null) { surface.release(); surface = null; }
    }

    void toggleControl() {
        if (!attached || !live || changingControl) return;
        boolean enable = !manual;
        cancelGesture();
        changingControl = true;
        int run = generation;
        ShowerController.Preview expected = uiPreview;
        worker.execute(() -> {
            try {
                if (preview == null || preview != expected) throw new IllegalStateException("虚拟桌面已断开");
                controller.setManualControl(preview, enable);
                publish(run, () -> { manual = enable; changingControl = false; setStatus(enable ? "手动操作 · AI 桌面操作等待中" : "虚拟桌面 · 实时"); });
            } catch (Exception exception) {
                publish(run, () -> { changingControl = false; showError(exception); });
            }
        });
    }

    boolean isManual() { return manual && attached && !changingControl; }

    void key(int code) { input(() -> controller.previewKey(preview, code)); }
    void text(String value) { input(() -> controller.previewText(preview, value)); }
    void launch(String packageName) { input(() -> controller.previewLaunch(preview, packageName)); }

    void applications(boolean recent, java.util.function.Consumer<java.util.Map<String, String>> result) {
        int run = generation;
        input(() -> {
            android.content.pm.PackageManager pm = getContext().getPackageManager();
            java.util.Map<String, String> apps = new java.util.LinkedHashMap<>();
            if (recent) {
                for (String name : controller.recentPackages(preview)) {
                    try { apps.put(name, pm.getApplicationLabel(pm.getApplicationInfo(name, 0)).toString()); }
                    catch (android.content.pm.PackageManager.NameNotFoundException ignored) { }
                }
            } else {
                android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_MAIN)
                        .addCategory(android.content.Intent.CATEGORY_LAUNCHER);
                java.util.List<android.content.pm.ResolveInfo> resolved = pm.queryIntentActivities(intent, 0);
                resolved.sort(new android.content.pm.ResolveInfo.DisplayNameComparator(pm));
                for (android.content.pm.ResolveInfo app : resolved) {
                    String name = app.activityInfo.packageName;
                    if (!name.equals(getContext().getPackageName())) apps.put(name, app.loadLabel(pm).toString());
                }
            }
            publish(run, () -> result.accept(apps));
        });
    }

    private interface Input { void run() throws Exception; }
    private void input(Input action) {
        if (!isManual()) return;
        int run = generation;
        ShowerController.Preview expected = uiPreview;
        worker.execute(() -> {
            if (!started || run != generation || preview == null || preview != expected) return;
            try { action.run(); }
            catch (Exception exception) { publish(run, () -> showError(exception)); }
        });
    }

    private boolean handleTouch(MotionEvent event) {
        if (!isManual()) return true;
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) getParent().requestDisallowInterceptTouchEvent(true);
        MotionEvent mapped = mapTouch(event, texture.getWidth(), texture.getHeight(), displayWidth, displayHeight);
        if (lastTouch != null) lastTouch.recycle();
        lastTouch = MotionEvent.obtain(mapped);
        sendTouch(mapped);
        if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            lastTouch.recycle(); lastTouch = null;
            getParent().requestDisallowInterceptTouchEvent(false);
            if (event.getActionMasked() == MotionEvent.ACTION_UP) texture.performClick();
        }
        return true;
    }

    private void sendTouch(MotionEvent event) {
        int run = generation;
        ShowerController.Preview expected = uiPreview;
        worker.execute(() -> {
            try {
                if (preview != null && preview == expected) controller.touch(preview, event);
            } catch (Exception exception) { publish(run, () -> showError(exception)); }
            finally { event.recycle(); }
        });
    }

    private void cancelGesture() {
        if (lastTouch == null) return;
        lastTouch.setAction(MotionEvent.ACTION_CANCEL);
        sendTouch(lastTouch);
        lastTouch = null;
    }

    static MotionEvent mapTouch(MotionEvent event, int viewWidth, int viewHeight, int width, int height) {
        int count = event.getPointerCount();
        MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[count];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
        for (int i = 0; i < count; i++) {
            properties[i] = new MotionEvent.PointerProperties(); event.getPointerProperties(i, properties[i]);
            coords[i] = new MotionEvent.PointerCoords(); event.getPointerCoords(i, coords[i]);
            coords[i].x = Math.max(0, Math.min(width - 1, coords[i].x * width / Math.max(1, viewWidth)));
            coords[i].y = Math.max(0, Math.min(height - 1, coords[i].y * height / Math.max(1, viewHeight)));
        }
        return MotionEvent.obtain(event.getDownTime(), event.getEventTime(), event.getAction(), count,
                properties, coords, event.getMetaState(), event.getButtonState(), 1, 1, 0,
                event.getEdgeFlags(), InputDevice.SOURCE_TOUCHSCREEN, event.getFlags());
    }

    @Override protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
        // Fit before layout; changing LayoutParams in onSizeChanged lags one resize behind.
        float scale = Math.min((float) getMeasuredWidth() / displayWidth,
                (float) getMeasuredHeight() / displayHeight);
        texture.measure(MeasureSpec.makeMeasureSpec(Math.max(1, Math.round(displayWidth * scale)), MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(Math.max(1, Math.round(displayHeight * scale)), MeasureSpec.EXACTLY));
    }

    private void setStatus(String value) {
        status = value;
        texture.setAlpha(live ? 1f : 0f);
        message.setText(value);
        message.setVisibility(live ? GONE : VISIBLE);
        listener.changed(available, live, manual, status);
    }

    private void showError(Exception exception) {
        android.widget.Toast.makeText(getContext(), error(exception), android.widget.Toast.LENGTH_SHORT).show();
    }
    private static String error(Exception exception) { return exception.getMessage() == null ? exception.getClass().getSimpleName() : exception.getMessage(); }
    private void publish(int run, Runnable action) { main.post(() -> { if (started && generation == run) action.run(); }); }

    @Override public void onSurfaceTextureAvailable(SurfaceTexture surfaceTexture, int width, int height) {
        worker.execute(() -> { output = surfaceTexture; poll(); });
    }
    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture surfaceTexture, int width, int height) {
        if (attached) surfaceTexture.setDefaultBufferSize(displayWidth, displayHeight);
    }
    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture surfaceTexture) {
        if (worker.isShutdown()) { surfaceTexture.release(); return false; }
        worker.execute(() -> {
            if (output == surfaceTexture) { detach(); output = null; }
            surfaceTexture.release();
        });
        if (disposed) worker.shutdown();
        return false;
    }
    @Override public void onSurfaceTextureUpdated(SurfaceTexture surfaceTexture) {
        if (!started || !attached || live) return;
        live = true;
        setStatus(manual ? "手动操作 · AI 桌面操作等待中" : "虚拟桌面 · 实时");
    }
}
