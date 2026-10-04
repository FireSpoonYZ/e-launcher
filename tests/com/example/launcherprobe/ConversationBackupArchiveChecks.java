package com.example.launcherprobe;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.zip.*;

/** Standalone ZIP checks; requires Android JsonReader and org.json (Android-all on the host). */
public final class ConversationBackupArchiveChecks {
    public static void main(String[] args) throws Exception {
        File root = Files.createTempDirectory("conversation-backup-checks").toFile();
        try {
            File conversation = new File(root, "conversation.json"); Files.writeString(conversation.toPath(), "{\"tree\":\"branches preserved\"}");
            File text = new File(root, "work.txt"); Files.writeString(text.toPath(), "workspace fixture");
            Map<String, File> sources = new LinkedHashMap<>(); sources.put("conversation.json", conversation); sources.put("workspace/work.txt", text);
            File zip = new File(root, "backup.zip");
            JSONObject manifest = ConversationBackupArchive.pack(zip, sources,
                    new JSONObject().put("title", "test").put("workspace", true).put("nodes", 0));
            ConversationBackupArchive.Unpacked unpacked = ConversationBackupArchive.unpack(new FileInputStream(zip), new File(root, "unpacked"));
            check(Files.readString(unpacked.files.get("conversation.json").toPath()).contains("branches preserved"), "conversation roundtrip");
            check("workspace fixture".equals(Files.readString(unpacked.files.get("workspace/work.txt").toPath())), "workspace roundtrip");
            for (String path : Arrays.asList("../escape", "/absolute", "workspace/../escape", "workspace/a\\b",
                    "workspace/.env", "workspace/.pi/auth.json", "workspace/id_rsa", "workspace/private.key",
                    "attachments/invalid", "workspace//x", "workspace/C:drive")) {
                rejects(() -> ConversationBackupArchive.validPath(path));
            }
            rejects(() -> ConversationBackupArchive.object(("[".repeat(65) + "0" + "]".repeat(65)).getBytes(StandardCharsets.UTF_8)));
            rejects(() -> ConversationBackupArchive.object("{} trailing".getBytes(StandardCharsets.UTF_8)));
            rejects(() -> ConversationBackupArchive.object(new byte[]{(byte) 0xc3, 0x28}));
            File link = new File(root, "symlink"); Files.createSymbolicLink(link.toPath(), text.toPath());
            rejects(() -> ConversationBackupArchive.requireRegular(link));
            for (String scenario : Arrays.asList("hash", "missing", "extra", "duplicate", "size", "version", "traversal", "inflate")) {
                JSONObject changed = new JSONObject(manifest.toString());
                Map<String, byte[]> data = new LinkedHashMap<>();
                data.put("conversation.json", Files.readAllBytes(conversation.toPath())); data.put("workspace/work.txt", Files.readAllBytes(text.toPath()));
                switch (scenario) {
                    case "hash": data.put("conversation.json", "wrong".getBytes(StandardCharsets.UTF_8)); break;
                    case "missing": data.remove("workspace/work.txt"); break;
                    case "extra": data.put("workspace/unlisted.txt", new byte[]{1}); break;
                    case "duplicate": changed.getJSONArray("files").put(changed.getJSONArray("files").getJSONObject(0)); break;
                    case "size": changed.getJSONArray("files").getJSONObject(0).put("bytes", ConversationBackupArchive.MAX_FILE + 1); break;
                    case "version": changed.put("version", 2); break;
                    case "traversal": changed.getJSONArray("files").getJSONObject(0).put("path", "../escape"); break;
                    case "inflate": data.put("conversation.json", new byte[1024 * 1024]); break;
                }
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (ZipOutputStream output = new ZipOutputStream(bytes)) {
                    output.putNextEntry(new ZipEntry("manifest.json")); output.write(changed.toString().getBytes(StandardCharsets.UTF_8)); output.closeEntry();
                    for (Map.Entry<String, byte[]> entry : data.entrySet()) {
                        output.putNextEntry(new ZipEntry(entry.getKey())); output.write(entry.getValue()); output.closeEntry();
                    }
                }
                File destination = new File(root, "rejected-" + scenario);
                rejects(() -> ConversationBackupArchive.unpack(new ByteArrayInputStream(bytes.toByteArray()), destination));
                check(!destination.exists(), "failed extraction cleaned: " + scenario);
            }
            System.out.println("PASS: ZIP roundtrip, 11 path attacks, UTF-8/depth/trailing JSON, symlink, hash/missing/extra/duplicate/size/version/traversal/inflation");
        } finally { ConversationBackupArchive.deleteTree(root); }
    }
    private interface Checked { void run() throws Exception; }
    private static void rejects(Checked action) throws Exception {
        try { action.run(); } catch (Exception expected) { return; }
        throw new AssertionError("Expected rejected input");
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
