package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.app.NotificationManager;
import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class ChatArchiveTest {
    private Application application;

    @Before public void setUp() {
        application = RuntimeEnvironment.getApplication();
        application.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        application.getSharedPreferences("chat_submissions", Context.MODE_PRIVATE).edit().clear().commit();
        application.getSystemService(NotificationManager.class).cancelAll();
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "generation", 0L);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "activeCount", 0);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "foreground", false);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    @After public void tearDown() {
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ChatExecutionService.setActiveCount(application, 0);
    }

    @Test public void archivePreservesHistoryDraftAttachmentsWorkspaceAndContext() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("user-1", "user", "Keep this history")));
        String id = store.activeId();
        store.saveDraft("unsent draft");
        ChatAttachment attachment = new ChatAttachment("kept-file", "notes.txt", "text/plain", "file", 4,
                new java.io.File(application.getFilesDir(), "chat-attachments/kept-file").getAbsolutePath());
        store.saveDraftAttachments(Collections.singletonList(attachment));
        store.setPiSelection(id, "openai", "gpt-test", "low");
        store.savePiContext("ctx-node", new JSONArray().put(new JSONObject().put("type", "session").put("id", id)));
        new PiConfigStore(application, id).save(true, "settings.json", "{\"keep\":true}", null);

        List<JSONObject> events = new ArrayList<>();
        ChatCoordinator.Listener listener = (messages, event) -> events.add(event);
        coordinator.addListener(listener);
        try {
            coordinator.archiveConversation(id);
            idleMain();
            assertEquals("conversationArchived", events.get(events.size() - 1).getString("type"));
            assertEquals(id, events.get(events.size() - 1).getString("conversationId"));
            assertNotEquals(id, store.activeId());
            assertTrue(store.isArchived(id));
            assertFalse(store.conversations().stream().anyMatch(item -> id.equals(item.id)));
            assertEquals(1, store.archivedConversations().size());
            assertEquals(id, store.archivedConversations().get(0).id);
            assertTrue(store.archivedConversations().get(0).archivedAt > 0);
            assertEquals(0, coordinator.taskCards().length());
            assertEquals("Keep this history", store.load(id).get(0).content);
            assertEquals("unsent draft", store.draft(id));
            assertEquals("kept-file", store.draftAttachments(id).get(0).id);
            assertEquals("gpt-test", new JSONObject(store.piSelection(id)).getString("model"));
            store.selectConversation(id);
            assertTrue(store.piContext("ctx-node").contains("session"));
            assertTrue(new PiConfigStore(application, id).read(true, "settings.json").contains("keep"));
            JSONObject summary = NativeJson.conversations(store.archivedConversations()).getJSONObject(0);
            assertEquals(store.archivedAt(id), summary.getLong("archivedAt"));
            assertEquals(store.archivedAt(id), NativeJson.conversation(store, id).getLong("archivedAt"));
        } finally {
            coordinator.removeListener(listener);
        }
    }

    @Test public void restoreDoesNotChangeUpdated() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("user-1", "user", "Pinned time")));
        String id = store.activeId();
        long updated = 1_700_000_000_000L;
        stamp(id, "updated", updated);
        coordinator.archiveConversation(id);
        idleMain();
        assertEquals(updated, store.archivedConversations().get(0).updated);
        List<JSONObject> events = new ArrayList<>();
        ChatCoordinator.Listener listener = (messages, event) -> events.add(event);
        coordinator.addListener(listener);
        try {
            coordinator.restoreConversation(id);
            idleMain();
            assertEquals("conversationRestored", events.get(0).getString("type"));
            assertEquals(id, events.get(0).getString("conversationId"));
            assertFalse(store.isArchived(id));
            assertEquals(updated, store.conversations().get(0).updated);
            assertEquals(0, store.conversations().get(0).archivedAt);
            assertFalse(NativeJson.conversation(store, id).has("archivedAt"));
        } finally {
            coordinator.removeListener(listener);
        }
    }

    @Test public void purgeExpiredArchivesUsesFourteenDayThreshold() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("expired-user", "user", "Expired chat")));
        String expired = store.activeId();
        store.newConversation();
        store.save(Collections.singletonList(message("kept-user", "user", "Still archived")));
        String kept = store.activeId();
        coordinator.archiveConversation(expired);
        coordinator.archiveConversation(kept);
        long now = System.currentTimeMillis();
        stamp(expired, "archivedAt", now - ChatStore.ARCHIVE_TTL_MS);
        stamp(kept, "archivedAt", now - ChatStore.ARCHIVE_TTL_MS + 60 * 60 * 1000L);
        new ChatStore(application);
        assertTrue(store.isArchived(expired));
        coordinator.purgeExpiredArchives();
        idleMain();
        assertFalse(store.isArchived(expired));
        assertFalse(new JSONObject(application.getSharedPreferences("chat", Context.MODE_PRIVATE)
                .getString("conversations", "{}")).has(expired));
        assertTrue(store.isArchived(kept));
        assertEquals("Still archived", store.load(kept).get(0).content);
    }

    @Test public void messageUpdatesPreserveArchiveMark() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("user-1", "user", "Original")));
        String id = store.activeId();
        coordinator.archiveConversation(id);
        idleMain();
        long archivedAt = store.archivedAt(id);
        List<AgentLoop.Message> next = new ArrayList<>(store.load(id));
        next.add(message("user-2", "user", "Follow-up while archived"));
        store.save(id, next);
        store.saveDraft(id, "later draft");
        assertEquals(archivedAt, store.archivedAt(id));
        assertEquals("Follow-up while archived", store.load(id).get(1).content);
        assertEquals("later draft", store.draft(id));
        assertTrue(store.isArchived(id));
    }

    @Test public void runningArchiveContinuesAndSendRequiresRestore() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("busy-user", "user", "Busy chat")));
        String id = store.activeId();
        ChatCoordinator.SessionRun run = coordinator.registerRun(id, null);
        coordinator.archiveConversation(id);
        idleMain();
        assertTrue(coordinator.running(id));
        assertTrue(store.isArchived(id));
        stamp(id, "archivedAt", System.currentTimeMillis() - ChatStore.ARCHIVE_TTL_MS);
        coordinator.purgeExpiredArchives();
        idleMain();
        assertTrue(store.isArchived(id));
        assertTrue(coordinator.running(id));

        store.selectConversation(id);
        IllegalStateException blocked = assertThrows(IllegalStateException.class,
                () -> coordinator.send(id, "hello", null));
        assertTrue(blocked.getMessage().contains("请先恢复"));
        assertTrue(coordinator.running(id));

        coordinator.finish(run, "completed", "");
        idleMain();
        coordinator.purgeExpiredArchives();
        idleMain();
        assertFalse(new JSONObject(application.getSharedPreferences("chat", Context.MODE_PRIVATE)
                .getString("conversations", "{}")).has(id));
    }

    @Test public void restoreThenSendIsAllowedAndRearhiveResetsTimer() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("user-1", "user", "Live chat")));
        String id = store.activeId();
        coordinator.archiveConversation(id);
        stamp(id, "archivedAt", System.currentTimeMillis() - ChatStore.ARCHIVE_TTL_MS);
        coordinator.restoreConversation(id);
        store.selectConversation(id);
        ChatCoordinator.SessionRun run = coordinator.registerRun(id, null);
        assertTrue(coordinator.running(id));
        coordinator.finish(run, "completed", "");
        coordinator.archiveConversation(id);
        assertTrue(System.currentTimeMillis() - store.archivedAt(id) < 5_000);
        coordinator.purgeExpiredArchives();
        idleMain();
        assertTrue(store.isArchived(id));
    }

    private static AgentLoop.Message message(String id, String role, String content) {
        return new AgentLoop.Message(id, role, content, null, Collections.emptyList(), false);
    }

    private void stamp(String conversationId, String field, long value) throws Exception {
        android.content.SharedPreferences prefs = application.getSharedPreferences("chat", Context.MODE_PRIVATE);
        JSONObject index = new JSONObject(prefs.getString("conversations", "{}"));
        index.getJSONObject(conversationId).put(field, value);
        prefs.edit().putString("conversations", index.toString()).commit();
    }

    private static void idleMain() {
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
    }
}
