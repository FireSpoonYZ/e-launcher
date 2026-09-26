package com.example.launcherprobe;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import rikka.shizuku.Shizuku;

/** Checks Shizuku passively; permission grants and assistant-role changes require an explicit button. */
final class ShizukuRepair {
    private static final int REQUEST_CODE = 7319;
    private static volatile String status = "Shizuku：尚未检查";
    private enum Operation { NAVIGATION, ASSISTANT }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Runnable changed;
    private final Shizuku.UserServiceArgs serviceArgs;
    private boolean foreground;
    private boolean destroyed;
    private Operation requested;
    private boolean bound;
    private boolean binding;
    private int commandGeneration;
    private final Runnable grantTimeout = () -> {
        requested = null;
        commandGeneration++;
        unbind();
        setStatus("Shizuku 授权服务超时；点击修复授权重试");
    };

    private final Shizuku.OnBinderReceivedListener binderReceived = () -> main.post(() -> {
        if (foreground) start(false);
    });
    private final Shizuku.OnBinderDeadListener binderDead = () -> main.post(() -> {
        bound = false;
        binding = false;
        cancelCommand();
        requested = null;
        setStatus("Shizuku：未运行或连接已断开");
    });
    private final Shizuku.OnRequestPermissionResultListener permissionResult = (code, result) -> {
        if (code != REQUEST_CODE) return;
        main.post(() -> {
            if (destroyed) return;
            if (result == PackageManager.PERMISSION_GRANTED) {
                if (foreground) start(false);
            } else {
                requested = null;
                setStatus("Shizuku：授权被拒绝；请在 Shizuku 管理器中允许后重试");
            }
        });
    };
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            if (destroyed || !foreground || !binding) return;
            int generation = commandGeneration;
            binding = false;
            bound = true;
            IOwnPermissionService remote = IOwnPermissionService.Stub.asInterface(binder);
            Operation operation = requested;
            requested = null;
            if (operation == null || (operation == Operation.NAVIGATION
                    && !LegacyNavigationRecovery.pending(context))) {
                unbind();
                setStatus("Shizuku：已授权，可用于 Shower");
                return;
            }
            setStatus(operation == Operation.ASSISTANT
                    ? "Shizuku：正在设置默认助手…" : "Shizuku：正在授予旧导航恢复权限…");
            worker.execute(() -> {
                String error;
                try {
                    error = operation == Operation.ASSISTANT
                            ? remote.setOwnDefaultAssistant() : remote.grantOwnWriteSecureSettings();
                } catch (Exception exception) {
                    error = exception.getClass().getSimpleName() + ": " + exception.getMessage();
                }
                String result = error;
                main.post(() -> {
                    if (!destroyed && generation == commandGeneration) finishCommand(result, operation);
                });
            });
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            if (!binding && !bound) return;
            bound = false;
            binding = false;
            requested = null;
            cancelCommand();
            if (foreground && !destroyed) setStatus("Shizuku 授权服务已断开；点击修复授权重试");
        }
    };

    ShizukuRepair(Context context, Runnable changed) {
        this.context = context.getApplicationContext();
        this.changed = changed;
        // Android assigns application UIDs in per-user ranges of 100000.
        int userId = context.getApplicationInfo().uid / 100000;
        serviceArgs = new Shizuku.UserServiceArgs(new ComponentName(context, OwnPermissionService.class))
                .tag("own-permission-u" + userId)
                .processNameSuffix("shizuku_permission")
                .daemon(false)
                .debuggable((context.getApplicationInfo().flags
                        & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
                .version(4);
    }

    void register() {
        Shizuku.addRequestPermissionResultListener(permissionResult);
        Shizuku.addBinderDeadListener(binderDead);
        Shizuku.addBinderReceivedListenerSticky(binderReceived);
    }

    void resume() {
        foreground = true;
        LegacyNavigationRecovery.recover(context);
        start(false);
    }

    void pause() {
        foreground = false;
        cancelCommand();
        unbind();
    }

    void repairFromButton() {
        if (binding || bound) return;
        LegacyNavigationRecovery.recover(context);
        requested = LegacyNavigationRecovery.pending(context) ? Operation.NAVIGATION : null;
        foreground = true;
        start(true);
    }

    void requestAssistantFromButton() {
        if (binding || bound) {
            setStatus("Shizuku：正在执行操作，请完成后再设置默认助手");
            return;
        }
        requested = Operation.ASSISTANT;
        foreground = true;
        start(true);
    }

    void destroy() {
        destroyed = true;
        foreground = false;
        requested = null;
        cancelCommand();
        Shizuku.removeBinderReceivedListener(binderReceived);
        Shizuku.removeBinderDeadListener(binderDead);
        Shizuku.removeRequestPermissionResultListener(permissionResult);
        unbind();
        worker.shutdownNow();
    }

    static String statusText() { return status; }

    private void start(boolean explicit) {
        if (destroyed || !foreground || binding || bound) return;
        try {
            if (!Shizuku.pingBinder()) {
                requested = null;
                setStatus("Shizuku：未运行；请先启动官方 Shizuku");
                return;
            }
            if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) {
                if (!explicit) {
                    setStatus("Shizuku：尚未授权；点击“修复授权”重试");
                } else if (Shizuku.shouldShowRequestPermissionRationale()) {
                    requested = null;
                    setStatus("Shizuku：授权被拒绝；请在 Shizuku 管理器中允许后重试");
                } else {
                    setStatus("Shizuku：等待授权…");
                    Shizuku.requestPermission(REQUEST_CODE);
                }
                return;
            }
            if (requested != null) bindGrantService();
            else setStatus("Shizuku：已授权，可用于 Shower");
        } catch (RuntimeException exception) {
            requested = null;
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
            requested = null;
            setStatus("Shizuku 授权服务失败：" + detail(exception));
        }
    }

    private void finishCommand(String error, Operation operation) {
        unbind();
        if (!foreground) return;
        if (!error.isEmpty()) {
            setStatus("Shizuku 命令失败：" + error);
        } else if (operation == Operation.ASSISTANT) {
            setStatus(LauncherVoiceInteractionService.isDefaultAssistant(context)
                    ? "Shizuku：已确认本应用是默认助手"
                    : "Shizuku 命令已完成，但默认助手未生效；请在系统“默认数字助理”中选择本应用");
        } else if (context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
                != PackageManager.PERMISSION_GRANTED) {
            setStatus("Shizuku 命令已完成，但写设置权限未生效");
        } else {
            LegacyNavigationRecovery.recover(context);
            setStatus(LegacyNavigationRecovery.pending(context)
                    ? LegacyNavigationRecovery.status(context) : "Shizuku：旧导航接管已解除");
        }
    }

    private void cancelCommand() {
        commandGeneration++;
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
