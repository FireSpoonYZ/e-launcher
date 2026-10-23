package com.example.launcherprobe;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * M16 foundation: explicit read-only legacy snapshot export. Chat prefs are read only through
 * BotHostLegacyPreferences (committed on-disk chat.xml/.bak samples); never triggers the
 * SharedPreferences platform loader/backup repair and never writes source data. Publishing is
 * limited to filesDir/bot-host/legacy-staging/<snapshotId>/.
 */
public final class BotHostLegacySnapshot {

    private static final String ATTACHMENTS_DIR = "chat-attachments";
    private static final String PI_CONTEXTS_DIR = "pi-contexts";
    private static final String STAGING_SUBDIR = "legacy-staging";

    private static final long MAX_MANIFEST_BYTES = 2L * 1024 * 1024;
    private static final long MAX_JSON_FILE_BYTES = 32L * 1024 * 1024;
    private static final long MAX_ATTACHMENT_FILE_BYTES = 64L * 1024 * 1024;
    private static final long MAX_TOTAL_BYTES = 256L * 1024 * 1024;
    private static final int MAX_FILES = 4096;
    private static final int MAX_HISTORY_NODES = 10000;
    private static final int DEFAULT_LIST_LIMIT = 50;
    private static final int MAX_LIST_LIMIT = 200;
    private static final String SOURCE_KIND = "android-chat";

    private final Context context;
    private final File attachmentsRoot;
    private final File piContextsRoot;
    private final File stagingRoot;

    public BotHostLegacySnapshot(Context context) {
        this.context = context.getApplicationContext();
        this.attachmentsRoot = new File(this.context.getFilesDir(), ATTACHMENTS_DIR);
        this.piContextsRoot = new File(this.context.getFilesDir(), PI_CONTEXTS_DIR);
        this.stagingRoot = new File(new File(this.context.getFilesDir(), "bot-host"), STAGING_SUBDIR);
    }

    /** {items:[source metadata],nextCursor}; stable conversation-ID order over known sources. */
    public JSONObject list(String cursor, int limit) throws IOException {
        int page;
        if (limit == 0) page = DEFAULT_LIST_LIMIT;
        else if (limit < 0 || limit > MAX_LIST_LIMIT) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "limit 超出范围");
        } else {
            page = limit;
        }
        try (BotHostLegacyPreferences sample = BotHostLegacyPreferences.open(context)) {
            List<String> ids = candidateIds(sample);
            int start = (cursor == null || cursor.isEmpty()) ? 0 : ids.size();
            if (cursor != null && !cursor.isEmpty()) {
                for (int i = 0; i < ids.size(); i++) {
                    if (ids.get(i).compareTo(cursor) > 0) { start = i; break; }
                }
            }
            int end = Math.min(ids.size(), start + page);
            JSONObject index = conversationIndex(sample);
            Set<String> convKeys = new LinkedHashSet<>();
            Set<String> selectionKeys = new LinkedHashSet<>();
            for (int i = start; i < end; i++) {
                String id = ids.get(i);
                convKeys.add(historyKey(id));
                convKeys.add("draft_" + id);
                convKeys.add("draft_attachments_" + id);
                selectionKeys.add("pi_selection_" + id);
            }
            Map<String, Object> convValues = sample.readAll(convKeys);
            Map<String, Object> selectionValues = sample.readAll(selectionKeys);
            JSONArray items = new JSONArray();
            for (int i = start; i < end; i++) {
                items.put(sourceMetadata(ids.get(i), index, convValues, selectionValues));
            }
            try {
                return new JSONObject().put("items", items)
                        .put("nextCursor", end < ids.size() ? ids.get(end - 1) : JSONObject.NULL);
            } catch (JSONException e) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话数据无效");
            }
        }
    }

    /** Publishes {snapshotId,sourceKey,source} into the new Host staging namespace. */
    public JSONObject capture(String conversationId) throws IOException {
        if (conversationId == null || conversationId.isBlank()) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "conversationId is required");
        }
        try (BotHostLegacyPreferences sample = BotHostLegacyPreferences.open(context)) {
            if (!candidateIds(sample).contains(conversationId)) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话不存在或没有数据");
            }
        }
        File staging = requireStagingRoot();
        File temp = new File(staging, ".tmp-" + UUID.randomUUID());
        try {
            if (!temp.mkdirs()) {
                throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "无法创建临时快照目录");
            }
            CaptureData data = buildCapture(conversationId, temp);
            // Full no-output resample from an independent sample; mismatch means source changed.
            CaptureData resampled = buildCapture(conversationId, null);
            if (!resampled.snapshotId.equals(data.snapshotId)) {
                throw new BotHostProcess.BridgeException("BUSY", "not-sent", "源数据在捕获期间发生变化");
            }
            File target = new File(staging, data.snapshotId);
            if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                // Existing cache is only accepted when it passes exact validation; never overwritten.
                validateExistingSnapshot(target, data);
            } else if (!temp.renameTo(target)) {
                throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "无法发布快照");
            }
            return new JSONObject().put("snapshotId", data.snapshotId)
                    .put("sourceKey", SOURCE_KIND + ":" + conversationId)
                    .put("source", data.source);
        } catch (JSONException e) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话数据无效");
        } finally {
            // Always clean this run's temp (after rename it no longer exists).
            try { deleteTree(temp); } catch (IOException ignored) { }
        }
    }

    /** Read-only recompute of the canonical snapshot id; never writes output. */
    public boolean matches(String conversationId, String snapshotId) throws IOException {
        if (snapshotId == null || !snapshotId.matches("[0-9a-fA-F]{64}")) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "snapshotId 无效");
        }
        try (BotHostLegacyPreferences sample = BotHostLegacyPreferences.open(context)) {
            if (!candidateIds(sample).contains(conversationId)) return false;
        }
        CaptureData first = buildCapture(conversationId, null);
        CaptureData second = buildCapture(conversationId, null);
        if (!first.snapshotId.equals(second.snapshotId)) {
            throw new BotHostProcess.BridgeException("BUSY", "not-sent", "源数据在捕获期间发生变化");
        }
        return first.snapshotId.equals(snapshotId.toLowerCase(Locale.ROOT));
    }

    /** Removes only this new staging snapshot; caller must not discard an in-flight import. */
    public void discard(String snapshotId) throws IOException {
        if (snapshotId == null || !snapshotId.matches("[0-9a-fA-F]{64}")) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "snapshotId 无效");
        }
        String id = snapshotId.toLowerCase(Locale.ROOT);
        File staging = requireStagingRoot();
        File target = new File(staging, id);
        if (Files.isSymbolicLink(target.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照路径无效");
        }
        File canonical = target.getCanonicalFile();
        if (!canonical.getParentFile().equals(staging.getCanonicalFile())
                || !canonical.getName().equals(id)) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照路径无效");
        }
        if (!Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (!target.isDirectory()) return;
        try { deleteTree(target); }
        catch (IOException e) { throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "无法清理快照"); }
    }

    /** Read-only: derives android-chat:<originalConversationId> from a published staging manifest. */
    public String readSnapshotSourceKey(String snapshotId) throws IOException {
        if (snapshotId == null || !snapshotId.matches("[0-9a-fA-F]{64}")) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "snapshotId 无效");
        }
        String id = snapshotId.toLowerCase(Locale.ROOT);
        File staging = requireStagingRoot();
        File target = new File(staging, id);
        if (Files.isSymbolicLink(target.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照路径无效");
        }
        File canonical = target.getCanonicalFile();
        if (!canonical.getParentFile().equals(staging.getCanonicalFile())
                || !canonical.getName().equals(id)) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照路径无效");
        }
        File manifestFile = new File(target, "manifest.json");
        if (Files.isSymbolicLink(manifestFile.toPath()) || !manifestFile.isFile()) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
        }
        byte[] manifestBytes = readStrictUtf8(manifestFile, MAX_MANIFEST_BYTES);
        String computed = sha256Hex(manifestBytes);
        if (!computed.equals(id)) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
        }
        Object value = strictJson(new String(manifestBytes, StandardCharsets.UTF_8));
        if (!(value instanceof JSONObject)) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照数据无效");
        }
        JSONObject manifest = (JSONObject) value;
        Object version = manifest.opt("version");
        if (!(version instanceof Number) || ((Number) version).longValue() != 1L
                || ((Number) version).doubleValue() != 1.0d) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照数据无效");
        }
        JSONObject source = manifest.optJSONObject("source");
        Object kind = source == null ? null : source.opt("kind");
        Object applicationId = source == null ? null : source.opt("applicationId");
        Object conversationId = source == null ? null : source.opt("conversationId");
        if (!(kind instanceof String) || !SOURCE_KIND.equals(kind)
                || !(applicationId instanceof String)
                || !context.getPackageName().equals(applicationId)
                || !(conversationId instanceof String) || ((String) conversationId).isEmpty()) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照数据无效");
        }
        return SOURCE_KIND + ":" + conversationId;
    }

    // ----- listing -----

    private List<String> candidateIds(BotHostLegacyPreferences sample) throws IOException {
        JSONObject index = conversationIndex(sample);
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        Iterator<String> keys = index.keys();
        while (keys.hasNext()) ids.add(keys.next());
        Map<String, Object> meta = sample.readAll(Arrays.asList("active_chat", "home_draft"));
        String active = str(meta, "active_chat", "legacy");
        String home = str(meta, "home_draft", null);
        LinkedHashSet<String> candidates = new LinkedHashSet<>(ids);
        candidates.add(active);
        candidates.add("legacy");
        if (home != null) candidates.add(home);
        Set<String> convKeys = new LinkedHashSet<>();
        for (String c : candidates) {
            convKeys.add(historyKey(c));
            convKeys.add("draft_" + c);
            convKeys.add("draft_attachments_" + c);
        }
        Map<String, Object> conv = sample.readAll(convKeys);
        List<String> result = new ArrayList<>();
        for (String c : candidates) if (ids.contains(c) || hasData(conv, c)) result.add(c);
        Collections.sort(result);
        return result;
    }

    private static String str(Map<String, Object> values, String key, String def) {
        Object value = values.get(key);
        return value == null ? def : (String) value;
    }

    private boolean historyData(Map<String, Object> values, String conversationId) {
        String history = str(values, historyKey(conversationId), "");
        return !history.trim().isEmpty() && !"[]".equals(history.trim());
    }

    /** Empty defaults ([] / "") must not qualify as a real fallback source. */
    private boolean hasData(Map<String, Object> values, String conversationId) {
        if (historyData(values, conversationId)) return true;
        String draft = str(values, "draft_" + conversationId, "");
        if (!draft.isEmpty()) return true;
        String attachments = str(values, "draft_attachments_" + conversationId, "");
        return !attachments.trim().isEmpty() && !"[]".equals(attachments.trim());
    }

    private JSONObject sourceMetadata(String conversationId, JSONObject index,
            Map<String, Object> convValues, Map<String, Object> selectionValues) throws IOException {
        try {
            JSONObject entry = index.optJSONObject(conversationId);
            boolean indexed = entry != null;
            JSONObject item = new JSONObject().put("conversationId", conversationId);
            if (indexed) {
                if (entry.has("title")) {
                    Object title = entry.opt("title");
                    if (title == null || title == JSONObject.NULL) item.put("title", JSONObject.NULL);
                    else if (title instanceof String) item.put("title", title);
                    else throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话数据无效");
                } else {
                    item.put("title", JSONObject.NULL);
                }
                item.put("createdAt", timeField(entry, "created"));
                item.put("updatedAt", timeField(entry, "updated"));
                item.put("archivedAt", timeField(entry, "archivedAt"));
                item.put("draftOnly", entry.optBoolean("draft_only", false));
            } else {
                item.put("title", JSONObject.NULL);
                item.put("createdAt", JSONObject.NULL);
                item.put("updatedAt", JSONObject.NULL);
                item.put("archivedAt", JSONObject.NULL);
                item.put("draftOnly", !historyData(convValues, conversationId));
            }
            item.put("modelSelection", modelSelection(str(selectionValues, "pi_selection_" + conversationId, null)));
            return item;
        } catch (JSONException e) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话数据无效");
        }
    }

    private static Object timeField(JSONObject entry, String key) throws IOException {
        if (!entry.has(key) || entry.isNull(key)) return JSONObject.NULL;
        Object value = entry.opt(key);
        if (value instanceof Number) return ((Number) value).longValue();
        throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话数据无效");
    }

    /** Absent selection is null; explicit bad JSON or non-string fields are rejected. */
    private Object modelSelection(String selectionRaw) throws IOException, JSONException {
        if (selectionRaw == null) return JSONObject.NULL;
        Object value;
        try { value = strictJson(selectionRaw); }
        catch (IOException e) { throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "模型选择无效"); }
        if (!(value instanceof JSONObject)) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "模型选择无效");
        }
        JSONObject selection = (JSONObject) value;
        Object provider = selection.opt("provider");
        Object model = selection.opt("model");
        if (!(provider instanceof String) || ((String) provider).isEmpty()
                || !(model instanceof String) || ((String) model).isEmpty()) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "模型选择无效");
        }
        JSONObject result = new JSONObject().put("provider", provider).put("model", model);
        if (selection.has("thinkingLevel") && !selection.isNull("thinkingLevel")) {
            Object thinking = selection.opt("thinkingLevel");
            if (!(thinking instanceof String) || ((String) thinking).isEmpty()) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "模型选择无效");
            }
            result.put("thinkingLevel", thinking);
        }
        return result;
    }

    // ----- capture -----

    private CaptureData buildCapture(String conversationId, File tempDir) throws IOException {
        if (ChatCoordinator.runningIfPresent(conversationId)) {
            throw new BotHostProcess.BridgeException("BUSY", "not-sent", "会话任务正在运行");
        }
        try (BotHostLegacyPreferences sample = BotHostLegacyPreferences.open(context)) {
            CaptureData data = buildCapture(sample, conversationId, tempDir);
            if (ChatCoordinator.runningIfPresent(conversationId)) {
                throw new BotHostProcess.BridgeException("BUSY", "not-sent", "会话任务正在运行");
            }
            return data;
        }
    }

    private CaptureData buildCapture(BotHostLegacyPreferences sample, String conversationId, File tempDir)
            throws IOException {
        try {
            Set<String> basicKeys = new LinkedHashSet<>();
            basicKeys.add("conversations");
            basicKeys.add(historyKey(conversationId));
            basicKeys.add("draft_" + conversationId);
            basicKeys.add("draft_attachments_" + conversationId);
            basicKeys.add("pi_selection_" + conversationId);
            basicKeys.add("pi_nodes_" + conversationId);
            Map<String, Object> basic = sample.readAll(basicKeys);

            String historyRaw = str(basic, historyKey(conversationId), "[]");
            String draftRaw = str(basic, "draft_" + conversationId, "");
            String draftAttachmentsRaw = str(basic, "draft_attachments_" + conversationId, "[]");
            List<String> nativeNodes = sortedStrings(basic.get("pi_nodes_" + conversationId));

            byte[] historyBytes = encodeStrictUtf8(historyRaw);
            if (historyBytes.length > MAX_JSON_FILE_BYTES) {
                throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "源文件超限");
            }
            byte[] draftBytes = encodeStrictUtf8(draftRaw);
            if (draftBytes.length > MAX_JSON_FILE_BYTES) {
                throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "源文件超限");
            }
            byte[] draftAttachmentsBytes = encodeStrictUtf8(draftAttachmentsRaw);
            if (draftAttachmentsBytes.length > MAX_JSON_FILE_BYTES) {
                throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "源文件超限");
            }
            // Parse only after size limits already passed.
            HistoryInfo history = parseHistory(historyRaw);
            List<ChatAttachment> draftAttachments = parseDraftAttachments(draftAttachmentsRaw);
            List<String> pendingUserIds = pendingUserIds(sample, conversationId, nativeNodes, history.ids);

            List<FileEntry> files = new ArrayList<>();
            long totalBytes = 0;
            int fileCount = 0;

            checkBudget(totalBytes, fileCount, historyBytes.length);
            if (tempDir != null) writeFile(new File(tempDir, "history.json"), historyBytes);
            files.add(new FileEntry("history.json", "history", null, historyBytes.length, sha256Hex(historyBytes)));
            totalBytes += historyBytes.length; fileCount++;

            checkBudget(totalBytes, fileCount, draftBytes.length);
            if (tempDir != null) writeFile(new File(tempDir, "draft.txt"), draftBytes);
            files.add(new FileEntry("draft.txt", "draft", null, draftBytes.length, sha256Hex(draftBytes)));
            totalBytes += draftBytes.length; fileCount++;

            checkBudget(totalBytes, fileCount, draftAttachmentsBytes.length);
            if (tempDir != null) writeFile(new File(tempDir, "draft-attachments.json"), draftAttachmentsBytes);
            files.add(new FileEntry("draft-attachments.json", "draft-attachments", null,
                    draftAttachmentsBytes.length, sha256Hex(draftAttachmentsBytes)));
            totalBytes += draftAttachmentsBytes.length; fileCount++;

            List<ChatAttachment> allDescriptors = new ArrayList<>(history.attachments);
            allDescriptors.addAll(draftAttachments);
            LinkedHashMap<String, ChatAttachment> descriptorsById = new LinkedHashMap<>();
            Map<String, String> shaToPath = new LinkedHashMap<>();
            LinkedHashMap<String, JSONObject> attachmentEntries = new LinkedHashMap<>();
            for (ChatAttachment attachment : allDescriptors) {
                File source = requireAttachmentFile(attachment);
                ChatAttachment previous = descriptorsById.get(attachment.id);
                if (previous != null) {
                    if (!previous.name.equals(attachment.name) || !previous.mimeType.equals(attachment.mimeType)
                            || !previous.kind.equals(attachment.kind) || previous.size != attachment.size
                            || !requireAttachmentFile(previous).equals(source)) {
                        throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件来源冲突");
                    }
                    continue; // identical descriptor id + identical file; keep the first.
                }
                descriptorsById.put(attachment.id, attachment);
                long length = source.length();
                if (attachment.size > 0 && length != attachment.size) {
                    throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件大小不一致");
                }
                if (length > MAX_ATTACHMENT_FILE_BYTES) {
                    throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "源文件超限");
                }
                String sha = copyHashed(source, null, MAX_ATTACHMENT_FILE_BYTES, length, false);
                String path = "attachments/" + sha;
                boolean firstSeen = !shaToPath.containsKey(sha);
                if (firstSeen) {
                    checkBudget(totalBytes, fileCount, length);
                    if (tempDir != null) {
                        String copiedSha = copyHashed(source, new File(tempDir, path),
                                MAX_ATTACHMENT_FILE_BYTES, length, false);
                        if (!copiedSha.equals(sha)) {
                            throw new BotHostProcess.BridgeException("BUSY", "not-sent", "源数据在捕获期间发生变化");
                        }
                    }
                    shaToPath.put(sha, path);
                    files.add(new FileEntry(path, "attachment", null, length, sha));
                    totalBytes += length; fileCount++;
                }
                attachmentEntries.put(attachment.id, new JSONObject()
                        .put("id", attachment.id).put("name", attachment.name)
                        .put("mimeType", attachment.mimeType).put("kind", attachment.kind)
                        .put("size", length).put("sha256", sha)
                        .put("path", path).put("sourcePath", ATTACHMENTS_DIR + "/" + attachment.id));
            }

            String contextDirName = UUID.nameUUIDFromBytes(
                    encodeStrictUtf8(conversationId)).toString();
            File contextDir = new File(piContextsRoot, contextDirName);
            LinkedHashSet<String> refIds = new LinkedHashSet<>(nativeNodes);
            refIds.addAll(history.ids);
            for (String nodeId : refIds) {
                String name = UUID.nameUUIDFromBytes(encodeStrictUtf8(nodeId)).toString();
                File context = contextSource(contextDir, name + ".json");
                if (context != null) {
                    long length = context.length();
                    checkBudget(totalBytes, fileCount, length);
                    String rel = "contexts/" + name + ".json";
                    String sha = copyHashed(context, null, MAX_JSON_FILE_BYTES, length, true);
                    if (tempDir != null) {
                        String copiedSha = copyHashed(context, new File(tempDir, rel),
                                MAX_JSON_FILE_BYTES, length, true);
                        if (!copiedSha.equals(sha)) {
                            throw new BotHostProcess.BridgeException("BUSY", "not-sent", "源数据在捕获期间发生变化");
                        }
                    }
                    files.add(new FileEntry(rel, "sdk", nodeId, length, sha));
                    totalBytes += length; fileCount++;
                }
                File ui = contextSource(contextDir, name + ".ui.json");
                if (ui != null) {
                    long length = ui.length();
                    checkBudget(totalBytes, fileCount, length);
                    String rel = "ui/" + name + ".json";
                    String sha = copyHashed(ui, null, MAX_JSON_FILE_BYTES, length, true);
                    if (tempDir != null) {
                        String copiedSha = copyHashed(ui, new File(tempDir, rel),
                                MAX_JSON_FILE_BYTES, length, true);
                        if (!copiedSha.equals(sha)) {
                            throw new BotHostProcess.BridgeException("BUSY", "not-sent", "源数据在捕获期间发生变化");
                        }
                    }
                    files.add(new FileEntry(rel, "ui", nodeId, length, sha));
                    totalBytes += length; fileCount++;
                }
            }
            files.sort(Comparator.comparing(f -> f.path));

            String indexRaw = str(basic, "conversations", "{}");
            Object indexValue = strictJson(indexRaw);
            if (!(indexValue instanceof JSONObject)) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话列表无效");
            }
            JSONObject index = (JSONObject) indexValue;
            JSONObject source = new JSONObject()
                    .put("kind", SOURCE_KIND).put("applicationId", context.getPackageName())
                    .put("conversationId", conversationId);
            JSONObject meta = sourceMetadata(conversationId, index, basic, basic);
            source.put("title", meta.get("title")).put("createdAt", meta.get("createdAt"))
                    .put("updatedAt", meta.get("updatedAt")).put("archivedAt", meta.get("archivedAt"))
                    .put("draftOnly", meta.getBoolean("draftOnly")).put("modelSelection", meta.get("modelSelection"));

            JSONArray nativeArray = new JSONArray();
            for (String node : nativeNodes) nativeArray.put(node);
            JSONArray pendingArray = new JSONArray();
            for (String node : pendingUserIds) pendingArray.put(node);
            JSONArray filesArray = new JSONArray();
            for (FileEntry entry : files) {
                JSONObject fileEntry = new JSONObject().put("path", entry.path)
                        .put("kind", entry.kind).put("size", entry.size).put("sha256", entry.sha256);
                if (entry.nodeId != null) fileEntry.put("nodeId", entry.nodeId);
                filesArray.put(fileEntry);
            }
            List<JSONObject> sortedAttachments = new ArrayList<>(attachmentEntries.values());
            sortedAttachments.sort(Comparator.comparing(o -> o.optString("id")));
            JSONArray attachmentsArray = new JSONArray();
            for (JSONObject entry : sortedAttachments) attachmentsArray.put(entry);

            JSONObject manifest = new JSONObject().put("version", 1).put("source", source)
                    .put("nativeNodes", nativeArray).put("pendingUserIds", pendingArray)
                    .put("files", filesArray).put("attachments", attachmentsArray);
            byte[] manifestBytes = encodeStrictUtf8(manifest.toString());
            if (manifestBytes.length > MAX_MANIFEST_BYTES) {
                throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "快照清单超限");
            }
            checkBudget(totalBytes, fileCount, manifestBytes.length);
            String snapshotId = sha256Hex(manifestBytes);
            if (tempDir != null) writeFile(new File(tempDir, "manifest.json"), manifestBytes);
            return new CaptureData(snapshotId, source, manifestBytes, files);
        } catch (JSONException e) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话数据无效");
        }
    }

    private static List<String> sortedStrings(Object value) {
        List<String> list = new ArrayList<>();
        if (value instanceof Collection) {
            for (Object item : (Collection<?>) value) if (item instanceof String) list.add((String) item);
        }
        Collections.sort(list);
        return list;
    }

    private static void checkBudget(long totalBytes, int fileCount, long addedBytes) throws IOException {
        if (fileCount + 1 > MAX_FILES) {
            throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "快照文件数量超限");
        }
        if (totalBytes + addedBytes > MAX_TOTAL_BYTES) {
            throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "快照总大小超限");
        }
    }

    private List<String> pendingUserIds(BotHostLegacyPreferences sample, String conversationId,
            List<String> nativeNodes, List<String> historyIds) throws IOException {
        LinkedHashSet<String> candidates = new LinkedHashSet<>(nativeNodes);
        candidates.addAll(historyIds);
        String prefix = "pi_pending_" + conversationId + "_";
        Set<String> keys = new LinkedHashSet<>();
        for (String node : candidates) keys.add(prefix + node);
        Map<String, Object> values = sample.readAll(keys);
        List<String> pending = new ArrayList<>();
        for (String node : candidates) if (Boolean.TRUE.equals(values.get(prefix + node))) pending.add(node);
        Collections.sort(pending);
        return pending;
    }

    private static String historyKey(String conversation) {
        return "legacy".equals(conversation) ? "history" : "history_" + conversation;
    }

    private JSONObject conversationIndex(BotHostLegacyPreferences sample) throws IOException {
        Map<String, Object> meta = sample.readAll(Collections.singleton("conversations"));
        Object value = strictJson(str(meta, "conversations", "{}"));
        if (!(value instanceof JSONObject)) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "会话列表无效");
        }
        return (JSONObject) value;
    }

    private static Object strictJson(String text) throws IOException {
        try {
            JSONTokener tokener = new JSONTokener(text == null ? "" : text);
            Object value = tokener.nextValue();
            if (tokener.nextClean() != 0) throw new IOException("trailing data");
            return value;
        } catch (Exception e) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "JSON 解析失败");
        }
    }

    private static final class HistoryInfo {
        final List<String> ids;
        final List<ChatAttachment> attachments;
        HistoryInfo(List<String> ids, List<ChatAttachment> attachments) {
            this.ids = ids;
            this.attachments = attachments;
        }
    }

    private HistoryInfo parseHistory(String raw) throws IOException {
        Object value = strictJson(raw);
        JSONArray nodes;
        if (value instanceof JSONArray) {
            nodes = (JSONArray) value;
        } else if (value instanceof JSONObject) {
            JSONObject envelope = (JSONObject) value;
            Object version = envelope.opt("version");
            if (!(version instanceof Number) || ((Number) version).longValue() != 1L
                    || ((Number) version).doubleValue() != 1.0d) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "聊天记录无效");
            }
            nodes = envelope.optJSONArray("nodes");
            if (nodes == null) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "聊天记录无效");
            }
        } else {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "聊天记录无效");
        }
        if (nodes.length() > MAX_HISTORY_NODES) {
            throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "聊天记录节点超限");
        }
        List<String> ids = new ArrayList<>();
        List<ChatAttachment> attachments = new ArrayList<>();
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject node = nodes.optJSONObject(i);
            if (node == null) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "聊天记录无效");
            }
            Object id = node.opt("id");
            if (id instanceof String) ids.add((String) id);
            if (node.has("attachments")) {
                JSONArray stored = node.optJSONArray("attachments");
                if (stored == null) {
                    throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "聊天记录无效");
                }
                for (int j = 0; j < stored.length(); j++) {
                    JSONObject desc = stored.optJSONObject(j);
                    if (desc == null) {
                        throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件描述无效");
                    }
                    attachments.add(parseAttachment(desc));
                }
            }
        }
        return new HistoryInfo(ids, attachments);
    }

    /** Strict descriptor validation: real field types, no optString/optLong coercion. */
    private static ChatAttachment parseAttachment(JSONObject desc) throws IOException {
        Object idValue = desc.opt("id");
        Object pathValue = desc.opt("path");
        if (!(idValue instanceof String) || ((String) idValue).isEmpty()
                || !(pathValue instanceof String) || ((String) pathValue).isEmpty()) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件描述无效");
        }
        Object nameValue = desc.opt("name");
        String name = nameValue instanceof String && !((String) nameValue).isEmpty()
                ? (String) nameValue : "附件";
        Object mimeValue = desc.opt("mimeType");
        String mimeType = mimeValue instanceof String && !((String) mimeValue).isEmpty()
                ? (String) mimeValue : "application/octet-stream";
        Object kindValue = desc.opt("kind");
        String kind;
        if (kindValue == null || kindValue == JSONObject.NULL) {
            kind = "file";
        } else if (kindValue instanceof String
                && ("image".equals(kindValue) || "file".equals(kindValue))) {
            kind = (String) kindValue;
        } else {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件描述无效");
        }
        Object sizeValue = desc.opt("size");
        long size = 0;
        if (sizeValue != null && sizeValue != JSONObject.NULL) {
            if (!(sizeValue instanceof Number)) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件描述无效");
            }
            double value = ((Number) sizeValue).doubleValue();
            long asLong = ((Number) sizeValue).longValue();
            if (value != (double) asLong || asLong < 0) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件描述无效");
            }
            size = asLong;
        }
        return new ChatAttachment((String) idValue, name, mimeType, kind, size, (String) pathValue);
    }

    private List<ChatAttachment> parseDraftAttachments(String raw) throws IOException {
        Object value = strictJson(raw);
        if (!(value instanceof JSONArray)) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "草稿附件无效");
        }
        JSONArray array = (JSONArray) value;
        List<ChatAttachment> result = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject desc = array.optJSONObject(i);
            if (desc == null) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "草稿附件无效");
            }
            result.add(parseAttachment(desc));
        }
        return result;
    }

    /** Validates descriptor.path against the canonical root/id; symlinks rejected pre-resolution. */
    private File requireAttachmentFile(ChatAttachment attachment) throws IOException {
        String id = attachment.id;
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}") || attachment.path == null) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件来源无效");
        }
        if (Files.isSymbolicLink(attachmentsRoot.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件来源无效");
        }
        File raw = new File(attachment.path);
        File rooted = new File(attachmentsRoot, id);
        if (Files.isSymbolicLink(raw.toPath()) || Files.isSymbolicLink(rooted.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件来源无效");
        }
        File root = attachmentsRoot.getCanonicalFile();
        File canonical = raw.getCanonicalFile();
        File expected = rooted.getCanonicalFile();
        if (!canonical.equals(expected) || !raw.isFile()) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "附件来源无效");
        }
        return raw;
    }

    private File contextSource(File dir, String base) throws IOException {
        if (Files.isSymbolicLink(piContextsRoot.toPath()) || Files.isSymbolicLink(dir.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "Pi 上下文路径无效");
        }
        File root = piContextsRoot.getCanonicalFile();
        File directory = dir.getCanonicalFile();
        if (!directory.getPath().startsWith(root.getPath() + File.separator)) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "Pi 上下文路径无效");
        }
        File bak = new File(directory, base + ".bak");
        File primary = new File(directory, base);
        if (Files.isSymbolicLink(bak.toPath()) || Files.isSymbolicLink(primary.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "Pi 上下文路径无效");
        }
        File selected = bak.isFile() ? bak : (primary.isFile() ? primary : null);
        if (selected == null) return null;
        File canonical = selected.getCanonicalFile();
        if (!canonical.getPath().startsWith(directory.getPath() + File.separator)) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "Pi 上下文路径无效");
        }
        return selected;
    }

    /** bot-host and legacy-staging directory links are rejected before any use. */
    private File requireStagingRoot() throws IOException {
        File botHost = new File(context.getFilesDir(), "bot-host");
        if (Files.isSymbolicLink(botHost.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照路径无效");
        }
        File root = new File(botHost, STAGING_SUBDIR);
        if (Files.isSymbolicLink(root.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "快照路径无效");
        }
        return root;
    }

    /** Exact validation of an already-published snapshot; rejects corrupted cache. */
    private void validateExistingSnapshot(File target, CaptureData data) throws IOException {
        if (Files.isSymbolicLink(target.toPath()) || !target.isDirectory()) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
        }
        Set<String> allowed = new HashSet<>();
        allowed.add("manifest.json");
        for (FileEntry entry : data.files) allowed.add(entry.path);
        List<String> found = new ArrayList<>();
        walkSnapshot(target, target, found, allowed);
        if (found.size() != allowed.size()) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
        }
        File manifestFile = new File(target, "manifest.json");
        byte[] storedManifest = readStrictUtf8(manifestFile, MAX_MANIFEST_BYTES);
        if (!Arrays.equals(storedManifest, data.manifestBytes)) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
        }
        for (FileEntry entry : data.files) {
            File file = new File(target, entry.path);
            boolean attachment = "attachment".equals(entry.kind);
            if (!file.isFile() || file.length() != entry.size) {
                throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
            }
            long max = attachment ? MAX_ATTACHMENT_FILE_BYTES : MAX_JSON_FILE_BYTES;
            String sha = copyHashed(file, null, max, entry.size, !attachment);
            if (!sha.equals(entry.sha256)) {
                throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
            }
        }
    }

    /** Rejects symlinks, unknown files and unexpected directories inside a snapshot cache. */
    private static void walkSnapshot(File dir, File root, List<String> files, Set<String> allowed)
            throws IOException {
        File[] children = dir.listFiles();
        if (children == null) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
        }
        for (File child : children) {
            if (Files.isSymbolicLink(child.toPath())) {
                throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
            }
            String rel = root.toPath().relativize(child.toPath()).toString()
                    .replace(File.separatorChar, '/');
            if (child.isDirectory()) {
                if (rel.indexOf('/') >= 0
                        || (!"contexts".equals(rel) && !"ui".equals(rel) && !"attachments".equals(rel))) {
                    throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
                }
                walkSnapshot(child, root, files, allowed);
            } else {
                if (!allowed.contains(rel)) {
                    throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "快照缓存损坏");
                }
                files.add(rel);
            }
        }
    }

    private static byte[] encodeStrictUtf8(String text) throws IOException {
        try {
            CharsetEncoder encoder = StandardCharsets.UTF_8.newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            ByteBuffer buffer = encoder.encode(CharBuffer.wrap(text));
            byte[] bytes = new byte[buffer.remaining()];
            buffer.get(bytes);
            return bytes;
        } catch (CharacterCodingException e) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "文本编码无效");
        }
    }

    private static void validateStrictUtf8(byte[] bytes) throws IOException {
        try {
            CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            decoder.decode(ByteBuffer.wrap(bytes));
        } catch (CharacterCodingException e) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "源文件非 UTF-8");
        }
    }

    private static byte[] readStrictUtf8(File file, long max) throws IOException {
        try {
            try (InputStream in = new FileInputStream(file)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[32768];
                long total = 0;
                int count;
                while ((count = in.read(buffer)) != -1) {
                    total += count;
                    if (total > max) {
                        throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "源文件超限");
                    }
                    out.write(buffer, 0, count);
                }
                byte[] bytes = out.toByteArray();
                validateStrictUtf8(bytes);
                return bytes;
            }
        } catch (BotHostProcess.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "读取源文件失败");
        }
    }

    private static void drain(CharBuffer chars) {
        chars.flip();
        while (chars.hasRemaining()) chars.get();
        chars.clear();
    }

    private static BotHostProcess.BridgeException utf8Error() {
        return new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "源文件非 UTF-8");
    }

    /** Incremental decode: leftovers underflow are kept and compacted into the next chunk. */
    private static void feedDecoder(CharsetDecoder decoder, ByteBuffer pending, CharBuffer chars,
            byte[] buffer, int count) throws IOException {
        pending.put(buffer, 0, count);
        pending.flip();
        while (pending.hasRemaining()) {
            CoderResult result = decoder.decode(pending, chars, false);
            drain(chars);
            if (result.isError()) throw utf8Error();
            if (result.isUnderflow()) break;
        }
        pending.compact();
    }

    private static void finishDecoder(CharsetDecoder decoder, ByteBuffer pending, CharBuffer chars)
            throws IOException {
        pending.flip(); // read the compacted leftover tail bytes, not free space.
        while (true) {
            CoderResult result = decoder.decode(pending, chars, true);
            drain(chars);
            if (result.isError()) throw utf8Error();
            if (result.isUnderflow()) break;
        }
        while (true) {
            CoderResult result = decoder.flush(chars);
            drain(chars);
            if (result.isError()) throw utf8Error();
            if (result.isUnderflow()) break;
        }
    }

    /** Streaming bounded copy while hashing; target==null hashes only (no output). */
    private static String copyHashed(File source, File target, long max, long expectedLength, boolean utf8)
            throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (Exception e) { throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "哈希计算失败"); }
        CharsetDecoder decoder = null;
        ByteBuffer pending = null;
        CharBuffer chars = null;
        if (utf8) {
            decoder = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            pending = ByteBuffer.allocate(32768 + 4);
            chars = CharBuffer.allocate(4096);
        }
        try (InputStream in = new FileInputStream(source)) {
            OutputStream out = null;
            if (target != null) out = openOutput(target);
            try {
                byte[] buffer = new byte[32768];
                long total = 0;
                int count;
                while ((count = in.read(buffer)) != -1) {
                    total += count;
                    if (total > max) {
                        throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "源文件超限");
                    }
                    if (expectedLength >= 0 && total > expectedLength) {
                        throw new BotHostProcess.BridgeException("BUSY", "not-sent", "源数据在捕获期间发生变化");
                    }
                    digest.update(buffer, 0, count);
                    if (out != null) out.write(buffer, 0, count);
                    if (decoder != null) feedDecoder(decoder, pending, chars, buffer, count);
                }
                if (decoder != null) finishDecoder(decoder, pending, chars);
                if (expectedLength >= 0 && total != expectedLength) {
                    throw new BotHostProcess.BridgeException("BUSY", "not-sent", "源数据在捕获期间发生变化");
                }
                return hex(digest.digest());
            } finally {
                if (out != null) out.close(); // close errors propagate; never swallowed.
            }
        } catch (BotHostProcess.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "读取源文件失败");
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static String sha256Hex(byte[] bytes) throws IOException {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "哈希计算失败");
        }
    }

    private static OutputStream openOutput(File target) throws IOException {
        File parent = target.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "无法创建快照目录");
        }
        return new FileOutputStream(target);
    }

    private static void writeFile(File target, byte[] bytes) throws IOException {
        try (OutputStream out = openOutput(target)) {
            out.write(bytes);
        } catch (BotHostProcess.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "无法写入快照文件");
        }
    }

    private static void deleteTree(File file) throws IOException {
        if (!Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (!Files.isSymbolicLink(file.toPath()) && file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("无法读取待清理目录");
            for (File child : children) deleteTree(child);
        }
        if (!file.delete()) throw new IOException("无法清理临时目录");
    }

    private static final class FileEntry {
        final String path;
        final String kind;
        final String nodeId;
        final long size;
        final String sha256;
        FileEntry(String path, String kind, String nodeId, long size, String sha256) {
            this.path = path;
            this.kind = kind;
            this.nodeId = nodeId;
            this.size = size;
            this.sha256 = sha256;
        }
    }

    private static final class CaptureData {
        final String snapshotId;
        final JSONObject source;
        final byte[] manifestBytes;
        final List<FileEntry> files;
        CaptureData(String snapshotId, JSONObject source, byte[] manifestBytes, List<FileEntry> files) {
            this.snapshotId = snapshotId;
            this.source = source;
            this.manifestBytes = manifestBytes;
            this.files = files;
        }
    }
}
