package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
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
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
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
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    @After public void tearDown() {
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

        JSONArray cards = coordinator.taskCards();
        assertEquals(Arrays.asList(firstId, secondId), ids(cards));
        assertEquals("Task A", cards.getJSONObject(0).getString("title"));
        assertEquals("working", cards.getJSONObject(0).getString("modelState"));
        assertEquals("in_progress", cards.getJSONObject(0).getJSONObject("todo")
                .getJSONArray("tasks").getJSONObject(0).getString("status"));
        assertTrue(cards.getJSONObject(1).isNull("todo"));

        coordinator.cancel(firstId);
        cards = coordinator.taskCards();
        assertEquals("stopping", cards.getJSONObject(0).getString("modelState"));
        assertEquals("in_progress", cards.getJSONObject(0).getJSONObject("todo")
                .getJSONArray("tasks").getJSONObject(0).getString("status"));

        coordinator.finish(first, "aborted", "");
        cards = coordinator.taskCards();
        assertEquals("idle", cards.getJSONObject(0).getString("modelState"));
        assertEquals("in_progress", cards.getJSONObject(0).getJSONObject("todo")
                .getJSONArray("tasks").getJSONObject(0).getString("status"));

        coordinator.dismissTaskCard(firstId);
        assertEquals(Collections.singletonList(secondId), ids(coordinator.taskCards()));
        assertTrue(store.conversations().stream().anyMatch(item -> firstId.equals(item.id)));
        assertTrue(coordinator.running(secondId));
        assertEquals(Collections.singletonList(secondId), new ChatStore(application).taskCardIds());

        coordinator.finish(second, "completed", "");
        store.selectConversation(firstId);
        ChatCoordinator.SessionRun restarted = coordinator.registerRun(firstId, null);
        assertEquals(Arrays.asList(secondId, firstId), ids(coordinator.taskCards()));
        coordinator.finish(restarted, "completed", "");
        store.clear(firstId);
        assertEquals(Collections.singletonList(secondId), store.taskCardIds());
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
        List<String> result = new java.util.ArrayList<>();
        for (int index = 0; index < cards.length(); index++)
            result.add(cards.getJSONObject(index).getString("conversationId"));
        return result;
    }
}
