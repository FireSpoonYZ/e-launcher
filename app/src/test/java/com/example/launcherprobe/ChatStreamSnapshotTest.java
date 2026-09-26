package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.Looper;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
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

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, instrumentedPackages = "com.example.launcherprobe",
        shadows = {HostAtomicFile.class, ChatStreamSnapshotTest.WidgetShadow.class})
public class ChatStreamSnapshotTest {
    private Context context;
    private ChatCoordinator coordinator;
    private ChatCoordinator.SessionRun run;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        coordinator = ChatCoordinator.get(context);
        ChatStore store = coordinator.store();
        AgentLoop.Message user = new AgentLoop.Message("user", "question");
        store.save(List.of(user));
        run = new ChatCoordinator.SessionRun(store.activeId(), "request");
        run.persistence = new PiTurnPersistence(store, run.conversationId, user.id, "reply", store.load());
        Map<String, ChatCoordinator.SessionRun> runs = ReflectionHelpers.getField(coordinator, "activeRuns");
        runs.put(run.conversationId, run);
        WidgetShadow.entered = null;
        WidgetShadow.release = null;
    }

    @After public void cleanup() throws Exception {
        if (WidgetShadow.release != null) WidgetShadow.release.countDown();
        ExecutorService executor = ReflectionHelpers.getField(coordinator, "executor");
        executor.shutdownNow();
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    @Test public void snapshotCannotObserveSavedDeltaBeforeItsSequenceIsPublished() throws Exception {
        List<JSONObject> events = new ArrayList<>();
        List<List<AgentLoop.Message>> histories = new ArrayList<>();
        coordinator.addListener((messages, event) -> { histories.add(messages); events.add(event); });
        coordinator.onPiEvent(new JSONObject().put("type", "text_delta").put("delta", "partial"), run);
        // Pause the actual flush after saving the preview, but before allocating its event sequence.
        WidgetShadow.entered = new CountDownLatch(1);
        WidgetShadow.release = new CountDownLatch(1);
        FutureTask<Void> flush = new FutureTask<>(() -> {
            ReflectionHelpers.callInstanceMethod(coordinator, "flushPiDelta",
                    ReflectionHelpers.ClassParameter.from(boolean.class, true),
                    ReflectionHelpers.ClassParameter.from(ChatCoordinator.SessionRun.class, run));
            return null;
        });
        Thread writer = new Thread(flush, "preview-writer");
        FutureTask<JSONObject> snapshot = new FutureTask<>(coordinator::snapshot);
        Thread reader = new Thread(snapshot, "plugin-snapshot");
        try {
            writer.start();
            assertTrue(WidgetShadow.entered.await(5, TimeUnit.SECONDS));
            assertEquals("partial", new ChatStore(context).load().get(1).content);
            reader.start();
            awaitBlockedOrFinished(reader);
        } finally {
            WidgetShadow.release.countDown();
            writer.join(5000);
            reader.join(5000);
        }
        flush.get(5, TimeUnit.SECONDS);
        JSONObject captured = snapshot.get(5, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(1, events.size());
        assertEquals("textDelta", events.get(0).getString("type"));
        assertEquals(events.get(0).getLong("sequence"), captured.getLong("sequence"));
        assertEquals("partial", captured.getJSONObject("conversation").getJSONArray("nodes")
                .getJSONObject(1).getJSONObject("message").getString("content"));
        assertEquals("partial", histories.get(0).get(1).content);
        assertThrows(UnsupportedOperationException.class, () -> histories.get(0).clear());
    }

    @Test public void terminalSnapshotAndListenerHistorySurviveQueuedAndLatePreviews() throws Exception {
        List<JSONObject> events = new ArrayList<>();
        List<List<AgentLoop.Message>> histories = new ArrayList<>();
        coordinator.addListener((messages, event) -> { events.add(event); histories.add(messages); });
        coordinator.onPiEvent(new JSONObject().put("type", "text_delta").put("delta", "partial"), run);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(40));
        coordinator.onPiEvent(new JSONObject().put("type", "text_delta").put("delta", " queued"), run);
        coordinator.onPiEvent(new JSONObject().put("type", "message").put("message",
                new JSONObject().put("role", "assistant").put("content", "complete")), run);
        coordinator.onPiEvent(new JSONObject().put("type", "end").put("status", "completed"), run);
        long terminalSequence = coordinator.sequence();
        coordinator.onPiEvent(new JSONObject().put("type", "text_delta").put("delta", "late"), run);
        AgentLoop.Message stale = new AgentLoop.Message("reply", "assistant", "stale", null, List.of(), true);
        run.persistence.savePreview(stale);
        ChatStore reopened = new ChatStore(context);
        reopened.savePiPreview(run.conversationId, reopened.load().get(0).id, "reply",
                List.of(reopened.load().get(0), stale));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        JSONObject captured = coordinator.snapshot();
        assertEquals(terminalSequence, captured.getLong("sequence"));
        assertFalse(captured.getBoolean("running"));
        assertEquals("completed", captured.getString("status"));
        assertEquals("complete", reopened.load().get(1).content);
        assertFalse(reopened.load().get(1).incomplete);
        assertEquals("end", events.get(events.size() - 1).getString("type"));
        assertEquals(terminalSequence, events.get(events.size() - 1).getLong("sequence"));
        assertEquals("complete", histories.get(histories.size() - 1).get(1).content);
        assertEquals("partial", histories.get(0).get(1).content);
    }

    @Test public void decodedHistoryIsReusedWithoutSharingMutableTreesOrMissingExternalWrites() {
        ChatStore store = coordinator.store();
        AgentLoop.Message first = store.load().get(0);
        assertSame("unchanged persisted history is decoded only once", first, store.load().get(0));
        ConversationTree detached = store.tree();
        detached.select(null);
        detached.merge(List.of(new AgentLoop.Message("assistant", "not saved")));
        assertEquals(List.of(first), store.load());
        ChatStore other = new ChatStore(context);
        AgentLoop.Message reply = new AgentLoop.Message("reply", "assistant", "saved", null,
                List.of(new AgentLoop.ToolCall("call", "read", "x".repeat(50_001))), false);
        other.save(List.of(first, reply));
        List<AgentLoop.Message> saved = store.load();
        assertEquals("saved", saved.get(1).content);
        assertEquals(50_000, saved.get(1).toolCalls.get(0).arguments.length());
        assertSame(saved.get(1), store.load().get(1));
        other.selectNode(first.id);
        assertEquals(1, store.load().size());
        other.newConversation();
        other.save(List.of(new AgentLoop.Message("user", "second conversation")));
        assertEquals("second conversation", store.load().get(0).content);
        assertEquals("question", store.load(run.conversationId).get(0).content);
    }

    private static void awaitBlockedOrFinished(Thread thread) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (thread.isAlive() && thread.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline)
            Thread.yield();
        assertTrue("snapshot must either reach the monitor or finish", !thread.isAlive()
                || thread.getState() == Thread.State.BLOCKED);
    }

    @Implements(value = TaskWidgetProvider.class, isInAndroidSdk = false)
    public static class WidgetShadow {
        static volatile CountDownLatch entered, release;
        @Implementation protected static void requestRefresh(Context context, boolean immediate) {
            if (entered == null) return;
            entered.countDown();
            try { assertTrue(release.await(5, TimeUnit.SECONDS)); }
            catch (InterruptedException exception) { throw new AssertionError(exception); }
        }
    }
}
