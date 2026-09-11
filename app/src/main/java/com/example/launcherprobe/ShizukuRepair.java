package com.example.launcherprobe;

import android.app.role.RoleManager;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.accessibility.AccessibilityManager;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import rikka.shizuku.Shizuku;

/** Event-driven Shizuku authorization and one-shot repair of this app's accessibility service. */
final class ShizukuRepair {
    private static final int REQUEST_CODE = 7319;
    private static final String PREFS = "shizuku_repair";
    private static final String REQUESTED = "permission_requested";
    private static volatile String status = "Shizuku：尚未检查";

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Runnable changed;
    private final Shizuku.UserServiceArgs serviceArgs;
    private boolean foreground;
    private boolean destroyed;
    private boolean homeRequested;
    private final Runnable grantTimeout = () -> {
        homeRequested = false;
        unbind();
        setStatus("Shizuku 授权服务超时；点击修复授权重试");
    };
    private boolean bound;
    private boolean binding;
    private int repairGeneration;

    private final Shizuku.OnBinderReceivedListener binderReceived = () -> main.post(() -> {
        if (foreground) start(false);
    });
    private final Shizuku.OnBinderDeadListener binderDead = () -> main.post(() -> {
        bound = false;
        binding = false;
        cancelRepair();
        homeRequested = false;
        setStatus("Shizuku：未运行或连接已断开");
    });
    private final Shizuku.OnRequestPermissionResultListener permissionResult = (code, result) -> {
        if (code != REQUEST_CODE) return;
        main.post(() -> {
            if (destroyed) return;
            if (result == PackageManager.PERMISSION_GRANTED) {
                if (foreground) start(false);
            }
            else {
                homeRequested = false;
                setStatus("Shizuku：授权被拒绝；请在 Shizuku 管理器中允许后重试");
            }
        });
    };
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            if (destroyed || !foreground || !binding) return;
            int generation = repairGeneration;
            binding = false;
            bound = true;
            IOwnPermissionService remote = IOwnPermissionService.Stub.asInterface(binder);
            boolean setHome = homeRequested;
            homeRequested = false;
            setStatus(setHome ? "Shizuku：正在设置默认桌面…" : "Shizuku：正在授予写设置权限…");
            worker.execute(() -> {
                String error;
                try { error = setHome ? remote.setOwnDefaultHome() : remote.grantOwnWriteSecureSettings(); }
                catch (Exception exception) {
                    error = exception.getClass().getSimpleName() + ": " + exception.getMessage();
                }
                String result = error;
                main.post(() -> {
                    if (!destroyed && generation == repairGeneration) finishCommand(result, setHome);
                });
            });
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            if (!binding && !bound) return;
            bound = false;
            binding = false;
            main.removeCallbacks(grantTimeout);
            if (foreground && !destroyed) setStatus("Shizuku 授权服务已断开；点击修复授权重试");
        }
    };

    ShizukuRepair(Context context, Runnable changed) {
        this.context = context.getApplicationContext();
        this.changed = changed;
        // Android assigns application UIDs in per-user ranges of 100000.
        int userId = context.getApplicationInfo().uid / 100000;
        serviceArgs = new Shizuku.UserServiceArgs(
                new ComponentName(context, OwnPermissionService.class))
                .tag("own-permission-u" + userId)
                .processNameSuffix("shizuku_permission")
                .daemon(false)
                .debuggable((context.getApplicationInfo().flags
                        & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
                .version(2);
    }

    void register() {
        Shizuku.addRequestPermissionResultListener(permissionResult);
        Shizuku.addBinderDeadListener(binderDead);
        Shizuku.addBinderReceivedListenerSticky(binderReceived);
    }

    void resume() {
        foreground = true;
        start(false);
    }

    void pause() {
        foreground = false;
        cancelRepair();
        unbind();
    }

    void repairFromButton() {
        if (binding || bound) return;
        homeRequested = false;
        foreground = true;
        start(true);
    }

    void requestHomeFromButton() {
        if (binding || bound) {
            setStatus("Shizuku：正在执行操作，请完成后再设置默认桌面");
            return;
        }
        homeRequested = true;
        foreground = true;
        start(true);
    }

    void destroy() {
        destroyed = true;
        foreground = false;
        cancelRepair();
        Shizuku.removeBinderReceivedListener(binderReceived);
        Shizuku.removeBinderDeadListener(binderDead);
        Shizuku.removeRequestPermissionResultListener(permissionResult);
        unbind();
        worker.shutdownNow();
    }

    static String statusText() { return status; }

    private void start(boolean explicit) {
        if (destroyed || !foreground || binding || bound) return;
        cancelRepair();
        try {
            if (!Shizuku.pingBinder()) {
                homeRequested = false;
                setStatus("Shizuku：未运行；请先启动官方 Shizuku");
                return;
            }
            if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) {
                boolean requested = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getBoolean(REQUESTED, false);
                if (Shizuku.shouldShowRequestPermissionRationale()) {
                    homeRequested = false;
                    setStatus("Shizuku：授权被拒绝；请在 Shizuku 管理器中允许后重试");
                } else if (explicit || !requested) {
                    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                            .putBoolean(REQUESTED, true).apply();
                    setStatus("Shizuku：等待授权…");
                    Shizuku.requestPermission(REQUEST_CODE);
                } else {
                    setStatus("Shizuku：尚未授权；点击“修复授权”重试");
                }
                return;
            }
            if (homeRequested) {
                bindGrantService();
            } else if (GestureService.canWrite(context)) {
                repairAccessibility();
            } else {
                bindGrantService();
            }
        } catch (RuntimeException exception) {
            homeRequested = false;
            setStatus("Shizuku API 失败：" + detail(exception));
        }
    }

    private void bindGrantService() {
        if (binding || bound) return;
        binding = true;
        setStatus("Shizuku：正在连接授权服务…");
        try {
            Shizuku.bindUserService(serviceArgs, connection);
            main.postDelayed(grantTimeout, 15000);
        } catch (RuntimeException exception) {
            binding = false;
            homeRequested = false;
            setStatus("Shizuku 授权服务失败：" + detail(exception));
        }
    }

    private void finishCommand(String error, boolean setHome) {
        unbind();
        if (!foreground) return;
        if (!error.isEmpty()) {
            setStatus("Shizuku 命令失败：" + error);
        } else if (setHome) {
            RoleManager roles = context.getSystemService(RoleManager.class);
            setStatus(roles != null && roles.isRoleHeld(RoleManager.ROLE_HOME)
                    ? "Shizuku：已确认本应用是默认桌面"
                    : "Shizuku 命令已完成，但默认桌面未生效；请重试或打开默认桌面设置");
        } else if (!GestureService.canWrite(context)) {
            setStatus("Shizuku 命令已完成，但写设置权限未生效");
        } else {
            repairAccessibility();
        }
    }

    private void repairAccessibility() {
        int generation = ++repairGeneration;
        if (GestureService.isConnected()) {
            setStatus("Shizuku 修复成功；无障碍服务已真实连接");
            return;
        }
        String own = new ComponentName(context, GestureService.class).flattenToString();
        try {
            String before = Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            String next = AccessibilityServices.add(before, own);
            if (!Settings.Secure.putString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, next)
                    || !Settings.Secure.putInt(context.getContentResolver(),
                    Settings.Secure.ACCESSIBILITY_ENABLED, 1)) {
                throw new IllegalStateException("系统拒绝写入无障碍设置");
            }
            String after = Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (!AccessibilityServices.contains(after, own)
                    || !AccessibilityServices.preservesOthers(before, after, own)
                    || Settings.Secure.getInt(context.getContentResolver(),
                    Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) {
                throw new IllegalStateException("无障碍设置读回校验失败");
            }
            setStatus("无障碍服务设置已启用，等待真实连接…");
            main.postDelayed(() -> checkConnection(generation, own, false), 1000);
        } catch (RuntimeException exception) {
            setStatus("无障碍修复失败：" + detail(exception));
        }
    }

    private void checkConnection(int generation, String own, boolean rebound) {
        if (!foreground || generation != repairGeneration) return;
        if (GestureService.isConnected()) {
            setStatus("Shizuku 修复成功；无障碍服务已真实连接");
            return;
        }
        if (!managerReportsEnabled()) {
            setStatus("自身服务设置已写入，但系统尚未报告启用；请打开无障碍设置检查");
            return;
        }
        if (rebound || !GestureService.safeToRebind(context)) {
            setStatus("自身服务设置已启用，但尚未真实连接；请打开无障碍设置检查");
            return;
        }
        try {
            String before = Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            String removed = AccessibilityServices.remove(before, own);
            if (!Settings.Secure.putString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, removed)) {
                throw new IllegalStateException("移除自身服务失败");
            }
            String removalReadback = Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (AccessibilityServices.contains(removalReadback, own)
                    || !AccessibilityServices.preservesOthers(before, removalReadback, own)) {
                throw new IllegalStateException("移除自身服务读回校验失败");
            }
            String restored = AccessibilityServices.add(removalReadback, own);
            if (!Settings.Secure.putString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, restored)) {
                throw new IllegalStateException("重新启用自身服务失败");
            }
            String restoredReadback = Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (!AccessibilityServices.contains(restoredReadback, own)
                    || !AccessibilityServices.preservesOthers(removalReadback, restoredReadback, own)) {
                throw new IllegalStateException("重新启用自身服务读回校验失败");
            }
            setStatus("已有限重绑自身服务，等待真实连接…");
            main.postDelayed(() -> checkConnection(generation, own, true), 1500);
        } catch (RuntimeException exception) {
            setStatus("无障碍重绑失败：" + detail(exception));
        }
    }

    private boolean managerReportsEnabled() {
        AccessibilityManager manager = context.getSystemService(AccessibilityManager.class);
        if (manager == null) return false;
        List<AccessibilityServiceInfo> enabled = manager.getEnabledAccessibilityServiceList(
                AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
        for (AccessibilityServiceInfo info : enabled) {
            if (info.getResolveInfo() != null && info.getResolveInfo().serviceInfo != null
                    && context.getPackageName().equals(info.getResolveInfo().serviceInfo.packageName)
                    && GestureService.class.getName().equals(info.getResolveInfo().serviceInfo.name)) {
                return true;
            }
        }
        return false;
    }

    private void cancelRepair() {
        repairGeneration++;
        main.removeCallbacksAndMessages(null);
    }

    private void unbind() {
        main.removeCallbacks(grantTimeout);
        if (!binding && !bound) return;
        binding = false;
        bound = false;
        try { Shizuku.unbindUserService(serviceArgs, connection, true); }
        catch (RuntimeException ignored) { }
    }

    private void setStatus(String value) {
        if (destroyed) return;
        status = value;
        changed.run();
    }

    private static String detail(Throwable throwable) {
        String message = throwable.getMessage();
        return throwable.getClass().getSimpleName() + (message == null ? "" : "：" + message);
    }
}
