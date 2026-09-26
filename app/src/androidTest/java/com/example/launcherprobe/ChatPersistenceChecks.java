package com.example.launcherprobe;

import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Device storage/JSON boundary only: no coordinator singleton, Node, model, Activity or Web rendering. */
final class ChatPersistenceChecks {
    static String run(Instrumentation test) throws Exception {
        try (FixtureContext context = new FixtureContext(test.getTargetContext())) {
            ChatStore store = new ChatStore(context);
            String source = UUID.randomUUID().toString(), target = UUID.randomUUID().toString();
            AgentLoop.Message sourceUser = new AgentLoop.Message("user", "source fixture");
            AgentLoop.Message targetUser = new AgentLoop.Message("user", "target fixture");
            store.save(source, List.of(sourceUser));
            store.save(target, List.of(targetUser));
            store.selectConversation(source);
            store.saveDraft("unsent source draft");
            store.saveDraft(target, "unsent target draft");
            String sourceReply = UUID.randomUUID().toString();
            PiTurnPersistence sourceTurn = new PiTurnPersistence(store, source, sourceUser.id,
                    sourceReply, store.load(source));

            sourceTurn.accept(delta("第一段 "));
            require(sourceTurn.savePreview() != null, "first delta creates a preview");
            expectReply(store, source, sourceUser.id, sourceReply, "第一段 ", true);
            sourceTurn.accept(delta("🙂\n"));
            sourceTurn.savePreview();
            expectReply(store, source, sourceUser.id, sourceReply, "第一段 🙂\n", true);

            store.selectConversation(target);
            String targetSnapshot = NativeJson.conversation(store).toString();
            sourceTurn.accept(delta("background tail"));
            sourceTurn.savePreview();
            expectReply(store, source, sourceUser.id, sourceReply, "第一段 🙂\nbackground tail", true);
            expectTargetUnchanged(store, target, targetSnapshot);

            // The canonical message supersedes the preview; it must not append a second assistant node.
            String finalText = "第一段 🙂\nbackground tail — canonical";
            sourceTurn.accept(new JSONObject().put("type", "message").put("message", new JSONObject()
                    .put("role", "assistant").put("content", finalText).put("stopReason", "stop")));
            sourceTurn.accept(new JSONObject().put("type", "context").put("entries", new JSONArray()));
            sourceTurn.accept(end("completed"));
            expectReply(store, source, sourceUser.id, sourceReply, finalText, false);
            expectTargetUnchanged(store, target, targetSnapshot);
            require("unsent source draft".equals(store.draft(source)), "background output preserves source draft");

            sourceTurn.accept(delta("late event must be ignored"));
            sourceTurn.accept(end("error"));
            require(sourceTurn.savePreview() == null, "ended turn cannot publish another preview");
            expectReply(store, source, sourceUser.id, sourceReply, finalText, false);
            expectTargetUnchanged(store, target, targetSnapshot);

            // The delta-only abort path must preserve its partial text, not borrow the other turn's result.
            String targetReply = UUID.randomUUID().toString();
            PiTurnPersistence targetTurn = new PiTurnPersistence(store, target, targetUser.id,
                    targetReply, store.load(target));
            targetTurn.accept(delta("interrupted "));
            targetTurn.savePreview();
            targetTurn.accept(delta("answer"));
            targetTurn.accept(end("aborted"));
            expectReply(store, target, targetUser.id, targetReply, "interrupted answer", true);
            expectReply(store, source, sourceUser.id, sourceReply, finalText, false);

            require(context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().commit(),
                    "fixture preferences flushed to disk");
            ChatStore reopened = new ChatStore(context);
            require(target.equals(reopened.activeId()), "reopening preserves the selected target");
            expectReply(reopened, source, sourceUser.id, sourceReply, finalText, false);
            expectReply(reopened, target, targetUser.id, targetReply, "interrupted answer", true);
            require("unsent source draft".equals(reopened.draft(source))
                    && "unsent target draft".equals(reopened.draft(target)), "both drafts survive reopening");
            JSONObject resume = new JSONObject(reopened.piResume(source, reopened.load(source)));
            require(resume.getJSONArray("entries").length() == 0 && resume.getJSONArray("tail").length() == 0,
                    "completed native context file survives reopening without replaying preview text");
        }
        return "PASS: chat-persistence; isolated device previews, canonical deduplication, background target/draft isolation, "
                + "completed/aborted reload; no Node, coordinator listener or Web UI";
    }

    private static JSONObject delta(String text) throws Exception {
        return new JSONObject().put("type", "text_delta").put("delta", text);
    }

    private static JSONObject end(String status) throws Exception {
        return new JSONObject().put("type", "end").put("status", status);
    }

    private static void expectTargetUnchanged(ChatStore store, String target, String snapshot) {
        require(target.equals(store.activeId()), "background output must not select its source conversation");
        require(snapshot.equals(NativeJson.conversation(store).toString()),
                "current target snapshot, tree and draft must not change with background output");
    }

    private static void expectReply(ChatStore store, String id, String userId, String replyId,
            String text, boolean incomplete) throws Exception {
        List<AgentLoop.Message> history = store.load(id);
        require(history.size() == 2, "exactly one user and one assistant in " + id);
        require(userId.equals(history.get(0).id) && "user".equals(history.get(0).role), "user identity retained");
        AgentLoop.Message reply = history.get(1);
        require(replyId.equals(reply.id) && "assistant".equals(reply.role), "stable assistant identity");
        require(text.equals(reply.content) && incomplete == reply.incomplete, "persisted reply text/completeness");
        JSONObject snapshot = NativeJson.conversation(store, id);
        require(id.equals(snapshot.getString("id")) && replyId.equals(snapshot.getString("leaf")),
                "snapshot identifies the correct conversation and selected assistant");
        JSONArray nodes = snapshot.getJSONArray("nodes");
        require(nodes.length() == 2, "preview/canonical updates do not leave phantom tree nodes");
        JSONObject replyNode = null;
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject node = nodes.getJSONObject(i);
            if (replyId.equals(node.getString("id"))) replyNode = node;
        }
        require(replyNode != null && userId.equals(replyNode.getString("parentId")), "reply stays attached to its user");
        JSONObject message = replyNode.getJSONObject("message");
        require(replyId.equals(message.getString("id")) && "assistant".equals(message.getString("role"))
                && text.equals(message.getString("content")) && incomplete == message.getBoolean("incomplete"),
                "native bridge snapshot agrees with persisted reply");
    }

    /** Never call ChatStore.clear: its attachment sweep is unnecessary for this private fixture. */
    private static final class FixtureContext extends ContextWrapper implements AutoCloseable {
        private final String namespace = "instrumentation_chat_persistence_" + UUID.randomUUID() + "_";
        private final Set<String> preferences = new LinkedHashSet<>();
        private final File root;

        FixtureContext(Context base) throws IOException {
            super(base);
            root = new File(base.getCacheDir(), namespace);
            Files.createDirectories(getFilesDir().toPath());
            Files.createDirectories(getCacheDir().toPath());
        }

        @Override public Context getApplicationContext() { return this; }
        @Override public File getFilesDir() { return new File(root, "files"); }
        @Override public File getCacheDir() { return new File(root, "cache"); }
        @Override public SharedPreferences getSharedPreferences(String name, int mode) {
            String isolated = namespace + name;
            preferences.add(isolated);
            return getBaseContext().getSharedPreferences(isolated, mode);
        }

        @Override public void close() throws IOException {
            boolean cleared = true;
            for (String name : preferences) {
                cleared &= getBaseContext().getSharedPreferences(name, MODE_PRIVATE).edit().clear().commit();
                cleared &= getBaseContext().deleteSharedPreferences(name);
            }
            delete(root);
            require(cleared, "fixture preferences cleaned up");
        }

        private static void delete(File file) throws IOException {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) delete(child);
            Files.deleteIfExists(file.toPath());
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
