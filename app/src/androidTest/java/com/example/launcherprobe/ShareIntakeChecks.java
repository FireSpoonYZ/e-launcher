package com.example.launcherprobe;

import android.app.Instrumentation;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Process;
import android.os.SystemClock;
import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

/** Register from the shared runner at integration time. Uses only synthetic, isolated drafts. */
public final class ShareIntakeChecks {
    public static String run(Instrumentation instrumentation) throws Exception {
        Context context = instrumentation.getTargetContext();
        Context tests = instrumentation.getContext();
        FeatureAcceptanceChecks.shell(instrumentation, "am start -W -n " + tests.getPackageName()
                + "/" + ShareSourceActivity.class.getName() + " --es mode grant");
        long deadline = SystemClock.uptimeMillis() + 5000;
        while (context.checkUriPermission(ShareTestProvider.uri("notes.txt"), Process.myPid(), Process.myUid(),
                Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            if (SystemClock.uptimeMillis() > deadline) throw new AssertionError("Test APK URI grant not received");
            SystemClock.sleep(50);
        }
        ChatStore store = new ChatStore(context);
        String active = store.activeId(), originalDraft = store.draft(active);
        List<String> tokens = new ArrayList<>(); String id = null;
        try {
            String initial = UUID.randomUUID().toString(); tokens.add(initial);
            id = store.importShareDraft(initial, null, "isolated existing draft", List.of());
            Intent intent = new Intent(Intent.ACTION_SEND_MULTIPLE).putExtra(Intent.EXTRA_TEXT, "shared text")
                    .putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(Arrays.asList(
                            ShareTestProvider.uri("notes.txt"), ShareTestProvider.uri("pixel.png"))));
            intent.setClipData(ClipData.newUri(context.getContentResolver(), "duplicate", ShareTestProvider.uri("notes.txt")));
            String operation = UUID.randomUUID().toString(); tokens.add(operation);
            ShareIntake input = ShareIntake.parse(intent);
            input.importDraft(context, operation, id); input.importDraft(context, operation, id);
            check(store.draft(id).equals("isolated existing draft\n\nshared text"), "draft merged exactly once");
            check(store.draftAttachments(id).size() == 2, "two distinct real content URIs");
            for (ChatAttachment attachment : store.draftAttachments(id))
                check(new File(attachment.path).length() == attachment.size && attachment.size > 0, "copied file bytes");
            check("image".equals(store.draftAttachments(id).get(1).kind), "image classified from provider MIME");
            for (String bad : Arrays.asList("empty.txt", "large.txt")) {
                Intent partial = new Intent(Intent.ACTION_SEND_MULTIPLE).putExtra(Intent.EXTRA_TEXT, "must not save")
                        .putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(Arrays.asList(
                                ShareTestProvider.uri("notes.txt"), ShareTestProvider.uri(bad))));
                boolean failed = false;
                try { ShareIntake.parse(partial).importDraft(context, UUID.randomUUID().toString(), id); }
                catch (IllegalArgumentException expected) { failed = true; }
                check(failed, "invalid attachment rejected");
                check(store.draftAttachments(id).size() == 2, "no partial files published");
                check(!store.draft(id).contains("must not save"), "no partial text saved");
            }
            check(active.equals(store.activeId()) && originalDraft.equals(store.draft(active)), "active draft untouched");
            check(store.load(id).isEmpty(), "no message submitted");
            return "Share intake: real URI text/image import, duplicate suppression, merge, empty/oversize rollback passed";
        } finally {
            if (id != null) store.clear(id);
            android.content.SharedPreferences.Editor edit = context.getSharedPreferences("chat", 0).edit();
            for (String token : tokens) edit.remove("share_intake_" + token);
            edit.commit();
        }
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
