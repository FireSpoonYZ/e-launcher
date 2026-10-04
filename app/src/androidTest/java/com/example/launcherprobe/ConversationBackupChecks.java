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
        File attachmentFile = new File(attachmentRoot, fileId); Files.writeString(attachmentFile.toPath(), "fixture attachment");
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
        store.savePiTurn(original, "root", "second", store.load(), "second", entries, new JSONObject());
        File workspace = new PiConfigStore(context, original).workspaceRoot(); workspace.mkdirs();
        Files.writeString(new File(workspace, "work.txt").toPath(), "workspace contents");
        Files.writeString(new File(workspace, ".env").toPath(), "excluded");
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
            require(!fileId.equals(copy.id) && "fixture attachment".equals(Files.readString(new AttachmentStore(context).requireFile(copy).toPath())), "attachment clone");
            JSONArray resumed = new JSONObject(store.piResume(restored, store.load(restored))).getJSONArray("entries");
            require(copy.path.equals(resumed.getJSONObject(1).getJSONArray("attachments").getJSONObject(0).getString("path")), "context attachment remap");
            File restoredWorkspace = new PiConfigStore(context, restored).workspaceRoot();
            require(restoredWorkspace.getAbsolutePath().equals(resumed.getJSONObject(0).getString("cwd")), "context workspace remap");
            require("workspace contents".equals(Files.readString(new File(restoredWorkspace, "work.txt").toPath())), "workspace");
            require(!new File(restoredWorkspace, ".env").exists(), "secret exclusion");
            for (String path : Arrays.asList("../escape", "workspace/../escape", "workspace/.env", "workspace/private.key")) {
                try { ConversationBackupArchive.validPath(path); throw new AssertionError("Accepted " + path); }
                catch (IOException expected) { }
            }
            // Alter the validated staging payload after preview: publication must refuse it.
            File staged = imported.unpacked.files.get("conversation.json");
            Files.writeString(staged.toPath(), "{}");
            try { backups.restore(imported, true); throw new AssertionError("Accepted changed backup"); }
            catch (Exception expected) { }
            require(store.conversations().size() == 2, "failed import preserves index");
            return "PASS: isolated backup roundtrip; all branches, drafts, selection, attachments, Pi contexts, workspace remap, exclusions, original preservation and adversarial validation";
        } finally {
            if (exported != null) exported.close();
            if (imported != null) imported.close();
            for (ChatStore.Conversation item : new ArrayList<>(store.conversations())) store.clear(item.id);
            context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
