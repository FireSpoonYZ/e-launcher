package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import java.util.Collections;
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

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class TaskNotificationsTest {
    private Application context;
    private ChatCoordinator coordinator;
    private ChatStore store;
    private NotificationManager notifications;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        coordinator = ChatCoordinator.get(context);
        store = coordinator.store();
        notifications = context.getSystemService(NotificationManager.class);
        notifications.cancelAll();
    }

    @After public void cleanup() {
        notifications.cancelAll();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    private ChatCoordinator.SessionRun start(String title) {
        store.newConversation();
        AgentLoop.Message user = new AgentLoop.Message("user", title);
        store.save(Collections.singletonList(user));
        ChatCoordinator.SessionRun run = coordinator.registerRun(store.activeId(), null);
        run.persistence = new PiTurnPersistence(store, run.conversationId, user.id, "reply-" + run.requestId, store.load());
        return run;
    }

    private Notification notification(String id) {
        return Shadows.shadowOf(notifications).getNotification(id, TaskNotifications.ID);
    }

    private void question(ChatCoordinator.SessionRun run, String id) throws Exception {
        JSONObject state = new JSONObject();
        if (id != null) state.put("askUser", new JSONObject().put("id", id));
        coordinator.onPiEvent(new JSONObject().put("type", "extension_ui").put("state", state), run);
    }

    @Test public void completionTargetsItsConversationAndOnlyReadingItClearsUnread() {
        ChatCoordinator.SessionRun first = start("First");
        coordinator.finish(first, "completed", "");
        Notification result = notification(first.conversationId);
        assertNotNull(result);
        assertEquals(TaskNotifications.CHANNEL, result.getChannelId());
        Intent intent = Shadows.shadowOf(result.contentIntent).getSavedIntent();
        assertEquals(TaskDetailActivity.class.getName(), intent.getComponent().getClassName());
        assertEquals(first.conversationId, intent.getStringExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID));
        ChatCoordinator.SessionRun second = start("Second");
        coordinator.finish(second, "error", "failed");
        assertNotEquals(result.contentIntent, notification(second.conversationId).contentIntent);
        assertEquals("执行失败", notification(second.conversationId).extras.getString(Notification.EXTRA_TEXT));
        coordinator.markTaskRead(second.conversationId);
        assertNull(notification(second.conversationId));
        assertNotNull(notification(first.conversationId));
        assertTrue(new ChatStore(context).taskResultUnread(first.conversationId));
        coordinator.markTaskRead(first.conversationId);
        coordinator.finish(first, "completed", "");
        assertNull(notification(first.conversationId));
        assertFalse(store.taskResultUnread(first.conversationId));
    }

    @Test public void questionsDeduplicateAndErrorsDoNotAnnounceTerminalState() throws Exception {
        ChatCoordinator.SessionRun run = start("Question");
        question(run, "q");
        assertEquals("需要你回答", notification(run.conversationId).extras.getString(Notification.EXTRA_TEXT));
        notifications.cancel(run.conversationId, TaskNotifications.ID);
        question(run, "q");
        assertNull("duplicate cannot resurrect a dismissed notification", notification(run.conversationId));
        question(run, "q2");
        assertNotNull(notification(run.conversationId));
        question(run, null);
        assertNull(notification(run.conversationId));
        coordinator.onPiEvent(new JSONObject().put("type", "error").put("message", "retrying"), run);
        assertTrue(coordinator.running(run.conversationId));
        assertFalse(store.taskResultUnread(run.conversationId));
        assertNull(notification(run.conversationId));
        coordinator.finish(run, "completed", "");
        assertEquals("任务已完成", notification(run.conversationId).extras.getString(Notification.EXTRA_TEXT));
    }

    @Test public void archiveDeleteAndCancellationDoNotReviveOldQuestions() throws Exception {
        ChatCoordinator.SessionRun run = start("Stop");
        question(run, "q");
        coordinator.cancel(run.conversationId);
        assertNull(notification(run.conversationId));
        question(run, "late");
        assertNull(notification(run.conversationId));
        coordinator.finish(run, "aborted", "");
        assertEquals("任务已中断", notification(run.conversationId).extras.getString(Notification.EXTRA_TEXT));
        coordinator.deleteConversation(run.conversationId);
        coordinator.finish(run, "completed", "");
        assertNull(notification(run.conversationId));
        assertFalse(store.taskResultUnread(run.conversationId));
        ChatCoordinator.SessionRun archived = start("Archive");
        question(archived, "q");
        coordinator.archiveConversation(archived.conversationId);
        assertNull(notification(archived.conversationId));
        coordinator.finish(archived, "completed", "");
        assertNull(notification(archived.conversationId));
        coordinator.restoreConversation(archived.conversationId);
        assertFalse(store.taskResultUnread(archived.conversationId));
    }

    @Test public void timeoutPersistsInterruptedResultAndOpeningDetailReadsOnlyItsTask() {
        ChatCoordinator.SessionRun run = start("Timed out");
        coordinator.foregroundServiceTimedOut();
        assertEquals("aborted", coordinator.taskCard(run.conversationId).optString("runStatus"));
        assertEquals("任务已中断", notification(run.conversationId).extras.getString(Notification.EXTRA_TEXT));
        ChatCoordinator.SessionRun other = start("Other");
        coordinator.finish(other, "completed", "");
        try (org.robolectric.android.controller.ActivityController<TaskDetailActivity> detail =
                org.robolectric.Robolectric.buildActivity(TaskDetailActivity.class,
                        new Intent(context, TaskDetailActivity.class)
                                .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, run.conversationId)).setup()) {
            assertFalse(store.taskResultUnread(run.conversationId));
            assertNull(notification(run.conversationId));
            assertTrue(store.taskResultUnread(other.conversationId));
            assertNotNull(notification(other.conversationId));
        }
    }

    public static class FocusedMainActivity extends MainActivity {
        boolean focused = true;
        @Override public boolean hasWindowFocus() { return focused; }
    }

    @Test public void retainedWebViewOnHomeCannotReadUntilTargetChatIsVisible() {
        ChatCoordinator.SessionRun run = start("Read target");
        coordinator.finish(run, "completed", "");
        FocusedMainActivity activity = org.robolectric.Robolectric.buildActivity(FocusedMainActivity.class).get();
        android.webkit.WebView web = new android.webkit.WebView(context);
        web.loadUrl("https://localhost/#/chat/" + run.conversationId);
        PagerRoot pager = new PagerRoot(context, web, PagerState.Page.HOME, ignored -> {});
        ReflectionHelpers.setField(activity, "chatStore", store);
        ReflectionHelpers.setField(activity, "chatWebView", web);
        ReflectionHelpers.setField(activity, "pager", pager);
        ReflectionHelpers.setField(activity, "trustedWebContent", true);
        assertFalse(activity.isTaskConversationVisible(run.conversationId));
        assertTrue(store.taskResultUnread(run.conversationId));
        pager.show(PagerState.Page.CHAT, false);
        assertTrue(activity.isTaskConversationVisible(run.conversationId));
        assertFalse(activity.isTaskConversationVisible("other"));
        activity.focused = false;
        assertFalse(activity.isTaskConversationVisible(run.conversationId));
        activity.focused = true;
        web.loadUrl("https://localhost/#/settings");
        assertFalse(activity.isTaskConversationVisible(run.conversationId));
        web.loadUrl("https://localhost/#/chat/" + run.conversationId);
        if (activity.isTaskConversationVisible(run.conversationId)) coordinator.markTaskRead(run.conversationId);
        assertFalse(store.taskResultUnread(run.conversationId));
        assertNull(notification(run.conversationId));
        web.destroy();
    }

    @Test public void disabledNotificationsStillFinishAndAttentionSurvivesFiveCardLimit() throws Exception {
        Shadows.shadowOf(notifications).setNotificationsEnabled(false);
        ChatCoordinator.SessionRun unread = start("Unread");
        coordinator.finish(unread, "completed", "");
        assertFalse(coordinator.running(unread.conversationId));
        assertTrue(store.taskResultUnread(unread.conversationId));
        assertNull(notification(unread.conversationId));
        ChatCoordinator.SessionRun pending = start("Pending");
        question(pending, "q");
        for (int i = 0; i < 6; i++) {
            ChatCoordinator.SessionRun read = start("Read " + i);
            coordinator.finish(read, "completed", "");
            coordinator.markTaskRead(read.conversationId);
        }
        assertEquals(5, coordinator.taskCards().length());
        assertEquals(pending.conversationId, coordinator.taskCards().optJSONObject(0).optString("conversationId"));
        assertEquals(unread.conversationId, coordinator.taskCards().optJSONObject(1).optString("conversationId"));
        assertTrue(coordinator.taskCards().optJSONObject(1).optBoolean("unreadResult"));
    }
}
