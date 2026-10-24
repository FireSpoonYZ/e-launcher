package com.example.launcherprobe;

import android.content.Context;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * M20 Android 独立客户端子进程：复用 libnode_launcher/BotHostProcess，以 mode=client 懒启动
 * 桌面 broker（openDesktopClient），dataRoot 固定 files/bot-client，与 files/bot-host 隔离。
 * 只转发固定 broker 操作，绝不启动/停止本机 Host、Runtime、FGS，也不发 native 工具调用。
 * 单写者：一个 clientRoot 同时只允许一个 UI 会话持有；其他会话按 BUSY 拒绝（不复用错误会话、
 * 不绕过独占）。关闭只释放本会话观察与该子进程；不自动重连，也不重放任何变更。
 * 进程占有权按默认进程共享（{@link #get}）：Bound Service 重建不会重置上一代的
 * starting/closing 状态，只有确认退出才允许下一代启动。
 */
final class BotHostClient {

    /** 与 Host 状态目录隔离的客户端根（profiles/drafts/pending 都在其下）。 */
    private static final String DATA_ROOT = "bot-client";
    private static final int CONTROL_QUEUE_CAPACITY = 8;
    private static final Object INSTANCE_LOCK = new Object();
    private static BotHostClient instance;

    private final Context context;
    private final Object lock = new Object();
    /** 串行化启动/关闭与帧派发；读响应不占用本线程。 */
    private final ThreadPoolExecutor control;

    /** 唯一一代客户端进程；从启动占位起占有，只有真实 onExit 才清空。 */
    private Generation generation;

    /** 默认进程内唯一的管理器：冷状态只构造（不启动 Node、不准备资产）。 */
    static BotHostClient get(Context context) {
        synchronized (INSTANCE_LOCK) {
            if (instance == null) instance = new BotHostClient(context);
            return instance;
        }
    }

    private BotHostClient(Context context) {
        this.context = context.getApplicationContext();
        this.control = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(CONTROL_QUEUE_CAPACITY),
                runnable -> {
                    Thread thread = new Thread(runnable, "bot-client-control");
                    thread.setDaemon(true);
                    return thread;
                },
                new ThreadPoolExecutor.AbortPolicy());
    }

    /**
     * 一代客户端进程：process 在 onStarting 时填入；current=已就绪并被 owner 使用，
     * closing=关闭已发起（等 onExit 才解除占有），owner=启动占位时即确定的持有会话。
     */
    private static final class Generation {
        final String owner;
        BotHostProcess process;
        boolean current;
        boolean closing;

        Generation(String owner) {
            this.owner = owner;
        }
    }

    /**
     * 固定 broker 操作（唯一入口由 Node client 模式再校验 16 项白名单）。返回
     * {value:&lt;broker 结果&gt;}，null/数组原样保留；不重放、不二次包装原始错误。
     */
    CompletableFuture<JSONObject> request(String ownerId, BooleanSupplier ownerOpen, String op, JSONObject params) {
        final JSONObject input = params == null ? new JSONObject() : params;
        return onControl(() -> {
            BotHostProcess process = acquire(ownerId, ownerOpen);
            CompletableFuture<JSONObject> reply;
            try {
                reply = process.request("call", new JSONObject().put("method", op).put("params", input));
            } catch (IOException | JSONException failure) {
                return failed(failure);
            }
            return reply.thenApply(BotHostClient::valueEnvelope);
        });
    }

    /**
     * 客户端观察：observationId 由 UI 会话提供（broker 要求 UUID），据此回传
     * DesktopObservationEvent；observationOpen 复核该记录仍属本会话且未关闭，
     * 排队前、派发后各查一次，迟到建立立即按同一 id 撤销。失败只报错，不自动重试。
     */
    CompletableFuture<JSONObject> observe(String ownerId, BooleanSupplier ownerOpen, BooleanSupplier observationOpen,
                                          String observationId, JSONObject target, Consumer<JSONObject> onFrame,
                                          Consumer<Throwable> onError) {
        return onControl(() -> {
            // 排队期间已被 pause/unobserve：不启动进程、不建立观察。
            if (!observationOpen.getAsBoolean()) {
                throw new BridgeException("CANCELLED", "not-sent", "观察已取消");
            }
            BotHostProcess process = acquire(ownerId, ownerOpen);
            String id;
            try {
                id = process.observe(observationId, target, onFrame, onError);
            } catch (IOException | RuntimeException failure) {
                return failed(failure);
            }
            if (!observationOpen.getAsBoolean()) {
                // 派发期间记录已关闭：立即撤销刚建立的观察（Node 侧 cancel 再发 broker unobserve）。
                process.cancel(id);
                throw new BridgeException("CANCELLED", "not-sent", "观察已取消");
            }
            return CompletableFuture.completedFuture(BotHostUiProtocol.object("observationId", id));
        });
    }

    /** 只撤销本会话自己的客户端观察（broker unobserve），从不影响目标 Host 或 Agent。 */
    void cancel(String ownerId, String observationId) {
        BotHostProcess process;
        synchronized (lock) {
            Generation current = generation;
            if (current == null || current.process == null || current.closing
                    || !current.owner.equals(ownerId)) {
                return;
            }
            process = current.process;
        }
        process.cancel(observationId);
    }

    /**
     * 释放独占：锁内先原子标记 closing（此后同目录不再出现新写者），锁外只发起一次异步幂等
     * close；占有权由真实 onExit 解除。启动期间调用同样在此登记，启动完成即回收。
     * 只由 UI 会话 close/EOF 调用（不提供显式关闭入口）：调用方已先置 closed，排队中的
     * 旧请求会因 ownerOpen 为假而被拒，不会在关闭后重新拉起子进程。
     */
    void release(String ownerId) {
        BotHostProcess process;
        synchronized (lock) {
            Generation current = generation;
            if (current == null || !current.owner.equals(ownerId) || current.closing) return;
            current.closing = true;
            current.current = false;
            // 启动中可能仍为 null：onStarting 登记后由 acquire 的放弃分支统一回收。
            process = current.process;
        }
        closeQuietly(process);
    }

    // ---------- 单写者与懒启动 ----------

    private BotHostProcess acquire(String ownerId, BooleanSupplier ownerOpen) throws BridgeException {
        if (!ownerOpen.getAsBoolean()) throw new BridgeException("CANCELLED", "not-sent", "界面会话已关闭");
        synchronized (lock) {
            if (generation != null) {
                if (generation.current && !generation.closing && generation.owner.equals(ownerId)) {
                    return generation.process;
                }
                throw new BridgeException("BUSY", "not-sent", "客户端由其他界面会话占用或上一代未回收");
            }
            // 启动占位：从此刻起同目录的下一代一律 BUSY；release 也能在启动期间登记关闭。
            generation = new Generation(ownerId);
        }
        JSONObject init;
        try {
            init = clientInit();
        } catch (IOException failure) {
            clearReservation(ownerId);
            throw new BridgeException("LAUNCH_FAILED", "not-sent", "客户端目录不可用");
        }
        BotHostProcess launched = null;
        BridgeException launchError = null;
        try {
            // 只有显式首次进入客户端才创建 child（冷启动 HostPage 绝不触发）。
            launched = BotHostProcess.launch(context, init, listener).join();
        } catch (Throwable failure) {
            launchError = launchFailure(failure);
        }
        boolean discard;
        boolean sessionClosed;
        synchronized (lock) {
            Generation reserved = generation;
            if (launched == null && reserved != null) launched = reserved.process;
            sessionClosed = !ownerOpen.getAsBoolean();
            discard = launchError != null || reserved == null || launched == null
                    || reserved.closing || sessionClosed;
            if (reserved != null && discard) {
                reserved.closing = true;
                reserved.current = false;
                // 尚未创建任何进程（init 被拒）时没有需要保留的占有，否则等 onExit。
                if (reserved.process == null && generation == reserved) generation = null;
            } else if (reserved != null) {
                reserved.current = true;
            }
        }
        if (discard) {
            closeQuietly(launched);
            if (launchError != null) throw launchError;
            if (sessionClosed) throw new BridgeException("CANCELLED", "not-sent", "界面会话已关闭");
            throw new BridgeException("CLOSED", "not-sent", "客户端进程已结束");
        }
        return launched;
    }

    /** 未创建进程即失败的启动只撤销占位，不会留下需要回收的占有。 */
    private void clearReservation(String ownerId) {
        synchronized (lock) {
            if (generation != null && generation.process == null && generation.owner.equals(ownerId)) {
                generation = null;
            }
        }
    }

    private JSONObject clientInit() throws IOException {
        File root = new File(context.getFilesDir(), DATA_ROOT);
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建 bot-client 目录");
        try {
            return new JSONObject()
                    .put("type", "init")
                    .put("protocol", 1)
                    .put("mode", "client")
                    .put("dataRoot", root.getAbsolutePath());
        } catch (JSONException failure) {
            throw new IOException("客户端 init 帧构造失败");
        }
    }

    private final BotHostProcess.Listener listener = new BotHostProcess.Listener() {
        /** 进程一创建就登记占有：启动失败或被放弃也走同一受跟踪的关闭路径。 */
        @Override public void onStarting(BotHostProcess process) {
            synchronized (lock) {
                if (generation != null && generation.process == null) generation.process = process;
            }
        }

        @Override public void onReady(BotHostProcess process, JSONObject ready) {
            // ready 由 launch future 交付；client 模式没有额外绑定。
        }

        @Override public void onNativeFrame(BotHostProcess process, JSONObject frame) {
            // client 模式不派发 native 工具调用：意外帧一律忽略。
        }

        /** 唯一解除占有的地方：BotHostProcess 保证真实退出（或回收结果未知时推迟）后通知一次。 */
        @Override public void onExit(BotHostProcess process, int exitCode, boolean graceful) {
            synchronized (lock) {
                if (generation != null && generation.process == process) generation = null;
            }
        }
    };

    // ---------- 串行控制执行器 ----------

    private CompletableFuture<JSONObject> onControl(ControlTask task) {
        CompletableFuture<JSONObject> promise = new CompletableFuture<>();
        try {
            control.execute(() -> {
                CompletableFuture<JSONObject> inner;
                try {
                    inner = task.call();
                } catch (Throwable failure) {
                    promise.completeExceptionally(failure);
                    return;
                }
                inner.whenComplete((value, failure) -> {
                    if (failure != null) promise.completeExceptionally(failure);
                    else promise.complete(value);
                });
            });
        } catch (RejectedExecutionException busy) {
            promise.completeExceptionally(new BridgeException("BUSY", "not-sent", "客户端请求排队已满"));
        }
        return promise;
    }

    private interface ControlTask {
        CompletableFuture<JSONObject> call() throws Exception;
    }

    // ---------- 工具 ----------

    /** Node 固定返回 {value:&lt;broker 结果&gt;}；缺失/null 之外的结构一律按协议错误拒绝。 */
    private static JSONObject valueEnvelope(JSONObject envelope) {
        Object result = envelope == null ? null : envelope.opt("result");
        if (envelope != null && "result".equals(envelope.optString("type"))
                && result instanceof JSONObject value && value.has("value")) {
            return value;
        }
        throw new CompletionException(new BridgeException("PROTOCOL", "invalid", "客户端响应无效"));
    }

    private static BridgeException launchFailure(Throwable failure) {
        Throwable cause = failure;
        while ((cause instanceof CompletionException || cause instanceof ExecutionException)
                && cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        if (cause instanceof BridgeException) return (BridgeException) cause;
        if (cause instanceof IOException) return new BridgeException("LAUNCH_FAILED", "not-sent", "客户端启动失败");
        return new BridgeException("INTERNAL", "not-sent", "客户端启动失败");
    }

    private static CompletableFuture<JSONObject> failed(Throwable failure) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        future.completeExceptionally(failure);
        return future;
    }

    /** 只发起关闭（幂等、异步 cleanup）；确认退出由 onExit 通知，调用方不阻塞。 */
    private static void closeQuietly(BotHostProcess process) {
        if (process == null) return;
        try {
            process.close();
        } catch (Throwable ignored) {
        }
    }
}
