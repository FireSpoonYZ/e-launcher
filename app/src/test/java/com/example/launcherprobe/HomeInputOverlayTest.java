package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.content.Context;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, shadows = HostAtomicFile.class)
public class HomeInputOverlayTest {
    private Context context;
    private ChatStore store;
    private String original;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        store = new ChatStore(context);
        store.newConversation();
        store.save(List.of(new AgentLoop.Message("user", "Existing chat")));
        original = store.activeId();
        store.saveDraft("Existing draft");
    }

    @Test public void unsentDraftSurvivesReopenWithoutSelectingOrSending() {
        String draftId = store.prepareHomeDraft();
        assertNotEquals(original, draftId);
        assertEquals(1, store.conversations().size());
        store.saveDraft(draftId, "Unsent assistant draft");
        assertEquals(original, store.activeId());
        assertEquals("Existing draft", store.draft(original));
        assertTrue(store.load(draftId).isEmpty());

        ChatStore reopened = new ChatStore(context);
        assertEquals(original, reopened.activeId());
        assertEquals(draftId, reopened.prepareHomeDraft());
        assertEquals(draftId, context.getSharedPreferences("chat", Context.MODE_PRIVATE).getString("home_draft", null));
        assertEquals("Unsent assistant draft", reopened.draft(draftId));
        reopened.selectHomeDraft();
        assertEquals(draftId, reopened.activeId());
        assertEquals("Unsent assistant draft", reopened.draft());
        assertTrue(reopened.load().isEmpty());
        assertEquals("Existing draft", reopened.draft(original));
        assertEquals("Existing chat", reopened.load(original).get(0).content);
    }

    @Test public void selectingUnsentDraftRetainsBothDraftsAttachmentsAndFiles() throws Exception {
        ChatAttachment existing = attachment("existing-file", "Original attachment");
        store.saveDraftAttachments(List.of(existing));
        String draftId = store.prepareHomeDraft();
        ChatAttachment unsent = attachment("unsent-file", "Unsent attachment");
        store.saveDraftAttachments(draftId, List.of(unsent));
        assertEquals(original, store.activeId());

        ChatStore reopened = new ChatStore(context);
        reopened.selectHomeDraft();
        reopened.cleanupAttachments();
        assertEquals(draftId, reopened.activeId());
        assertTrue(reopened.draft().isEmpty());
        assertTrue(reopened.load().isEmpty());
        assertEquals(unsent.toJson().toString(), reopened.draftAttachments().get(0).toJson().toString());
        assertEquals(existing.toJson().toString(), reopened.draftAttachments(original).get(0).toJson().toString());
        assertEquals("Unsent attachment", new String(Files.readAllBytes(new AttachmentStore(context).requireFile(unsent).toPath()), StandardCharsets.UTF_8));
        assertEquals("Original attachment", new String(Files.readAllBytes(new AttachmentStore(context).requireFile(existing).toPath()), StandardCharsets.UTF_8));
        assertEquals("Existing draft", reopened.draft(original));
    }

    private ChatAttachment attachment(String id, String content) throws Exception {
        File file = new File(context.getFilesDir(), "chat-attachments/" + id);
        Files.createDirectories(file.getParentFile().toPath());
        Files.write(file.toPath(), content.getBytes(StandardCharsets.UTF_8));
        return new ChatAttachment(id, id + ".txt", "text/plain", "file", file.length(), file.getAbsolutePath());
    }
}
