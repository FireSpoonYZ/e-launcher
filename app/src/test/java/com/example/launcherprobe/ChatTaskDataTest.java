package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
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
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class ChatTaskDataTest {
    private Application application;

    @Before public void setUp() {
        application = RuntimeEnvironment.getApplication();
        application.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        application.getSharedPreferences("chat_submissions", Context.MODE_PRIVATE).edit().clear().commit();
        application.getSystemService(NotificationManager.class).cancelAll();
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "generation", 0L);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "activeCount", 0);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "foreground", false);
        ReflectionHelpers.setStaticField(BotManager.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    @After public void tearDown() {
        ReflectionHelpers.setStaticField(BotManager.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ChatExecutionService.setActiveCount(application, 0);
    }

    @Test public void homeDraftSurvivesChatSwitchWithoutTakingExistingDraft() {
        ChatStore store = new ChatStore(application);
        store.save(Collections.singletonList(message("existing", "user", "Existing chat")));
        String existing = store.activeId();
        store.saveDraft("existing draft");
        store.selectHomeDraft();
        String home = store.activeId();
        assertFalse(home.equals(existing));
        assertEquals("", store.draft());
        store.saveDraft("home draft");
        store.selectConversation(existing);
        assertEquals("existing draft", store.draft());
        store.selectHomeDraft();
        assertEquals(home, store.activeId());
        assertEquals("home draft", store.draft());
        store.save(Collections.singletonList(message("sent", "user", "home draft")));
        store.selectHomeDraft();
        assertFalse(home.equals(store.activeId()));
    }

    @Test public void conversationSearchCoversTitlesAndEveryBranchWithoutChangingSelectionOrDraft() throws Exception {
        ChatStore store = new ChatStore(application);
        AgentLoop.Message root = message("root", "user", "Root question");
        AgentLoop.Message selected = message("selected", "assistant", "visible answer");
        AgentLoop.Message hidden = message("hidden", "assistant",
                "Hidden NEEDLE\n" + "x".repeat(180));
        store.save(Arrays.asList(root, selected));
        store.save(Arrays.asList(root, hidden));
        store.selectNode(selected.id);
        store.saveDraft("kept draft");
        String conversationId = store.activeId();
        JSONObject index = new JSONObject(application.getSharedPreferences("chat", Context.MODE_PRIVATE)
                .getString("conversations", "{}"));
        index.getJSONObject(conversationId).put("title", "Alpha title");
        application.getSharedPreferences("chat", Context.MODE_PRIVATE).edit()
                .putString("conversations", index.toString()).commit();

        store.newConversation();
        store.save(Collections.singletonList(message("other", "user", "Other conversation")));
        store.selectConversation(conversationId);
        List<String> unfiltered = store.conversations().stream().map(item -> item.id).collect(Collectors.toList());

        List<ChatStore.Conversation> titleMatches = store.conversations("  ALPHA  ");
        assertEquals(1, titleMatches.size());
        assertEquals(conversationId, titleMatches.get(0).id);
        assertNull("a title-only match does not invent a body snippet", titleMatches.get(0).snippet);

        List<ChatStore.Conversation> bodyMatches = store.conversations("needle");
        assertEquals(1, bodyMatches.size());
        assertEquals(conversationId, bodyMatches.get(0).id);
        assertFalse(bodyMatches.get(0).snippet.contains("\n"));
        assertTrue(bodyMatches.get(0).snippet.length() <= 120);
        assertEquals("body search includes nodes outside the selected branch", selected.id, store.tree().leaf());
        assertEquals(conversationId, store.activeId());
        assertEquals("kept draft", store.draft());
        assertEquals(unfiltered, store.conversations(" \n ").stream().map(item -> item.id).collect(Collectors.toList()));

        JSONObject projected = NativeJson.conversations(bodyMatches).getJSONObject(0);
        assertTrue(projected.has("snippet"));
        assertFalse(NativeJson.conversations(titleMatches).getJSONObject(0).has("snippet"));
    }

    @Test public void taskCardsKeepStableMembershipAndSeparateModelStateFromTrustedTodo() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("a-user", "user", "Task A")));
        String firstId = store.activeId();
        persistTodo(store, firstId, "a-user", "a-reply", todoState("first step", "in_progress"));
        ChatCoordinator.SessionRun first = coordinator.registerRun(firstId, null);

        store.newConversation();
        store.save(Collections.singletonList(message("b-user", "user", "Task B")));
        String secondId = store.activeId();
        ChatCoordinator.SessionRun second = coordinator.registerRun(secondId, null);
        second.extensionUi = new JSONObject().put("todo", new JSONObject()
                .put("package", "not-the-installed-package")
                .put("tasks", new JSONArray().put(new JSONObject()
                        .put("id", 1).put("subject", "forged").put("status", "completed")))
                .put("nextId", 2));
        stampUpdated(firstId, 1_000L);
        stampUpdated(secondId, 2_000L);

        JSONArray cards = coordinator.taskCards();
        assertEquals(Arrays.asList(secondId, firstId), ids(cards));
        JSONObject firstCard = card(cards, firstId);
        JSONObject secondCard = card(cards, secondId);
        assertEquals("Task A", firstCard.getString("title"));
        assertEquals("working", firstCard.getString("modelState"));
        assertEquals("in_progress", firstCard.getJSONObject("todo")
                .getJSONArray("tasks").getJSONObject(0).getString("status"));
        assertTrue(secondCard.isNull("todo"));
        assertEquals("working", secondCard.getString("modelState"));

        coordinator.cancel(firstId);
        firstCard = card(coordinator.taskCards(), firstId);
        assertEquals("stopping", firstCard.getString("modelState"));
        assertEquals("in_progress", firstCard.getJSONObject("todo")
                .getJSONArray("tasks").getJSONObject(0).getString("status"));

        coordinator.finish(first, "aborted", "");
        firstCard = card(coordinator.taskCards(), firstId);
        assertEquals("idle", firstCard.getString("modelState"));
        assertEquals("in_progress", firstCard.getJSONObject("todo")
                .getJSONArray("tasks").getJSONObject(0).getString("status"));

        coordinator.dismissTaskCard(firstId);
        assertEquals("desktop cards follow history, not dismiss membership",
                Arrays.asList(secondId, firstId), ids(coordinator.taskCards()));
        assertTrue(store.conversations().stream().anyMatch(item -> firstId.equals(item.id)));
        assertTrue(coordinator.running(secondId));

        coordinator.finish(second, "completed", "");
        store.selectConversation(firstId);
        ChatCoordinator.SessionRun restarted = coordinator.registerRun(firstId, null);
        assertEquals(Arrays.asList(secondId, firstId), ids(coordinator.taskCards()));
        coordinator.finish(restarted, "completed", "");
        store.clear(firstId);
        assertEquals(Collections.singletonList(secondId), ids(coordinator.taskCards()));
    }

    @Test public void questionnairesOnlyProjectFromCurrentLiveRun() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("ask-user", "user", "Ask me")));
        String id = store.activeId();
        JSONObject ask = HomeQuestionnaireTest.card().getJSONObject("askUser");
        persistTodo(store, id, "ask-user", "ask-reply", new JSONObject().put("askUser", ask));
        assertTrue(coordinator.taskCard(id).isNull("askUser"));
        ChatCoordinator.SessionRun run = coordinator.registerRun(id, null);
        assertTrue("a new run must not revive a persisted question", coordinator.taskCard(id).isNull("askUser"));
        run.extensionUi = new JSONObject().put("askUser", ask);
        assertEquals("q", coordinator.taskCard(id).getJSONObject("askUser").getString("id"));
        assertEquals(run.requestId, coordinator.taskCard(id).getString("requestId"));
        run.questionnaireReplyPending = "q";
        assertTrue(coordinator.taskCard(id).getBoolean("questionnairePending"));
        run.questionnaireReplyPending = null;
        run.questionnaireError = "try again";
        assertEquals("try again", coordinator.taskCard(id).getString("questionnaireError"));
        coordinator.cancel(id);
        assertTrue(coordinator.taskCard(id).isNull("askUser"));
        coordinator.finish(run, "aborted", "");
        assertTrue(coordinator.taskCard(id).isNull("askUser"));
    }

    @Test public void taskCardsLimitToFiveRecentHistoriesAndExcludeUnsentDrafts() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        List<String> histories = new ArrayList<>();
        for (int index = 0; index < 6; index++) {
            if (index > 0) store.newConversation();
            store.save(Collections.singletonList(message("user-" + index, "user", "Task " + index)));
            histories.add(store.activeId());
        }
        store.selectHomeDraft();
        store.saveDraft("unsent home draft");
        String draftId = store.activeId();
        assertTrue(store.load(draftId).isEmpty());
        for (int index = 0; index < histories.size(); index++)
            stampUpdated(histories.get(index), (index + 1) * 1_000L);
        stampUpdated(draftId, 99_000L);

        JSONArray cards = coordinator.taskCards();
        assertEquals(Arrays.asList(
                histories.get(5), histories.get(4), histories.get(3), histories.get(2), histories.get(1)),
                ids(cards));
        assertFalse(ids(cards).contains(histories.get(0)));
        assertFalse(ids(cards).contains(draftId));
        assertTrue(store.conversations().stream().anyMatch(item -> draftId.equals(item.id)));
    }

    @Test public void deleteConversationNotifiesObserversWithMonotonicSequence() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("keep-user", "user", "Keep me")));
        String kept = store.activeId();
        store.newConversation();
        store.save(Collections.singletonList(message("gone-user", "user", "Delete me")));
        String other = store.activeId();
        store.selectConversation(kept);
        ChatCoordinator.SessionRun seed = coordinator.registerRun(kept, null);
        coordinator.finish(seed, "completed", "");
        idleMain();
        // useChat treats a missing sequence as 0 and drops sequence <= current.sequence.
        long before = coordinator.sequence();
        assertTrue(before > 0);

        List<JSONObject> events = new ArrayList<>();
        ChatCoordinator.Listener listener = (messages, event) -> events.add(event);
        coordinator.addListener(listener);
        try {
            coordinator.deleteConversation(other);
            idleMain();
            assertEquals(1, events.size());
            JSONObject deletedOther = events.get(0);
            assertEquals("conversationDeleted", deletedOther.getString("type"));
            assertEquals(other, deletedOther.getString("conversationId"));
            assertEquals(before + 1, deletedOther.getLong("sequence"));
            JSONObject afterOther = coordinator.snapshot();
            assertEquals(before + 1, afterOther.getLong("sequence"));
            assertEquals(kept, afterOther.getString("conversationId"));
            assertEquals(kept, afterOther.getJSONObject("conversation").getString("id"));
            assertEquals("Keep me", store.load(kept).get(0).content);
            assertFalse(store.conversations().stream().anyMatch(item -> other.equals(item.id)));

            events.clear();
            coordinator.deleteConversation(kept);
            idleMain();
            assertEquals(1, events.size());
            JSONObject deletedCurrent = events.get(0);
            JSONObject afterCurrent = coordinator.snapshot();
            assertEquals("conversationDeleted", deletedCurrent.getString("type"));
            assertEquals(kept, deletedCurrent.getString("conversationId"));
            assertEquals(before + 2, deletedCurrent.getLong("sequence"));
            assertEquals(before + 2, afterCurrent.getLong("sequence"));
            assertNotEquals(kept, afterCurrent.getString("conversationId"));
            assertEquals(afterCurrent.getString("conversationId"),
                    afterCurrent.getJSONObject("conversation").getString("id"));
            assertEquals(0, afterCurrent.getJSONObject("conversation").getJSONArray("nodes").length());
            assertFalse(store.conversations().stream().anyMatch(item -> kept.equals(item.id)));
            assertFalse(store.conversations().stream().anyMatch(item -> other.equals(item.id)));
        } finally {
            coordinator.removeListener(listener);
        }
    }

    @Test public void deleteConversationDoesNotEmitWhenRunIsActiveOrTerminating() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("busy-user", "user", "Busy chat")));
        String conversation = store.activeId();
        ChatCoordinator.SessionRun run = coordinator.registerRun(conversation, null);
        long before = coordinator.sequence();

        List<JSONObject> events = new ArrayList<>();
        ChatCoordinator.Listener listener = (messages, event) -> events.add(event);
        coordinator.addListener(listener);
        try {
            IllegalStateException active = assertThrows(IllegalStateException.class,
                    () -> coordinator.deleteConversation(conversation));
            assertTrue(active.getMessage().contains("请稍后再删除"));
            idleMain();
            assertEquals(0, events.size());
            assertEquals(before, coordinator.sequence());
            assertEquals(conversation, coordinator.snapshot().getString("conversationId"));
            assertTrue(coordinator.running(conversation));
            assertEquals("Busy chat", store.load(conversation).get(0).content);

            coordinator.finish(run, "completed", "");
            idleMain();
            events.clear();
            @SuppressWarnings("unchecked")
            Map<String, ChatCoordinator.SessionRun> terminating =
                    ReflectionHelpers.getField(coordinator, "terminatingRuns");
            ChatCoordinator.SessionRun ending = new ChatCoordinator.SessionRun(conversation, "ending");
            terminating.put(conversation, ending);
            long afterFinish = coordinator.sequence();
            IllegalStateException endingError = assertThrows(IllegalStateException.class,
                    () -> coordinator.deleteConversation(conversation));
            assertTrue(endingError.getMessage().contains("请稍后再删除"));
            idleMain();
            assertEquals(0, events.size());
            assertEquals(afterFinish, coordinator.sequence());
            assertEquals(conversation, store.activeId());
            assertEquals("Busy chat", store.load(conversation).get(0).content);
            terminating.remove(conversation, ending);
        } finally {
            coordinator.removeListener(listener);
        }
    }

    @Test public void generatedTitleUpdatesConversationAndHomeCardWithoutTouchingOtherChats() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.save(Collections.singletonList(message("title-user", "user", "A long original request")));
        String conversation = store.activeId();
        store.showTaskCard(conversation);
        PiTurnPersistence turn = new PiTurnPersistence(store, conversation, "title-user", "title-reply", store.load());
        store.newConversation();
        store.save(Collections.singletonList(message("other-user", "user", "Other chat")));
        String other = store.activeId();
        turn.accept(new JSONObject().put("type", "message").put("message",
                new JSONObject().put("role", "assistant").put("content", "Done")));
        turn.accept(new JSONObject().put("type", "context").put("entries", new JSONArray()
                .put(new JSONObject().put("type", "session").put("id", conversation))
                .put(new JSONObject().put("type", "session_info").put("name", "旧标题"))
                .put(new JSONObject().put("type", "session_info").put("name", "整理桌面应用"))));
        turn.accept(new JSONObject().put("type", "end").put("status", "completed"));

        ChatStore reopened = new ChatStore(application);
        assertEquals("整理桌面应用", reopened.conversations().stream()
                .filter(item -> item.id.equals(conversation)).findFirst().get().title);
        assertEquals("整理桌面应用", card(coordinator.taskCards(), conversation).getString("title"));
        assertEquals("Other chat", card(coordinator.taskCards(), other).getString("title"));
        assertEquals("Other chat", reopened.conversations().stream()
                .filter(item -> item.id.equals(other)).findFirst().get().title);
        assertEquals(other, reopened.activeId());
        assertTrue(reopened.piResume(conversation, reopened.load(conversation)).contains("整理桌面应用"));

        // A later failed/legacy turn without title metadata keeps the generated title.
        List<AgentLoop.Message> next = new java.util.ArrayList<>(reopened.load(conversation));
        next.add(message("next-user", "user", "Continue"));
        reopened.save(conversation, next);
        PiTurnPersistence failed = new PiTurnPersistence(reopened, conversation, "next-user", "next-reply", next);
        failed.accept(new JSONObject().put("type", "end").put("status", "error"));
        assertEquals("整理桌面应用", card(coordinator.taskCards(), conversation).getString("title"));
        assertEquals("Other chat", card(coordinator.taskCards(), other).getString("title"));
    }

    private static AgentLoop.Message message(String id, String role, String content) {
        return new AgentLoop.Message(id, role, content, null, Collections.emptyList(), false);
    }

    private static JSONObject todoState(String subject, String status) throws Exception {
        return new JSONObject().put("todo", new JSONObject()
                .put("package", "@juicesharp/rpiv-todo")
                .put("tasks", new JSONArray().put(new JSONObject()
                        .put("id", 1).put("subject", subject).put("status", status)))
                .put("nextId", 2));
    }

    private static void persistTodo(ChatStore store, String conversationId, String userId, String replyId,
            JSONObject state) throws Exception {
        PiTurnPersistence turn = new PiTurnPersistence(store, conversationId, userId, replyId,
                store.load(conversationId));
        turn.accept(new JSONObject().put("type", "extension_ui").put("state", state));
        turn.accept(new JSONObject().put("type", "message").put("message",
                new JSONObject().put("role", "assistant").put("content", "done")));
        turn.accept(new JSONObject().put("type", "context").put("entries", new JSONArray()
                .put(new JSONObject().put("type", "session").put("version", 3).put("id", conversationId))));
        turn.accept(new JSONObject().put("type", "end").put("status", "completed"));
    }

    private static List<String> ids(JSONArray cards) throws Exception {
        List<String> result = new ArrayList<>();
        for (int index = 0; index < cards.length(); index++)
            result.add(cards.getJSONObject(index).getString("conversationId"));
        return result;
    }

    private static JSONObject card(JSONArray cards, String conversationId) throws Exception {
        for (int index = 0; index < cards.length(); index++) {
            JSONObject card = cards.getJSONObject(index);
            if (conversationId.equals(card.getString("conversationId"))) return card;
        }
        throw new AssertionError("missing card " + conversationId + " in " + ids(cards));
    }

    private void stampUpdated(String conversationId, long updated) throws Exception {
        android.content.SharedPreferences prefs = application.getSharedPreferences("chat", Context.MODE_PRIVATE);
        JSONObject index = new JSONObject(prefs.getString("conversations", "{}"));
        index.getJSONObject(conversationId).put("updated", updated);
        prefs.edit().putString("conversations", index.toString()).commit();
    }

    private static void idleMain() {
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
    }
}
