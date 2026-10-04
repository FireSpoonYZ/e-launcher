package com.example.launcherprobe;

import static org.junit.Assert.*;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE, shadows = HostAtomicFile.class)
public class ConversationBackupsTest {
    private Context context;
    private ChatStore store;
    private ConversationBackups backups;

    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        for (String name : Arrays.asList("chat-attachments", "pi-contexts", "pi-workspaces"))
            ConversationBackupArchive.deleteTree(new File(context.getFilesDir(), name));
        ConversationBackupArchive.deleteTree(new File(context.getCacheDir(), "conversation-backups"));
        store = new ChatStore(context); store.newConversation();
        backups = new ConversationBackups(context, store);
    }

    private AgentLoop.Message message(String id, String role, String content, List<ChatAttachment> files) {
        return new AgentLoop.Message(id, role, content, null, Collections.emptyList(), false, files);
    }

    private ChatAttachment attachment(String text) throws Exception {
        String id = UUID.randomUUID().toString();
        File root = new File(context.getFilesDir(), "chat-attachments"); root.mkdirs();
        File file = new File(root, id); Files.writeString(file.toPath(), text);
        return new ChatAttachment(id, "note.txt", "text/plain", "file", file.length(), file.getAbsolutePath());
    }

    @Test public void roundTripPreservesAllBranchesDraftsContextsAndClonesAttachmentIdentity() throws Exception {
        ChatAttachment file = attachment("important content");
        AgentLoop.Message user = message("user", "user", "question", Collections.singletonList(file));
        AgentLoop.Message answer = message("answer", "assistant", "first answer", Collections.emptyList());
        store.save(Arrays.asList(user, answer));
        store.selectNode("user");
        AgentLoop.Message alternative = message("alternative", "assistant", "other answer", Collections.emptyList());
        store.save(Arrays.asList(user, alternative));
        store.saveDraft("unsent"); store.saveDraftAttachments(Collections.singletonList(file));
        store.setPiSelection("provider", "model", "high");
        store.beginPiTurn(store.activeId(), "user", "alternative");
        JSONArray contextEntries = new JSONArray().put(new JSONObject().put("type", "session").put("cwd", "/old/workspace"))
                .put(new JSONObject().put("type", "message").put("attachments", AttachmentStore.json(Collections.singletonList(file))));
        store.savePiTurn(store.activeId(), "user", "alternative", store.load(), "alternative", contextEntries,
                new JSONObject().put("askUser", new JSONObject().put("id", "expired")).put("todo", new JSONObject().put("tasks", new JSONArray())));
        String originalId = store.activeId(), originalHistory = store.backupSnapshot(originalId).toString();
        File workspace = new PiConfigStore(context, originalId).workspaceRoot(); workspace.mkdirs();
        Files.writeString(new File(workspace, "report.txt").toPath(), "workspace report");
        Files.writeString(new File(workspace, ".env").toPath(), "SECRET=excluded");
        File pi = new File(workspace, ".pi"); pi.mkdir(); Files.writeString(new File(pi, "auth.json").toPath(), "secret");
        File dependency = new File(workspace, "node_modules"); dependency.mkdir();
        Files.createSymbolicLink(new File(workspace, "escape-link").toPath(), context.getCacheDir().toPath());

        ConversationBackups.Prepared exported = backups.prepareExport(originalId, true);
        assertTrue(exported.preview().getInt("excluded") >= 4);
        ConversationBackups.Prepared imported;
        try (InputStream input = new FileInputStream(exported.archive)) { imported = backups.prepareImport(input); }
        String restoredId = backups.restore(imported, true);
        assertNotEquals(originalId, restoredId);
        assertEquals(originalId, store.activeId());
        assertEquals(originalHistory, store.backupSnapshot(originalId).toString());
        assertEquals(3, store.tree(restoredId).nodes().size());
        assertEquals("alternative", store.tree(restoredId).leaf());
        assertEquals("unsent", store.draft(restoredId));
        assertEquals("model", new JSONObject(store.piSelection(restoredId)).getString("model"));
        ChatAttachment restoredFile = store.draftAttachments(restoredId).get(0);
        assertNotEquals(file.id, restoredFile.id);
        assertEquals("important content", Files.readString(new AttachmentStore(context).requireFile(restoredFile).toPath()));
        JSONObject resume = new JSONObject(store.piResume(restoredId, store.load(restoredId)));
        JSONObject restoredReference = resume.getJSONArray("entries").getJSONObject(1).getJSONArray("attachments").getJSONObject(0);
        assertEquals(restoredFile.path, restoredReference.getString("path"));
        File restoredWorkspace = new PiConfigStore(context, restoredId).workspaceRoot();
        assertEquals("workspace report", Files.readString(new File(restoredWorkspace, "report.txt").toPath()));
        assertFalse(new File(restoredWorkspace, ".env").exists());
        assertFalse(new File(restoredWorkspace, ".pi/auth.json").exists());
        assertFalse(new File(restoredWorkspace, "escape-link").exists());
        assertFalse(store.isArchived(restoredId));
        assertFalse(context.getSharedPreferences("chat", Context.MODE_PRIVATE).contains("run_status_" + restoredId));
        assertFalse(new JSONObject(store.extensionUi(restoredId, store.load(restoredId))).has("askUser"));
        exported.close(); imported.close();
    }

    @Test public void compressionDoesNotHoldStoreOrCoordinatorMonitors() throws Exception {
        store.save(Collections.singletonList(new AgentLoop.Message("user", "snapshot")));
        String id = store.activeId();
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        java.util.concurrent.ExecutorService other = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            ConversationBackups nonBlocking = new ConversationBackups(context, store, () -> {
                try {
                    other.submit(() -> {
                        synchronized (coordinator) { store.backupSnapshot(id); }
                        return true;
                    }).get(2, java.util.concurrent.TimeUnit.SECONDS);
                } catch (Exception failure) { throw new AssertionError("Compression must not hold application monitors", failure); }
            });
            nonBlocking.prepareExport(id, false).close();
        } finally { other.shutdownNow(); }
    }

    @Test public void workspaceIsOptionalAndArchivedOriginalIsUntouched() throws Exception {
        store.save(Collections.singletonList(new AgentLoop.Message("user", "keep")));
        String original = store.activeId(); store.archive(original); long archivedAt = store.archivedAt(original);
        File workspace = new PiConfigStore(context, original).workspaceRoot(); workspace.mkdirs();
        Files.writeString(new File(workspace, "report.txt").toPath(), "report");
        ConversationBackups.Prepared exported = backups.prepareExport(original, true);
        ConversationBackups.Prepared imported = backups.prepareImport(new FileInputStream(exported.archive));
        String restored = backups.restore(imported, false);
        assertFalse(new PiConfigStore(context, restored).workspaceRoot().exists());
        assertEquals(archivedAt, store.archivedAt(original)); assertFalse(store.isArchived(restored));
        assertEquals(14L * 24 * 60 * 60 * 1000, ChatStore.ARCHIVE_TTL_MS);
        exported.close(); imported.close();
    }

    @Test public void readsLegacyWorkspaceWithoutMigratingOrChangingOriginal() throws Exception {
        store.save(Collections.singletonList(new AgentLoop.Message("user", "legacy workspace")));
        String id = store.activeId();
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit()
                .putStringSet("pi_legacy_workspace_sessions", Collections.singleton(id)).commit();
        File legacy = new File(context.getFilesDir(), "pi-workspace"); legacy.mkdirs();
        Files.writeString(new File(legacy, "legacy.txt").toPath(), "legacy contents");
        File current = new PiConfigStore(context, id).workspaceRoot();
        assertFalse(current.exists());
        ConversationBackups.Prepared exported = backups.prepareExport(id, true);
        ConversationBackups.Prepared imported = backups.prepareImport(new FileInputStream(exported.archive));
        String restored = backups.restore(imported, true);
        assertFalse(current.exists());
        assertEquals("legacy contents", Files.readString(new File(legacy, "legacy.txt").toPath()));
        assertEquals("legacy contents", Files.readString(new File(new PiConfigStore(context, restored).workspaceRoot(), "legacy.txt").toPath()));
        exported.close(); imported.close();
        ConversationBackupArchive.deleteTree(legacy);
    }

    @Test public void failureBeforeCommitRollsBackNewAssetsAndKeepsOriginal() throws Exception {
        ChatAttachment file = attachment("data");
        store.save(Collections.singletonList(message("user", "user", "question", Collections.singletonList(file))));
        store.savePiContext("user", new JSONArray().put(new JSONObject().put("type", "message")));
        String id = store.activeId(), before = store.backupSnapshot(id).toString();
        ConversationBackups.Prepared exported = backups.prepareExport(id, false);
        ConversationBackups.Prepared imported = backups.prepareImport(new FileInputStream(exported.archive));
        // Force publication failure after the cloned attachment was written.
        File contextRoot = new File(context.getFilesDir(), "pi-contexts");
        File moved = new File(context.getFilesDir(), "saved-test-contexts");
        Files.move(contextRoot.toPath(), moved.toPath()); Files.writeString(contextRoot.toPath(), "blocking file");
        try {
            assertThrows(IOException.class, () -> backups.restore(imported, false));
            assertEquals(before, store.backupSnapshot(id).toString());
            assertEquals(1, new File(context.getFilesDir(), "chat-attachments").listFiles().length);
            assertEquals(1, store.conversations().size());
        } finally {
            Files.delete(contextRoot.toPath()); Files.move(moved.toPath(), contextRoot.toPath());
            exported.close(); imported.close();
        }
    }

    @Test public void failedPreferencesCommitRestoresMemoryIndexAndRemovesPublishedFiles() throws Exception {
        ChatAttachment file = attachment("keep me");
        store.save(Collections.singletonList(message("user", "user", "keep", Collections.singletonList(file))));
        String original = store.activeId(), before = store.backupSnapshot(original).toString();
        ConversationBackups.Prepared exported = backups.prepareExport(original, false);
        ConversationBackups.Prepared imported = backups.prepareImport(new FileInputStream(exported.archive));
        java.util.concurrent.atomic.AtomicBoolean fail = new java.util.concurrent.atomic.AtomicBoolean(false);
        Context faulty = new android.content.ContextWrapper(context) {
            @Override public Context getApplicationContext() { return this; }
            @Override public android.content.SharedPreferences getSharedPreferences(String name, int mode) {
                android.content.SharedPreferences target = super.getSharedPreferences(name, mode);
                if (!"chat".equals(name)) return target;
                return (android.content.SharedPreferences) java.lang.reflect.Proxy.newProxyInstance(
                        getClass().getClassLoader(), new Class<?>[]{android.content.SharedPreferences.class}, (proxy, method, args) -> {
                    Object result = method.invoke(target, args);
                    if (!"edit".equals(method.getName())) return result;
                    android.content.SharedPreferences.Editor edit = (android.content.SharedPreferences.Editor) result;
                    return java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(),
                            new Class<?>[]{android.content.SharedPreferences.Editor.class}, (editorProxy, editorMethod, editorArgs) -> {
                        Object edited = editorMethod.invoke(edit, editorArgs);
                        if ("commit".equals(editorMethod.getName()) && fail.compareAndSet(true, false)) return false;
                        return edited instanceof android.content.SharedPreferences.Editor ? editorProxy : edited;
                    });
                });
            }
        };
        ConversationBackups failing = new ConversationBackups(faulty, new ChatStore(faulty));
        fail.set(true);
        assertThrows(IOException.class, () -> failing.restore(imported, false));
        assertEquals(before, store.backupSnapshot(original).toString());
        assertEquals(1, store.conversations().size());
        assertEquals(1, new File(context.getFilesDir(), "chat-attachments").listFiles().length);
        exported.close(); imported.close();
    }

    @Test public void rejectsTraversalUnknownPathsExclusionsAndSymlinkSources() throws Exception {
        for (String path : Arrays.asList("../escape", "/absolute", "workspace/../x", "workspace/a/../../x",
                "workspace/a\\b", "workspace/C:drive", "workspace/.env", "workspace/.pi/auth.json",
                "workspace/private.key", "workspace/a//b", "workspace/./a", "manifest.json", "attachments/not-a-uuid"))
            assertThrows(path, IOException.class, () -> ConversationBackupArchive.validPath(path));
        File link = new File(context.getCacheDir(), UUID.randomUUID().toString());
        Files.createSymbolicLink(link.toPath(), new File(context.getFilesDir(), "outside").toPath());
        assertThrows(IOException.class, () -> ConversationBackupArchive.requireRegular(link));
        Files.delete(link.toPath());
    }

    @Test public void rejectsCorruptExtraMissingOversizedAndDeepJsonArchives() throws Exception {
        Map<String, byte[]> files = new LinkedHashMap<>(); files.put("conversation.json", "{}".getBytes(StandardCharsets.UTF_8));
        JSONObject manifest = manifest(files);
        Map<String, byte[]> damaged = new LinkedHashMap<>(files); damaged.put("conversation.json", "[]".getBytes(StandardCharsets.UTF_8));
        rejectZip(manifest, damaged);
        Map<String, byte[]> extra = new LinkedHashMap<>(files); extra.put("workspace/unlisted.txt", new byte[]{1}); rejectZip(manifest, extra);
        rejectZip(manifest, Collections.emptyMap());
        JSONObject oversized = new JSONObject(manifest.toString());
        oversized.getJSONArray("files").getJSONObject(0).put("bytes", ConversationBackupArchive.MAX_FILE + 1);
        rejectZip(oversized, files);
        JSONObject duplicate = new JSONObject(manifest.toString());
        duplicate.getJSONArray("files").put(duplicate.getJSONArray("files").getJSONObject(0)); rejectZip(duplicate, files);
        JSONObject version = new JSONObject(manifest.toString()).put("version", 99); rejectZip(version, files);
        assertThrows(IOException.class, () -> ConversationBackupArchive.object(("[".repeat(65) + "0" + "]".repeat(65)).getBytes(StandardCharsets.UTF_8)));
        assertThrows(IOException.class, () -> ConversationBackupArchive.object(new byte[]{(byte) 0xc3, 0x28}));
    }

    @Test public void rejectsDuplicateZipEntriesAndInvalidTreeWithoutPublishing() throws Exception {
        byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
        Map<String, byte[]> files = new LinkedHashMap<>(); files.put("conversation.json", payload);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        localEntry(bytes, "manifest.json", manifest(files).toString().getBytes(StandardCharsets.UTF_8));
        localEntry(bytes, "conversation.json", payload); localEntry(bytes, "conversation.json", payload);
        File directory = new File(context.getCacheDir(), UUID.randomUUID().toString());
        assertThrows(IOException.class, () -> ConversationBackupArchive.unpack(new ByteArrayInputStream(bytes.toByteArray()), directory));
        assertFalse(directory.exists());
        store.save(Collections.singletonList(message("node", "user", "keep", Collections.emptyList())));
        JSONObject snapshot = store.backupSnapshot(store.activeId());
        snapshot.getJSONObject("tree").getJSONArray("nodes").getJSONObject(0).put("parent_id", "node");
        assertThrows(IllegalArgumentException.class, () -> ChatStore.validateBackupSnapshot(snapshot));
        assertEquals(1, store.conversations().size());
    }

    private static void localEntry(OutputStream output, String name, byte[] data) throws Exception {
        byte[] filename = name.getBytes(StandardCharsets.UTF_8);
        java.util.zip.CRC32 crc = new java.util.zip.CRC32(); crc.update(data);
        java.nio.ByteBuffer header = java.nio.ByteBuffer.allocate(30).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        header.putInt(0x04034b50).putShort((short) 20).putShort((short) 0).putShort((short) 0)
                .putInt(0).putInt((int) crc.getValue()).putInt(data.length).putInt(data.length)
                .putShort((short) filename.length).putShort((short) 0);
        output.write(header.array()); output.write(filename); output.write(data);
    }

    @Test public void boundedExtractionStopsActualInflationBeyondDeclaredSize() throws Exception {
        Map<String, byte[]> files = new LinkedHashMap<>(); files.put("conversation.json", new byte[]{1});
        JSONObject manifest = manifest(files);
        files.put("conversation.json", new byte[1024 * 1024]);
        rejectZip(manifest, files);
    }

    @Test public void rejectsForgedAttachmentReferencesEvenWithValidHashes() throws Exception {
        ChatAttachment file = attachment("hello");
        store.save(Collections.singletonList(message("user", "user", "hi", Collections.singletonList(file))));
        JSONObject snapshot = store.backupSnapshot(store.activeId());
        snapshot.getJSONObject("tree").getJSONArray("nodes").getJSONObject(0).getJSONArray("attachments")
                .getJSONObject(0).put("path", "/outside/private");
        File directory = new File(context.getCacheDir(), UUID.randomUUID().toString()); directory.mkdir();
        File conversation = new File(directory, "conversation.json"); Files.writeString(conversation.toPath(), snapshot.toString());
        Map<String, File> sources = new LinkedHashMap<>(); sources.put("conversation.json", conversation);
        sources.put("attachments/" + file.id, new File(file.path));
        File zip = new File(directory, "forged.zip");
        ConversationBackupArchive.pack(zip, sources, new JSONObject().put("title", "forged").put("nodes", 1).put("workspace", false));
        assertThrows(IOException.class, () -> backups.prepareImport(new FileInputStream(zip)));
        assertEquals(1, store.conversations().size());
        ConversationBackupArchive.deleteTree(directory);
    }

    private JSONObject manifest(Map<String, byte[]> files) throws Exception {
        JSONArray entries = new JSONArray(); long total = 0;
        for (Map.Entry<String, byte[]> item : files.entrySet()) {
            total += item.getValue().length;
            entries.put(new JSONObject().put("path", item.getKey()).put("bytes", item.getValue().length)
                    .put("sha256", ConversationBackupArchive.hex(java.security.MessageDigest.getInstance("SHA-256").digest(item.getValue()))));
        }
        return new JSONObject().put("format", ConversationBackupArchive.FORMAT).put("version", 1).put("bytes", total).put("files", entries);
    }

    private void rejectZip(JSONObject manifest, Map<String, byte[]> files) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            zip.putNextEntry(new ZipEntry("manifest.json")); zip.write(manifest.toString().getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
            for (Map.Entry<String, byte[]> item : files.entrySet()) {
                zip.putNextEntry(new ZipEntry(item.getKey())); zip.write(item.getValue()); zip.closeEntry();
            }
        }
        File directory = new File(context.getCacheDir(), UUID.randomUUID().toString());
        assertThrows(Exception.class, () -> ConversationBackupArchive.unpack(new ByteArrayInputStream(bytes.toByteArray()), directory));
        assertFalse(directory.exists());
    }
}
