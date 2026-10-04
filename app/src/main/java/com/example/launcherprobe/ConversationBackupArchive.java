package com.example.launcherprobe;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Bounded, versioned data-only ZIP. Hashes detect damage, not the identity of its author. */
final class ConversationBackupArchive {
    static final long MAX_TOTAL = 128L * 1024 * 1024;
    static final long MAX_FILE = 32L * 1024 * 1024;
    static final int MAX_FILES = 4096;
    static final int MAX_JSON = 4 * 1024 * 1024;
    static final String FORMAT = "e-launcher-conversation";
    private ConversationBackupArchive() { }

    static final class Unpacked {
        final File directory;
        final JSONObject manifest;
        final LinkedHashMap<String, File> files;
        Unpacked(File directory, JSONObject manifest, LinkedHashMap<String, File> files) {
            this.directory = directory; this.manifest = manifest; this.files = files;
        }
    }

    static JSONObject pack(File target, Map<String, File> sources, JSONObject details) throws Exception {
        if (!sources.containsKey("conversation.json") || sources.size() > MAX_FILES)
            throw new IOException("备份文件数量无效 / Invalid file count");
        JSONObject manifest = new JSONObject(details.toString()).put("format", FORMAT).put("version", 1);
        JSONArray entries = new JSONArray();
        long total = 0;
        for (Map.Entry<String, File> source : sources.entrySet()) {
            validPath(source.getKey());
            requireRegular(source.getValue());
            long size = source.getValue().length();
            if (size > MAX_FILE || (total += size) > MAX_TOTAL) throw limit();
            entries.put(new JSONObject().put("path", source.getKey()).put("bytes", size)
                    .put("sha256", digest(source.getValue())));
        }
        manifest.put("files", entries).put("bytes", total);
        byte[] header = manifest.toString().getBytes(StandardCharsets.UTF_8);
        if (header.length > MAX_JSON) throw limit();
        boolean finished = false;
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(target.toPath(),
                StandardOpenOption.CREATE_NEW))) {
            zip.putNextEntry(new ZipEntry("manifest.json")); zip.write(header); zip.closeEntry();
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i);
                File source = sources.get(entry.getString("path"));
                zip.putNextEntry(new ZipEntry(entry.getString("path")));
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                long copied;
                try (InputStream input = Files.newInputStream(source.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                    copied = copy(input, zip, MAX_FILE, hash);
                }
                zip.closeEntry();
                if (copied != entry.getLong("bytes") || !hex(hash.digest()).equals(entry.getString("sha256")))
                    throw new IOException("备份时文件发生变化，请重试 / Source changed during backup");
            }
            finished = true;
        } finally { if (!finished) Files.deleteIfExists(target.toPath()); }
        return manifest;
    }

    static Unpacked unpack(InputStream source, File directory) throws Exception {
        if (!directory.mkdir()) throw new IOException("无法创建导入暂存目录 / Cannot create staging directory");
        boolean finished = false;
        try (LimitedInputStream bounded = new LimitedInputStream(source, MAX_TOTAL);
             ZipInputStream zip = new ZipInputStream(bounded)) {
            ZipEntry first = zip.getNextEntry();
            if (first == null || first.isDirectory() || !"manifest.json".equals(first.getName()))
                throw new IOException("不是会话备份 / Missing backup manifest");
            ByteArrayOutputStream header = new ByteArrayOutputStream();
            copy(zip, header, MAX_JSON, null); zip.closeEntry();
            JSONObject manifest = object(header.toByteArray());
            if (!FORMAT.equals(manifest.optString("format")) || !(manifest.opt("version") instanceof Number version) || version.doubleValue() != 1)
                throw new IOException("不支持的备份版本 / Unsupported backup version");
            JSONArray list = manifest.getJSONArray("files");
            if (list.length() == 0 || list.length() > MAX_FILES) throw limit();
            Map<String, JSONObject> expected = new LinkedHashMap<>();
            long total = 0;
            for (int i = 0; i < list.length(); i++) {
                JSONObject entry = list.getJSONObject(i);
                String path = entry.getString("path"); validPath(path);
                long size = integer(entry, "bytes");
                if (size < 0 || size > MAX_FILE || (total += size) > MAX_TOTAL) throw limit();
                if (!entry.getString("sha256").matches("[0-9a-f]{64}") || expected.put(path, entry) != null)
                    throw new IOException("备份清单重复或校验值无效 / Invalid manifest");
            }
            if (total != integer(manifest, "bytes") || !expected.containsKey("conversation.json"))
                throw new IOException("备份清单不完整 / Incomplete manifest");
            LinkedHashMap<String, File> files = new LinkedHashMap<>();
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                String path = entry.getName(); validPath(path);
                JSONObject info = expected.get(path);
                if (entry.isDirectory() || info == null || files.containsKey(path)) throw new IOException("备份条目无效 / Unexpected ZIP entry");
                File output = new File(directory, path);
                if (!output.getParentFile().isDirectory() && !output.getParentFile().mkdirs()) throw new IOException("无法创建暂存目录");
                requireInside(directory, output);
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                long count;
                // Never interpret ZIP Unix mode, link targets or executable bits: materialize ordinary files.
                try (OutputStream out = Files.newOutputStream(output.toPath(), StandardOpenOption.CREATE_NEW)) {
                    count = copy(zip, out, info.getLong("bytes"), hash);
                }
                zip.closeEntry();
                if (count != info.getLong("bytes") || !hex(hash.digest()).equals(info.getString("sha256")))
                    throw new IOException("备份损坏：大小或 SHA-256 不匹配 / Backup integrity check failed");
                files.put(path, output);
            }
            if (files.size() != expected.size()) throw new IOException("备份缺少文件 / Missing ZIP entries");
            byte[] remainder = new byte[32768];
            while (bounded.read(remainder) != -1) { /* Bound trailing ZIP metadata and provider bytes too. */ }
            finished = true;
            return new Unpacked(directory, manifest, files);
        } finally { if (!finished) deleteTree(directory); }
    }

    private static long integer(JSONObject object, String key) throws IOException {
        Object value = object.opt(key);
        if (!(value instanceof Number number) || number.doubleValue() != number.longValue())
            throw new IOException("Invalid integer field: " + key);
        return number.longValue();
    }

    static void validPath(String path) throws IOException {
        if (path == null || path.length() > 512 || path.startsWith("/") || path.contains("\\")
                || path.contains(":") || path.chars().anyMatch(c -> c < 32 || c == 127)) throw pathError();
        String[] parts = path.split("/", -1);
        if (parts.length > 20) throw pathError();
        for (String part : parts) if (part.isEmpty() || part.equals(".") || part.equals("..")) throw pathError();
        if (path.equals("conversation.json")) return;
        if (parts.length == 2 && parts[0].equals("attachments") && uuid(parts[1])) return;
        if (parts.length == 2 && parts[0].equals("contexts")
                && parts[1].matches("[0-9a-f-]{36}(\\.ui)?\\.json")
                && uuid(parts[1].substring(0, 36))) return;
        if (parts.length >= 2 && parts[0].equals("workspace")) {
            for (int i = 1; i < parts.length; i++) if (excluded(parts[i])) throw new IOException("备份包含排除的工作区文件 / Excluded workspace path");
            return;
        }
        throw pathError();
    }

    static boolean uuid(String value) {
        return value != null && value.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }

    static boolean excluded(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        return n.startsWith(".") || Arrays.asList("node_modules", "build", "dist", "target", "venv",
                "auth.json", "mcp-auth.json", "credentials", "credentials.json", "secrets", "secrets.json",
                "id_rsa", "id_dsa", "id_ed25519", "npmrc", "netrc").contains(n)
                || n.endsWith(".pem") || n.endsWith(".key") || n.endsWith(".p12") || n.endsWith(".pfx")
                || n.endsWith(".keystore") || n.endsWith(".jks")
                || n.startsWith("credentials.") || n.startsWith("auth.json.") || n.startsWith("mcp-auth.json.");
    }

    static JSONObject object(byte[] bytes) throws Exception {
        String json = jsonText(bytes);
        org.json.JSONTokener tokener = new org.json.JSONTokener(json);
        Object value = tokener.nextValue();
        if (tokener.nextClean() != 0) throw new IOException("Trailing JSON data");
        if (!(value instanceof JSONObject)) throw new IOException("JSON 必须是对象 / Expected JSON object");
        return (JSONObject) value;
    }

    static String jsonText(byte[] bytes) throws Exception {
        if (bytes.length > MAX_JSON) throw limit();
        String json = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString();
        validateStringLexemes(json);
        // Android JSONTokener is lenient (single quotes/comments/unquoted names). Validate with
        // the strict streaming reader before it sees the payload, and bound the same parsed nesting.
        try (android.util.JsonReader reader = new android.util.JsonReader(new StringReader(json))) {
            reader.setLenient(false);
            validateJson(reader, 0);
            if (reader.peek() != android.util.JsonToken.END_DOCUMENT) throw new IOException("Trailing JSON data");
        } catch (IllegalStateException | NumberFormatException failure) {
            throw new IOException("Invalid JSON", failure);
        }
        return json;
    }

    private static void validateStringLexemes(String json) throws IOException {
        boolean quoted = false;
        for (int i = 0; i < json.length(); i++) {
            char c = json.charAt(i);
            if (quoted) {
                if (c == '"') quoted = false;
                else if (c == '\\') {
                    if (++i >= json.length()) throw new IOException("Invalid JSON escape");
                    char escape = json.charAt(i);
                    if (escape == 'u') {
                        if (i + 4 >= json.length()) throw new IOException("Invalid JSON Unicode escape");
                        for (int n = 0; n < 4; n++)
                            if ("0123456789abcdefABCDEF".indexOf(json.charAt(++i)) < 0) throw new IOException("Invalid JSON Unicode escape");
                    } else if ("\"\\/bfnrt".indexOf(escape) < 0) throw new IOException("Invalid JSON escape");
                } else if (c < 32) throw new IOException("Unescaped JSON control character");
            } else if (c == '"') quoted = true;
            else if (" \t\r\n{}[]:,0123456789.-+eEtruefalsn".indexOf(c) < 0)
                throw new IOException("Nonstandard JSON token");
        }
        if (quoted) throw new IOException("Unclosed JSON string");
    }

    private static void validateJson(android.util.JsonReader reader, int depth) throws IOException {
        if (depth > 64) throw limit();
        switch (reader.peek()) {
            case BEGIN_OBJECT:
                reader.beginObject();
                Set<String> keys = new HashSet<>();
                while (reader.hasNext()) {
                    if (!keys.add(reader.nextName())) throw new IOException("Duplicate JSON key");
                    validateJson(reader, depth + 1);
                }
                reader.endObject(); break;
            case BEGIN_ARRAY:
                reader.beginArray();
                while (reader.hasNext()) validateJson(reader, depth + 1);
                reader.endArray(); break;
            case STRING: case NUMBER: reader.nextString(); break;
            case BOOLEAN: reader.nextBoolean(); break;
            case NULL: reader.nextNull(); break;
            default: throw new IOException("Invalid JSON token");
        }
    }

    static byte[] readJson(File file) throws Exception {
        requireRegular(file);
        if (file.length() > MAX_JSON) throw limit();
        try (InputStream in = Files.newInputStream(file.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            copy(in, out, MAX_JSON, null); return out.toByteArray();
        }
    }

    static void requireRegular(File file) throws IOException {
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(file.toPath()))
            throw new IOException("只支持普通文件 / Only regular files are supported");
    }

    static void requireInside(File root, File file) throws IOException {
        if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw pathError();
        for (File parent = file; parent != null && !parent.equals(root); parent = parent.getParentFile())
            if (Files.isSymbolicLink(parent.toPath())) throw pathError();
        if (Files.isSymbolicLink(root.toPath())) throw pathError();
    }

    static long copy(InputStream in, OutputStream out, long limit, MessageDigest hash) throws IOException {
        byte[] buffer = new byte[32768]; long size = 0;
        for (int n; (n = in.read(buffer)) != -1;) {
            if (n == 0) continue;
            if ((size += n) > limit) throw limit();
            if (hash != null) hash.update(buffer, 0, n);
            out.write(buffer, 0, n);
        }
        return size;
    }

    static String digest(File file) throws Exception {
        requireRegular(file);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = Files.newInputStream(file.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            copy(in, OutputStream.nullOutputStream(), MAX_FILE, digest);
        }
        return hex(digest.digest());
    }

    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format(Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }

    static void deleteTree(File file) throws IOException {
        if (!Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (!Files.isSymbolicLink(file.toPath()) && file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Cannot list staging directory");
            for (File child : children) deleteTree(child);
        }
        Files.delete(file.toPath());
    }

    private static IOException limit() { return new IOException("备份超出限制：128 MiB 总量、32 MiB 单文件、4096 文件 / Backup limit exceeded"); }
    private static IOException pathError() { return new IOException("不安全的备份路径 / Unsafe backup path"); }

    private static final class LimitedInputStream extends FilterInputStream {
        private final long limit; private long read;
        LimitedInputStream(InputStream input, long limit) { super(input); this.limit = limit; }
        @Override public int read() throws IOException { int b = in.read(); if (b >= 0 && ++read > limit) throw limit(); return b; }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            int n = in.read(b, off, len); if (n > 0 && (read += n) > limit) throw limit(); return n;
        }
    }
}
