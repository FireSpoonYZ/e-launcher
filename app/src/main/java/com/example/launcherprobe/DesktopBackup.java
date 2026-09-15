package com.example.launcherprobe;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import org.json.JSONException;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Desktop-only backups. HomeLayout owns schema validation and widget restoration. */
public final class DesktopBackup {
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private static final String FORMAT = "e-launcher-desktop";
    private final Context context;
    private final DesktopPreferences prefs;
    private final File directory;
    public DesktopBackup(Context context) {
        this.context = context.getApplicationContext();
        prefs = new DesktopPreferences(context);
        directory = new File(context.getFilesDir(), "desktop-backups");
    }
    public JSONObject capture() throws Exception {
        String layout = context.getSharedPreferences("launcher_home", Context.MODE_PRIVATE).getString("layout", null);
        if (layout == null) throw new IOException("桌面尚未初始化，请先返回桌面");
        // Normalizing at export also prevents exporting device-local AppWidget IDs.
        JSONObject normalized = HomeLayout.validateBackup(new JSONObject(layout));
        return new JSONObject().put("format", FORMAT).put("version", 1)
                .put("createdAt", System.currentTimeMillis()).put("layout", normalized)
                .put("settings", prefs.exportSettings());
    }
    public synchronized File snapshot() throws Exception {
        JSONObject value = capture();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建备份目录");
        File target = new File(directory, System.currentTimeMillis() + "-" + UUID.randomUUID() + ".json");
        AtomicFile atomic = new AtomicFile(target);
        FileOutputStream stream = null;
        try {
            stream = atomic.startWrite(); stream.write(value.toString().getBytes(StandardCharsets.UTF_8));
            atomic.finishWrite(stream);
        } catch (Exception e) { if (stream != null) atomic.failWrite(stream); throw e; }
        List<File> files = snapshots();
        for (int index = 5; index < files.size(); index++) delete(files.get(index));
        return target;
    }
    public List<File> snapshots() {
        File[] files = directory.listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return Collections.emptyList();
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        return Arrays.asList(files);
    }
    public void delete(File file) throws IOException {
        checkFile(file);
        if (!file.delete()) throw new IOException("无法删除备份");
    }
    private void checkFile(File file) throws IOException {
        if (!directory.getCanonicalFile().equals(file.getCanonicalFile().getParentFile())) throw new IOException("无效备份路径");
    }
    public JSONObject read(File file) throws Exception {
        checkFile(file);
        try (InputStream input = new FileInputStream(file)) { return read(input); }
    }
    public static JSONObject read(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192]; int size;
        while ((size = input.read(buffer)) != -1) {
            if (bytes.size() + size > MAX_BYTES) throw new IOException("备份超过 2 MB 上限");
            bytes.write(buffer, 0, size);
        }
        String text = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString();
        // Bound nesting before JSONObject parsing, avoiding stack exhaustion on hostile files.
        boolean quoted = false, escaped = false; int depth = 0;
        for (int index = 0; index < text.length(); index++) {
            char ch = text.charAt(index);
            if (quoted) {
                if (escaped) escaped = false;
                else if (ch == '\\') escaped = true;
                else if (ch == '"') quoted = false;
            } else if (ch == '"') quoted = true;
            else if (ch == '{' || ch == '[') { if (++depth > 32) throw new IOException("备份层级过深"); }
            else if (ch == '}' || ch == ']') { if (--depth < 0) throw new IOException("备份格式无效"); }
        }
        if (quoted || depth != 0) throw new IOException("备份格式无效");
        org.json.JSONTokener tokener = new org.json.JSONTokener(text);
        Object value = tokener.nextValue();
        if (!(value instanceof JSONObject) || tokener.nextClean() != 0) throw new IOException("备份格式无效");
        return (JSONObject) value;
    }
    public void restore(JSONObject source) throws Exception {
        if (!FORMAT.equals(source.getString("format")) || source.getInt("version") != 1)
            throw new JSONException("不支持的桌面备份格式");
        JSONObject settings = source.getJSONObject("settings");
        DesktopPreferences.validate(settings);
        JSONObject layout = HomeLayout.validateBackup(source.getJSONObject("layout"));
        // Nothing is mutated until both independent payloads have passed validation.
        snapshot();
        HomeLayout.restoreBackup(context, layout);
        prefs.replace(settings);
    }
    public String summary(File file) throws Exception {
        JSONObject value = read(file);
        JSONObject settings = value.getJSONObject("settings");
        return settings.getInt("columns") + " 列 × " + settings.getInt("rows") + " 行 · 桌面布局与设置";
    }
}
