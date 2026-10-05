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
        File file = new File(root, id); writeUtf8(file.toPath(), text);
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
        writeUtf8(new File(workspace, "report.txt").toPath(), "workspace report");
        writeUtf8(new File(workspace, ".env").toPath(), "SECRET=excluded");
        File pi = new File(workspace, ".pi"); pi.mkdir(); writeUtf8(new File(pi, "auth.json").toPath(), "secret");
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
        assertEquals("important content", readUtf8(new AttachmentStore(context).requireFile(restoredFile).toPath()));
        JSONObject resume = new JSONObject(store.piResume(restoredId, store.load(restoredId)));
        JSONObject restoredReference = resume.getJSONArray("entries").getJSONObject(1).getJSONArray("attachments").getJSONObject(0);
        assertEquals(restoredFile.path, restoredReference.getString("path"));
        File restoredWorkspace = new PiConfigStore(context, restoredId).workspaceRoot();
        assertEquals("workspace report", readUtf8(new File(restoredWorkspace, "report.txt").toPath()));
        assertFalse(new File(restoredWorkspace, ".env").exists());
        assertFalse(new File(restoredWorkspace, ".pi/auth.json").exists());
        assertFalse(new File(restoredWorkspace, "escape-link").exists());
        assertFalse(store.isArchived(restoredId));
        assertFalse(context.getSharedPreferences("chat", Context.MODE_PRIVATE).contains("run_status_" + restoredId));
        assertFalse(new JSONObject(store.extensionUi(restoredId, store.load(restoredId))).has("askUser"));
        exported.close(); imported.close();
    }

    @Test public void remapsRealSdkFileNoticeAndResumesAfterOriginalIsDeleted() throws Exception {
        ChatAttachment file = attachment("native attachment");
        AgentLoop.Message user = message("user", "user", "use attached file", Collections.singletonList(file));
        AgentLoop.Message answer = message("answer", "assistant", "ready", Collections.emptyList());
        store.save(Arrays.asList(user, answer));
        String original = store.activeId();
        String prose = "Quoted historic path stays unchanged: " + file.path;
        String notice = prose + "\n\n[用户附件已安全复制到应用私有工作区。请使用 read 工具实际读取，不要声称已读取而未读取。]\n"
                + "- \"note.txt\" (text/plain, " + file.size + " bytes): " + new File(file.path).getCanonicalPath();
        JSONArray entries = nativeSessionEntries(notice, "ready", new PiConfigStore(context, original).workspaceRoot().getAbsolutePath());
        store.savePiContext("answer", entries);
        ConversationBackups.Prepared exported = backups.prepareExport(original, false);
        ConversationBackups.Prepared imported = backups.prepareImport(new FileInputStream(exported.archive));
        String restored = backups.restore(imported, false);
        ChatAttachment copy = store.tree(restored).node("user").message.attachments.get(0);
        store.clear(original);
        assertFalse(new File(file.path).exists());
        JSONArray resumed = new JSONObject(store.piResume(restored, store.load(restored))).getJSONArray("entries");
        String text = resumed.getJSONObject(1).getJSONObject("message").getJSONArray("content").getJSONObject(0).getString("text");
        assertTrue(text.startsWith(prose + "\n\n"));
        assertTrue(text.endsWith(" bytes): " + copy.path));
        assertEquals("native attachment", readUtf8(new File(copy.path).toPath()));
        // Reusable synthetic artifact for the real SDK/loopback regression; no app/user data.
        File artifact = new File(System.getProperty("backupSdkFixtureDir", "build/backup-sdk-fixture")); artifact.mkdirs();
        Files.copy(new File(copy.path).toPath(), new File(artifact, "attachment.txt").toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        writeUtf8(new File(artifact, "context.json").toPath(), new JSONObject().put("entries", resumed)
                .put("attachmentPath", copy.path).put("originalPath", file.path)
                .put("originalDeleted", !new File(file.path).exists()).toString());
        exported.close(); imported.close();
    }

    @Test public void pendingTurnsRemainBlockedWithoutImportingRetryConsent() throws Exception {
        store.save(Collections.singletonList(message("pending-user", "user", "possibly consequential", Collections.emptyList())));
        String source = store.activeId();
        store.beginPiTurn(source, "pending-user", "not-yet-observed-assistant");
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().putString("pi_recovery_" + source, "old consent").commit();
        ConversationBackups.Prepared exported = backups.prepareExport(source, false);
        assertEquals(1, exported.preview().getInt("pendingTurns"));
        ConversationBackups.Prepared imported = backups.prepareImport(new FileInputStream(exported.archive));
        String restored = backups.restore(imported, false);
        assertTrue(context.getSharedPreferences("chat", Context.MODE_PRIVATE).getBoolean("pi_pending_" + restored + "_pending-user", false));
        assertFalse(context.getSharedPreferences("chat", Context.MODE_PRIVATE).contains("pi_recovery_" + restored));
        assertThrows(IOException.class, () -> store.piResume(restored, store.load(restored)));
        exported.close(); imported.close();
    }

    @Test public void rejectsExportThatItsOwnImporterCannotRestore() throws Exception {
        List<AgentLoop.Message> messages = new ArrayList<>();
        for (int i = 0; i < 10001; i++) messages.add(message("node-" + i, "user", "", Collections.emptyList()));
        store.save(messages);
        assertThrows(IllegalArgumentException.class, () -> backups.prepareExport(store.activeId(), false));
        assertEquals(0, Objects.requireNonNull(new File(context.getCacheDir(), "conversation-backups").list()).length);
    }

    @Test public void exportsCommittedAtomicContextBackupAndIgnoresUncommittedSidecar() throws Exception {
        store.save(Collections.singletonList(message("user", "user", "atomic context", Collections.emptyList())));
        JSONArray committed = new JSONArray().put(new JSONObject().put("type", "message").put("value", "committed"));
        store.savePiContext("user", committed);
        String sourceId = store.activeId();
        File contexts = new File(new File(context.getFilesDir(), "pi-contexts"),
                UUID.nameUUIDFromBytes(sourceId.getBytes(StandardCharsets.UTF_8)).toString());
        File primary = new File(contexts, UUID.nameUUIDFromBytes("user".getBytes(StandardCharsets.UTF_8)) + ".json");
        Files.move(primary.toPath(), new File(primary + ".bak").toPath());
        writeUtf8(new File(primary + ".new").toPath(), "[{\"type\":\"message\",\"value\":\"uncommitted\"}]");
        ConversationBackups.Prepared exported = backups.prepareExport(sourceId, false);
        ConversationBackups.Prepared imported = backups.prepareImport(new FileInputStream(exported.archive));
        String restored = backups.restore(imported, false);
        assertEquals(committed.toString(), new JSONObject(store.piResume(restored, store.load(restored))).getJSONArray("entries").toString());
        assertEquals(committed.toString(), store.piContext("user"));
        for (String path : imported.unpacked.files.keySet()) {
            assertFalse(path.endsWith(".bak")); assertFalse(path.endsWith(".new"));
        }
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
        writeUtf8(new File(workspace, "report.txt").toPath(), "report");
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
        writeUtf8(new File(legacy, "legacy.txt").toPath(), "legacy contents");
        File current = new PiConfigStore(context, id).workspaceRoot();
        assertFalse(current.exists());
        ConversationBackups.Prepared exported = backups.prepareExport(id, true);
        ConversationBackups.Prepared imported = backups.prepareImport(new FileInputStream(exported.archive));
        String restored = backups.restore(imported, true);
        assertFalse(current.exists());
        assertEquals("legacy contents", readUtf8(new File(legacy, "legacy.txt").toPath()));
        assertEquals("legacy contents", readUtf8(new File(new PiConfigStore(context, restored).workspaceRoot(), "legacy.txt").toPath()));
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
        Files.move(contextRoot.toPath(), moved.toPath()); writeUtf8(contextRoot.toPath(), "blocking file");
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

    @Test public void boundsWorkspaceScanEvenWhenEveryEntryIsExcluded() throws Exception {
        store.save(Collections.singletonList(new AgentLoop.Message("user", "bounded scan")));
        File workspace = new PiConfigStore(context, store.activeId()).workspaceRoot(); workspace.mkdirs();
        for (int i = 0; i <= ConversationBackupArchive.MAX_FILES; i++) Files.createFile(new File(workspace, ".hidden-" + i).toPath());
        assertThrows(IOException.class, () -> backups.prepareExport(store.activeId(), true));
        File cache = new File(context.getCacheDir(), "conversation-backups");
        assertEquals(0, Objects.requireNonNull(cache.list()).length);
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

    @Test public void missingMimeCannotAliasAnExistingAttachmentInDraftOrMessageSlots() throws Exception {
        ChatAttachment file = attachment("private original");
        store.save(Collections.singletonList(message("user", "user", "original", Collections.singletonList(file))));
        store.saveDraftAttachments(Collections.singletonList(file));
        for (boolean draft : Arrays.asList(false, true)) for (boolean decoy : Arrays.asList(false, true)) {
            JSONObject snapshot = store.backupSnapshot(store.activeId());
            JSONObject broken = draft ? snapshot.getJSONArray("draftAttachments").getJSONObject(0)
                    : snapshot.getJSONObject("tree").getJSONArray("nodes").getJSONObject(0).getJSONArray("attachments").getJSONObject(0);
            broken.remove("mimeType");
            if (decoy) {
                JSONObject metadata = file.toJson().put("path", "attachments/" + file.id);
                Iterator<String> keys = metadata.keys();
                while (keys.hasNext()) { String key = keys.next(); snapshot.put(key, metadata.get(key)); }
            }
            if (draft) snapshot.getJSONObject("tree").getJSONArray("nodes").getJSONObject(0).remove("attachments");
            else snapshot.put("draftAttachments", new JSONArray());
            File directory = new File(context.getCacheDir(), UUID.randomUUID().toString()); directory.mkdir();
            File conversation = new File(directory, "conversation.json"); writeUtf8(conversation.toPath(), snapshot.toString());
            Map<String, File> sources = new LinkedHashMap<>(); sources.put("conversation.json", conversation);
            if (decoy) sources.put("attachments/" + file.id, new File(file.path));
            File archive = new File(directory, "forged.zip");
            ConversationBackupArchive.pack(archive, sources, new JSONObject().put("title", "forged").put("workspace", false).put("nodes", 1));
            assertThrows(IOException.class, () -> backups.prepareImport(new FileInputStream(archive)));
            assertEquals(1, store.conversations().size());
            assertEquals("private original", readUtf8(new File(file.path).toPath()));
            ConversationBackupArchive.deleteTree(directory);
        }
    }

    @Test public void portableReferencesStillRequireStrictRuntimeCompatibleMetadata() throws Exception {
        store.save(Collections.singletonList(message("user", "user", "valid tree", Collections.emptyList())));
        for (String corruption : Arrays.asList("mime", "name", "kind", "unsupported-kind", "fraction", "zero", "oversized", "image-mime")) {
            String id = UUID.randomUUID().toString();
            File directory = new File(context.getCacheDir(), UUID.randomUUID().toString()); directory.mkdir();
            File payload = new File(directory, "payload");
            long size = corruption.equals("zero") ? 0 : corruption.equals("oversized") ? AttachmentStore.MAX_BYTES + 1 : 1;
            try (RandomAccessFile file = new RandomAccessFile(payload, "rw")) { file.setLength(size); }
            JSONObject metadata = new ChatAttachment(id, "file.txt", "text/plain", "file", size, "attachments/" + id).toJson();
            if (corruption.equals("mime")) metadata.remove("mimeType");
            if (corruption.equals("name")) metadata.remove("name");
            if (corruption.equals("kind")) metadata.remove("kind");
            if (corruption.equals("unsupported-kind")) metadata.put("kind", "video");
            if (corruption.equals("fraction")) metadata.put("size", 1.5);
            if (corruption.equals("image-mime")) metadata.put("kind", "image");
            JSONObject snapshot = store.backupSnapshot(store.activeId()).put("draftAttachments", new JSONArray().put(metadata));
            File conversation = new File(directory, "conversation.json"); writeUtf8(conversation.toPath(), snapshot.toString());
            Map<String, File> sources = new LinkedHashMap<>();
            sources.put("conversation.json", conversation); sources.put("attachments/" + id, payload);
            File archive = new File(directory, "invalid.zip");
            ConversationBackupArchive.pack(archive, sources, new JSONObject().put("title", "invalid").put("workspace", false).put("nodes", 1));
            assertThrows(corruption, IOException.class, () -> backups.prepareImport(new FileInputStream(archive)));
            assertEquals(1, store.conversations().size());
            ConversationBackupArchive.deleteTree(directory);
        }
    }

    @Test public void rejectsLenientJsonDepthBypassAndDuplicateKeys() throws Exception {
        String attack = "{'x':'\"', 'deep':" + "[".repeat(1000) + "0" + "]".repeat(1000) + ", 'y':'\"'}";
        assertThrows(IOException.class, () -> ConversationBackupArchive.object(attack.getBytes(StandardCharsets.UTF_8)));
        for (String json : Arrays.asList("{unquoted:1}", "{\"x\":1, \"x\":2}", "{\"x\":/*comment*/1}", "{'x':1}"))
            assertThrows(IOException.class, () -> ConversationBackupArchive.object(json.getBytes(StandardCharsets.UTF_8)));
    }

    @Test public void rejectsForgedAttachmentReferencesEvenWithValidHashes() throws Exception {
        ChatAttachment file = attachment("hello");
        store.save(Collections.singletonList(message("user", "user", "hi", Collections.singletonList(file))));
        JSONObject snapshot = store.backupSnapshot(store.activeId());
        snapshot.getJSONObject("tree").getJSONArray("nodes").getJSONObject(0).getJSONArray("attachments")
                .getJSONObject(0).put("path", "/outside/private");
        File directory = new File(context.getCacheDir(), UUID.randomUUID().toString()); directory.mkdir();
        File conversation = new File(directory, "conversation.json"); writeUtf8(conversation.toPath(), snapshot.toString());
        Map<String, File> sources = new LinkedHashMap<>(); sources.put("conversation.json", conversation);
        sources.put("attachments/" + file.id, new File(file.path));
        File zip = new File(directory, "forged.zip");
        ConversationBackupArchive.pack(zip, sources, new JSONObject().put("title", "forged").put("nodes", 1).put("workspace", false));
        assertThrows(IOException.class, () -> backups.prepareImport(new FileInputStream(zip)));
        assertEquals(1, store.conversations().size());
        ConversationBackupArchive.deleteTree(directory);
    }

    private static JSONArray nativeSessionEntries(String notice, String answer, String cwd) throws Exception {
        String stamp = "2026-10-04T00:00:00.000Z";
        JSONObject usage = new JSONObject().put("input", 0).put("output", 0).put("cacheRead", 0).put("cacheWrite", 0)
                .put("totalTokens", 0).put("cost", new JSONObject().put("input", 0).put("output", 0)
                        .put("cacheRead", 0).put("cacheWrite", 0).put("total", 0));
        return new JSONArray()
                .put(new JSONObject().put("type", "session").put("version", 3)
                        .put("id", "11111111-2222-4333-8444-555555555555").put("timestamp", stamp).put("cwd", cwd))
                .put(new JSONObject().put("type", "message").put("id", "a1b2c3d4").put("parentId", JSONObject.NULL)
                        .put("timestamp", stamp).put("message", new JSONObject().put("role", "user").put("timestamp", 1791072000000L)
                                .put("content", new JSONArray().put(new JSONObject().put("type", "text").put("text", notice)))))
                .put(new JSONObject().put("type", "message").put("id", "b2c3d4e5").put("parentId", "a1b2c3d4")
                        .put("timestamp", stamp).put("message", new JSONObject().put("role", "assistant").put("timestamp", 1791072000001L)
                                .put("content", new JSONArray().put(new JSONObject().put("type", "text").put("text", answer)))
                                .put("api", "openai-completions").put("provider", "local").put("model", "mock").put("stopReason", "stop").put("usage", usage)));
    }

    private static void writeUtf8(java.nio.file.Path path, String text) throws IOException {
        Files.write(path, text.getBytes(StandardCharsets.UTF_8));
    }
    private static String readUtf8(java.nio.file.Path path) throws IOException {
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
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
