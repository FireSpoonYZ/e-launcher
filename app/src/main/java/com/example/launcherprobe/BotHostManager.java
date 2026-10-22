package com.example.launcherprobe;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * M15 本地 AI Host 管理器：单线程串行控制执行器（有界队列）+ 每代子进程。
 * 冷状态仅读私有 bot_host 偏好元数据；绝不准备资产/启动 Node/拉起 FGS。
 * 控制操作排队有界（超越即 BUSY/not-sent）；原生回调（reader 线程）不经过执行器。
 * 停止/清理使用每代一次的有界专用 daemon 线程（不排在可能阻塞的 start 之后），
 * 确认子进程真实关闭后才允许替换/重启；离线 settings 整事务在控制线程内串行。
 */
public final class BotHostManager {

    private static volatile BotHostManager instance;

    private static final String PREFS_BOT_HOST = "bot_host";
    private static final String PREFS_CREDENTIALS = "bot_host_credentials";
    private static final String PREF_PHASE = "phase";
    private static final String PREF_DEVICE_ID = "device_id";
    private static final String PREF_LAST_UPDATED = "last_updated";
    private static final String PREF_ERROR_CODE = "error_code";
    private static final String PREF_RESTART_REQUIRED = "restart_required";
    private static final String PREF_CREDENTIAL_ALIASES = "credential_aliases";
    private static final int CONTROL_QUEUE_CAPACITY = 8;
    private static final long CLEANUP_SPAWN_WAIT_MS = 30_000;

    private static final Pattern ENV_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");
    private static final Set<String> PROTECTED_ENV = new HashSet<>(Arrays.asList(
            "PATH", "HOME", "PWD", "SHELL", "USER", "LOGNAME", "HOSTNAME", "LANG", "LC_ALL",
            "TMPDIR", "TEMP", "TMP", "ANDROID_ROOT", "ANDROID_DATA", "ANDROID_STORAGE",
            "LD_LIBRARY_PATH", "JAVA_HOME", "NODE_OPTIONS", "SYSTEMROOT", "WINDIR"));

    enum Phase { STOPPED, STARTING, RUNNING, STOPPING, FAILED }

    /** 观察句柄：只取消捕获时的进程与 id；进程更换/关闭后自动失效。 */
    public static final class Observation implements AutoCloseable {
        private final BotHostProcess process;
        private final String id;
        private volatile boolean closed;

        Observation(BotHostProcess process, String id) {
            this.process = process;
            this.id = id;
        }

        @Override public void close() {
            if (closed) return;
            closed = true;
            process.cancel(id);
        }
    }

    /** 每代状态。非静态内部类：可引用外层实例成员（gen/handleReady/handleExit）。 */
    private final class Gen {
        final BotHostVoice voice;
        final BotHostNativeTools nativeTools;
        final String token;
        final long epoch;
        final CompletableFuture<JSONObject> startPromise;
        final BotHostProcess.Listener listener;
        final CompletableFuture<Void> launchAssigned = new CompletableFuture<>();
        final AtomicBoolean cleanupScheduled = new AtomicBoolean();
        volatile CompletableFuture<Void> cleanupDone = new CompletableFuture<>();
        volatile CompletableFuture<BotHostProcess> launchFuture;
        volatile BotHostProcess process; // onStarting 捕获（ready 前）；onReady 绑定 deviceId/native。
        volatile String deviceId;
        volatile boolean closed;

        Gen(BotHostVoice voice, BotHostNativeTools nativeTools, String token, long epoch,
            CompletableFuture<JSONObject> startPromise) {
            this.voice = voice;
            this.nativeTools = nativeTools;
            this.token = token;
            this.epoch = epoch;
            this.startPromise = startPromise;
            this.listener = new BotHostProcess.Listener() {
                @Override public void onStarting(BotHostProcess process) {
                    // launch 在 host.start 前同步触发：仅捕获进程，不 bind native。
                    Gen self = Gen.this;
                    synchronized (lock) {
                        if (self.closed || gen != self) {
                            // 已被停止接管：立即关闭以免孤儿。
                            if (process != null) {
                                try {
                                    process.close();
                                } catch (Throwable ignored) {
                                }
                            }
                            return;
                        }
                        self.process = process;
                    }
                }

                @Override public void onReady(BotHostProcess process, JSONObject ready) {
                    handleReady(Gen.this, process, ready);
                }

                @Override public void onNativeFrame(BotHostProcess process, JSONObject frame) {
                    Gen self = Gen.this;
                    if (!self.closed && gen == self && self.process == process) {
                        try {
                            self.nativeTools.onFrame(process, frame);
                        } catch (Throwable ignored) {
                        }
                    }
                }

                @Override public void onExit(BotHostProcess process, int exitCode, boolean graceful) {
                    handleExit(Gen.this, process, exitCode, graceful);
                }
            };
        }
    }

    private static final BotHostProcess.Listener OFFLINE_LISTENER = new BotHostProcess.Listener() {
        @Override public void onReady(BotHostProcess process, JSONObject ready) {
        }

        @Override public void onNativeFrame(BotHostProcess process, JSONObject frame) {
        }

        @Override public void onExit(BotHostProcess process, int exitCode, boolean graceful) {
        }
    };

    private final Context context;
    private final ThreadPoolExecutor control = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(CONTROL_QUEUE_CAPACITY),
            runnable -> {
                Thread thread = new Thread(runnable, "bot-host-control");
                thread.setDaemon(true);
                return thread;
            },
            new ThreadPoolExecutor.AbortPolicy());
    private final Object lock = new Object();
    private final SharedPreferences prefs;
    private final SharedPreferences credentialPrefs;
    private final String workspacePath;

    private volatile Phase phase = Phase.STOPPED;
    private volatile Gen gen;
    private volatile CompletableFuture<JSONObject> startFuture;
    private volatile CompletableFuture<Void> stopFuture;
    private volatile String lastDeviceId;
    private volatile long lastUpdated;
    private volatile String errorCode;
    private volatile boolean restartRequired;
    private volatile BotHostService service;
    private volatile BotHostVoice spareVoice;
    private volatile Gen pendingCleanupGen; // 清理失败残留代：确认死亡前禁止替换。
    private long epoch; // 受 lock 保护：停止递增以取消未提交/进行中的启动。

    private BotHostManager(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREFS_BOT_HOST, Context.MODE_PRIVATE);
        this.credentialPrefs = this.context.getSharedPreferences(PREFS_CREDENTIALS, Context.MODE_PRIVATE);
        this.workspacePath = new File(this.context.getFilesDir(), "bot-host/workspaces").getAbsolutePath();
        // 进程冷启动：持久化运行中/启动中/停止中一律视为已停止（子进程守父退出）。
        this.lastDeviceId = prefs.getString(PREF_DEVICE_ID, null);
        this.lastUpdated = prefs.getLong(PREF_LAST_UPDATED, 0L);
        this.errorCode = prefs.getString(PREF_ERROR_CODE, null);
        this.restartRequired = prefs.getBoolean(PREF_RESTART_REQUIRED, false);
    }

    /** 冷单例访问：不准备资产/不启动 Node/不拉起 FGS。 */
    public static BotHostManager get(Context context) {
        if (instance == null) {
            synchronized (BotHostManager.class) {
                if (instance == null) instance = new BotHostManager(context);
            }
        }
        return instance;
    }

    // ---------- 快照 ----------

    /** 缓存安全本地状态；绝不包含令牌/凭据，也不声称过期的 ready；含安全 workspace 路径。 */
    public JSONObject snapshot() {
        synchronized (lock) {
            try {
                String deviceId = null;
                Gen g = gen;
                if (g != null && !g.closed && phase == Phase.RUNNING) deviceId = g.deviceId;
                if (deviceId == null) deviceId = lastDeviceId;
                return new JSONObject()
                        .put("phase", phase.name().toLowerCase())
                        .put("lastUpdated", lastUpdated)
                        .put("restartRequired", restartRequired)
                        .put("deviceId", deviceId != null && !deviceId.isEmpty() ? deviceId : JSONObject.NULL)
                        .put("errorCode", errorCode != null && !errorCode.isEmpty() ? errorCode : JSONObject.NULL)
                        .put("workspace", workspacePath);
            } catch (JSONException impossible) {
                try {
                    return new JSONObject()
                            .put("phase", phase.name().toLowerCase())
                            .put("lastUpdated", lastUpdated)
                            .put("restartRequired", restartRequired)
                            .put("deviceId", JSONObject.NULL)
                            .put("errorCode", JSONObject.NULL)
                            .put("workspace", workspacePath);
                } catch (JSONException again) {
                    return new JSONObject();
                }
            }
        }
    }

    // ---------- 生命周期 ----------

    /**
     * 内部启动：仅 BotHostService 在 startForeground 成功后调用（package-private 约束）。
     * 重复启动共享同一 start future；绝不自动重启；停止会使未提交启动取消。
     */
    CompletableFuture<JSONObject> start() {
        synchronized (lock) {
            if (phase == Phase.RUNNING) return CompletableFuture.completedFuture(snapshot());
            if (phase == Phase.STARTING) {
                CompletableFuture<JSONObject> existing = startFuture;
                if (existing != null) return existing;
            }
            if (phase == Phase.STOPPING) throw new IllegalStateException("Host 正在停止");
            if (pendingCleanupGen != null) throw new IllegalStateException("上一代清理未完成，无法启动");
        }
        final long e;
        synchronized (lock) {
            e = epoch;
        }
        return onControl(() -> startTask(e));
    }

    private CompletableFuture<JSONObject> startTask(long e) {
        Gen g;
        synchronized (lock) {
            if (phase == Phase.RUNNING) return CompletableFuture.completedFuture(snapshot());
            if (phase == Phase.STARTING) {
                CompletableFuture<JSONObject> existing = startFuture;
                if (existing != null) return existing;
            }
            if (phase == Phase.STOPPING) throw new IllegalStateException("Host 正在停止");
            if (pendingCleanupGen != null) throw new IllegalStateException("上一代清理未完成，无法启动");
            if (e != epoch) throw new CancellationException("Host 启动已取消");
            if (spareVoice != null) {
                try {
                    spareVoice.close();
                } catch (Throwable ignored) {
                }
                spareVoice = null;
            }
            BotHostVoice voice = new BotHostVoice(context);
            BotHostNativeTools nativeTools = new BotHostNativeTools(context, voice);
            g = new Gen(voice, nativeTools, randomToken(), e, new CompletableFuture<>());
            gen = g;
            startFuture = g.startPromise;
            setPhaseLocked(Phase.STARTING, null, false);
        }
        // 不持有锁等待子进程：若持有，reader 线程的 onReady 会阻塞在锁上而无法完成 launch。
        CompletableFuture<BotHostProcess> launchFuture;
        try {
            launchFuture = BotHostProcess.launch(context, hostInit(g), g.listener);
        } catch (Throwable t) {
            g.launchAssigned.complete(null); // launch 明确未产生进程对象。
            failStart(g, t);
            throw asUnchecked(t);
        }
        g.launchFuture = launchFuture;
        g.launchAssigned.complete(null); // launch 调用已返回：process 已知（可能为 null）。
        try {
            g.process = launchFuture.join();
        } catch (Throwable t) {
            failStart(g, t);
            throw asUnchecked(t);
        }
        boolean superseded;
        synchronized (lock) {
            superseded = g.closed || gen != g || g.epoch != epoch;
        }
        if (superseded) {
            // 停止期间的迟到 ready/进程：立即关闭该代，绝不重新入场。
            if (g.launchFuture != null) {
                try {
                    g.launchFuture.cancel(true);
                } catch (Throwable ignored) {
                }
            }
            if (g.process != null) {
                try {
                    g.process.close();
                } catch (Throwable ignored) {
                }
            }
            CancellationException cancelled = new CancellationException("Host 启动已取消");
            failStart(g, cancelled);
            throw cancelled;
        }
        return g.startPromise;
    }

    /**
     * 立即停止：同步停准入、递增 epoch、取消 startPromise、捕获一代并置 STOPPING，
     * 随后在每代一次的专用清理线程上取消/关闭/确认死亡；不做持锁等待。
     * stopFuture 保证单次：并发 stop 共享同一 future。
     */
    CompletableFuture<Void> stop() {
        Gen g;
        CompletableFuture<Void> promise;
        synchronized (lock) {
            epoch++;
            if (phase == Phase.STOPPED) return CompletableFuture.completedFuture(null);
            if (stopFuture != null) return stopFuture;
            promise = new CompletableFuture<>();
            stopFuture = promise;
            CompletableFuture<JSONObject> pendingStart = startFuture;
            startFuture = null;
            if (pendingStart != null && !pendingStart.isDone()) {
                pendingStart.completeExceptionally(new CancellationException("Host 启动已取消"));
            }
            if (pendingCleanupGen != null) {
                // 上次清理失败：重试同一残留代，确认死亡前保持 FAILED/CLEANUP_FAILED。
                g = pendingCleanupGen;
                pendingCleanupGen = null;
                gen = null;
                g.closed = true;
                setPhaseLocked(Phase.STOPPING, null, false);
                if (g.cleanupDone.isDone()) {
                    // 旧清理已结束：允许新一轮清理尝试。
                    g.cleanupScheduled.set(false);
                    g.cleanupDone = new CompletableFuture<>();
                }
            } else {
                g = gen;
                gen = null;
                if (g != null) g.closed = true;
                setPhaseLocked(Phase.STOPPING, null, false);
            }
        }
        awaitCleanup(g, promise);
        return promise;
    }

    /** 每代至多启动一次清理线程；stop/失败路径均可挂接该清理结果。 */
    private void triggerCleanup(Gen g) {
        if (g.cleanupScheduled.compareAndSet(false, true)) {
            Thread thread = new Thread(() -> runCleanup(g), "bot-host-cleanup");
            thread.setDaemon(true);
            thread.start();
        }
    }

    private void awaitCleanup(Gen g, CompletableFuture<Void> promise) {
        if (g == null) {
            finishStop(promise);
            return;
        }
        g.cleanupDone.whenComplete((v, ex) -> {
            if (ex != null) failCleanupNotify(promise);
            else finishStop(promise);
        });
        triggerCleanup(g);
    }

    private void runCleanup(Gen g) {
        boolean dead;
        try {
            dead = confirmDead(g);
        } catch (Throwable t) {
            dead = false;
        }
        synchronized (lock) {
            if (dead) {
                if (pendingCleanupGen == g) pendingCleanupGen = null;
                if (phase == Phase.STOPPING) setPhaseLocked(Phase.STOPPED, null, false);
                g.cleanupDone.complete(null);
            } else {
                if (phase == Phase.STOPPING) {
                    setPhaseLocked(Phase.FAILED, "CLEANUP_FAILED", false);
                } else if (!"CLEANUP_FAILED".equals(errorCode)) {
                    errorCode = "CLEANUP_FAILED";
                    persistLocked();
                }
                pendingCleanupGen = g;
                g.cleanupDone.completeExceptionally(
                        new BridgeException("CLEANUP_FAILED", "unconfirmed", "子进程清理失败"));
            }
        }
    }

    /** 确认一代无存活子进程；无法确认视为存活，不得声称已停止。 */
    private boolean confirmDead(Gen g) {
        closeVoiceNative(g); // 先关资源：即使等待 launchAssigned 超时 return false 也不漏关闭。
        // 等待 launch 调用明确返回（onStarting 已捕获 process）；超时视为未知。
        try {
            g.launchAssigned.get(CLEANUP_SPAWN_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            return false;
        }
        if (g.process == null) {
            // 仅 launch 明确未产生进程对象才算 dead。
            return g.launchAssigned.isDone();
        }
        if (g.launchFuture != null) {
            try {
                g.launchFuture.cancel(true);
            } catch (Throwable ignored) {
            }
        }
        closeGenerationResources(g);
        try {
            g.process.close().join();
        } catch (Throwable ignored) {
        }
        return !g.process.isAlive();
    }

    private void failCleanupNotify(CompletableFuture<Void> promise) {
        synchronized (lock) {
            if (stopFuture == promise) stopFuture = null;
        }
        promise.completeExceptionally(new BridgeException("CLEANUP_FAILED", "unconfirmed", "子进程清理失败"));
        notifyServiceStop(true, "CLEANUP_FAILED");
    }

    private void finishStop(CompletableFuture<Void> promise) {
        synchronized (lock) {
            if (phase == Phase.STOPPING) setPhaseLocked(Phase.STOPPED, null, false);
            if (stopFuture == promise) stopFuture = null;
        }
        promise.complete(null);
        notifyServiceStop(false, null);
    }

    private void failStart(Gen g, Throwable t) {
        String code = safeCode(t);
        synchronized (lock) {
            if (gen != g || g.closed) return; // 已被停止/清理接管
            if (phase == Phase.STOPPING) return; // 主动停止不覆盖为 failed
            gen = null;
            g.closed = true;
            setPhaseLocked(Phase.FAILED, code, false);
            g.startPromise.completeExceptionally(t);
            startFuture = null;
            // spawn 未知/已退出但代资源未 close 时也走统一清理：
            // 复用 triggerCleanup/confirmDead/pendingCleanupGen，直到确认 spawn/exit。
            if (pendingCleanupGen == null) pendingCleanupGen = g;
        }
        notifyServiceStop(true, code);
        triggerCleanup(g);
    }

    private void closeVoiceNative(Gen g) {
        try {
            g.nativeTools.close();
        } catch (Throwable ignored) {
        }
        try {
            g.voice.close();
        } catch (Throwable ignored) {
        }
    }

    private void closeGenerationResources(Gen g) {
        closeVoiceNative(g);
        if (g.process != null) {
            try {
                g.process.close(); // 幂等
            } catch (Throwable ignored) {
            }
        }
    }

    // ---------- 子进程回调（reader 线程；非阻塞） ----------

    private void handleReady(Gen g, BotHostProcess process, JSONObject ready) {
        Throwable failure = null;
        boolean accepted = false;
        synchronized (lock) {
            if (g.closed || gen != g) {
                // 非当前代/已关闭：不允许重新入场。
                return;
            }
            g.process = process; // 先固定代内指针，使后续 onExit 可匹配，再 bind。
            if (ready.optString("deviceId").isEmpty()) {
                failure = new IllegalStateException("ready 缺少 deviceId");
            } else {
                try {
                    g.nativeTools.bind(process, ready.optString("deviceId"));
                    g.deviceId = ready.optString("deviceId");
                    lastDeviceId = g.deviceId;
                    // ready bind 成功：清 restartRequired 再持久化 RUNNING。
                    // 过渡期配置写被拒，init 读取后无可成功的新配置写，故此处为唯一清标点。
                    restartRequired = false;
                    setPhaseLocked(Phase.RUNNING, null, false);
                    g.startPromise.complete(snapshot());
                    startFuture = null;
                    accepted = true;
                } catch (Throwable t) {
                    failure = t;
                }
            }
        }
        if (accepted) {
            notifyServiceState();
            return;
        }
        // 锁外统一走 failStart 清理路径：保留 g 为当前（不手写 gen=null/close），
        // ready/bind 失败同样挂 pendingCleanupGen，直到真实确认死亡才解除替换限制。
        failStart(g, failure != null ? failure : new IllegalStateException("ready 无效"));
    }

    private void handleExit(Gen g, BotHostProcess process, int exitCode, boolean graceful) {
        String code = null;
        boolean resolvedCleanup = false;
        synchronized (lock) {
            if (pendingCleanupGen == g && g.process == process) {
                // 清理失败残留的子进程最终退出：确认死亡并解除替换限制。
                pendingCleanupGen = null;
                if (phase == Phase.FAILED && "CLEANUP_FAILED".equals(errorCode)) {
                    setPhaseLocked(Phase.STOPPED, null, false);
                    resolvedCleanup = true;
                }
            } else if (gen != g || g.closed) {
                return; // 旧代忽略
            } else {
                gen = null;
                g.closed = true;
                closeGenerationResources(g);
                if (phase != Phase.STOPPING) {
                    code = graceful ? "HOST_CLOSED" : "HOST_EXITED";
                    setPhaseLocked(Phase.FAILED, code, false);
                }
            }
        }
        if (resolvedCleanup) notifyServiceStop(false, null);
        else if (code != null) notifyServiceStop(true, code);
    }

    // ---------- 控制调用 ----------

    /** 运行中子状态 RESULT PAYLOAD（解包并校验对象）；停止/未运行返回冷快照（无 Node）。 */
    public CompletableFuture<JSONObject> status() {
        return onControl(() -> {
            Gen g = gen;
            if (running(g)) return unwrapWithRestart(g, processRequest(g, "status", null));
            return CompletableFuture.completedFuture(snapshot());
        });
    }

    /** 固定控制调用：不隐式启动；返回完整 {type:'result',id,result} 信封，不做二次包装。 */
    public CompletableFuture<JSONObject> call(String method, JSONObject params) {
        return onControl(() -> {
            Gen g = gen;
            if (!running(g)) return failedFuture(new IllegalStateException("Host 未运行"));
            try {
                JSONObject fields = new JSONObject().put("method", method)
                        .put("params", params != null ? params : new JSONObject());
                return processRequest(g, "call", fields);
            } catch (JSONException e) {
                return failedFuture(new BridgeException("INVALID_ARGUMENT", "not-sent", "请求字段无效"));
            }
        });
    }

    /** 观察固定目标；绝不启动 Host。close() 只取消捕获时的进程/id。 */
    public CompletableFuture<Observation> observe(JSONObject target,
                                                  Consumer<JSONObject> onFrame,
                                                  Consumer<Throwable> onError) {
        return onControl(() -> {
            Gen g = gen;
            if (!running(g)) return failedFuture(new IllegalStateException("Host 未运行"));
            try {
                return CompletableFuture.completedFuture(new Observation(g.process, g.process.observe(target, onFrame, onError)));
            } catch (IOException | RuntimeException e) {
                return failedFuture(e);
            }
        });
    }

    // ---------- Settings ----------

    /** 设置 GET：在线走当前进程；离线在控制线程内整体串行瞬态 settings 子进程并 finally 关闭。 */
    public CompletableFuture<JSONObject> settingsGet() {
        if (transitionBlocked()) {
            // 排队前即刻拒绝：防止队列积压在阻塞的 start 之后。
            return failedFuture(new BridgeException("BUSY", "not-sent", "Host 正在启动/停止"));
        }
        return onControl(() -> {
            Gen g = gen;
            if (running(g)) return unwrapWithRestart(g, processRequest(g, "settings_get", null));
            if (transitionBlocked()) {
                // 队列内复查：排队期间进入过渡态同样拒绝。
                return failedFuture(new BridgeException("BUSY", "not-sent", "Host 正在启动/停止"));
            }
            try {
                return CompletableFuture.completedFuture(offlineSettingsSync(true, null));
            } catch (Throwable t) {
                return failedFuture(t);
            }
        });
    }

    /** 设置 SET：输入 {expectedRevision, settings}；仅下次显式重启生效。 */
    public CompletableFuture<JSONObject> settingsSet(JSONObject input) {
        if (transitionBlocked()) {
            // 排队前即刻拒绝：防止队列积压在阻塞的 start 之后。
            return failedFuture(new BridgeException("BUSY", "not-sent", "Host 正在启动/停止"));
        }
        return onControl(() -> {
            Gen g = gen;
            if (running(g)) {
                try {
                    return unwrapWithRestart(g, processRequest(g, "settings_set", new JSONObject().put("input", input)));
                } catch (JSONException e) {
                    return failedFuture(new BridgeException("INVALID_ARGUMENT", "not-sent", "设置输入无效"));
                }
            }
            if (transitionBlocked()) {
                // 队列内复查：排队期间进入过渡态同样拒绝。
                return failedFuture(new BridgeException("BUSY", "not-sent", "Host 正在启动/停止"));
            }
            try {
                return CompletableFuture.completedFuture(offlineSettingsSync(false, input));
            } catch (Throwable t) {
                return failedFuture(t);
            }
        });
    }

    /** 离线 settings 整事务：阻塞等待请求与子进程关闭，失败不触发数据库；与 Host 串行。 */
    private JSONObject offlineSettingsSync(boolean get, JSONObject input) {
        JSONObject init;
        try {
            init = settingsInit();
        } catch (IOException e) {
            throw new CompletionException(e);
        }
        BotHostProcess child;
        try {
            child = BotHostProcess.launch(context, init, OFFLINE_LISTENER).join();
        } catch (Throwable t) {
            throw new CompletionException(t);
        }
        try {
            try {
                CompletableFuture<JSONObject> request = get
                        ? child.request("settings_get", null)
                        : child.request("settings_set", new JSONObject().put("input", input));
                return requireObjectResult(request.join());
            } catch (IOException | JSONException e) {
                throw new CompletionException(e);
            }
        } finally {
            try {
                child.close().join();
            } catch (Throwable ignored) {
            }
        }
    }

    // ---------- 凭据 ----------

    /**
     * 替换私有 bot_host 凭据映射并同步提交；无 getter，绝不返回真实值。
     * 校验规则与 Node 一致（标准变量名/非空/无 NUL/4096 字节/64 项/64KiB/保留名）。
     * 在线保存标记 restartRequired，下次启动复制到 init 才生效。
     */
    public CompletableFuture<Void> saveCredentials(JSONObject aliases) {
        if (transitionBlocked()) {
            // 排队前即刻拒绝：防止队列积压在阻塞的 start 之后。
            return failedFuture(new BridgeException("BUSY", "not-sent", "Host 正在启动/停止"));
        }
        return onControl(() -> {
            if (transitionBlocked()) {
                // 队列内复查：排队期间进入过渡态同样拒绝。
                return failedFuture(new BridgeException("BUSY", "not-sent", "Host 正在启动/停止"));
            }
            try {
                JSONObject cleaned = validateCredentials(aliases);
                if (!credentialPrefs.edit().putString(PREF_CREDENTIAL_ALIASES, cleaned.toString()).commit()) {
                    return failedFuture(new IllegalStateException("凭据保存失败"));
                }
                synchronized (lock) {
                    if (phase == Phase.RUNNING) {
                        restartRequired = true;
                        persistLocked();
                    }
                }
                return CompletableFuture.completedFuture(null);
            } catch (Throwable t) {
                return failedFuture(t);
            }
        });
    }

    private static JSONObject validateCredentials(JSONObject aliases) {
        JSONObject cleaned = new JSONObject();
        if (aliases == null) return cleaned;
        int count = 0;
        long total = 0;
        Iterator<String> keys = aliases.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            Object value = aliases.opt(name);
            if (!(value instanceof String)) throw new IllegalArgumentException("凭据值必须是字符串");
            String text = (String) value;
            if (!ENV_NAME.matcher(name).matches() || "__proto__".equals(name)) {
                throw new IllegalArgumentException("凭据环境变量名无效");
            }
            if (text.isEmpty() || text.indexOf('\u0000') >= 0) {
                throw new IllegalArgumentException("凭据值必须是非空且不含 NUL 的字符串");
            }
            byte[] valueBytes;
            try {
                valueBytes = text.getBytes("UTF-8");
            } catch (Exception e) {
                throw new IllegalArgumentException("凭据值编码无效");
            }
            if (valueBytes.length > 4096) throw new IllegalArgumentException("凭据值超过 4096 字节");
            total += name.length() + valueBytes.length;
            if (total > 65536) throw new IllegalArgumentException("凭据总长超过 64KiB");
            if (isProtectedEnv(name)) throw new IllegalArgumentException("凭据名称与宿主环境冲突：" + name);
            count++;
            if (count > 64) throw new IllegalArgumentException("凭据项超过 64 个");
            try {
                cleaned.put(name, text);
            } catch (JSONException e) {
                throw new IllegalArgumentException("凭据项编码无效");
            }
        }
        return cleaned;
    }

    private static boolean isProtectedEnv(String name) {
        return PROTECTED_ENV.contains(name)
                || name.startsWith("ANDROID_")
                || name.startsWith("LC_")
                || name.startsWith("NODE_")
                || name.startsWith("PI_")
                || name.startsWith("npm_")
                || System.getenv().containsKey(name);
    }

    // ---------- 语音门面 ----------

    /** 懒语音门面：运行中返回当前代语音；未运行返回独立瞬态语音（下次启动时关闭）。 */
    public BotHostVoice voice() {
        synchronized (lock) {
            Gen g = gen;
            if (g != null && !g.closed) return g.voice;
            if (spareVoice == null) spareVoice = new BotHostVoice(context);
            return spareVoice;
        }
    }

    // ---------- 服务接线 ----------

    void attachService(BotHostService svc) {
        this.service = svc;
    }

    void detachService(BotHostService svc) {
        synchronized (lock) {
            if (this.service == svc) this.service = null;
        }
    }

    boolean isActiveService(BotHostService svc) {
        return service == svc;
    }

    /**
     * Service 销毁：仅当仍是当前挂接服务时，对仍活跃的 starting/running/stopping 代执行 stop
     * （避免旧实例关闭替换代）。终态 failed 且代已清理时保留 FAILED/errorCode，不自动清错。
     */
    void onServiceDestroyed(BotHostService svc) {
        synchronized (lock) {
            if (this.service != svc) return;
            this.service = null;
            Phase p = phase;
            if (p != Phase.STARTING && p != Phase.RUNNING && p != Phase.STOPPING) {
                // 终态 failed（或已停止）：保留失败信息，由用户显式 stop / 下次启动更新。
                return;
            }
        }
        stop();
    }

    private void notifyServiceState() {
        BotHostService current = service;
        if (current != null) {
            try {
                current.onManagerStateChanged();
            } catch (Throwable ignored) {
            }
        }
    }

    private void notifyServiceStop(boolean failed, String code) {
        BotHostService current = service;
        if (current != null) {
            try {
                current.onManagerStopped(failed, code);
            } catch (Throwable ignored) {
            }
        }
    }

    // ---------- 内部辅助 ----------

    private boolean running(Gen g) {
        return g != null && !g.closed && g.process != null && phase == Phase.RUNNING;
    }

    private CompletableFuture<JSONObject> processRequest(Gen g, String type, JSONObject fields) {
        try {
            return g.process.request(type, fields);
        } catch (IOException | RuntimeException e) {
            return failedFuture(e);
        }
    }

    /** Process.request 现返回完整信封；解包并校验对象 result（call 不调用）。 */
    private CompletableFuture<JSONObject> unwrapResult(CompletableFuture<JSONObject> request) {
        CompletableFuture<JSONObject> out = new CompletableFuture<>();
        request.whenComplete((envelope, ex) -> {
            if (ex != null) {
                out.completeExceptionally(ex);
                return;
            }
            try {
                out.complete(requireObjectResult(envelope));
            } catch (Throwable t) {
                out.completeExceptionally(t);
            }
        });
        return out;
    }

    /** 在线 status/settings 响应：合并 restartRequired（凭据 true 不被 Node false 抹掉）并回写结果。 */
    private CompletableFuture<JSONObject> unwrapWithRestart(Gen g, CompletableFuture<JSONObject> request) {
        CompletableFuture<JSONObject> out = new CompletableFuture<>();
        request.whenComplete((envelope, ex) -> {
            if (ex != null) {
                out.completeExceptionally(ex);
                return;
            }
            try {
                out.complete(mergeRestartRequired(g, requireObjectResult(envelope)));
            } catch (Throwable t) {
                out.completeExceptionally(t);
            }
        });
        return out;
    }

    /** 仅当前代响应可更新缓存并回写：合并后的 restartRequired；旧 Gen 响应不改新缓存。 */
    private JSONObject mergeRestartRequired(Gen g, JSONObject result) {
        synchronized (lock) {
            if (gen == g && !g.closed) {
                boolean merged = restartRequired || result.optBoolean("restartRequired", false);
                if (merged) {
                    if (!restartRequired) {
                        restartRequired = true;
                        persistLocked();
                    }
                    try {
                        result.put("restartRequired", true);
                    } catch (JSONException ignored) {
                    }
                }
            }
        }
        return result;
    }

    /** STARTING/STOPPING/残留清理中：禁止启动离线 child 与写配置。 */
    private boolean transitionBlocked() {
        synchronized (lock) {
            return phase == Phase.STARTING || phase == Phase.STOPPING || pendingCleanupGen != null;
        }
    }

    private static JSONObject requireObjectResult(JSONObject envelope) throws IOException {
        Object result = envelope == null ? null : envelope.opt("result");
        if (envelope == null || !"result".equals(envelope.optString("type")) || !(result instanceof JSONObject)) {
            throw new BridgeException("PROTOCOL", "invalid", "响应信封结果无效");
        }
        return (JSONObject) result;
    }

    private JSONObject hostInit(Gen g) throws IOException {
        try {
            BotHostAssets assets = BotHostAssets.prepare(context);
            JSONObject init = new JSONObject()
                    .put("type", "init")
                    .put("protocol", 1)
                    .put("mode", "host")
                    .put("dataRoot", assets.state.getAbsolutePath())
                    .put("token", g.token);
            JSONObject credentials = loadCredentials();
            if (credentials.length() > 0) init.put("credentials", credentials);
            return init;
        } catch (JSONException e) {
            throw new IOException("init 帧构造失败");
        }
    }

    private JSONObject settingsInit() throws IOException {
        try {
            BotHostAssets assets = BotHostAssets.prepare(context);
            return new JSONObject()
                    .put("type", "init")
                    .put("protocol", 1)
                    .put("mode", "settings")
                    .put("dataRoot", assets.state.getAbsolutePath());
        } catch (JSONException e) {
            throw new IOException("settings init 帧构造失败");
        }
    }

    private JSONObject loadCredentials() {
        String raw = credentialPrefs.getString(PREF_CREDENTIAL_ALIASES, null);
        if (raw == null || raw.isEmpty()) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static String randomToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String safeCode(Throwable t) {
        if (t instanceof BotHostProcess.BridgeException) {
            String code = ((BotHostProcess.BridgeException) t).code;
            if (code != null && !code.isEmpty()) return code;
        }
        if (t instanceof IOException) return "LAUNCH_FAILED";
        return "INTERNAL";
    }

    private static RuntimeException asUnchecked(Throwable t) {
        if (t instanceof RuntimeException) return (RuntimeException) t;
        return new CompletionException(t);
    }

    private static <T> CompletableFuture<T> failedFuture(Throwable t) {
        CompletableFuture<T> f = new CompletableFuture<>();
        f.completeExceptionally(t);
        return f;
    }

    /** 有界串行控制执行：队列满抛 BUSY/not-sent；内部 future 扁平化。 */
    private <T> CompletableFuture<T> onControl(Supplier<CompletableFuture<T>> action) {
        CompletableFuture<CompletableFuture<T>> holder = new CompletableFuture<>();
        try {
            control.execute(() -> {
                try {
                    holder.complete(action.get());
                } catch (Throwable t) {
                    holder.completeExceptionally(t);
                }
            });
        } catch (RejectedExecutionException e) {
            holder.completeExceptionally(new BridgeException("BUSY", "not-sent", "控制操作繁忙"));
        }
        return holder.thenCompose(f -> f);
    }

    private void setPhaseLocked(Phase next, String code, boolean restart) {
        phase = next;
        errorCode = code;
        if (restart) restartRequired = true;
        lastUpdated = System.currentTimeMillis();
        persistLocked();
    }

    private void persistLocked() {
        String deviceId = lastDeviceId;
        Gen g = gen;
        if (g != null && !g.closed && g.deviceId != null) deviceId = g.deviceId;
        prefs.edit()
                .putString(PREF_PHASE, phase.name().toLowerCase())
                .putString(PREF_DEVICE_ID, deviceId != null ? deviceId : "")
                .putLong(PREF_LAST_UPDATED, lastUpdated)
                .putString(PREF_ERROR_CODE, errorCode != null ? errorCode : "")
                .putBoolean(PREF_RESTART_REQUIRED, restartRequired)
                .apply();
    }
}
