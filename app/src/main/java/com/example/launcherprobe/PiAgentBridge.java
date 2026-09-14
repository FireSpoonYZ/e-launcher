package com.example.launcherprobe;

import android.content.Context;
import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/** One-process Node/pi agent, with a randomized abstract socket and same-process peer check. */
final class PiAgentBridge {
    interface Listener { void event(JSONObject event); }
    private static PiAgentBridge instance;
    private static boolean attempted;
    private final LocalSocket socket;
    private final OutputStreamWriter writer;
    private final Map<String, Request> requests = new HashMap<>();
    private final Map<String, ShowerCall> showerCalls = new HashMap<>();
    private final ExecutorService nativeWorker = Executors.newFixedThreadPool(4);
    private final ShowerToolBridge showerTools;
    private final AppCatalog appCatalog;
    private boolean closed;

    static synchronized PiAgentBridge get(Context context) throws Exception {
        if (instance != null) return instance;
        if (attempted) throw new IllegalStateException("pi 启动曾失败，请重新启动应用进程");
        // Node cannot be restarted in the same process, even if bridge construction failed.
        attempted = true;
        instance = new PiAgentBridge(context.getApplicationContext());
        return instance;
    }

    static synchronized void forgetConversation(String conversationId) {
        PiAgentBridge bridge = instance;
        if (bridge == null) return;
        synchronized (bridge) {
            if (!bridge.closed) {
                bridge.nativeWorker.execute(() -> bridge.showerTools.forgetConversation(conversationId));
            }
        }
    }

    private PiAgentBridge(Context context) throws Exception {
        showerTools = new ShowerToolBridge(context);
        appCatalog = new AppCatalog(context);
        System.loadLibrary("node");
        System.loadLibrary("launcher_node");
        File home = new File(context.getFilesDir(), "node");
        if (!home.isDirectory() && !home.mkdirs()) throw new IllegalStateException("无法创建 Node 私有目录");
        prepareNpm(context, home);
        File script = new File(home, "pi-runtime.cjs");
        try (java.io.InputStream in = context.getAssets().open("pi-runtime.cjs");
             FileOutputStream out = new FileOutputStream(script)) {
            byte[] buffer = new byte[16_384];
            for (int count; (count = in.read(buffer)) >= 0;) out.write(buffer, 0, count);
        }
        copyAssets(context, "pi-sdk", new File(home, "pi-sdk"));
        String endpoint = "e-launcher-pi-" + UUID.randomUUID();
        CountDownLatch ready = new CountDownLatch(1);
        final LocalSocket[] accepted = new LocalSocket[1];
        final boolean[] waiting = {true};
        boolean initialized = false;
        try {
        try (LocalServerSocket server = new LocalServerSocket(endpoint)) {
            Thread accept = new Thread(() -> {
                try {
                    while (true) {
                        LocalSocket peer = server.accept();
                        boolean keep = false;
                        try {
                            Credentials credentials = peer.getPeerCredentials();
                            if (credentials.getUid() != android.os.Process.myUid()
                                    || credentials.getPid() != android.os.Process.myPid()) continue;
                            synchronized (accepted) {
                                if (waiting[0]) { accepted[0] = peer; keep = true; }
                            }
                            return;
                        } finally {
                            if (!keep) peer.close();
                        }
                    }
                } catch (Exception ignored) {
                    // Closing the server also releases a timed-out/interrupted accept.
                } finally { ready.countDown(); }
            }, "pi-node-accept");
            accept.setDaemon(true);
            accept.start();
            try {
                startNode(script.getAbsolutePath(), "@" + endpoint, home.getAbsolutePath());
                if (!ready.await(15, TimeUnit.SECONDS) || accepted[0] == null) {
                    throw new IllegalStateException("pi Node 启动超时");
                }
                socket = accepted[0];
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw exception;
            } finally {
                synchronized (accepted) {
                    waiting[0] = false;
                }
            }
        }
        writer = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
        Thread reader = new Thread(this::readEvents, "pi-node-events");
        reader.setDaemon(true);
        reader.start();
        initialized = true;
        } finally {
            if (!initialized) synchronized (accepted) {
                waiting[0] = false;
                if (accepted[0] != null) accepted[0].close();
            }
        }
    }

    static void copyAssets(Context context, String source, File target) throws Exception {
        String[] entries = context.getAssets().list(source);
        if (entries != null && entries.length > 0) {
            if (!target.isDirectory() && !target.mkdirs()) throw new IllegalStateException("无法创建 Pi 资源目录");
            for (String entry : entries) copyAssets(context, source + "/" + entry, new File(target, entry));
        } else {
            try (java.io.InputStream input = context.getAssets().open(source);
                 FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[16_384];
                for (int count; (count = input.read(buffer)) >= 0;) output.write(buffer, 0, count);
            }
        }
    }

    static void prepareNpm(Context context, File home) throws Exception {
        String version = "11.6.2";
        File root = new File(home, "npm"), target = new File(root, version);
        if (!new File(target, "payload-complete.txt").isFile() || !new File(target, "bin/npm-cli.js").isFile()) {
            File temporary = new File(root, "." + version + "-installing");
            deleteTree(temporary);
            try {
                copyAssets(context, "npm/" + version, temporary);
                if (!new File(temporary, "payload-complete.txt").isFile() || !new File(temporary, "bin/npm-cli.js").isFile())
                    throw new IllegalStateException("内置 npm 资源不完整");
                deleteTree(target);
                if (!temporary.renameTo(target)) throw new IllegalStateException("无法启用内置 npm");
            } catch (Exception exception) {
                deleteTree(temporary);
                throw exception;
            }
        }
        File bin = new File(home, "bin");
        if (!bin.isDirectory() && !bin.mkdirs()) throw new IllegalStateException("无法创建 Node 命令目录");
        File launcher = new File(context.getApplicationInfo().nativeLibraryDir, "libnode_launcher.so");
        if (!launcher.isFile()) throw new IllegalStateException("内置 Node 启动器缺失");
        File node = new File(bin, "node");
        // APK replacement changes nativeLibraryDir; Files.exists without following links
        // also finds the dangling entry left after Android removes the old installation.
        if (java.nio.file.Files.exists(node.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)
                && !node.getCanonicalFile().equals(launcher.getCanonicalFile())) java.nio.file.Files.delete(node.toPath());
        if (!node.exists()) android.system.Os.symlink(launcher.getAbsolutePath(), node.getAbsolutePath());
    }

    private static void deleteTree(File file) throws Exception {
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        if (!file.delete()) throw new IllegalStateException("无法清理未完成的 npm 资源");
    }

    synchronized void prompt(String id, String conversationId, String config, String text,
            List<ChatAttachment> attachments, String sdkHistory, List<AgentLoop.Message> history,
            PiConfigStore configStore, Listener nextListener) throws Exception {
        JSONArray converted = ChatStore.piHistory(history);
        JSONObject command = new JSONObject().put("type", "prompt").put("id", id)
                .put("conversationId", conversationId).put("sdk", true)
                .put("config", new JSONObject(config).put("bundledShower", true))
                .put("history", converted).put("prompt", text)
                .put("attachments", AttachmentStore.json(attachments));
        if (sdkHistory != null) {
            JSONObject resume = new JSONObject(sdkHistory);
            command.put("sdkHistory", resume.getJSONArray("entries")).put("sdkHistoryTail", resume.getJSONArray("tail"));
        }
        sendRequest(command, configStore, nextListener);
    }

    synchronized String query(String type, String config, JSONObject arguments, PiConfigStore configStore,
            Listener nextListener) throws Exception {
        arguments.put("id", UUID.randomUUID().toString()).put("type", type).put("config", new JSONObject(config));
        sendRequest(arguments, configStore, nextListener);
        return arguments.getString("id");
    }

    private synchronized void sendRequest(JSONObject command, PiConfigStore configStore,
            Listener nextListener) throws Exception {
        if (closed) throw new IllegalStateException("Pi 连接已关闭，请重新启动应用进程");
        String id = command.getString("id");
        if (requests.containsKey(id)) throw new IllegalStateException("Pi 请求 ID 重复");
        requests.put(id, new Request(configStore, nextListener, command.optString("conversationId", null)));
        try {
            write(command);
        } catch (Exception exception) {
            fail("pi 请求发送失败");
            throw exception;
        }
    }

    synchronized void replyAuth(String id, String promptId, String value, boolean cancelled) throws Exception {
        if (closed || id == null || !requests.containsKey(id)) throw new IllegalStateException("登录请求已结束");
        write(new JSONObject().put("type", "auth_reply").put("id", id).put("promptId", promptId)
                .put("value", value).put("cancelled", cancelled));
    }

    synchronized void abort(String id) {
        if (closed || id == null || !requests.containsKey(id)) return;
        cancelShowerCalls(id);
        try { write(new JSONObject().put("type", "abort").put("id", id)); }
        catch (Exception exception) { fail("pi 取消请求发送失败"); }
    }

    private void write(JSONObject value) throws Exception {
        writer.write(value.toString()); writer.write('\n'); writer.flush();
    }

    private void readEvents() {
        try (BufferedReader input = new BufferedReader(new InputStreamReader(
                socket.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = input.readLine()) != null;) {
                JSONObject event = new JSONObject(line);
                String type = event.optString("type");
                if ("shower_request".equals(type)) {
                    handleShowerRequest(event);
                    continue;
                }
                if ("shower_cancel".equals(type)) {
                    cancelShowerCall(event.optString("callId"));
                    continue;
                }
                if ("apps_request".equals(type)) {
                    handleAppsRequest(event);
                    continue;
                }
                synchronized (this) {
                    if (closed) continue;
                    String id = event.optString("id");
                    Request request = requests.get(id);
                    if (request == null) continue;
                    Listener current = request.listener;
                    if ("credential".equals(event.optString("type"))) {
                        try {
                            request.configStore.updateCredential(event.getString("providerId"),
                                    event.isNull("value") ? null : event.getJSONObject("value").toString(),
                                    event.isNull("previous") ? null : event.getJSONObject("previous").toString());
                        } catch (Exception exception) {
                            current.event(new JSONObject().put("id", id).put("type", "error")
                                    .put("message", "凭据刷新未保存：" + exception.getMessage()));
                        }
                        continue;
                    }
                    if ("setting".equals(event.optString("type"))) {
                        try {
                            request.configStore.updateSetting(event.optBoolean("project"), event.getString("key"),
                                    event.get("value").toString(), event.get("previous").toString());
                        } catch (Exception exception) {
                            current.event(new JSONObject().put("id", id).put("type", "error")
                                    .put("message", "配置未保存：" + exception.getMessage()));
                        }
                        continue;
                    }
                    if ("end".equals(type)) {
                        requests.remove(id);
                        cancelShowerCalls(id);
                    }
                    current.event(event);
                }
            }
        } catch (Exception ignored) {
            // EOF and read failures have the same terminal semantics.
        } finally { fail("pi Node 连接已结束，请重新启动应用进程"); }
    }

    private synchronized void handleShowerRequest(JSONObject event) {
        String requestId = event.optString("id");
        String callId = event.optString("callId");
        JSONObject arguments = event.optJSONObject("arguments");
        if (requestId.isEmpty() || callId.isEmpty()) return;
        Request request = requests.get(requestId);
        if (closed || request == null || showerCalls.containsKey(callId)) return;
        // Never accept a conversation/display owner from model-supplied tool arguments.
        String conversationId = request.conversationId;
        ShowerCall call = new ShowerCall(requestId);
        FutureTask<Void> task = new FutureTask<>(() -> {
            JSONObject response = new JSONObject().put("type", "shower_response")
                    .put("id", requestId).put("callId", callId);
            try {
                response.put("result", showerTools.execute(conversationId, arguments));
            } catch (Exception exception) {
                response.put("error", exception.getMessage() == null
                        ? exception.getClass().getSimpleName() : exception.getMessage());
            }
            synchronized (PiAgentBridge.this) {
                ShowerCall current = showerCalls.get(callId);
                if (current != call || closed || !requests.containsKey(requestId)) return null;
                showerCalls.remove(callId);
                try { write(response); }
                catch (Exception exception) { fail("Shower 工具结果发送失败"); }
            }
            return null;
        });
        call.task = task;
        showerCalls.put(callId, call);
        nativeWorker.execute(task);
    }

    private synchronized void handleAppsRequest(JSONObject event) {
        String requestId = event.optString("id");
        String callId = event.optString("callId");
        JSONObject arguments = event.optJSONObject("arguments");
        if (closed || requestId.isEmpty() || callId.isEmpty() || !requests.containsKey(requestId)) return;
        nativeWorker.execute(new FutureTask<Void>(() -> {
            JSONObject response = new JSONObject().put("type", "apps_response")
                    .put("id", requestId).put("callId", callId);
            try {
                response.put("result", appCatalog.execute(arguments));
            } catch (Exception exception) {
                response.put("error", exception.getMessage() == null
                        ? exception.getClass().getSimpleName() : exception.getMessage());
            }
            synchronized (PiAgentBridge.this) {
                if (closed || !requests.containsKey(requestId)) return null;
                try { write(response); }
                catch (Exception exception) { fail("应用查询结果发送失败"); }
            }
            return null;
        }));
    }

    private synchronized void cancelShowerCall(String callId) {
        ShowerCall call = showerCalls.remove(callId);
        if (call != null) call.task.cancel(true);
    }

    private synchronized void cancelShowerCalls(String requestId) {
        java.util.Iterator<Map.Entry<String, ShowerCall>> iterator = showerCalls.entrySet().iterator();
        while (iterator.hasNext()) {
            ShowerCall call = iterator.next().getValue();
            if (requestId.equals(call.requestId)) {
                iterator.remove();
                call.task.cancel(true);
            }
        }
    }

    private synchronized void fail(String message) {
        if (closed) return;
        closed = true;
        for (ShowerCall call : showerCalls.values()) call.task.cancel(true);
        showerCalls.clear();
        showerTools.shutdown();
        nativeWorker.shutdownNow();
        try { socket.close(); } catch (Exception ignored) { }
        Map<String, Request> failed = new HashMap<>(requests);
        requests.clear();
        for (Map.Entry<String, Request> item : failed.entrySet()) try {
            item.getValue().listener.event(new JSONObject().put("id", item.getKey()).put("type", "error")
                    .put("message", message));
            item.getValue().listener.event(new JSONObject().put("id", item.getKey()).put("type", "end")
                    .put("status", "error"));
        } catch (Exception ignored) { }
    }

    private static final class ShowerCall {
        final String requestId;
        FutureTask<Void> task;
        ShowerCall(String requestId) { this.requestId = requestId; }
    }

    private static final class Request {
        final PiConfigStore configStore;
        final Listener listener;
        final String conversationId;
        Request(PiConfigStore configStore, Listener listener, String conversationId) {
            this.configStore = configStore;
            this.listener = listener;
            this.conversationId = conversationId;
        }
    }

    private static native void startNode(String script, String socket, String home);
}
