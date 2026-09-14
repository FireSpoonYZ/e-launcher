package com.example.launcherprobe;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Shared system picker and bounded import path for native home and Web chat. */
final class AttachmentPicker {
    static File cameraFile(Context context) {
        File directory = new File(context.getCacheDir(), "chat-camera");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("无法准备相机文件");
        return new File(directory, UUID.randomUUID() + ".jpg");
    }

    static Intent intent(Context context, String kind, File capture) {
        if ("camera".equals(kind)) {
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".files", capture);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (intent.resolveActivity(context.getPackageManager()) == null) throw new IllegalStateException("没有可用的相机应用");
            return intent;
        }
        if ("image".equals(kind)) return new ActivityResultContracts.PickMultipleVisualMedia().createIntent(context,
                new PickVisualMediaRequest.Builder().setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE).build());
        if ("file".equals(kind)) return new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
                .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        throw new IllegalArgumentException("附件类型无效");
    }

    static List<ChatAttachment> importResult(Context context, ChatStore store, String conversation,
            String kind, File capture, Intent data) throws Exception {
        List<ChatAttachment> staged = new ArrayList<>();
        try {
            store.beginAttachmentImport(conversation);
            AttachmentStore files = new AttachmentStore(context);
            if (capture != null) staged.add(files.stageUri(FileProvider.getUriForFile(context,
                    context.getPackageName() + ".files", capture), true));
            else {
                if (data == null) throw new IllegalArgumentException("未选择附件");
                boolean image = "image".equals(kind);
                if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++)
                    staged.add(files.stageUri(data.getClipData().getItemAt(i).getUri(), image));
                else if (data.getData() != null) staged.add(files.stageUri(data.getData(), image));
            }
            if (staged.isEmpty()) throw new IllegalArgumentException("未选择附件");
            List<ChatAttachment> published = store.publishDraftAttachments(conversation, staged);
            staged.clear();
            return published;
        } finally {
            for (ChatAttachment item : staged) new File(item.path).delete();
            if (capture != null) capture.delete();
        }
    }
}
