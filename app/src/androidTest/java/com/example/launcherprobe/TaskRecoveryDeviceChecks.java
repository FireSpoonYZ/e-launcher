package com.example.launcherprobe;

import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Two processes, synthetic pending data only. Never sends a prompt or executes an external tool. */
final class TaskRecoveryDeviceChecks {
    private static final String PREFIX = "instrumentation_task_recovery_";
    private static final String DRAFT = "Preserve this unsent recovery draft";
    private static final String ATTACHMENT_TEXT = "Synthetic attachment; no secrets or user data";

    static String run(Instrumentation test, String phase) throws Exception {
        Context context = isolated(test.getTargetContext());
        SharedPreferences metadata = context.getSharedPreferences("fixture", Context.MODE_PRIVATE);
        assertRuntimeIdle();
        if ("task-recovery-seed".equals(phase)) return seed(context, metadata);
        require(metadata.getBoolean("seeded", false), "Run task-recovery-seed first");
        int seedPid = metadata.getInt("pid", -1);
        require(seedPid != android.os.Process.myPid(), "A fresh OS process is required; force-stop between phases");
        String id = metadata.getString("conversation", ""), leaf = metadata.getString("leaf", "");
        ChatStore store = new ChatStore(context);
        require("running".equals(context.getSharedPreferences("chat", 0).getString("run_status_" + id, "")),
                "seeded running marker survived the process boundary");
        require(field(ChatCoordinator.class, "instance") == null, "coordinator must be fresh before verification");
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        JSONObject snapshot = coordinator.snapshot();
        require(!snapshot.getBoolean("running") && snapshot.getJSONArray("activeRuns").length() == 0, "no task restarted");
        require("interrupted".equals(snapshot.getJSONObject("execution").getString("phase")), "interruption surfaced");
        require(snapshot.getJSONObject("recovery").getBoolean("needed"), "explicit recovery required");
        require("synthetic_side_effect".equals(snapshot.getJSONObject("execution").getString("toolName")), "last tool preserved");
        assertFixtureUnchanged(store, metadata, context);
        assertRuntimeIdle();

        List<AgentLoop.Message> interrupted = new ArrayList<>(store.load(id));
        coordinator.prepareRecovery(id, leaf);
        require(!coordinator.running(id) && coordinator.snapshot().getJSONObject("recovery").getBoolean("prepared"),
                "preparation remains idle");
        assertFixtureUnchanged(store, metadata, context);
        assertRuntimeIdle();
        JSONObject resume = new JSONObject(store.piResume(id, interrupted, true));
        require(resume.getJSONArray("entries").toString().contains("fixture-checkpoint"), "last native checkpoint retained");
        String tail = resume.getJSONArray("tail").toString();
        require(tail.contains("历史工具调用（未重新执行）") && tail.contains("synthetic_side_effect"),
                "uncertain tool tail is inert history");
        for (int i = 0; i < resume.getJSONArray("tail").length(); i++)
            require(!resume.getJSONArray("tail").getJSONObject(i).has("tool_calls"), "no executable historical call queue");

        store.selectNode(id, "fixture-checkpoint");
        require(!store.needsRecovery(id), "complete ancestor remains usable");
        boolean rejected = false;
        try { store.piResume(id, interrupted, true); }
        catch (IllegalStateException expected) { rejected = true; }
        require(rejected, "a grant cannot follow a different selected branch");
        store.selectNode(id, leaf);
        require(store.needsRecovery(id), "interrupted branch still retains its pending marker");
        assertFixtureUnchanged(store, metadata, context);
        assertRuntimeIdle();

        // Cleanup is confined to the dedicated prefix/files directory; never clear real app chat/config.
        store.clear(id);
        context.getSharedPreferences("chat", 0).edit().clear().commit();
        metadata.edit().clear().commit();
        return "PASS: fresh process " + seedPid + " -> " + android.os.Process.myPid()
                + "; interruption, no Node/FGS/task startup, explicit idle preparation, draft/attachment/history and branch checks."
                + " Synthetic pending data; not a live external-tool interruption.";
    }

    private static String seed(Context context, SharedPreferences metadata) throws Exception {
        require(!metadata.getBoolean("seeded", false), "Verify the existing fixture before seeding another");
        context.getSharedPreferences("chat", 0).edit().clear().commit(); // Dedicated test namespace only.
        ChatStore store = new ChatStore(context);
        String id = store.activeId();
        List<AgentLoop.Message> path = new ArrayList<>();
        path.add(message("fixture-initial-user", "user", "Synthetic completed request"));
        path.add(message("fixture-checkpoint", "assistant", "Synthetic completed response"));
        store.save(id, path);
        store.savePiContext("fixture-checkpoint", new JSONArray()
                .put(new JSONObject().put("type", "session").put("version", 3).put("id", "fixture-checkpoint"))
                .put(new JSONObject().put("type", "session_info").put("name", "fixture-checkpoint")));
        path.add(message("fixture-pending-user", "user", "Synthetic request; no external action is executed"));
        store.save(id, path);
        PiTurnPersistence turn = new PiTurnPersistence(store, id, "fixture-pending-user", "fixture-pending-assistant", path);
        turn.accept(new JSONObject().put("type", "message").put("message", new JSONObject()
                .put("role", "assistant").put("content", "").put("toolCalls", new JSONArray().put(new JSONObject()
                .put("id", "fixture-call").put("name", "synthetic_side_effect").put("arguments", "{}")))));
        turn.accept(new JSONObject().put("type", "tool_start").put("toolCallId", "fixture-call").put("name", "synthetic_side_effect"));
        turn.accept(new JSONObject().put("type", "text_delta").put("delta", "Synthetic partial output"));
        turn.savePreview();
        store.saveDraft(id, DRAFT);
        File root = new File(context.getFilesDir(), "chat-attachments"); root.mkdirs();
        String attachmentId = "00000000-0000-4000-8000-000000000001";
        File file = new File(root, attachmentId);
        Files.write(file.toPath(), ATTACHMENT_TEXT.getBytes(StandardCharsets.UTF_8));
        store.saveDraftAttachments(id, List.of(ChatAttachment.fromJson(new JSONObject().put("id", attachmentId)
                .put("name", "fixture.txt").put("mimeType", "text/plain").put("kind", "file")
                .put("size", file.length()).put("path", file.getAbsolutePath()))));
        require(context.getSharedPreferences("chat", 0).edit().putString("run_status_" + id, "running")
                .putString("run_execution_" + id, new JSONObject().put("phase", "tool")
                        .put("toolName", "synthetic_side_effect").toString()).commit(), "durable run marker");
        require(metadata.edit().putBoolean("seeded", true).putInt("pid", android.os.Process.myPid())
                .putString("conversation", id).putString("leaf", store.tree(id).leaf())
                .putString("snapshot", NativeJson.conversation(store, id).toString()).commit(), "durable fixture metadata");
        assertRuntimeIdle();
        return "PASS: synthetic pending fixture seeded in isolated storage; pid=" + android.os.Process.myPid()
                + ". Force-stop the target app, then run task-recovery-verify.";
    }

    private static void assertFixtureUnchanged(ChatStore store, SharedPreferences metadata, Context context) throws Exception {
        String id = metadata.getString("conversation", "");
        require(metadata.getString("snapshot", "").equals(NativeJson.conversation(store, id).toString()), "history/draft/attachments unchanged");
        require(DRAFT.equals(store.draft(id)), "unsent draft retained");
        require(store.draftAttachments(id).size() == 1, "unsent attachment retained");
        File file = new File(context.getFilesDir(), "chat-attachments/00000000-0000-4000-8000-000000000001");
        require(ATTACHMENT_TEXT.equals(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)), "attachment bytes retained");
        require(context.getSharedPreferences("chat", 0).getBoolean("pi_pending_" + id + "_fixture-pending-user", false),
                "uncertain original turn remains marked");
    }

    private static Context isolated(Context target) {
        File root = new File(target.getCacheDir(), "instrumentation-task-recovery");
        File files = new File(root, "files"), cache = new File(root, "cache");
        files.mkdirs(); cache.mkdirs();
        return new ContextWrapper(target) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getFilesDir() { return files; }
            @Override public File getCacheDir() { return cache; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return super.getSharedPreferences(PREFIX + name, mode);
            }
        };
    }
    private static AgentLoop.Message message(String id, String role, String text) {
        return new AgentLoop.Message(id, role, text, null, Collections.emptyList(), false);
    }
    private static Object field(Class<?> type, String name) throws Exception {
        java.lang.reflect.Field field = type.getDeclaredField(name); field.setAccessible(true); return field.get(null);
    }
    private static void assertRuntimeIdle() throws Exception {
        require(Boolean.FALSE.equals(field(PiAgentBridge.class, "attempted")) && field(PiAgentBridge.class, "instance") == null,
                "Node/runtime was not started");
        require(Integer.valueOf(0).equals(field(ChatExecutionService.class, "activeCount"))
                && Boolean.FALSE.equals(field(ChatExecutionService.class, "foreground")), "no foreground execution service");
    }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
