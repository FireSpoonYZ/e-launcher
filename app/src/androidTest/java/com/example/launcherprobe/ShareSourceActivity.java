package com.example.launcherprobe;

import android.app.Activity;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import java.util.ArrayList;
import java.util.Arrays;

/** External test-APK share sender. Launch with --es mode text|process|multiple|partial|empty|file|grant. */
public final class ShareSourceActivity extends Activity {
    private static final String TARGET = "com.example.launcherprobe";
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) { finish(); return; }
        String mode = getIntent().getStringExtra("mode");
        if ("grant".equals(mode)) {
            for (String name : Arrays.asList("notes.txt", "pixel.png", "empty.txt", "large.txt"))
                grantUriPermission(TARGET, ShareTestProvider.uri(name), Intent.FLAG_GRANT_READ_URI_PERMISSION);
            finish(); return;
        }
        Intent share = new Intent("process".equals(mode) ? Intent.ACTION_PROCESS_TEXT : Intent.ACTION_SEND)
                .setComponent(new ComponentName(TARGET, TARGET + ".ShareReceiverActivity")).setType("text/plain");
        if (!"empty".equals(mode)) share.putExtra("process".equals(mode) ? Intent.EXTRA_PROCESS_TEXT : Intent.EXTRA_TEXT,
                "Share test: https://example.org — 请先检查草稿，再主动发送");
        if ("multiple".equals(mode) || "partial".equals(mode)) {
            ArrayList<Uri> uris = new ArrayList<>(Arrays.asList(ShareTestProvider.uri("notes.txt"),
                    ShareTestProvider.uri("partial".equals(mode) ? "empty.txt" : "pixel.png")));
            share.setAction(Intent.ACTION_SEND_MULTIPLE).setType("*/*").putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            ClipData clip = ClipData.newUri(getContentResolver(), "fixtures", uris.get(0));
            clip.addItem(new ClipData.Item(uris.get(1))); share.setClipData(clip);
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        if ("file".equals(mode)) {
            // Deliberately malformed sender fixture; the receiver, not StrictMode, must reject it.
            android.os.StrictMode.setVmPolicy(new android.os.StrictMode.VmPolicy.Builder().build());
            share.putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///data/private.txt"));
        }
        startActivity(share); finish();
    }
}
