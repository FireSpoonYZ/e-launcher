package com.example.launcherprobe;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Explicit single-conversation snapshots and clone-only, rollback-safe publication. */
final class ConversationBackups {
    final Context context;
    final ChatStore store;
    private final Runnable beforePack;
    ConversationBackups(Context context, ChatStore store) { this(context, store, () -> { }); }
    ConversationBackups(Context context, ChatStore store, Runnable beforePack) {
        this.context = context; this.store = store; this.beforePack = beforePack;
    }

    static final class Prepared {
        final String token = UUID.randomUUID().toString();
        final File directory, archive;
        final JSONObject manifest;
        final ConversationBackupArchive.Unpacked unpacked;
        Prepared(File directory, File archive, JSONObject manifest, ConversationBackupArchive.Unpacked unpacked) {
            this.directory = directory; this.archive = archive; this.manifest = manifest; this.unpacked = unpacked;
        }
        JSONObject preview() throws Exception {
            return new JSONObject().put("token", token).put("title", manifest.getString("title"))
                    .put("bytes", manifest.getLong("bytes")).put("files", manifest.getJSONArray("files").length())
                    .put("nodes", manifest.getInt("nodes")).put("workspace", manifest.getBoolean("workspace"))
                    .put("excluded", manifest.optInt("excluded")).put("missingContexts", manifest.optInt("missingContexts")).put("encrypted", false);
        }
        void close() throws IOException { ConversationBackupArchive.deleteTree(directory); }
    }

    private File cacheRoot() throws IOException {
        File root = new File(context.getCacheDir(), "conversation-backups");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot create backup cache");
        ConversationBackupArchive.requireInside(context.getCacheDir(), root);
        return root;
    }

    Prepared prepareExport(String id, boolean workspace) throws Exception {
        File directory = new File(cacheRoot(), UUID.randomUUID().toString());
        if (!directory.mkdir()) throw new IOException("Cannot create backup staging directory");
        boolean finished = false;
        try {
                JSONObject snapshot = store.backupSnapshot(id);
                String snapshotVersion = snapshot.toString();
                Map<File, String> observed = new LinkedHashMap<>();
                Map<String, File> sources = new LinkedHashMap<>();
                Map<String, String> attachmentPaths = new HashMap<>();
                collectExportAttachments(snapshot, sources, attachmentPaths);
                JSONObject portable = (JSONObject) rewriteAttachments(snapshot, attachmentPaths, null);
                File conversation = new File(directory, "conversation.json");
                writeJson(conversation, portable.toString());
                sources.put("conversation.json", conversation);
                File contexts = contextDirectory(id);
                Set<String> allowedContexts = contextNames(snapshot);
                for (String name : allowedContexts) {
                    File original = new File(contexts, name);
                    // AtomicFile backup recovery is part of reading a committed Pi context.
                    if (!original.exists() && !new File(original + ".bak").exists()) continue;
                    ConversationBackupArchive.requireInside(context.getFilesDir(), original);
                    if (Files.isSymbolicLink(original.toPath()) || Files.isSymbolicLink(new File(original + ".bak").toPath()))
                        throw new IOException("Pi context symlink is not supported");
                    byte[] bytes;
                    try (InputStream in = new android.util.AtomicFile(original).openRead()) {
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        ConversationBackupArchive.copy(in, out, ConversationBackupArchive.MAX_JSON, null);
                        bytes = out.toByteArray();
                    }
                    observed.put(original, ConversationBackupArchive.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)));
                    String json = ConversationBackupArchive.jsonText(bytes);
                    Object value = new org.json.JSONTokener(json).nextValue();
                    if (!(value instanceof JSONObject) && !(value instanceof JSONArray)) throw new IOException("Invalid Pi context");
                    collectExportAttachments(value, sources, attachmentPaths);
                    File copied = new File(directory, name);
                    writeJson(copied, rewriteAttachments(value, attachmentPaths, null).toString());
                    sources.put("contexts/" + name, copied);
                }
                int[] excluded = {0};
                if (workspace) collectWorkspace(new PiConfigStore(context, id).backupWorkspaceRoot(), "", sources, excluded, 0);
                // Copy into private staging without holding coordinator/store monitors.
                // Recheck originals and metadata after the copy; never silently accept a moving source.
                if (sources.size() > ConversationBackupArchive.MAX_FILES) throw new IOException("Too many backup files");
                Map<String, File> immutable = new LinkedHashMap<>();
                long total = 0;
                for (Map.Entry<String, File> source : sources.entrySet()) {
                    ConversationBackupArchive.validPath(source.getKey());
                    if ((total += source.getValue().length()) > ConversationBackupArchive.MAX_TOTAL) throw new IOException("Backup exceeds 128 MiB");
                    if (source.getValue().getParentFile().equals(directory)) {
                        immutable.put(source.getKey(), source.getValue()); continue;
                    }
                    String hash = ConversationBackupArchive.digest(source.getValue());
                    observed.put(source.getValue(), hash);
                    File copy = new File(directory, "payload/" + source.getKey());
                    if (!copy.getParentFile().isDirectory() && !copy.getParentFile().mkdirs()) throw new IOException("Cannot create snapshot staging");
                    try (InputStream in = Files.newInputStream(source.getValue().toPath(), LinkOption.NOFOLLOW_LINKS);
                         OutputStream out = Files.newOutputStream(copy.toPath(), StandardOpenOption.CREATE_NEW)) {
                        ConversationBackupArchive.copy(in, out, ConversationBackupArchive.MAX_FILE, null);
                    }
                    if (!hash.equals(ConversationBackupArchive.digest(copy))) throw new IOException("Source changed during snapshot; retry");
                    immutable.put(source.getKey(), copy);
                }
                for (Map.Entry<File, String> observation : observed.entrySet()) {
                    ConversationBackupArchive.requireInside(context.getFilesDir(), observation.getKey());
                    if (!observation.getValue().equals(ConversationBackupArchive.digest(observation.getKey())))
                        throw new IOException("Source changed during snapshot; retry");
                }
                if (!snapshotVersion.equals(store.backupSnapshot(id).toString())) throw new IOException("Conversation changed during snapshot; retry");
                int missingContexts = missingContexts(snapshot, sources.keySet());
                JSONObject details = new JSONObject().put("missingContexts", missingContexts).put("title", snapshot.getString("title"))
                        .put("nodes", snapshot.getJSONObject("tree").getJSONArray("nodes").length())
                        .put("workspace", workspace).put("excluded", excluded[0]).put("createdAt", System.currentTimeMillis());
                File archive = new File(directory, "conversation.zip");
                beforePack.run();
                JSONObject manifest = ConversationBackupArchive.pack(archive, immutable, details);
                if (archive.length() > ConversationBackupArchive.MAX_TOTAL) throw new IOException("Compressed backup exceeds 128 MiB");
                finished = true;
                return new Prepared(directory, archive, manifest, null);
        } finally { if (!finished) ConversationBackupArchive.deleteTree(directory); }
    }

    Prepared prepareImport(InputStream input) throws Exception {
        File directory = new File(cacheRoot(), UUID.randomUUID().toString());
        ConversationBackupArchive.Unpacked unpacked = ConversationBackupArchive.unpack(input, directory);
        boolean finished = false;
        try {
            JSONObject snapshot = readSnapshot(unpacked);
            validateContents(unpacked, snapshot);
            // Derive user-visible scope from validated payload, not untrusted descriptive fields.
            unpacked.manifest.put("title", snapshot.getString("title"))
                    .put("nodes", snapshot.getJSONObject("tree").getJSONArray("nodes").length())
                    .put("missingContexts", missingContexts(snapshot, unpacked.files.keySet()));
            finished = true;
            return new Prepared(directory, null, unpacked.manifest, unpacked);
        } finally { if (!finished) ConversationBackupArchive.deleteTree(directory); }
    }

    String restore(Prepared prepared, boolean workspace) throws Exception {
        if (prepared.unpacked == null) throw new IOException("No prepared import");
        ConversationBackupArchive.Unpacked unpacked = prepared.unpacked;
        JSONObject snapshot = readSnapshot(unpacked);
        validateContents(unpacked, snapshot);
        String id = UUID.randomUUID().toString();
        File staging = new File(prepared.directory, "publication-" + id);
        if (!staging.mkdir()) throw new IOException("Cannot stage restore publication");
        List<File> published = new ArrayList<>();
        Map<File, File> publication = new LinkedHashMap<>();
        boolean keepFiles = false;
        try {
            Map<String, String> paths = new HashMap<>(), ids = new HashMap<>();
            File attachmentRoot = new File(context.getFilesDir(), "chat-attachments");
            for (Map.Entry<String, File> item : unpacked.files.entrySet()) if (item.getKey().startsWith("attachments/")) {
                String original = item.getKey().substring("attachments/".length());
                String fresh = UUID.randomUUID().toString();
                File destination = new File(attachmentRoot, fresh), copy = new File(staging, fresh);
                stageCopy(item.getValue(), copy);
                publication.put(copy, destination);
                paths.put(item.getKey(), destination.getAbsolutePath()); ids.put(original, fresh);
            }
            JSONObject restored = (JSONObject) rewriteAttachments(snapshot, paths, ids);
            File contextStaging = new File(staging, "contexts"), workspaceStaging = new File(staging, "workspace");
            for (Map.Entry<String, File> item : unpacked.files.entrySet()) {
                String path = item.getKey();
                if (path.startsWith("contexts/")) {
                    if (!contextStaging.isDirectory() && !contextStaging.mkdir()) throw new IOException("Cannot stage contexts");
                    publication.put(contextStaging, contextDirectory(id));
                    File destination = new File(contextStaging, path.substring("contexts/".length()));
                    String text = ConversationBackupArchive.jsonText(ConversationBackupArchive.readJson(item.getValue()));
                    Object value = new org.json.JSONTokener(text).nextValue();
                    Object rewritten = rewriteAttachments(value, paths, ids);
                    if (path.endsWith(".ui.json")) ((JSONObject) rewritten).remove("askUser");
                    else if (rewritten instanceof JSONArray entries) for (int i = 0; i < entries.length(); i++) {
                        JSONObject entry = entries.optJSONObject(i);
                        if (entry != null && "session".equals(entry.optString("type")))
                            entry.put("cwd", new PiConfigStore(context, id).workspaceRoot().getAbsolutePath());
                    }
                    writeJson(destination, rewritten.toString());
                } else if (workspace && path.startsWith("workspace/")) {
                    File destination = new File(workspaceStaging, path.substring("workspace/".length()));
                    if (!destination.getParentFile().isDirectory() && !destination.getParentFile().mkdirs()) throw new IOException("Cannot stage workspace");
                    publication.put(workspaceStaging, new PiConfigStore(context, id).workspaceRoot());
                    stageCopy(item.getValue(), destination);
                }
            }
            // All validation, copying, rewriting and fsync occur before taking the shared store lock.
            // Only same-filesystem moves and the single index commit publish the complete clone.
            synchronized (ChatStore.backupLock()) {
                try {
                    for (Map.Entry<File, File> item : publication.entrySet()) {
                        File target = item.getValue();
                        ensureDirectory(target.getParentFile());
                        ConversationBackupArchive.requireInside(context.getFilesDir(), target);
                        if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("Restore destination already exists");
                        Files.move(item.getKey().toPath(), target.toPath());
                        published.add(target);
                    }
                    try { store.commitRestoredBackup(id, restored); }
                    catch (ChatStore.BackupCommitUncertainException failure) { keepFiles = true; throw failure; }
                    keepFiles = true;
                    return id;
                } finally {
                    if (!keepFiles) for (int i = published.size() - 1; i >= 0; i--)
                        ConversationBackupArchive.deleteTree(published.get(i));
                }
            }
        } finally {
            try { ConversationBackupArchive.deleteTree(staging); } catch (IOException ignored) { /* Cache only. */ }
        }
    }

    private static void stageCopy(File source, File target) throws Exception {
        try (InputStream in = Files.newInputStream(source.toPath(), LinkOption.NOFOLLOW_LINKS);
             FileOutputStream out = new FileOutputStream(Files.createFile(target.toPath()).toFile())) {
            ConversationBackupArchive.copy(in, out, ConversationBackupArchive.MAX_FILE, null);
            out.getFD().sync();
        }
    }

    private JSONObject readSnapshot(ConversationBackupArchive.Unpacked unpacked) throws Exception {
        JSONObject snapshot = ConversationBackupArchive.object(ConversationBackupArchive.readJson(unpacked.files.get("conversation.json")));
        ChatStore.validateBackupSnapshot(snapshot);
        return snapshot;
    }

    private void validateContents(ConversationBackupArchive.Unpacked unpacked, JSONObject snapshot) throws Exception {
        Set<String> contexts = contextNames(snapshot);
        Set<String> referenced = new HashSet<>();
        validateAttachments(snapshot, unpacked, referenced);
        boolean hasWorkspace = false;
        JSONArray files = unpacked.manifest.getJSONArray("files");
        for (int i = 0; i < files.length(); i++) {
            JSONObject entry = files.getJSONObject(i);
            File file = unpacked.files.get(entry.getString("path"));
            if (file.length() != entry.getLong("bytes") || !ConversationBackupArchive.digest(file).equals(entry.getString("sha256")))
                throw new IOException("Staged backup changed");
        }
        for (Map.Entry<String, File> item : unpacked.files.entrySet()) {
            String path = item.getKey();
            if (path.startsWith("contexts/")) {
                String name = path.substring("contexts/".length());
                if (!contexts.contains(name)) throw new IOException("Pi context does not belong to a conversation node");
                String text = ConversationBackupArchive.jsonText(ConversationBackupArchive.readJson(item.getValue()));
                Object value = new org.json.JSONTokener(text).nextValue();
                if (name.endsWith(".ui.json") ? !(value instanceof JSONObject) : !(value instanceof JSONArray))
                    throw new IOException("Invalid Pi context type");
                validateAttachments(value, unpacked, referenced);
            } else if (path.startsWith("workspace/")) hasWorkspace = true;
        }
        if (hasWorkspace && !unpacked.manifest.getBoolean("workspace")) throw new IOException("Workspace scope mismatch");
        for (String path : unpacked.files.keySet())
            if (path.startsWith("attachments/") && !referenced.contains(path)) throw new IOException("Unreferenced attachment");
    }

    private void collectExportAttachments(Object value, Map<String, File> sources, Map<String, String> paths) throws Exception {
        walkAttachments(value, attachment -> {
            ChatAttachment item = ChatAttachment.fromJson(attachment);
            if (!ConversationBackupArchive.uuid(item.id)) throw new IOException("Invalid attachment ID");
            File source = new AttachmentStore(context).requireFile(item);
            ConversationBackupArchive.requireInside(context.getFilesDir(), new File(item.path));
            ConversationBackupArchive.requireRegular(new File(item.path));
            if (source.length() != item.size) throw new IOException("Attachment size changed");
            String path = "attachments/" + item.id;
            sources.put(path, source); paths.put(item.path, path);
        });
    }

    private void validateAttachments(Object value, ConversationBackupArchive.Unpacked unpacked, Set<String> referenced) throws Exception {
        walkAttachments(value, attachment -> {
            ChatAttachment item = ChatAttachment.fromJson(attachment);
            String path = "attachments/" + item.id;
            File file = unpacked.files.get(path);
            if (!ConversationBackupArchive.uuid(item.id) || !path.equals(item.path) || file == null || file.length() != item.size)
                throw new IOException("Invalid attachment reference");
            referenced.add(path);
        });
    }

    interface AttachmentVisitor { void visit(JSONObject value) throws Exception; }
    private static void walkAttachments(Object value, AttachmentVisitor visitor) throws Exception {
        if (value instanceof JSONObject object) {
            if (object.has("id") && object.has("path") && object.has("mimeType")) visitor.visit(object);
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) walkAttachments(object.get(keys.next()), visitor);
        } else if (value instanceof JSONArray array) {
            for (int i = 0; i < array.length(); i++) walkAttachments(array.get(i), visitor);
        }
    }

    private static Object rewriteAttachments(Object value, Map<String, String> paths, Map<String, String> ids) throws Exception {
        // Reparse a copy: neither export nor restore ever mutates the source snapshot.
        Object copy = value instanceof JSONObject ? new JSONObject(value.toString()) : new JSONArray(value.toString());
        walkAttachments(copy, attachment -> {
            String mapped = paths.get(attachment.getString("path"));
            if (mapped == null) throw new IOException("Unmapped attachment reference");
            attachment.put("path", mapped);
            if (ids != null) {
                String fresh = ids.get(attachment.getString("id"));
                if (fresh == null) throw new IOException("Unmapped attachment identity");
                attachment.put("id", fresh);
            }
        });
        return copy;
    }

    private int missingContexts(JSONObject snapshot, Set<String> files) throws Exception {
        int count = 0;
        JSONArray nodes = snapshot.getJSONArray("piNodes");
        for (int i = 0; i < nodes.length(); i++) {
            String stem = UUID.nameUUIDFromBytes(nodes.getString(i).getBytes(StandardCharsets.UTF_8)).toString();
            if (!files.contains("contexts/" + stem + ".json")) count++;
        }
        return count;
    }

    private Set<String> contextNames(JSONObject snapshot) throws Exception {
        Set<String> names = new LinkedHashSet<>();
        JSONArray nodes = snapshot.getJSONObject("tree").getJSONArray("nodes");
        for (int i = 0; i < nodes.length(); i++) {
            String stem = UUID.nameUUIDFromBytes(nodes.getJSONObject(i).getString("id").getBytes(StandardCharsets.UTF_8)).toString();
            names.add(stem + ".json"); names.add(stem + ".ui.json");
        }
        return names;
    }

    private File contextDirectory(String id) {
        return new File(new File(context.getFilesDir(), "pi-contexts"),
                UUID.nameUUIDFromBytes(id.getBytes(StandardCharsets.UTF_8)).toString());
    }

    private void collectWorkspace(File root, String relative, Map<String, File> sources, int[] excluded, int depth) throws Exception {
        if (!Files.exists(root.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (depth > 18) throw new IOException("Workspace nesting exceeds backup limit");
        if (Files.isSymbolicLink(root.toPath())) { excluded[0]++; return; }
        ConversationBackupArchive.requireInside(context.getFilesDir(), root);
        if (root.isDirectory()) {
            File[] children = root.listFiles();
            if (children == null) throw new IOException("Cannot list workspace");
            Arrays.sort(children, Comparator.comparing(File::getName));
            for (File child : children) {
                if (ConversationBackupArchive.excluded(child.getName())) { excluded[0]++; continue; }
                collectWorkspace(child, relative.isEmpty() ? child.getName() : relative + "/" + child.getName(), sources, excluded, depth + 1);
            }
        } else {
            ConversationBackupArchive.requireRegular(root);
            if (sources.size() >= ConversationBackupArchive.MAX_FILES) throw new IOException("Too many workspace files");
            sources.put("workspace/" + relative, root);
        }
    }

    private void ensureDirectory(File directory) throws IOException {
        ConversationBackupArchive.requireInside(context.getFilesDir(), directory);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create restore directory");
    }

    private static void writeJson(File file, String text) throws Exception {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        ConversationBackupArchive.jsonText(bytes);
        try (FileOutputStream out = new FileOutputStream(Files.createFile(file.toPath()).toFile())) {
            out.write(bytes); out.getFD().sync();
        }
    }
}
