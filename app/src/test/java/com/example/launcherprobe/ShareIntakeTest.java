package com.example.launcherprobe;

import static org.junit.Assert.*;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class ShareIntakeTest {
    private Context context;
    private ChatStore store;
    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        store = new ChatStore(context);
    }
    private String token() { return UUID.randomUUID().toString(); }
    private ChatAttachment staged(String body) throws Exception {
        String id = token(); File file = new File(context.getCacheDir(), "chat-attachment-import/" + id);
        file.getParentFile().mkdirs(); Files.write(file.toPath(), body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return new ChatAttachment(id, "notes.txt", "text/plain", "file", body.length(), file.getAbsolutePath());
    }
    @Test public void parsesTextLinksProcessTextAndDeduplicatesStreams() {
        Uri first = Uri.parse("content://test/one"), second = Uri.parse("content://test/two");
        Intent intent = new Intent(Intent.ACTION_SEND_MULTIPLE).putExtra(Intent.EXTRA_TEXT, "https://example.org")
                .putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(List.of(first, second)));
        intent.setClipData(ClipData.newUri(context.getContentResolver(), "file", first));
        ShareIntake input = ShareIntake.parse(intent);
        assertEquals("https://example.org", input.text); assertEquals(List.of(first, second), input.uris);
        assertEquals("selected", ShareIntake.parse(new Intent(Intent.ACTION_PROCESS_TEXT)
                .putExtra(Intent.EXTRA_PROCESS_TEXT, "selected")).text);
    }
    @Test public void rejectsEmptyInvalidPrivateAndExcessiveInput() {
        assertThrows(IllegalArgumentException.class, () -> ShareIntake.parse(new Intent(Intent.ACTION_SEND)));
        assertThrows(IllegalArgumentException.class, () -> ShareIntake.parse(new Intent(Intent.ACTION_VIEW)));
        assertThrows(SecurityException.class, () -> ShareIntake.parse(new Intent(Intent.ACTION_SEND)
                .putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///data/private"))));
        assertThrows(IllegalArgumentException.class, () -> ShareIntake.parse(new Intent(Intent.ACTION_SEND)
                .putExtra(Intent.EXTRA_STREAM, "not a uri")));
        assertThrows(SecurityException.class, () -> ShareIntake.requireGrant(context,
                Uri.parse("content://" + context.getPackageName() + ".files/private")));
        ArrayList<Uri> uris = new ArrayList<>();
        for (int i = 0; i <= ShareIntake.MAX_FILES; i++) uris.add(Uri.parse("content://test/" + i));
        assertThrows(IllegalArgumentException.class, () -> ShareIntake.parse(new Intent(Intent.ACTION_SEND_MULTIPLE)
                .putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)));
    }
    @Test public void mergesAtomicallyAndRetriesOnceWithoutSelectingOrSending() throws Exception {
        store.saveDraft("current draft"); String active = store.activeId();
        String target = store.importShareDraft(token(), null, "existing", List.of(staged("one")));
        String operation = token();
        store.importShareDraft(operation, target, "shared", List.of(staged("two")));
        assertEquals(target, store.importShareDraft(operation, target, "shared", List.of()));
        assertEquals("existing\n\nshared", store.draft(target));
        assertEquals(2, store.draftAttachments(target).size());
        assertEquals(active, store.activeId()); assertEquals("current draft", store.draft());
        assertTrue(store.load(target).isEmpty());
        assertEquals(0, context.getSharedPreferences("chat_submissions", 0).getAll().size());
    }
    @Test public void deletedOrArchivedAtConfirmationIsRejectedAndPublishFailureRollsBack() throws Exception {
        String target = store.importShareDraft(token(), null, "keep", List.of());
        ChatAttachment first = staged("published then rolled back");
        ChatAttachment missing = new ChatAttachment(token(), "bad", "text/plain", "file", 1, "/missing");
        assertThrows(Exception.class, () -> store.importShareDraft(token(), target, "lost", List.of(first, missing)));
        assertEquals("keep", store.draft(target)); assertTrue(store.draftAttachments(target).isEmpty());
        assertFalse(new File(context.getFilesDir(), "chat-attachments/" + first.id).exists());
        store.archive(target);
        assertThrows(IllegalStateException.class, () -> store.importShareDraft(token(), target, "bad", List.of()));
        store.clear(target);
        assertThrows(IllegalStateException.class, () -> store.importShareDraft(token(), target, "bad", List.of()));
    }
    @Test public void previewCancelAndRecreationDoNotImport() {
        store.saveDraft("unchanged");
        int count = store.conversations().size();
        Intent input = new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "preview only");
        var activity = Robolectric.buildActivity(ShareReceiverActivity.class, input).setup();
        Bundle saved = new Bundle(); activity.saveInstanceState(saved).pause().stop().destroy();
        var restored = Robolectric.buildActivity(ShareReceiverActivity.class, input).create(saved).start().resume();
        restored.get().finish(); restored.pause().stop().destroy();
        assertEquals(count, store.conversations().size()); assertEquals("unchanged", store.draft());
    }
}
