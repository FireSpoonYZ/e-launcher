package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.Looper;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
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
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.util.ReflectionHelpers;

/** Coordinator/provider boundary: real persistence and events, no Activity, Node or widget host. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, instrumentedPackages = "com.example.launcherprobe",
        shadows = {HostAtomicFile.class, TaskWidgetEventsTest.WidgetShadow.class, TaskWidgetEventsTest.BridgeShadow.class})
public class TaskWidgetEventsTest {
    private Context context;
    private ChatCoordinator coordinator;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "foreground", false);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "activeCount", 0);
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        coordinator = ChatCoordinator.get(context);
        WidgetShadow.requests.clear();
        WidgetShadow.lastImmediateCards = null;
    }

    @After public void cleanup() throws Exception {
        ExecutorService executor = ReflectionHelpers.getField(coordinator, "executor");
        executor.shutdownNow();
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        ChatExecutionService.setActiveCount(context, 0);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    private ChatCoordinator.SessionRun start(String source) throws Exception {
        BridgeShadow.started = new CountDownLatch(1);
        String id = coordinator.store().activeId();
        switch (source) {
            case "scheduled" -> {
                id = UUID.randomUUID().toString();
                coordinator.sendScheduled(id, "Scheduled task", "Scheduled prompt");
            }
            case "voice" -> coordinator.sendVoice(id, "Spoken prompt");
            default -> coordinator.send(id, "Typed prompt", null);
        }
        assertTrue(BridgeShadow.started.await(5, TimeUnit.SECONDS));
        Map<String, ChatCoordinator.SessionRun> runs = ReflectionHelpers.getField(coordinator, "activeRuns");
        Object runLock = ReflectionHelpers.getField(coordinator, "runLock");
        synchronized (runLock) { return runs.get(id); }
    }

    @Test public void foregroundVoiceAndScheduledStartsRefreshAfterUserPersistenceWithoutAnActivity() throws Exception {
        for (String source : List.of("typed", "voice", "scheduled")) {
            coordinator.store().newConversation();
            String selected = coordinator.store().activeId();
            WidgetShadow.requests.clear();
            ChatCoordinator.SessionRun run = start(source);
            assertEquals(List.of(true, false), WidgetShadow.requests);
            JSONObject card = card(WidgetShadow.lastImmediateCards, run.conversationId);
            assertEquals("working", card.getString("modelState"));
            assertFalse(new ChatStore(context).load(run.conversationId).isEmpty());
            if ("scheduled".equals(source)) assertEquals(selected, coordinator.store().activeId());
            coordinator.onPiEvent(new JSONObject().put("type", "end").put("status", "completed"), run);
        }
    }

    @Test public void textDeltasAndOrdinaryStatusRequestOnlyThrottledUpdatesThenTerminalWins() throws Exception {
        ChatCoordinator.SessionRun run = start("typed");
        WidgetShadow.requests.clear();
        for (int i = 0; i < 25; i++) {
            coordinator.onPiEvent(new JSONObject().put("type", "text_delta").put("delta", "x"), run);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(40));
            coordinator.onPiEvent(new JSONObject().put("type", "status").put("message", "Working " + i), run);
        }
        assertTrue("stream events reach the process-owned refresh path", WidgetShadow.requests.size() >= 25);
        assertFalse("40ms streams and repeated status must never bypass provider throttling", WidgetShadow.requests.contains(true));
        coordinator.onPiEvent(new JSONObject().put("type", "end").put("status", "completed"), run);
        JSONObject terminal = card(WidgetShadow.lastImmediateCards, run.conversationId);
        assertEquals("completed", terminal.getString("runStatus"));
        assertEquals("idle", terminal.getString("modelState"));
        assertEquals("x".repeat(25), terminal.getString("result"));
        assertEquals("x".repeat(25), new ChatStore(context).load(run.conversationId).get(1).content);
        int count = WidgetShadow.requests.size();
        coordinator.onPiEvent(new JSONObject().put("type", "text_delta").put("delta", "late"), run);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertEquals("terminal removes stale delta callbacks and fences late events", count, WidgetShadow.requests.size());
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        JSONObject reopened = ChatCoordinator.get(context).taskCard(run.conversationId);
        assertEquals("completed", reopened.getString("runStatus"));
        assertEquals("x".repeat(25), reopened.getString("result"));
        assertEquals("idle", reopened.getString("modelState"));
    }

    @Test public void onlyQuestionChangesRepliesStopAndErrorsBypassOrdinaryEventThrottling() throws Exception {
        ChatCoordinator.SessionRun run = start("typed");
        WidgetShadow.requests.clear();
        JSONObject state = new JSONObject();
        coordinator.onPiEvent(new JSONObject().put("type", "extension_ui").put("state", state), run);
        state.put("askUser", HomeQuestionnaireTest.card().getJSONObject("askUser"));
        coordinator.onPiEvent(new JSONObject().put("type", "extension_ui").put("state", state), run);
        coordinator.onPiEvent(new JSONObject().put("type", "extension_ui").put("state", state), run);
        coordinator.submitQuestionnaire(run.conversationId, run.requestId, "q", new JSONArray(), null);
        coordinator.onPiEvent(new JSONObject().put("type", "questionnaire_reply").put("questionnaireId", "q")
                .put("accepted", false).put("message", "Try again"), run);
        state.remove("askUser");
        coordinator.onPiEvent(new JSONObject().put("type", "extension_ui").put("state", state), run);
        coordinator.cancel(run.conversationId);
        assertEquals("stopping", card(WidgetShadow.lastImmediateCards, run.conversationId).getString("modelState"));
        coordinator.onPiEvent(new JSONObject().put("type", "error").put("message", "Stopped"), run);
        coordinator.onPiEvent(new JSONObject().put("type", "end").put("status", "aborted"), run);
        assertEquals(List.of(false, true, false, true, true, true, true, true, true), WidgetShadow.requests);
        assertEquals("aborted", card(WidgetShadow.lastImmediateCards, run.conversationId).getString("runStatus"));
    }

    @Test public void timeoutAcknowledgementPublishesSavedLateResultAndArchiveDeleteRefreshImmediately() throws Exception {
        ChatCoordinator.SessionRun run = start("typed");
        coordinator.foregroundServiceTimedOut();
        assertEquals("stopping", card(WidgetShadow.lastImmediateCards, run.conversationId).getString("modelState"));
        coordinator.onTerminatingPiEvent(new JSONObject().put("type", "message").put("message",
                new JSONObject().put("role", "assistant").put("content", "Saved interrupted answer")), run);
        coordinator.onTerminatingPiEvent(new JSONObject().put("type", "end").put("status", "aborted"), run);
        JSONObject terminal = card(WidgetShadow.lastImmediateCards, run.conversationId);
        assertEquals("idle", terminal.getString("modelState"));
        assertEquals("aborted", terminal.getString("runStatus"));
        assertEquals("Saved interrupted answer", terminal.getString("result"));
        WidgetShadow.requests.clear();
        coordinator.archiveConversation(run.conversationId);
        assertEquals(0, WidgetShadow.lastImmediateCards.length());
        assertFalse(new ChatStore(context).load(run.conversationId).isEmpty());
        coordinator.restoreConversation(run.conversationId);
        assertEquals(1, WidgetShadow.lastImmediateCards.length());
        coordinator.deleteConversation(run.conversationId);
        assertEquals(0, WidgetShadow.lastImmediateCards.length());
        assertEquals(List.of(true, true, true), WidgetShadow.requests);
    }

    private static JSONObject card(JSONArray cards, String id) throws Exception {
        for (int i = 0; i < cards.length(); i++)
            if (id.equals(cards.getJSONObject(i).optString("conversationId"))) return cards.getJSONObject(i);
        throw new AssertionError("Missing task " + id);
    }

    @Implements(value = TaskWidgetProvider.class, isInAndroidSdk = false)
    public static class WidgetShadow {
        static final List<Boolean> requests = new ArrayList<>();
        static JSONArray lastImmediateCards;
        @Implementation protected static void requestRefresh(Context context, boolean immediate) {
            requests.add(immediate);
            if (immediate) lastImmediateCards = ChatCoordinator.get(context).taskCards();
        }
    }

    @Implements(value = PiAgentBridge.class, isInAndroidSdk = false)
    public static class BridgeShadow {
        static CountDownLatch started;
        @Implementation protected void __constructor__(Context context) { }
        @Implementation protected static PiAgentBridge get(Context context) {
            return ReflectionHelpers.callConstructor(PiAgentBridge.class,
                    ReflectionHelpers.ClassParameter.from(Context.class, context));
        }
        @Implementation protected void prompt(String id, String conversationId, String configuration, String text,
                List<ChatAttachment> files, String sdkHistory, List<AgentLoop.Message> prior,
                PiConfigStore configStore, PiAgentBridge.Listener listener) { started.countDown(); }
        @Implementation protected void replyQuestionnaire(String request, String conversation, String questionnaire,
                JSONObject result, boolean cancelled) { }
        @Implementation protected void abort(String request) { }
        @Implementation protected static void forgetConversation(String conversationId) { }
    }
}
