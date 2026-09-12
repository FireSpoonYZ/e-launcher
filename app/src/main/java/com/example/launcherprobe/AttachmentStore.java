package com.example.launcherprobe;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import org.json.JSONArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Imports untrusted provider URIs into bounded, app-private files. */
final class AttachmentStore {
    static final long MAX_BYTES = 25L * 1024 * 1024;
    private final Context context;
    private final File root;

    AttachmentStore(Context context) {
        this.context = context.getApplicationContext();
        root = new File(context.getFilesDir(), "chat-attachments");
    }

    ChatAttachment stageUri(Uri uri, boolean image) throws Exception {
        if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) throw new SecurityException("附件来源无效");
        String name = "附件", type = context.getContentResolver().getType(uri);
        try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (n >= 0 && cursor.getString(n) != null) name = cursor.getString(n);
                int s = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (s >= 0 && !cursor.isNull(s) && cursor.getLong(s) > MAX_BYTES) throw new IllegalArgumentException("附件不能超过 25 MB");
            }
        }
        if (type == null || type.isBlank()) type = "application/octet-stream";
        if (image && !type.startsWith("image/")) throw new IllegalArgumentException("所选内容不是图片");
        String id = UUID.randomUUID().toString();
        File staging = new File(context.getCacheDir(), "chat-attachment-import");
        if (!staging.isDirectory() && !staging.mkdirs()) throw new IllegalStateException("无法创建附件临时目录");
        File target = new File(staging, id);
        long size = 0;
        try (InputStream input = context.getContentResolver().openInputStream(uri); FileOutputStream output = new FileOutputStream(target)) {
            if (input == null) throw new IllegalArgumentException("无法读取附件");
            byte[] buffer = new byte[32 * 1024];
            for (int count; (count = input.read(buffer)) != -1;) {
                size += count;
                if (size > MAX_BYTES) throw new IllegalArgumentException("附件不能超过 25 MB");
                output.write(buffer, 0, count);
            }
        } catch (Exception exception) { target.delete(); throw exception; }
        if (size == 0) { target.delete(); throw new IllegalArgumentException("附件为空"); }
        return new ChatAttachment(id, name, type, image ? "image" : "file", size, target.getAbsolutePath());
    }

    ChatAttachment publish(ChatAttachment staged) throws Exception {
        File staging = new File(context.getCacheDir(), "chat-attachment-import").getCanonicalFile();
        File source = new File(staged.path).getCanonicalFile();
        if (!source.getParentFile().equals(staging) || !source.getName().equals(staged.id) || !source.isFile())
            throw new SecurityException("附件临时文件无效");
        if (!root.isDirectory() && !root.mkdirs()) throw new IllegalStateException("无法创建附件目录");
        File target = new File(root, staged.id);
        if (!source.renameTo(target)) throw new java.io.IOException("无法发布附件");
        return new ChatAttachment(staged.id, staged.name, staged.mimeType, staged.kind, staged.size,
                target.getAbsolutePath());
    }

    File requireFile(ChatAttachment attachment) throws Exception {
        File file = new File(attachment.path).getCanonicalFile();
        File directory = root.getCanonicalFile();
        if (!file.getParentFile().equals(directory) || !file.getName().equals(attachment.id) || !file.isFile())
            throw new SecurityException("附件文件无效");
        return file;
    }

    static JSONArray json(List<ChatAttachment> attachments) {
        JSONArray result = new JSONArray(); for (ChatAttachment item : attachments) result.put(item.toJson()); return result;
    }

    void cleanup(java.util.Set<String> used) {
        File[] files = root.listFiles();
        if (files != null) for (File file : files) if (!used.contains(file.getName())) file.delete();
    }

    static List<ChatAttachment> parse(String source) {
        try {
            JSONArray values = new JSONArray(source == null ? "[]" : source); List<ChatAttachment> result = new ArrayList<>();
            for (int i = 0; i < values.length(); i++) result.add(ChatAttachment.fromJson(values.getJSONObject(i)));
            return result;
        } catch (Exception exception) { throw new IllegalStateException("无法读取草稿附件", exception); }
    }
}
