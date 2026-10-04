package com.example.launcherprobe;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.file.Files;
import java.util.*;

/** Called with ChatStoreChecks.storageContext(); never touches the real chat namespace. */
final class ConversationBackupChecks {
    static String run(Context context) throws Exception {
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        for (String name : Arrays.asList("chat-attachments", "pi-contexts", "pi-workspaces"))
            ConversationBackupArchive.deleteTree(new File(context.getFilesDir(), name));
        ChatStore store = new ChatStore(context); store.newConversation();
        String original = store.activeId();
        File attachmentRoot = new File(context.getFilesDir(), "chat-attachments"); attachmentRoot.mkdirs();
        String fileId = UUID.randomUUID().toString();
        File attachmentFile = new File(attachmentRoot, fileId); writeUtf8(attachmentFile.toPath(), "fixture attachment");
        ChatAttachment attachment = new ChatAttachment(fileId, "fixture.txt", "text/plain", "file",
                attachmentFile.length(), attachmentFile.getAbsolutePath());
        AgentLoop.Message user = new AgentLoop.Message("root", "user", "question", null,
                Collections.emptyList(), false, Collections.singletonList(attachment));
        AgentLoop.Message first = new AgentLoop.Message("first", "assistant", "branch one", null,
                Collections.emptyList(), false);
        AgentLoop.Message second = new AgentLoop.Message("second", "assistant", "branch two", null,
                Collections.emptyList(), false);
        store.save(Arrays.asList(user, first)); store.selectNode("root"); store.save(Arrays.asList(user, second));
        store.saveDraft("unsent draft"); store.saveDraftAttachments(Collections.singletonList(attachment));
        store.setPiSelection("test-provider", "test-model", "high");
        store.beginPiTurn(original, "root", "second");
        JSONArray entries = new JSONArray().put(new JSONObject().put("type", "session").put("cwd", "/previous/workspace"))
                .put(new JSONObject().put("type", "message").put("attachments", AttachmentStore.json(Collections.singletonList(attachment))));
        String notice = "read attachment\n\n[用户附件已安全复制到应用私有工作区。请使用 read 工具实际读取，不要声称已读取而未读取。]\n"
                + "- \"fixture.txt\" (text/plain, " + attachment.size + " bytes): " + attachmentFile.getCanonicalPath();
        entries.put(new JSONObject().put("type", "message").put("message", new JSONObject().put("role", "user")
                .put("content", new JSONArray().put(new JSONObject().put("type", "text").put("text", notice)))));
        store.savePiTurn(original, "root", "second", store.load(), "second", entries, new JSONObject());
        File workspace = new PiConfigStore(context, original).workspaceRoot(); workspace.mkdirs();
        writeUtf8(new File(workspace, "work.txt").toPath(), "workspace contents");
        writeUtf8(new File(workspace, ".env").toPath(), "excluded");
        String before = store.backupSnapshot(original).toString();
        ConversationBackups backups = new ConversationBackups(context, store);
        ConversationBackups.Prepared exported = null, imported = null;
        try {
            exported = backups.prepareExport(original, true);
            imported = backups.prepareImport(new FileInputStream(exported.archive));
            String restored = backups.restore(imported, true);
            require(!original.equals(restored), "clone identity");
            require(before.equals(store.backupSnapshot(original).toString()), "source preservation");
            require(original.equals(store.activeId()), "active conversation preservation");
            require(store.tree(restored).nodes().size() == 3 && "second".equals(store.tree(restored).leaf()), "branches and leaf");
            require("unsent draft".equals(store.draft(restored)), "draft");
            require("test-model".equals(new JSONObject(store.piSelection(restored)).getString("model")), "selection");
            ChatAttachment copy = store.draftAttachments(restored).get(0);
            require(!fileId.equals(copy.id) && "fixture attachment".equals(readUtf8(new AttachmentStore(context).requireFile(copy).toPath())), "attachment clone");
            JSONArray resumed = new JSONObject(store.piResume(restored, store.load(restored))).getJSONArray("entries");
            require(copy.path.equals(resumed.getJSONObject(1).getJSONArray("attachments").getJSONObject(0).getString("path")), "context attachment remap");
            File restoredWorkspace = new PiConfigStore(context, restored).workspaceRoot();
            require(restoredWorkspace.getAbsolutePath().equals(resumed.getJSONObject(0).getString("cwd")), "context workspace remap");
            require("workspace contents".equals(readUtf8(new File(restoredWorkspace, "work.txt").toPath())), "workspace");
            require(!new File(restoredWorkspace, ".env").exists(), "secret exclusion");
            for (String path : Arrays.asList("../escape", "workspace/../escape", "workspace/.env", "workspace/private.key")) {
                try { ConversationBackupArchive.validPath(path); throw new AssertionError("Accepted " + path); }
                catch (IOException expected) { }
            }
            // Alter the validated staging payload after preview: publication must refuse it.
            File staged = imported.unpacked.files.get("conversation.json");
            writeUtf8(staged.toPath(), "{}");
            try { backups.restore(imported, true); throw new AssertionError("Accepted changed backup"); }
            catch (Exception expected) { }
            require(store.conversations().size() == 2, "failed import preserves index");
            store.clear(original);
            require(!attachmentFile.exists(), "original fixture intentionally deleted");
            JSONArray continued = new JSONObject(store.piResume(restored, store.load(restored))).getJSONArray("entries");
            String restoredNotice = continued.getJSONObject(2).getJSONObject("message").getJSONArray("content").getJSONObject(0).getString("text");
            require(restoredNotice.endsWith(" bytes): " + copy.path), "native SDK fileNotice path remap");
            require("fixture attachment".equals(readUtf8(new File(copy.path).toPath())), "clone remains readable after original deletion");
            return "PASS: isolated backup roundtrip; all branches, drafts, selection, attachments, Pi contexts, workspace remap, exclusions, original preservation and adversarial validation";
        } finally {
            if (exported != null) exported.close();
            if (imported != null) imported.close();
            for (ChatStore.Conversation item : new ArrayList<>(store.conversations())) store.clear(item.id);
            context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        }
    }

    private static void writeUtf8(java.nio.file.Path path, String text) throws IOException {
        Files.write(path, text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    private static String readUtf8(java.nio.file.Path path) throws IOException {
        return new String(Files.readAllBytes(path), java.nio.charset.StandardCharsets.UTF_8);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
