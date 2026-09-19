package com.example.launcherprobe;

import static org.junit.Assert.*;
import android.app.Application;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class BotSessionsTest {
    private Application app;
    private ChatCoordinator coordinator;
    private ChatStore store;
    private BotManager bots;
    @Before public void setup() throws Exception {
        app = RuntimeEnvironment.getApplication();
        for (String name : new String[] {"chat", "chat_submissions", "scheduled_tasks"})
            app.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit();
        java.nio.file.Files.deleteIfExists(new java.io.File(app.getFilesDir(), "bot-mailbox.bin").toPath());
        ReflectionHelpers.setStaticField(BotManager.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "activeCount", 0);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "foreground", false);
        coordinator = ChatCoordinator.get(app); store = coordinator.store();
        store.ensureBotSession(store.activeId()); bots = BotManager.get(app);
    }
    @After public void cleanup() {
        ChatExecutionService.setActiveCount(app, 0);
        ReflectionHelpers.setStaticField(BotManager.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
    }
    private JSONObject task() throws Exception {
        return new JSONObject().put("title", "简报").put("prompt", "总结资讯").put("repeat", "daily").put("time", "09:00");
    }
    @Test public void createInitializesRoleAndOwnedRoutinesWithoutCopyingHistory() throws Exception {
        String actor = store.activeId(); store.saveDraft("用户的草稿");
        JSONObject result = bots.userAction(actor, "create-once", new JSONObject().put("action", "create")
                .put("name", "研究员").put("rolePrompt", "研究 Rust").put("schedules", new JSONArray().put(task())));
        String id = result.getJSONObject("bot").getString("id");
        assertNotEquals(actor, id); assertEquals("研究 Rust", store.botProfile(id).getString("rolePrompt"));
        assertTrue(store.load(id).isEmpty()); assertEquals("用户的草稿", store.draft(actor));
        JSONObject schedule = result.getJSONObject("schedules").getJSONArray("tasks").getJSONObject(0);
        assertEquals(id, schedule.getString("conversationId"));
        assertTrue(schedule.getLong("nextRunAt") > System.currentTimeMillis());
        assertEquals(0, result.getJSONObject("schedules").getJSONArray("records").length());
    }
    @Test public void ownRoleUsesRevisionAndKeepsHistory() throws Exception {
        String id = store.activeId();
        JSONObject first = bots.userAction(id, "role-1", new JSONObject().put("action", "role").put("rolePrompt", "first").put("revision", 0));
        assertEquals(1, first.getInt("revision"));
        assertThrows(Exception.class, () -> bots.userAction(id, "stale", new JSONObject().put("action", "role").put("rolePrompt", "bad").put("revision", 0)));
        bots.userAction(id, "role-2", new JSONObject().put("action", "role").put("rolePrompt", "second").put("revision", 1));
        assertEquals("first", store.botProfile(id).getJSONArray("history").getJSONObject(1).getString("rolePrompt"));
    }
    @Test public void unsupportedDeletionAndCrossBotRoutineChangesAreRejected() throws Exception {
        String actor = store.activeId();
        store.createBotSession("other", "Other", "", "{}");
        ScheduledTasks schedules = ScheduledTasks.get(app);
        JSONObject otherTask = schedules.save(task().put("conversationId", "other")).getJSONArray("tasks").getJSONObject(0);
        assertThrows(SecurityException.class, () -> bots.userAction(actor, "x", new JSONObject().put("action", "schedule_delete")
                .put("taskId", otherTask.getString("id")).put("revision", 1)));
        assertThrows(IllegalArgumentException.class, () -> bots.userAction(actor, "x", new JSONObject().put("action", "delete").put("userAuthorized", true)));
        assertThrows(Exception.class, () -> bots.execute(actor, "invented-request", "bots:x", new JSONObject().put("action", "self")));
        assertTrue(store.hasConversation("other"));
    }
    @Test public void pausingACurrentlyQueuedRoutineCancelsItBeforeDispatch() throws Exception {
        ScheduledTasks schedules = ScheduledTasks.get(app);
        JSONObject t = schedules.save(task()).getJSONArray("tasks").getJSONObject(0);
        schedules.runNow(t.getString("id"), 1, "test-manual-once");
        assertEquals("queued", schedules.snapshot().getJSONArray("records").getJSONObject(0).getString("status"));
        schedules.setEnabled(t.getString("id"), 1, false);
        assertEquals("cancelled", schedules.snapshot().getJSONArray("records").getJSONObject(0).getString("status"));
        assertFalse(coordinator.running());
    }
    @Test public void manualDeletionRemovesRoutinesAndProfileButLeavesOtherBots() throws Exception {
        String id = store.activeId(); store.saveBotProfile(id, "Primary", "role", 0, "user");
        store.createBotSession("other", "Other", "", "{}");
        ScheduledTasks.get(app).save(task());
        coordinator.deleteConversation(id);
        assertFalse(store.hasConversation(id)); assertTrue(store.hasConversation("other"));
        assertEquals(0, ScheduledTasks.get(app).snapshot().getJSONArray("tasks").length());
    }

    private JSONObject appearance(String name) throws Exception {
        return new JSONObject().put("name", name).put("rolePrompt", "研究 Rust").put("description", "项目伙伴")
                .put("avatar", new JSONObject().put("shape", "cloud").put("color", "blue"))
                .put("routines", new JSONArray());
    }
    private JSONObject find(JSONArray array, String key, String id) throws Exception {
        for (int i = 0; i < array.length(); i++) if (id.equals(array.getJSONObject(i).optString(key))) return array.getJSONObject(i);
        throw new AssertionError("Missing " + key + "=" + id);
    }
    @Test public void workspaceCreatesPersistentAvatarAndPreservesItAcrossModelRoleEdits() throws Exception {
        String selected = store.activeId();
        JSONObject result = BotWorkspace.action(app, "createBot", appearance("研究员"));
        String id = result.getString("id");
        assertEquals(selected, store.activeId());
        JSONObject profile = new ChatStore(app).botProfile(id);
        assertEquals("cloud", profile.getJSONObject("avatar").getString("shape"));
        assertEquals("项目伙伴", profile.getString("description"));
        bots.userAction(id, "role", new JSONObject().put("action", "role").put("rolePrompt", "新的角色")
                .put("revision", profile.getInt("revision")));
        assertEquals("blue", store.botProfile(id).getJSONObject("avatar").getString("color"));
        assertThrows(IllegalStateException.class, () -> BotWorkspace.action(app, "updateBot", appearance("过期编辑")
                .put("id", id).put("revision", profile.getInt("revision"))));
        JSONObject view = bots.workspace().getJSONObject("snapshot");
        JSONObject bot = find(view.getJSONArray("bots"), "id", id);
        assertEquals("新的角色", bot.getString("rolePrompt"));
        assertEquals(1, view.getInt("version"));
        assertTrue(bots.workspace().getJSONObject("capabilities").getBoolean("send"));
    }
    @Test public void workspaceProjectsUserAssistantAndExplicitPeersWithoutDuplicateDelivery() throws Exception {
        String actor = store.activeId();
        store.createBotSession("other", "Other", "", "{}");
        JSONObject sent = bots.userAction(actor, "send", new JSONObject().put("action", "send")
                .put("targetId", "other").put("message", "研究任务"));
        store.saveBotOrigin("other", sent.getString("id"), sent);
        store.save("other", java.util.List.of(new AgentLoop.Message(sent.getString("id"), "user", "HOST ENVELOPE", null,
                java.util.List.of(), false), new AgentLoop.Message("assistant", "仅此会话可见的最终输出")));
        JSONObject view = bots.workspace().getJSONObject("snapshot");
        JSONArray messages = view.getJSONArray("messages");
        assertEquals(2, messages.length());
        JSONObject peer = find(messages, "id", sent.getString("id"));
        assertEquals("bot", peer.getJSONObject("source").getString("kind"));
        assertEquals("研究任务", peer.getString("body"));
        JSONObject assistant = find(messages, "body", "仅此会话可见的最终输出");
        assertEquals("assistant", assistant.getJSONObject("source").getString("kind"));
        JSONObject reply = bots.userAction("other", "reply", new JSONObject().put("action", "reply")
                .put("messageId", sent.getString("id")).put("message", "显式回复"));
        JSONObject replyView = find(bots.workspace().getJSONObject("snapshot").getJSONArray("messages"), "id", reply.getString("id"));
        assertEquals(sent.getString("id"), replyView.getString("replyToMessageId"));
        assertEquals(actor, replyView.getString("toSessionId"));
        assertThrows(SecurityException.class, () -> bots.userAction(actor, "spoof", new JSONObject().put("action", "reply")
                .put("messageId", sent.getString("id")).put("message", "forged")));
    }
    @Test public void workspaceUserQueuePreservesSelectedChatAndDraftAndStopCancelsPending() throws Exception {
        String actor = store.activeId(); store.saveDraft("保留草稿");
        store.createBotSession("other", "Other", "", "{}");
        JSONObject input = new JSONObject().put("toSessionId", "other").put("body", "[bot] still a user")
                .put("submissionId", "workspace-click");
        JSONObject first = BotWorkspace.action(app, "sendUserMessage", input);
        assertEquals(first.getString("id"), BotWorkspace.action(app, "sendUserMessage", input).getString("id"));
        assertThrows(IllegalArgumentException.class, () -> BotWorkspace.action(app, "sendUserMessage",
                new JSONObject(input.toString()).put("body", "changed")));
        JSONObject view = bots.workspace().getJSONObject("snapshot");
        assertEquals("user", view.getJSONArray("messages").getJSONObject(0).getJSONObject("source").getString("kind"));
        assertEquals(actor, store.activeId()); assertEquals("保留草稿", store.draft(actor));
        BotWorkspace.action(app, "stop", new JSONObject().put("id", "other"));
        assertEquals("cancelled", bots.workspace().getJSONObject("snapshot").getJSONArray("messages").getJSONObject(0).getString("status"));
        assertFalse(coordinator.running());
    }
    @Test public void workspaceRoutineEditorSavesRealWeeklyAndMonthlyRulesWithRevision() throws Exception {
        String owner = store.activeId();
        JSONObject input = new JSONObject().put("ownerSessionId", owner).put("title", "每周任务").put("prompt", "研究")
                .put("schedule", new JSONObject().put("kind", "weekly").put("hour", 9).put("minute", 30).put("weekday", 3));
        BotWorkspace.action(app, "saveRoutine", input);
        JSONObject routine = bots.workspace().getJSONObject("snapshot").getJSONArray("routines").getJSONObject(0);
        assertEquals("weekly", routine.getString("repeat")); assertEquals(3, routine.getInt("weekday"));
        assertEquals("09:30", routine.getString("time"));
        input.put("id", routine.getString("id")).put("revision", routine.getInt("revision"));
        input.put("schedule", new JSONObject().put("kind", "monthly").put("hour", 10).put("minute", 15).put("monthDay", 31));
        BotWorkspace.action(app, "saveRoutine", input);
        JSONObject updated = bots.workspace().getJSONObject("snapshot").getJSONArray("routines").getJSONObject(0);
        assertEquals("monthly", updated.getString("repeat")); assertEquals(31, updated.getInt("monthDay"));
        assertEquals(routine.getInt("revision") + 1, updated.getInt("revision"));
        assertThrows(Exception.class, () -> BotWorkspace.action(app, "saveRoutine", input));
        assertEquals(0, ScheduledTasks.get(app).snapshot().getJSONArray("records").length());
        JSONObject invalid = new JSONObject().put("ownerSessionId", owner).put("title", "bad").put("prompt", "x")
                .put("schedule", new JSONObject().put("kind", "weekly").put("hour", 9).put("minute", 0).put("weekday", 1.5));
        assertThrows(IllegalArgumentException.class, () -> BotWorkspace.action(app, "saveRoutine", invalid));
    }
    @Test public void invalidInitialRoutineCreatesNothingAndManualDeleteChecksProfileRevision() throws Exception {
        int count = store.conversations().size();
        JSONObject bad = appearance("Bad").put("routines", new JSONArray().put(new JSONObject().put("title", "x").put("prompt", "x")
                .put("schedule", new JSONObject().put("kind", "daily").put("hour", 25).put("minute", 0))));
        assertThrows(IllegalArgumentException.class, () -> BotWorkspace.action(app, "createBot", bad));
        assertEquals(count, store.conversations().size());
        String id = BotWorkspace.action(app, "createBot", appearance("Disposable")).getString("id");
        JSONObject input = new JSONObject().put("id", id).put("revision", 0);
        assertThrows(IllegalStateException.class, () -> BotWorkspace.action(app, "deleteBot", input));
        BotWorkspace.action(app, "deleteBot", input.put("revision", store.botProfile(id).getInt("revision")));
        assertFalse(store.hasConversation(id));
    }
}
