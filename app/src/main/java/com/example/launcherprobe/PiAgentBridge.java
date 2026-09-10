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
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** One-process Node/pi agent, with a randomized abstract socket and same-process peer check. */
final class PiAgentBridge {
    interface Listener { void event(JSONObject event); }
    private static PiAgentBridge instance;
    private static boolean attempted;
    private final LocalSocket socket;
    private final OutputStreamWriter writer;
    private Listener listener;
    private String requestId;
    private boolean closed;

    static synchronized PiAgentBridge get(Context context) throws Exception {
        if (instance != null) return instance;
        if (attempted) throw new IllegalStateException("pi 启动曾失败，请重新启动应用进程");
        // Node cannot be restarted in the same process, even if bridge construction failed.
        attempted = true;
        instance = new PiAgentBridge(context.getApplicationContext());
        return instance;
    }

    private PiAgentBridge(Context context) throws Exception {
        System.loadLibrary("node");
        System.loadLibrary("launcher_node");
        File home = new File(context.getFilesDir(), "node");
        if (!home.isDirectory() && !home.mkdirs()) throw new IllegalStateException("无法创建 Node 私有目录");
        File script = new File(home, "pi-runtime.cjs");
        try (java.io.InputStream in = context.getAssets().open("pi-runtime.cjs");
             FileOutputStream out = new FileOutputStream(script)) {
            byte[] buffer = new byte[16_384];
            for (int count; (count = in.read(buffer)) >= 0;) out.write(buffer, 0, count);
        }
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

    synchronized void prompt(String id, String baseUrl, String apiKey, String model, String text,
            List<AgentLoop.Message> history, Listener nextListener) throws Exception {
        if (closed) throw new IllegalStateException("pi 连接已关闭，请重新启动应用进程");
        if (listener != null) throw new IllegalStateException("pi 正在结束上一轮请求，请稍后重试");
        JSONArray converted = new JSONArray();
        for (AgentLoop.Message message : history) {
            if ("system".equals(message.role)) continue;
            if ((!"user".equals(message.role) && !"assistant".equals(message.role))
                    || !message.toolCalls.isEmpty() || message.content == null) {
                throw new IllegalStateException("pi 文本模式使用纯文本历史；当前对话含工具消息，请新建对话或切回工具模式。");
            }
            converted.put(new JSONObject().put("role", message.role).put("content", message.content));
        }
        listener = nextListener;
        requestId = id;
        try {
            write(new JSONObject().put("type", "prompt").put("id", id).put("baseUrl", baseUrl)
                    .put("apiKey", apiKey).put("modelId", model).put("history", converted).put("prompt", text));
        } catch (Exception exception) {
            fail("pi 请求发送失败");
            throw exception;
        }
    }

    synchronized void abort(String id) {
        if (closed || id == null || !id.equals(requestId)) return;
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
                synchronized (this) {
                    if (closed || requestId == null || !requestId.equals(event.optString("id"))) continue;
                    Listener current = listener;
                    if ("end".equals(event.optString("type"))) { listener = null; requestId = null; }
                    if (current != null) current.event(event);
                }
            }
        } catch (Exception ignored) {
            // EOF and read failures have the same terminal semantics.
        } finally { fail("pi Node 连接已结束，请重新启动应用进程"); }
    }

    private synchronized void fail(String message) {
        if (closed) return;
        closed = true;
        try { socket.close(); } catch (Exception ignored) { }
        Listener current = listener;
        String id = requestId;
        listener = null; requestId = null;
        if (current != null) try {
            current.event(new JSONObject().put("id", id).put("type", "error").put("message", message));
            current.event(new JSONObject().put("id", id).put("type", "end").put("status", "error"));
        } catch (Exception ignored) { }
    }

    private static native void startNode(String script, String socket, String home);
}
