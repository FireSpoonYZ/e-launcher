package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.pm.ServiceInfo;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowApplication;
import org.robolectric.shadows.ShadowNotificationManager;
import org.robolectric.util.ReflectionHelpers;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class ChatExecutionServiceTest {
    private Application application;
    private ShadowApplication shadowApplication;

    @Before public void setUp() {
        application = RuntimeEnvironment.getApplication();
        shadowApplication = Shadows.shadowOf(application);
        shadowApplication.clearStartedServices();
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

    @Test public void notificationCountTracksOneTwoOneZero() {
        ServiceController<ChatExecutionService> controller = Robolectric.buildService(ChatExecutionService.class).create();
        ChatExecutionService service = controller.get();
        try {
            ChatExecutionService.setActiveCount(application, 1);
            Intent first = shadowApplication.getNextStartedService();
            assertNotNull(first);
            service.onStartCommand(first, 0, 1);
            assertEquals("1 个会话正在运行", notificationText());

            ChatExecutionService.setActiveCount(application, 2);
            assertEquals("2 个会话正在运行", notificationText());
            ChatExecutionService.setActiveCount(application, 1);
            assertEquals("1 个会话正在运行", notificationText());
            ChatExecutionService.setActiveCount(application, 0);
            assertNotNull(shadowApplication.getNextStoppedService());
            assertEquals(0, (int) ReflectionHelpers.getStaticField(ChatExecutionService.class, "activeCount"));
        } finally {
            controller.destroy();
        }
    }

    @Test public void staleStartCannotReplaceTheLatestCount() {
        ServiceController<ChatExecutionService> controller = Robolectric.buildService(ChatExecutionService.class).create();
        ChatExecutionService service = controller.get();
        try {
            ChatExecutionService.setActiveCount(application, 1);
            Intent stale = shadowApplication.getNextStartedService();
            ChatExecutionService.setActiveCount(application, 2);
            Intent latest = shadowApplication.getNextStartedService();
            service.onStartCommand(latest, 0, 2);
            assertEquals("2 个会话正在运行", notificationText());
            service.onStartCommand(stale, 0, 1);
            assertEquals("2 个会话正在运行", notificationText());
        } finally {
            controller.destroy();
        }
    }

    @Test public void timeoutBeforeNodeRegistrationEndsImmediatelyWithoutAFence() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        AgentLoop.Message user = new AgentLoop.Message("timeout-user", "user", "timeout", null,
                Collections.emptyList(), false);
        store.save(Collections.singletonList(user));
        ChatCoordinator.SessionRun run = new ChatCoordinator.SessionRun(store.activeId(), "timeout-request");
        run.persistence = new PiTurnPersistence(store, store.activeId(), user.id, "timeout-assistant", store.load());
        @SuppressWarnings("unchecked")
        Map<String, ChatCoordinator.SessionRun> active = ReflectionHelpers.getField(coordinator, "activeRuns");
        active.put(run.conversationId, run);
        List<JSONObject> events = new ArrayList<>();
        ChatCoordinator.Listener listener = (messages, event) -> events.add(event);
        coordinator.addListener(listener);
        ServiceController<ChatExecutionService> controller = Robolectric.buildService(ChatExecutionService.class).create();
        try {
            ChatExecutionService.setActiveCount(application, 1);
            Intent start = shadowApplication.getNextStartedService();
            controller.get().onStartCommand(start, 0, 7);
            controller.get().onTimeout(7, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();

            assertTrue(run.cancellation.cancelled());
            assertFalse(coordinator.running(run.conversationId));
            assertEquals("aborted", coordinator.snapshot().getString("status"));
            assertTrue(coordinator.snapshot().getString("error").contains("超时"));
            assertEquals(1, store.load(run.conversationId).size());
            store.piResume(run.conversationId, store.load(run.conversationId));
            assertTrue(events.stream().anyMatch(event -> "end".equals(event.optString("type"))
                    && run.conversationId.equals(event.optString("conversationId"))));
            @SuppressWarnings("unchecked")
            Map<String, ChatCoordinator.SessionRun> terminating = ReflectionHelpers.getField(
                    coordinator, "terminatingRuns");
            assertFalse(terminating.containsKey(run.conversationId));
            assertNotNull(shadowApplication.getNextStoppedService());
        } finally {
            coordinator.removeListener(listener);
            controller.destroy();
        }
    }

    @Test public void registeredNodeTimeoutSavesLateContextBeforeReleasingFence() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        AgentLoop.Message firstUser = new AgentLoop.Message("first-user", "user", "first question", null,
                Collections.emptyList(), false);
        store.save(Collections.singletonList(firstUser));
        String firstConversation = store.activeId();
        ChatCoordinator.SessionRun first = new ChatCoordinator.SessionRun(firstConversation, "first-request");
        first.persistence = new PiTurnPersistence(store, firstConversation, firstUser.id, "first-assistant",
                store.load(firstConversation));
        first.nodeRegistered = true;
        @SuppressWarnings("unchecked")
        Map<String, ChatCoordinator.SessionRun> active = ReflectionHelpers.getField(coordinator, "activeRuns");
        @SuppressWarnings("unchecked")
        Map<String, ChatCoordinator.SessionRun> terminating = ReflectionHelpers.getField(
                coordinator, "terminatingRuns");
        active.put(firstConversation, first);
        coordinator.onPiEvent(message(new JSONObject().put("role", "assistant").put("content", "checking")
                .put("stopReason", "toolUse").put("toolCalls", new JSONArray()
                        .put(call("tool-1", "read", "{\"path\":\"one\"}")))), first);
        coordinator.onPiEvent(message(new JSONObject().put("role", "tool").put("content", "first-result")
                .put("toolCallId", "tool-1")), first);

        ServiceController<ChatExecutionService> controller = Robolectric.buildService(ChatExecutionService.class).create();
        try {
            ChatExecutionService.setActiveCount(application, 1);
            controller.get().onStartCommand(shadowApplication.getNextStartedService(), 0, 9);
            controller.get().onTimeout(9, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            assertNotNull(shadowApplication.getNextStoppedService());
            assertFalse(coordinator.running(firstConversation));
            assertTrue(terminating.containsKey(firstConversation));
            assertThrows(java.io.IOException.class,
                    () -> store.piResume(firstConversation, store.load(firstConversation)));

            store.newConversation();
            String secondConversation = store.activeId();
            AgentLoop.Message secondUser = new AgentLoop.Message("second-user", "user", "second question", null,
                    Collections.emptyList(), false);
            store.save(secondConversation, Collections.singletonList(secondUser));
            ChatCoordinator.SessionRun second = new ChatCoordinator.SessionRun(secondConversation, "second-request");
            second.persistence = new PiTurnPersistence(store, secondConversation, secondUser.id, "second-assistant",
                    store.load(secondConversation));
            active.put(secondConversation, second);
            coordinator.onPiEvent(message(new JSONObject().put("role", "assistant").put("content", "second answer")
                    .put("stopReason", "stop").put("toolCalls", new JSONArray())), second);

            coordinator.onTerminatingPiEvent(message(new JSONObject().put("role", "assistant")
                    .put("content", "first interrupted answer").put("stopReason", "aborted")
                    .put("toolCalls", new JSONArray())), first);
            coordinator.onPiEvent(new JSONObject().put("type", "context").put("entries", entries("second")), second);
            coordinator.onPiEvent(new JSONObject().put("type", "end").put("status", "completed"), second);
            coordinator.onTerminatingPiEvent(new JSONObject().put("type", "context")
                    .put("entries", entries("first")), first);
            coordinator.onTerminatingPiEvent(new JSONObject().put("type", "end").put("status", "aborted"), first);

            assertFalse(terminating.containsKey(firstConversation));
            List<AgentLoop.Message> firstHistory = store.load(firstConversation);
            assertEquals(Arrays.asList("user", "assistant", "tool", "assistant"),
                    roles(firstHistory));
            JSONObject firstResume = new JSONObject(store.piResume(firstConversation, firstHistory));
            assertEquals("first", firstResume.getJSONArray("entries").getJSONObject(0).getString("id"));
            List<AgentLoop.Message> secondHistory = store.load(secondConversation);
            assertEquals(Arrays.asList("user", "assistant"), roles(secondHistory));
            assertEquals("second answer", secondHistory.get(1).content);
            assertTrue(store.piContext(secondHistory.get(1).id).contains("second"));
        } finally {
            active.clear();
            terminating.clear();
            controller.destroy();
        }
    }

    @Test public void coordinatorRegistrationAndOtherFailureKeepLatestCount() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(application);
        ChatStore store = coordinator.store();
        store.newConversation();
        String registeredConversation = store.activeId();
        @SuppressWarnings("unchecked")
        Map<String, ChatCoordinator.SessionRun> active = ReflectionHelpers.getField(coordinator, "activeRuns");
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            for (int i = 0; i < 20; i++) {
                ChatCoordinator.SessionRun failing = new ChatCoordinator.SessionRun("failing-" + i, "old-" + i);
                active.put(failing.conversationId, failing);
                ChatExecutionService.setActiveCount(application, 1);
                CountDownLatch start = new CountDownLatch(1);
                Future<ChatCoordinator.SessionRun> registration = executor.submit(() -> {
                    start.await();
                    return coordinator.registerRun(registeredConversation, null);
                });
                Future<?> failure = executor.submit(() -> {
                    start.await();
                    coordinator.finish(failing, "error", "startup failed");
                    return null;
                });
                start.countDown();
                ChatCoordinator.SessionRun registered = registration.get();
                failure.get();
                assertEquals(1, active.size());
                assertTrue(active.get(registeredConversation) == registered);
                assertEquals(1, (int) ReflectionHelpers.getStaticField(ChatExecutionService.class, "activeCount"));
                coordinator.finish(registered, "aborted", "");
            }
        } finally {
            executor.shutdownNow();
            active.clear();
        }
    }

    @Test public void registrationRollsBackWhenForegroundServiceStartFails() {
        Context failingContext = new ContextWrapper(application) {
            @Override public ComponentName startForegroundService(Intent service) {
                throw new IllegalStateException("fixture start failure");
            }
        };
        ChatCoordinator coordinator = ReflectionHelpers.callConstructor(ChatCoordinator.class,
                ReflectionHelpers.ClassParameter.from(Context.class, failingContext));
        @SuppressWarnings("unchecked")
        Map<String, ChatCoordinator.SessionRun> active = ReflectionHelpers.getField(coordinator, "activeRuns");
        assertThrows(IllegalStateException.class, () -> coordinator.registerRun(coordinator.store().activeId(), null));
        assertTrue(active.isEmpty());
        assertEquals(0, (int) ReflectionHelpers.getStaticField(ChatExecutionService.class, "activeCount"));
    }

    private static JSONObject message(JSONObject value) throws Exception {
        return new JSONObject().put("type", "message").put("message", value);
    }

    private static JSONObject call(String id, String name, String arguments) throws Exception {
        return new JSONObject().put("id", id).put("name", name).put("arguments", arguments);
    }

    private static JSONArray entries(String id) throws Exception {
        return new JSONArray().put(new JSONObject().put("type", "session").put("version", 3).put("id", id));
    }

    private static List<String> roles(List<AgentLoop.Message> messages) {
        List<String> result = new ArrayList<>();
        for (AgentLoop.Message message : messages) result.add(message.role);
        return result;
    }

    private ShadowNotificationManager notificationManager() {
        return Shadows.shadowOf(application.getSystemService(NotificationManager.class));
    }

    private String notificationText() {
        Notification notification = notificationManager().getNotification(3107);
        assertNotNull(notification);
        return String.valueOf(notification.extras.getCharSequence(Notification.EXTRA_TEXT));
    }
}
