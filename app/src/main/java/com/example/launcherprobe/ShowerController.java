package com.example.launcherprobe;

import android.graphics.BitmapFactory;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.util.Base64;

import com.ai.assistance.shower.IShowerClient;
import com.ai.assistance.shower.IShowerGesture;
import com.ai.assistance.shower.IShowerService;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;

/** Owns the app's single Operit Shower virtual display. */
final class ShowerController {
    private static final int MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
    private final ShowerManager manager;
    private Integer displayId;
    private int width;
    private int height;
    private int dpi;
    private IBinder displayService;
    private IShowerClient clientToken;

    ShowerController(android.content.Context context) {
        manager = new ShowerManager(context);
    }

    synchronized JSONObject create(int requestedWidth, int requestedHeight, int requestedDpi,
            int bitrateKbps) throws Exception {
        int alignedWidth = align(requestedWidth);
        int alignedHeight = align(requestedHeight);
        validateDisplay(alignedWidth, alignedHeight, requestedDpi, bitrateKbps);
        IShowerService service = manager.ensureService();
        if (displayId != null && service.asBinder() == displayService && width == alignedWidth
                && height == alignedHeight && dpi == requestedDpi) {
            return state("create").put("reused", true);
        }
        if (displayId != null && service.asBinder() == displayService) {
            try {
                service.destroyDisplay(displayId);
            } finally {
                clearDisplay();
            }
        } else {
            clearDisplay();
        }
        int created = service.ensureDisplay(alignedWidth, alignedHeight, requestedDpi, bitrateKbps);
        if (created <= 0) throw new IllegalStateException("Operit Shower 未创建虚拟屏");
        if (Thread.currentThread().isInterrupted()) {
            try { service.destroyDisplay(created); }
            catch (Exception ignored) { }
            throw new InterruptedException("Operit Shower 创建已取消");
        }
        IShowerClient token = new IShowerClient.Stub() { };
        try {
            if (!service.attachClient(created, token)) {
                throw new IllegalStateException("Operit Shower 未绑定虚拟屏生命周期");
            }
        } catch (Exception exception) {
            try { service.destroyDisplay(created); }
            catch (Exception ignored) { }
            throw exception;
        }
        displayId = created;
        width = alignedWidth;
        height = alignedHeight;
        dpi = requestedDpi;
        displayService = service.asBinder();
        clientToken = token;
        return state("create").put("reused", false);
    }

    synchronized JSONObject launch(String packageName) throws Exception {
        if (packageName == null || !packageName.matches(
                "[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+")) {
            throw new IllegalArgumentException("packageName 格式无效");
        }
        IShowerService service = activeService();
        if (!service.launchApp(packageName, displayId)) {
            throw new IllegalStateException("应用不存在、不可启动或系统拒绝在虚拟屏启动");
        }
        return state("launch").put("packageName", packageName);
    }

    synchronized JSONObject screenshot(int maxWidth, int maxHeight) throws Exception {
        if (maxWidth < 160 || maxWidth > 1440 || maxHeight < 160 || maxHeight > 3200) {
            throw new IllegalArgumentException("截图尺寸范围为 160..1440 × 160..3200");
        }
        IShowerService service = activeService();
        byte[] png;
        try (ParcelFileDescriptor descriptor = service.requestScreenshot(displayId, maxWidth, maxHeight)) {
            if (descriptor == null) throw new IllegalStateException("Operit Shower 未返回截图");
            try (FileInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = input.read(buffer)) != -1; ) {
                    if (output.size() + count > MAX_SCREENSHOT_BYTES) {
                        throw new IllegalStateException("截图超过 12 MiB，请减小 maxWidth/maxHeight");
                    }
                    output.write(buffer, 0, count);
                }
                png = output.toByteArray();
            }
        }
        if (png.length < 24 || (png[0] & 0xff) != 0x89 || png[1] != 'P' || png[2] != 'N'
                || png[3] != 'G') throw new IllegalStateException("Operit Shower 截图不是有效 PNG");
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(png, 0, png.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IllegalStateException("无法读取截图尺寸");
        }
        return state("screenshot").put("imageWidth", bounds.outWidth)
                .put("imageHeight", bounds.outHeight).put("mimeType", "image/png")
                .put("data", Base64.encodeToString(png, Base64.NO_WRAP));
    }

    synchronized JSONObject tap(int x, int y) throws Exception {
        requireCoordinate(x, y);
        if (!activeService().tap(displayId, x, y)) {
            throw new IllegalStateException("虚拟屏点击注入失败");
        }
        return state("tap").put("x", x).put("y", y);
    }

    synchronized JSONObject swipe(int x1, int y1, int x2, int y2, long durationMs)
            throws Exception {
        requireCoordinate(x1, y1);
        requireCoordinate(x2, y2);
        if (durationMs < 1 || durationMs > 10_000) {
            throw new IllegalArgumentException("durationMs 范围为 1..10000");
        }
        Thread caller = Thread.currentThread();
        IShowerGesture gesture = new IShowerGesture.Stub() {
            @Override public boolean isCancelled() { return caller.isInterrupted(); }
        };
        if (!activeService().swipe(displayId, x1, y1, x2, y2, durationMs, gesture)) {
            if (caller.isInterrupted()) throw new InterruptedException("虚拟屏滑动已取消");
            throw new IllegalStateException("虚拟屏滑动注入失败");
        }
        return state("swipe").put("x1", x1).put("y1", y1).put("x2", x2)
                .put("y2", y2).put("durationMs", durationMs);
    }

    synchronized JSONObject key(int keyCode, int metaState, String keyName) throws Exception {
        if (!activeService().injectKeyWithMeta(displayId, keyCode, metaState)) {
            throw new IllegalStateException("虚拟屏按键注入失败");
        }
        return state("key").put("key", keyName).put("metaState", metaState);
    }

    synchronized JSONObject text(String text) throws Exception {
        if (text == null || text.isEmpty() || text.length() > 1000) {
            throw new IllegalArgumentException("text 长度范围为 1..1000");
        }
        if (!activeService().inputText(displayId, text)) {
            throw new IllegalArgumentException("当前 Android 虚拟键盘无法生成这些字符；请使用 key 或目标应用输入法");
        }
        return state("text").put("characters", text.length());
    }

    synchronized JSONObject release() throws Exception {
        boolean hadDisplay = displayId != null;
        boolean released = false;
        String destroyError = "";
        if (hadDisplay) {
            try {
                IShowerService service = manager.aliveService();
                released = service != null && service.asBinder() == displayService
                        && service.destroyDisplay(displayId);
            } catch (Exception exception) {
                destroyError = exception.getClass().getSimpleName() + ": " + exception.getMessage();
            } finally {
                clearDisplay();
            }
        }
        String stopError = hadDisplay ? manager.stopServer() : "";
        JSONObject result = new JSONObject().put("ok", destroyError.isEmpty() && stopError.isEmpty())
                .put("action", "release").put("released", released);
        if (!destroyError.isEmpty()) result.put("destroyWarning", destroyError);
        if (!stopError.isEmpty()) result.put("serverStopWarning", stopError);
        return result;
    }

    private IShowerService activeService() {
        IShowerService service = manager.aliveService();
        if (displayId == null || service == null || service.asBinder() != displayService) {
            clearDisplay();
            throw new IllegalStateException("虚拟屏尚未创建或 Shower 服务已断开；先调用 create");
        }
        return service;
    }

    private void requireCoordinate(int x, int y) {
        if (displayId == null) throw new IllegalStateException("虚拟屏尚未创建；先调用 create");
        if (x < 0 || y < 0 || x >= width || y >= height) {
            throw new IllegalArgumentException("坐标超出虚拟屏 " + width + "x" + height);
        }
    }

    private JSONObject state(String action) throws Exception {
        return new JSONObject().put("ok", true).put("action", action).put("displayId", displayId)
                .put("width", width).put("height", height).put("dpi", dpi);
    }

    private void clearDisplay() {
        displayId = null;
        width = 0;
        height = 0;
        dpi = 0;
        displayService = null;
        clientToken = null;
    }

    private static int align(int value) {
        return (value + 15) / 16 * 16;
    }

    private static void validateDisplay(int width, int height, int dpi, int bitrateKbps) {
        if (width < 320 || width > 1440 || height < 320 || height > 3200
                || (long) width * height > 4_000_000L) {
            throw new IllegalArgumentException("虚拟屏尺寸范围为 320..1440 × 320..3200，且不超过 400 万像素");
        }
        if (dpi < 120 || dpi > 640) throw new IllegalArgumentException("dpi 范围为 120..640");
        if (bitrateKbps < 128 || bitrateKbps > 12_000) {
            throw new IllegalArgumentException("bitrateKbps 范围为 128..12000");
        }
    }
}
