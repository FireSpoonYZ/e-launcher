package com.example.launcherprobe;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** SAF grants only the selected document; no storage permission or background export. */
@CapacitorPlugin(name = "ConversationBackup")
public final class ConversationBackupPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean();
    private ConversationBackups backups;
    private volatile ConversationBackups.Prepared prepared;

    @Override public void load() { backups = new ConversationBackups(getContext(), ChatCoordinator.get(getContext()).store()); }

    @PluginMethod public void prepareExport(PluginCall call) {
        work(call, () -> {
            clear();
            String id = required(call, "conversationId");
            ChatCoordinator coordinator = ChatCoordinator.get(getContext());
            // Never hold coordinator/store monitors across file-provider I/O or ZIP compression.
            if (coordinator.backupBusy(id)) throw new IOException("请等待此会话停止并保存完成 / Wait for this conversation to finish saving");
            prepared = backups.prepareExport(id, Boolean.TRUE.equals(call.getBoolean("workspace", false)));
            call.resolve(JSObject.fromJSONObject(prepared.preview()));
        });
    }

    @PluginMethod public void saveExport(PluginCall call) {
        if (!begin(call)) return;
        try {
            ConversationBackups.Prepared value = require(call, false);
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/zip").putExtra(Intent.EXTRA_TITLE, "conversation-backup.zip");
            getActivity().runOnUiThread(() -> {
                try { startActivityForResult(call, intent, "exportResult"); }
                catch (Exception e) { busy.set(false); call.reject(e.getMessage(), e); }
            });
        } catch (Exception e) { busy.set(false); call.reject(e.getMessage(), e); }
    }

    @ActivityCallback private void exportResult(PluginCall call, ActivityResult result) {
        if (call == null) { busy.set(false); return; }
        executor.execute(() -> {
            try {
                if (result.getResultCode() != Activity.RESULT_OK) { call.resolve(new JSObject().put("cancelled", true)); return; }
                Uri uri = uri(result);
                ConversationBackups.Prepared value = require(call, false);
                try (InputStream in = new FileInputStream(value.archive);
                     OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new IOException("Cannot open backup destination");
                    ConversationBackupArchive.copy(in, out, ConversationBackupArchive.MAX_TOTAL, null);
                    out.flush();
                }
                clear();
                call.resolve(new JSObject().put("cancelled", false));
            } catch (Exception e) {
                call.reject("导出失败，所选位置可能留下不完整文件 / Export failed; destination may contain a partial file. " + e.getMessage(), e);
            } finally { busy.set(false); }
        });
    }

    @PluginMethod public void chooseImport(PluginCall call) {
        if (!begin(call)) return;
        getActivity().runOnUiThread(() -> {
            try {
                startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                        .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/zip", "application/octet-stream"}), "importResult");
            } catch (Exception e) { busy.set(false); call.reject(e.getMessage(), e); }
        });
    }

    @ActivityCallback private void importResult(PluginCall call, ActivityResult result) {
        if (call == null) { busy.set(false); return; }
        executor.execute(() -> {
            try {
                if (result.getResultCode() != Activity.RESULT_OK) { call.resolve(new JSObject().put("cancelled", true)); return; }
                clear();
                try (InputStream input = getContext().getContentResolver().openInputStream(uri(result))) {
                    if (input == null) throw new IOException("Cannot open selected backup");
                    prepared = backups.prepareImport(input);
                }
                call.resolve(JSObject.fromJSONObject(prepared.preview()));
            } catch (Exception e) { call.reject(e.getMessage(), e); }
            finally { busy.set(false); }
        });
    }

    @PluginMethod public void restoreImport(PluginCall call) {
        work(call, () -> {
            ConversationBackups.Prepared value = require(call, true);
            String id = backups.restore(value, Boolean.TRUE.equals(call.getBoolean("workspace", false)));
            // Publication has succeeded. A cache cleanup error must never turn it into an apparent failed import.
            try { clear(); } catch (IOException ignored) { prepared = null; }
            call.resolve(new JSObject().put("conversationId", id));
        });
    }

    @PluginMethod public void discard(PluginCall call) { work(call, () -> { clear(); call.resolve(); }); }

    private ConversationBackups.Prepared require(PluginCall call, boolean importing) throws Exception {
        ConversationBackups.Prepared value = prepared;
        if (value == null || !value.token.equals(required(call, "token"))
                || importing != (value.unpacked != null)) throw new IOException("预览已失效，请重新选择 / Preview expired; prepare again");
        return value;
    }
    private void clear() throws IOException {
        ConversationBackups.Prepared old = prepared; prepared = null;
        if (old != null) old.close();
    }
    private boolean begin(PluginCall call) {
        if (busy.compareAndSet(false, true)) return true;
        call.reject("备份操作进行中 / A backup operation is already in progress"); return false;
    }
    private interface Work { void run() throws Exception; }
    private void work(PluginCall call, Work work) {
        if (!begin(call)) return;
        executor.execute(() -> {
            try { work.run(); } catch (Exception e) { call.reject(e.getMessage(), e); }
            finally { busy.set(false); }
        });
    }
    private static String required(PluginCall call, String key) throws IOException {
        String value = call.getString(key);
        if (value == null || value.isBlank()) throw new IOException(key + " is required");
        return value;
    }
    private static Uri uri(ActivityResult result) throws IOException {
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) throw new IOException("Invalid document URI");
        return uri;
    }
    @Override protected void handleOnDestroy() {
        executor.execute(() -> { try { clear(); } catch (IOException ignored) { } });
        executor.shutdown();
    }
}
