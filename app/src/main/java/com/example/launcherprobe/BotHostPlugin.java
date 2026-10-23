package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;

/** M15 Host UI 插件：只处理显式用户动作，不自动启动/重启 Host/Agent。 */
@CapacitorPlugin(name = "BotHost", permissions = {@Permission(alias = BotHostPlugin.MICROPHONE,
        strings = {Manifest.permission.RECORD_AUDIO})})
public final class BotHostPlugin extends Plugin {
    static final String MICROPHONE = "microphone";
    private static final int MAX_OBSERVATIONS = 8;

    private static final class ObservationRecord {
        final String id;
        volatile boolean closed;
        volatile BotHostManager.Observation handle;

        ObservationRecord(String id) {
            this.id = id;
        }
    }

    /** UI 先给 observationId 再 observe，避免初始帧与句柄竞态；容量上限 8。 */
    private final Map<String, ObservationRecord> observations = new HashMap<>();

    /** 语音/权限/捕获引用变更统一串行化到主线程，保证检查与清理原子顺序。 */
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    private volatile BotHostVoice captureVoice;
    private volatile String frozenBotId;
    private volatile String frozenRequestId;
    private volatile PluginCall pendingVoiceCall;
    private volatile String pendingVoiceBotId;
    private volatile String pendingVoiceRequestId;

    @Override public void load() {
        // 冷单例访问即可：不准备资产/不启动 Node/不拉起 FGS。
        BotHostManager.get(getContext());
    }

    private BotHostManager manager() {
        return BotHostManager.get(getContext());
    }

    // ---------- 状态与控制 ----------

    @PluginMethod public void snapshot(PluginCall call) {
        resolve(call, manager().snapshot());
    }

    @PluginMethod public void status(PluginCall call) {
        try {
            manager().status().whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    /** 显式前台动作：仅经 Service 入口启动，不直接调 Manager.start，不声称 ready。 */
    @PluginMethod public void start(PluginCall call) {
        try {
            if (getActivity() == null || getActivity().isFinishing()) {
                throw new IllegalStateException("仅可在前台启动 AI Host");
            }
            getActivity().runOnUiThread(() -> {
                if (getActivity() == null || getActivity().isFinishing()) {
                    reject(call, new IllegalStateException("仅可在前台启动 AI Host"));
                    return;
                }
                try {
                    BotHostService.startFromActivity(getActivity());
                    resolve(call, object("requested", true));
                } catch (RuntimeException failure) {
                    reject(call, failure);
                }
            });
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void stop(PluginCall call) {
        try {
            BotHostService.stopFromUser(getContext());
            resolve(call, object("requested", true));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    // ---------- 设置与凭据 ----------

    @PluginMethod public void settingsGet(PluginCall call) {
        try {
            manager().settingsGet().whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void settingsSet(PluginCall call) {
        try {
            JSONObject input = call.getObject("input");
            if (input == null) throw new IllegalArgumentException("input is required");
            manager().settingsSet(input).whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void saveCredentials(PluginCall call) {
        try {
            JSONObject aliases = call.getObject("aliases");
            if (aliases == null) aliases = new JSONObject();
            manager().saveCredentials(aliases).whenComplete((v, ex) -> {
                if (ex != null) reject(call, ex);
                else call.resolve(new JSObject());
            });
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    /** 固定控制调用：返回 Node 归一化完整结果信封，绝不隐式启动。 */
    @PluginMethod public void call(PluginCall call) {
        try {
            String method = required(call, "method");
            JSONObject params = call.getObject("params");
            manager().call(method, params).whenComplete((envelope, ex) -> complete(call, envelope, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    // ---------- 遗留导入（M16 显式用户动作；运行中走 Host 私有命令，离线走 settings 子进程） ----------

    @PluginMethod public void legacyList(PluginCall call) {
        try {
            String cursor = null;
            JSONObject data = call.getData();
            if (data.has("cursor") && !data.isNull("cursor")) {
                Object value = data.opt("cursor");
                if (!(value instanceof String)) throw new IllegalArgumentException("cursor 无效");
                cursor = (String) value;
            }
            int limit = 0;
            if (data.has("limit") && !data.isNull("limit")) {
                Object value = data.opt("limit");
                if (!(value instanceof Number)) throw new IllegalArgumentException("limit 无效");
                double number = ((Number) value).doubleValue();
                if (number != Math.floor(number) || number < 0 || number > 200) {
                    throw new IllegalArgumentException("limit 超出范围");
                }
                limit = (int) number;
            }
            manager().legacyList(cursor, limit).whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void legacyPreview(PluginCall call) {
        try {
            JSONObject input = new JSONObject()
                    .put("conversationId", required(call, "conversationId"))
                    .put("role", required(call, "role"))
                    .put("cwd", required(call, "cwd"))
                    .put("modelRef", required(call, "modelRef"));
            manager().legacyPreview(input).whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void legacyStatus(PluginCall call) {
        try {
            JSONObject input = new JSONObject().put("sourceKey", required(call, "sourceKey"));
            JSONObject data = call.getData();
            if (data.has("requestId")) {
                Object value = data.opt("requestId");
                if (!(value instanceof String)) throw new IllegalArgumentException("requestId 无效");
                input.put("requestId", value);
            }
            manager().legacyStatus(input).whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void legacyImport(PluginCall call) {
        try {
            JSONObject input = call.getObject("input");
            if (input == null) throw new IllegalArgumentException("input is required");
            manager().legacyImport(input).whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void legacyDraft(PluginCall call) {
        try {
            JSONObject input = new JSONObject()
                    .put("sourceKey", required(call, "sourceKey"))
                    .put("requestId", required(call, "requestId"));
            JSONObject data = call.getData();
            if (data.has("textOffset")) {
                Object value = data.opt("textOffset");
                if (value == null) value = JSONObject.NULL;
                input.put("textOffset", value);
            }
            if (data.has("attachmentOffset")) {
                Object value = data.opt("attachmentOffset");
                if (value == null) value = JSONObject.NULL;
                input.put("attachmentOffset", value);
            }
            manager().legacyDraft(input).whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void legacyDiscard(PluginCall call) {
        try {
            JSONObject input = new JSONObject()
                    .put("sourceKey", required(call, "sourceKey"))
                    .put("snapshotId", required(call, "snapshotId"));
            manager().legacyDiscard(input).whenComplete((payload, ex) -> complete(call, payload, ex));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    // ---------- 观察（宿主 UI 专用；断开不会停止 Host/Agent） ----------

    @PluginMethod public void observe(PluginCall call) {
        try {
            String observationId = required(call, "observationId");
            JSONObject target = call.getObject("target");
            if (target == null) throw new IllegalArgumentException("target is required");
            String kind = target.optString("kind");
            if (!"primary".equals(kind) && !"work".equals(kind)) {
                throw new IllegalArgumentException("target.kind 无效");
            }
            if (target.optString("botId").isEmpty()) throw new IllegalArgumentException("target.botId 无效");
            if ("work".equals(kind) && target.optString("scopeId").isEmpty()) {
                throw new IllegalArgumentException("target.scopeId 无效");
            }
            ObservationRecord record;
            synchronized (observations) {
                if (observations.size() >= MAX_OBSERVATIONS) throw new IllegalStateException("观察数已达上限");
                if (observations.containsKey(observationId)) throw new IllegalArgumentException("observationId 已存在");
                record = new ObservationRecord(observationId);
                observations.put(observationId, record);
            }
            manager().observe(target, frame -> onObservationFrame(record, frame), error -> onObservationError(record, error))
                    .whenComplete((handle, ex) -> {
                        if (ex != null) {
                            onObservationError(record, ex);
                            return;
                        }
                        boolean closeNow;
                        synchronized (observations) {
                            closeNow = record.closed;
                            if (!closeNow) record.handle = handle;
                        }
                        if (closeNow) closeQuietly(handle);
                    });
            resolve(call, object("observationId", observationId));
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void cancelObservation(PluginCall call) {
        try {
            closeQuietly(removeObservation(required(call, "observationId")));
            call.resolve(new JSObject());
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    private void onObservationFrame(ObservationRecord record, JSONObject frame) {
        boolean terminal;
        synchronized (observations) {
            if (record.closed || observations.get(record.id) != record) return;
            terminal = "end".equals(frame.optString("type"));
            if (terminal) {
                record.closed = true;
                observations.remove(record.id);
            }
        }
        JSObject event = new JSObject();
        event.put("observationId", record.id);
        event.put("frame", frame); // JSObject 继承 JSONObject，无需再转换（避免 checked JSONException）
        notifyListeners("hostFrame", event);
        if (terminal) closeQuietly(record.handle);
    }

    private void onObservationError(ObservationRecord record, Throwable error) {
        BotHostManager.Observation handle;
        synchronized (observations) {
            if (record.closed || observations.get(record.id) != record) return;
            record.closed = true;
            observations.remove(record.id);
            handle = record.handle;
        }
        JSObject event = new JSObject();
        event.put("observationId", record.id);
        event.put("error", errorObject(error));
        notifyListeners("hostFrame", event);
        closeQuietly(handle);
    }

    private BotHostManager.Observation removeObservation(String observationId) {
        synchronized (observations) {
            ObservationRecord record = observations.remove(observationId);
            if (record == null) return null;
            record.closed = true;
            return record.handle;
        }
    }

    private void closeAllObservations() {
        List<ObservationRecord> records;
        synchronized (observations) {
            records = new ArrayList<>(observations.values());
        }
        // 复用 onObservationError 终态（锁外），客户端收错误事件并移除注册，后端 end 不丢。
        BotHostProcess.BridgeException paused =
                new BotHostProcess.BridgeException("CANCELLED", "responded", "页面暂停，观察已结束");
        for (ObservationRecord record : records) onObservationError(record, paused);
    }

    private static void closeQuietly(BotHostManager.Observation handle) {
        if (handle == null) return;
        try {
            handle.close();
        } catch (Throwable ignored) {
        }
    }

    // ---------- 语音（显式本地用户动作；最终转录原生提交一次） ----------

    @PluginMethod public void voiceSettings(PluginCall call) {
        try {
            resolve(call, manager().voice().getSettings());
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void saveVoiceSettings(PluginCall call) {
        try {
            JSONObject input = call.getObject("settings");
            if (input == null) throw new IllegalArgumentException("settings is required");
            manager().voice().saveSettings(input);
            call.resolve(new JSObject());
        } catch (Exception exception) {
            reject(call, exception);
        }
    }

    @PluginMethod public void startVoice(PluginCall call) {
        main.post(() -> {
            try {
                String botId = required(call, "botId");
                String requestId = required(call, "requestId");
                if (!foregroundUi()) {
                    throw new IllegalStateException("仅可在前台开始语音输入");
                }
                rejectPendingVoice("语音输入请求已取消", "CANCELLED"); // 明确拒绝旧 pending permission
                cancelActiveCapture();
                if (!microphoneGranted()) {
                    pendingVoiceCall = call;
                    pendingVoiceBotId = botId;
                    pendingVoiceRequestId = requestId;
                    requestPermissionForAlias(MICROPHONE, call, "micPermission");
                    return;
                }
                beginCapture(botId, requestId);
                call.resolve(new JSObject());
            } catch (Exception exception) {
                reject(call, exception);
            }
        });
    }

    @PermissionCallback private void micPermission(PluginCall call) {
        // 权限回调可能早于 MainActivity.onResume 复位 resumed()：推迟一个主线程轮次再判，
        // 届时仍必须 pendingVoiceCall==call 且真实前台，才允许开始捕获。
        main.post(() -> {
            if (pendingVoiceCall != call) return; // 旧 callback：不误清新请求（try 外早退）
            try {
                if (!foregroundUi()) {
                    rejectPendingVoice("语音输入已取消", "CANCELLED");
                    return;
                }
                if (microphoneGranted()) {
                    String botId = pendingVoiceBotId;
                    String requestId = pendingVoiceRequestId;
                    clearPendingVoice();
                    beginCapture(botId, requestId);
                    call.resolve(new JSObject());
                } else {
                    clearPendingVoice();
                    call.reject("需要麦克风权限才能语音输入", "PERMISSION_DENIED");
                }
            } catch (Exception exception) {
                // 进入 try 即持有本 call 的处理权：无条件 reject 此 call，避免悬空；
                // 仅当 pending 仍匹配时才清理，不可清新 pending。
                if (pendingVoiceCall == call) clearPendingVoice();
                reject(call, exception);
            }
        });
    }

    @PluginMethod public void finishVoice(PluginCall call) {
        main.post(() -> {
            try {
                BotHostVoice voice = captureVoice;
                if (voice != null) voice.finishInput();
                call.resolve(new JSObject());
            } catch (Exception exception) {
                reject(call, exception);
            }
        });
    }

    @PluginMethod public void cancelVoice(PluginCall call) {
        main.post(() -> {
            try {
                rejectPendingVoice("语音输入已取消", "CANCELLED");
                cancelActiveCapture();
                call.resolve(new JSObject());
            } catch (Exception exception) {
                reject(call, exception);
            }
        });
    }

    private void beginCapture(String botId, String requestId) {
        if (botId == null || requestId == null) return;
        final BotHostVoice voice = manager().voice();
        captureVoice = voice;
        frozenBotId = botId;
        frozenRequestId = requestId;
        voice.startInput(botId, requestId, new BotHostVoice.InputListener() {
            @Override public void onPartial(String text) {
                main.post(() -> {
                    // 旧捕获的迟到回调不得发给新捕获，也不得清除新引用。
                    if (!isCurrentCapture(voice, botId, requestId)) return;
                    emitVoiceEvent("partial", botId, requestId, text, null, null, null, null);
                });
            }

            @Override public void onResult(String capturedBotId, String capturedRequestId, String text) {
                main.post(() -> {
                    if (!isCurrentCapture(voice, botId, requestId)) return;
                    if (!capturedBotId.equals(botId) || !capturedRequestId.equals(requestId)) return;
                    clearCaptureRefs();
                    submitTranscript(text, botId, requestId);
                });
            }

            @Override public void onError(String message) {
                main.post(() -> {
                    if (!isCurrentCapture(voice, botId, requestId)) return;
                    emitVoiceEvent("error", botId, requestId, null, null, null, null, message);
                    clearCaptureRefs();
                });
            }
        });
    }

    /** 仅当前冻结捕获（同一 Voice 实例且双 id 匹配）才接受回调。 */
    private boolean isCurrentCapture(BotHostVoice voice, String botId, String requestId) {
        return voice == captureVoice && botId.equals(frozenBotId) && requestId.equals(frozenRequestId);
    }

    /** 唯一一次原生提交：Node call schema 权威（submit 参数读取自 remote-control-protocol.js）。 */
    private void submitTranscript(String text, String botId, String requestId) {
        try {
            JSONObject params = new JSONObject()
                    .put("botId", botId)
                    .put("requestId", requestId)
                    .put("text", text);
            manager().call("submit", params).whenComplete((envelope, ex) -> {
                if (ex != null) {
                    // 保留冻结请求与文本供显式对账，不自动重试。
                    emitVoiceEvent("error", botId, requestId, text, null, errorCode(ex), errorOutcome(ex), safeMessage(ex));
                } else {
                    Object receipt = envelope.has("result") ? envelope.opt("result") : null;
                    emitVoiceEvent("submitted", botId, requestId, null, receipt, null, null, null);
                }
            });
        } catch (Exception exception) {
            emitVoiceEvent("error", botId, requestId, text, null, errorCode(exception), errorOutcome(exception), safeMessage(exception));
        }
    }

    private void emitVoiceEvent(String type, String botId, String requestId, String text,
                                Object receipt, String code, String outcome, String message) {
        JSObject event = new JSObject();
        event.put("type", type);
        event.put("botId", botId);
        event.put("requestId", requestId);
        if (text != null) event.put("text", text);
        if (receipt != null) event.put("receipt", receipt);
        if (code != null) event.put("code", code);
        if (outcome != null) event.put("outcome", outcome);
        if (message != null) event.put("message", message);
        notifyListeners("voiceEvent", event);
    }

    private void cancelActiveCapture() {
        BotHostVoice voice = captureVoice;
        if (voice != null) voice.cancelInput();
        clearCaptureRefs();
    }

    private void clearCaptureRefs() {
        captureVoice = null;
        frozenBotId = null;
        frozenRequestId = null;
    }

    private void clearPendingVoice() {
        pendingVoiceCall = null;
        pendingVoiceBotId = null;
        pendingVoiceRequestId = null;
    }

    private void rejectPendingVoice(String message, String code) {
        PluginCall call = pendingVoiceCall;
        clearPendingVoice();
        if (call != null) call.reject(message, code);
    }

    // ---------- 生命周期（只取消本插件的输入/观察，不动持久 Host 与旧语音） ----------

    @Override protected void handleOnPause() {
        // 权限回调内部重新校验前台，因此被系统权限对话框暂停时保留 pending；
        // 仅在回调/销毁时拒绝，避免后台 beginCapture。
        cancelActiveCapture();
        closeAllObservations();
    }

    @Override protected void handleOnDestroy() {
        rejectPendingVoice("语音输入已取消", "CANCELLED"); // 拒绝未完成的 PluginCall
        cancelActiveCapture();
        closeAllObservations();
    }

    private boolean microphoneGranted() {
        return getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** 真实前台生命周期 guard：Activity 必须处于 resumed 且未 finishing/destroyed。 */
    private boolean foregroundUi() {
        Activity activity = getActivity();
        return activity != null && activity instanceof MainActivity
                && MainActivity.resumed() == activity && !activity.isFinishing() && !activity.isDestroyed();
    }

    // ---------- 工具 ----------

    private static String required(PluginCall call, String name) {
        String value = call.getString(name);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(name + " is required");
        return value;
    }

    private static JSObject object(Object... values) {
        JSObject result = new JSObject();
        try {
            for (int i = 0; i < values.length; i += 2) result.put(String.valueOf(values[i]), values[i + 1]);
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
        return result;
    }

    private static void resolve(PluginCall call, JSONObject value) {
        try {
            call.resolve(JSObject.fromJSONObject(value));
        } catch (Exception exception) {
            reject(call, exception); // 转换失败应 reject，不让异步回调悬空
        }
    }

    private static void complete(PluginCall call, JSONObject payload, Throwable ex) {
        if (ex != null) reject(call, ex);
        else resolve(call, payload);
    }

    private static void reject(PluginCall call, Throwable failure) {
        Throwable t = unwrap(failure);
        String message = safeMessage(t);
        String code = errorCode(t);
        String outcome = errorOutcome(t);
        if (outcome != null) {
            // Capacitor reject 支持 JSObject data：以 data 携带固定 outcome，不透传任意 cause。
            JSObject data = new JSObject();
            data.put("outcome", outcome);
            call.reject(message, code, null, data);
        } else if (code != null) {
            call.reject(message, code);
        } else {
            call.reject(message);
        }
    }

    private static String errorCode(Throwable failure) {
        Throwable t = unwrap(failure);
        if (t instanceof BotHostProcess.BridgeException bridge) return bridge.code;
        return null;
    }

    private static String errorOutcome(Throwable failure) {
        Throwable t = unwrap(failure);
        if (t instanceof BotHostProcess.BridgeException bridge) return bridge.outcome;
        return null;
    }

    private static String safeMessage(Throwable failure) {
        Throwable t = unwrap(failure);
        String message = t.getMessage();
        if (message == null || message.trim().isEmpty()) return "操作失败";
        // 仅透出有界 Bridge 消息与受控业务异常；其余保持通用，避免泄露内部细节/凭据。
        if (t instanceof BotHostProcess.BridgeException) {
            return message.length() > 512 ? message.substring(0, 512) : message;
        }
        if (t instanceof IllegalArgumentException || t instanceof IllegalStateException) {
            return message;
        }
        return "操作失败";
    }

    /** 解包 CompletableFuture 包装（CompletionException/ExecutionException），保留内部 code/outcome。 */
    private static Throwable unwrap(Throwable failure) {
        Throwable current = failure;
        while (current instanceof CompletionException || current instanceof ExecutionException) {
            Throwable cause = current.getCause();
            if (cause == null || cause == current) break;
            current = cause;
        }
        return current;
    }

    private static JSObject errorObject(Throwable failure) {
        Throwable t = unwrap(failure);
        JSObject error = new JSObject();
        String code = errorCode(t);
        error.put("code", code != null ? code : "INTERNAL");
        String outcome = errorOutcome(t);
        if (outcome != null) error.put("outcome", outcome);
        error.put("message", safeMessage(t));
        return error;
    }
}
