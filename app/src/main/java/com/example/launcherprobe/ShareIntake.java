package com.example.launcherprobe;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.net.Uri;
import android.os.Process;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/** Untrusted Android share input; all files stage successfully before any draft is changed. */
final class ShareIntake {
    static final int MAX_FILES = 20;
    static final int MAX_TEXT = 100_000;
    final String text;
    final List<Uri> uris;

    private ShareIntake(String text, List<Uri> uris) { this.text = text; this.uris = uris; }

    static ShareIntake parse(Intent intent) {
        if (intent == null) throw new IllegalArgumentException("没有分享内容");
        String action = intent.getAction();
        boolean process = Intent.ACTION_PROCESS_TEXT.equals(action);
        if (!process && !Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action))
            throw new IllegalArgumentException("不支持的分享操作");
        CharSequence value = intent.getCharSequenceExtra(process ? Intent.EXTRA_PROCESS_TEXT : Intent.EXTRA_TEXT);
        String text = value == null ? "" : value.toString();
        if (text.length() > MAX_TEXT) throw new IllegalArgumentException("分享文本不能超过 100000 字符");
        LinkedHashSet<Uri> uris = new LinkedHashSet<>();
        if (!process) {
            Object stream = intent.getExtras() == null ? null : intent.getExtras().get(Intent.EXTRA_STREAM);
            if (stream instanceof Uri) add(uris, stream);
            else if (stream instanceof ArrayList<?>) {
                if (((ArrayList<?>) stream).size() > MAX_FILES) throw new IllegalArgumentException("一次最多分享 20 个附件");
                for (Object uri : (ArrayList<?>) stream) add(uris, uri);
            }
            else if (stream != null) throw new IllegalArgumentException("分享附件格式无效");
            ClipData clip = intent.getClipData();
            if (clip != null) {
                if (clip.getItemCount() > MAX_FILES) throw new IllegalArgumentException("一次最多分享 20 个附件");
                for (int i = 0; i < clip.getItemCount(); i++) {
                    ClipData.Item item = clip.getItemAt(i);
                    if (item.getUri() != null) add(uris, item.getUri());
                    else if (item.getIntent() != null) throw new IllegalArgumentException("不支持嵌套分享操作");
                    else if (text.isEmpty() && item.getText() != null) text = item.getText().toString();
                }
            }
        }
        if (text.length() > MAX_TEXT) throw new IllegalArgumentException("分享文本不能超过 100000 字符");
        if (text.isBlank() && uris.isEmpty()) throw new IllegalArgumentException("没有可导入的分享内容");
        return new ShareIntake(text, new ArrayList<>(uris));
    }

    private static void add(LinkedHashSet<Uri> uris, Object value) {
        if (!(value instanceof Uri)) throw new IllegalArgumentException("分享附件格式无效");
        Uri uri = (Uri) value;
        if (!"content".equals(uri.getScheme()) || uri.getAuthority() == null
                || uri.getAuthority().contains("@")) throw new SecurityException("只接受授权的 content:// 附件");
        uris.add(uri);
        if (uris.size() > MAX_FILES) throw new IllegalArgumentException("一次最多分享 20 个附件");
    }

    static void requireGrant(Context context, Uri uri) {
        ProviderInfo provider = context.getPackageManager().resolveContentProvider(uri.getAuthority(), 0);
        if (provider == null || provider.applicationInfo.uid == Process.myUid()
                || context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION)
                != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("附件没有读取授权或来自应用私有文件");
    }

    String importDraft(Context context, String token, String target) throws Exception {
        // A restored confirmation can retry after process death without rereading expired URI grants.
        String receipt = context.getSharedPreferences("chat", Context.MODE_PRIVATE).getString("share_intake_" + token, null);
        if (receipt != null) return receipt;
        List<ChatAttachment> staged = new ArrayList<>();
        try {
            AttachmentStore files = new AttachmentStore(context);
            for (Uri uri : uris) {
                requireGrant(context, uri);
                String type = context.getContentResolver().getType(uri);
                staged.add(files.stageUri(uri, type != null && type.startsWith("image/")));
            }
            return new ChatStore(context).importShareDraft(token, target, text, staged);
        } finally {
            for (ChatAttachment attachment : staged) new File(attachment.path).delete();
        }
    }
}
