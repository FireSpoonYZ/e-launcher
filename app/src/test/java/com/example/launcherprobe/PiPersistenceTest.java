package com.example.launcherprobe;

import static org.junit.Assert.*;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE, shadows = HostAtomicFile.class)
public class PiPersistenceTest {
    private Context context;
    @Before public void prepare() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test public void snapshotProvidesBuiltInNpmWithoutPersistingOrOverridingUserCommand() throws Exception {
        PiConfigStore store = new PiConfigStore(context);
        store.save(false, "settings.json", "{}", null);
        JSONObject snapshot = new JSONObject(store.snapshot());
        JSONArray command = snapshot.getJSONObject("globalSettings").getJSONArray("npmCommand");
        assertTrue(command.getString(0).endsWith("libnode_launcher.so"));
        assertTrue(command.getString(1).replace('\\', '/').endsWith("npm/11.6.2/bin/npm-cli.js"));
        assertFalse(store.settings(false).containsKey("npmCommand"));
        store.save(false, "settings.json", "{\"npmCommand\":[\"custom-npm\"]}", store.read(false, "settings.json"));
        assertEquals("custom-npm", new JSONObject(store.snapshot()).getJSONObject("globalSettings")
                .getJSONArray("npmCommand").getString(0));
        store.save(true, "settings.json", "{\"npmCommand\":[\"workspace-npm\"]}", null);
        assertEquals("workspace-npm", new JSONObject(store.snapshot()).getJSONObject("projectSettings")
                .getJSONArray("npmCommand").getString(0));
        store.save(true, "settings.json", "{\"npmCommand\":[]}", null);
        snapshot = new JSONObject(store.snapshot());
        assertTrue(snapshot.getJSONObject("globalSettings").getJSONArray("npmCommand").getString(0).endsWith("libnode_launcher.so"));
        assertFalse(snapshot.getJSONObject("projectSettings").has("npmCommand"));
        assertEquals("[]", new JSONObject(store.read(true, "settings.json")).getJSONArray("npmCommand").toString());
    }

    @Test public void oauthRotationAndLogoutCompareNumericExpiryByValue() throws Exception {
        PiConfigStore store = new PiConfigStore(context);
        String old = "{\"type\":\"oauth\",\"access\":\"old\",\"refresh\":\"r1\",\"expires\":1700000000000}";
        String next = "{\"type\":\"oauth\",\"access\":\"new\",\"refresh\":\"r2\",\"expires\":1800000000000}";
        store.save(false, "auth.json", "{\"test\":" + old + ",\"unknown\":9007199254740993123456789}", store.read(false, "auth.json"));
        store.updateCredential("test", next, old);
        assertTrue(store.read(false, "auth.json").contains("9007199254740993123456789"));
        String atomicLogs = org.robolectric.shadows.ShadowLog.getLogsForTag("AtomicFile").stream()
                .map(item -> item.msg).collect(java.util.stream.Collectors.joining("\n"));
        assertEquals(atomicLogs, "new", ConfigJson.asObject(ConfigJson.object(store.read(false, "auth.json")).get("test")).get("access"));
        assertThrows(java.io.IOException.class, () -> store.updateCredential("test", old, old));
        store.updateCredential("test", null, next);
        assertFalse(ConfigJson.object(store.read(false, "auth.json")).containsKey("test"));
        JSONObject numeric = new JSONObject("{\"type\":\"number\",\"min\":3,\"max\":20}");
        PiSettingsActivity.validateField(numeric, ConfigJson.object("{\"value\":5}").get("value"));
        for (String invalid : Arrays.asList("2", "21", "3.5", "1e-9999")) {
            assertThrows(IllegalArgumentException.class, () -> PiSettingsActivity.validateField(numeric, ConfigJson.object("{\"value\":" + invalid + "}").get("value")));
        }
    }

    private JSONArray entries() throws Exception {
        return new JSONArray("[{\"type\":\"session\",\"version\":3,\"id\":\"fixture\"},{\"type\":\"compaction\",\"summary\":\"kept\"}]");
    }

    @Test public void retiredActivityStillPersistsOnlyItsOriginalConversation() throws Exception {
        ChatStore store = new ChatStore(context);
        AgentLoop.Message user = new AgentLoop.Message("user", "question");
        store.save(Collections.singletonList(user));
        String conversation = store.activeId();
        PiTurnPersistence turn = new PiTurnPersistence(store, conversation, user.id, "reply", store.load());
        RunEpoch epoch = new RunEpoch(); long owner = epoch.acquire(); epoch.retire(owner);
        assertFalse(epoch.owns(owner));
        store.newConversation(); String active = store.activeId();
        turn.accept(new JSONObject().put("type", "text_delta").put("delta", "answer"));
        turn.accept(new JSONObject().put("type", "context").put("entries", entries()));
        turn.accept(new JSONObject().put("type", "end").put("status", "aborted"));
        assertEquals(active, store.activeId());
        assertTrue(store.load().isEmpty());
        store.selectConversation(conversation);
        assertEquals("answer", store.load().get(1).content);
        assertTrue(store.load().get(1).incomplete);
        assertEquals(entries().toString(), store.piContext("reply"));
        List<AgentLoop.Message> branch = new ArrayList<>(store.load());
        branch.add(new AgentLoop.Message("user", "follow-up")); store.save(branch);
        JSONObject resume = new JSONObject(store.piResume(store.load()));
        assertEquals(entries().toString(), resume.getJSONArray("entries").toString());
        assertEquals("follow-up", resume.getJSONArray("tail").getJSONObject(0).getString("content"));
    }

    @Test public void latePreviewCannotOverwriteCompletedTextOrContext() throws Exception {
        ChatStore store = new ChatStore(context);
        AgentLoop.Message user = new AgentLoop.Message("user", "question"); store.save(Collections.singletonList(user));
        String conversation = store.activeId();
        PiTurnPersistence turn = new PiTurnPersistence(store, conversation, user.id, "reply", store.load());
        AgentLoop.Message partial = new AgentLoop.Message("reply", "assistant", "partial", null, Collections.emptyList(), true);
        turn.savePreview(partial);
        assertTrue(store.load().get(1).incomplete);
        turn.accept(new JSONObject().put("type", "message").put("message", new JSONObject().put("content", "complete answer")));
        turn.accept(new JSONObject().put("type", "context").put("entries", entries()));
        turn.accept(new JSONObject().put("type", "end").put("status", "completed"));
        turn.savePreview(partial);
        new ChatStore(context).savePiPreview(conversation, user.id, "reply", Arrays.asList(user, partial));
        assertEquals("complete answer", store.load().get(1).content);
        assertFalse(store.load().get(1).incomplete);
        assertEquals(entries().toString(), store.piContext("reply"));
    }

    @Test public void previewAndCompletionPreserveAnotherSelectedBranch() throws Exception {
        ChatStore store = new ChatStore(context);
        AgentLoop.Message first = new AgentLoop.Message("user", "first");
        AgentLoop.Message selected = new AgentLoop.Message("assistant", "other branch");
        store.save(Arrays.asList(first, selected));
        AgentLoop.Message user = new AgentLoop.Message("user", "new branch");
        store.save(Arrays.asList(first, user));
        PiTurnPersistence turn = new PiTurnPersistence(store, store.activeId(), user.id, "reply", store.load());
        store.selectNode(selected.id);
        turn.savePreview(new AgentLoop.Message("reply", "assistant", "partial", null, Collections.emptyList(), true));
        assertEquals(selected.id, store.tree().leaf());
        turn.accept(new JSONObject().put("type", "message").put("message", new JSONObject().put("content", "complete")));
        turn.accept(new JSONObject().put("type", "context").put("entries", entries()));
        turn.accept(new JSONObject().put("type", "end").put("status", "completed"));
        assertEquals(selected.id, store.tree().leaf());
        store.selectNode("reply");
        assertEquals("complete", store.load().get(2).content);
    }

    @Test public void missingNativeContextIsNotSilentlyReplayedAsText() throws Exception {
        ChatStore store = new ChatStore(context);
        AgentLoop.Message user = new AgentLoop.Message("user", "question"); store.save(Collections.singletonList(user));
        PiTurnPersistence turn = new PiTurnPersistence(store, store.activeId(), user.id, "missing", store.load());
        assertThrows(java.io.IOException.class, () -> store.piResume(store.load()));
        turn.accept(new JSONObject().put("type", "text_delta").put("delta", "partial"));
        turn.accept(new JSONObject().put("type", "end").put("status", "error"));
        assertThrows(java.io.IOException.class, () -> store.piResume(store.load()));
    }

    @Test public void coordinatorDropsThrottledDeltaAtCanonicalAssistantBoundary() throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        ChatStore store = coordinator.store();
        AgentLoop.Message user = new AgentLoop.Message("user", "cross round");
        store.save(Collections.singletonList(user));
        AgentLoop.CancelToken token = new AgentLoop.CancelToken();
        PiTurnPersistence turn = new PiTurnPersistence(store, store.activeId(), user.id, "reply", store.load());
        org.robolectric.util.ReflectionHelpers.setField(coordinator, "running", true);
        org.robolectric.util.ReflectionHelpers.setField(coordinator, "cancellation", token);
        org.robolectric.util.ReflectionHelpers.setField(coordinator, "conversationId", store.activeId());
        org.robolectric.util.ReflectionHelpers.setField(coordinator, "requestId", "request");
        org.robolectric.util.ReflectionHelpers.setField(coordinator, "piPersistence", turn);
        org.robolectric.util.ReflectionHelpers.setField(coordinator, "lastDeltaFlush", System.currentTimeMillis());
        StringBuilder pending = org.robolectric.util.ReflectionHelpers.getField(coordinator, "pendingDelta");
        pending.setLength(0);
        List<JSONObject> events = new ArrayList<>();
        ChatCoordinator.Listener listener = (messages, event) -> events.add(event);
        coordinator.addListener(listener);
        try {
            coordinator.onPiEvent(new JSONObject().put("type", "text_delta").put("delta", "checking"), token, turn);
            coordinator.onPiEvent(message(new JSONObject().put("role", "assistant").put("content", "checking")
                    .put("stopReason", "toolUse").put("toolCalls", new JSONArray()
                            .put(call("probe", "read", "{}")))), token, turn);
            coordinator.onPiEvent(message(new JSONObject().put("role", "tool").put("content", "result")
                    .put("toolCallId", "probe")), token, turn);
            coordinator.onPiEvent(new JSONObject().put("type", "text_delta").put("delta", "done"), token, turn);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(100, TimeUnit.MILLISECONDS);
            List<JSONObject> deltas = events.stream().filter(event -> "textDelta".equals(event.optString("type")))
                    .collect(java.util.stream.Collectors.toList());
            assertEquals(1, deltas.size());
            assertEquals("reply:assistant:1", deltas.get(0).getString("nodeId"));
            assertEquals("done", deltas.get(0).getJSONObject("payload").getString("delta"));
            coordinator.onPiEvent(message(new JSONObject().put("role", "assistant").put("content", "done")
                    .put("stopReason", "stop").put("toolCalls", new JSONArray())), token, turn);
            coordinator.onPiEvent(new JSONObject().put("type", "context").put("entries", entries()), token, turn);
            coordinator.onPiEvent(new JSONObject().put("type", "end").put("status", "completed"), token, turn);
        } finally {
            coordinator.removeListener(listener);
            org.robolectric.util.ReflectionHelpers.setField(coordinator, "running", false);
            pending.setLength(0);
        }
    }

    @Test public void retryKeepsFailedPartialAssistantIncomplete() throws Exception {
        ChatStore store = new ChatStore(context);
        AgentLoop.Message user = new AgentLoop.Message("user", "retry"); store.save(Collections.singletonList(user));
        PiTurnPersistence turn = new PiTurnPersistence(store, store.activeId(), user.id, "reply", store.load());
        turn.accept(new JSONObject().put("type", "text_delta").put("delta", "partial"));
        turn.accept(message(new JSONObject().put("role", "assistant").put("content", "partial")
                .put("stopReason", "error").put("errorMessage", "temporary failure")
                .put("toolCalls", new JSONArray())));
        turn.accept(new JSONObject().put("type", "text_delta").put("delta", "recovered"));
        turn.accept(message(new JSONObject().put("role", "assistant").put("content", "recovered")
                .put("stopReason", "stop").put("toolCalls", new JSONArray())));
        turn.accept(new JSONObject().put("type", "context").put("entries", entries()));
        turn.accept(new JSONObject().put("type", "end").put("status", "completed"));
        List<AgentLoop.Message> restored = new ChatStore(context).load();
        assertTrue(restored.get(1).incomplete);
        assertEquals("partial", restored.get(1).content);
        assertFalse(restored.get(2).incomplete);
        assertEquals("recovered", restored.get(2).content);
    }

    @Test public void canonicalToolMessagesRemainOrderedAndAssociatedAfterReload() throws Exception {
        ChatStore store = new ChatStore(context);
        AgentLoop.Message user = new AgentLoop.Message("user", "use tools"); store.save(Collections.singletonList(user));
        PiTurnPersistence turn = new PiTurnPersistence(store, store.activeId(), user.id, "reply", store.load());
        turn.accept(new JSONObject().put("type", "text_delta").put("delta", "checking"));
        AgentLoop.Message preview = turn.savePreview();
        assertEquals("reply", preview.id);
        assertTrue(store.load().get(1).incomplete);
        turn.accept(message(new JSONObject().put("role", "assistant").put("content", "checking")
                .put("toolCalls", new JSONArray()
                        .put(call("first", "read", "{\"path\":\"a\"}"))
                        .put(call("second", "grep", "{\"pattern\":\"b\"}")))));
        turn.accept(message(new JSONObject().put("role", "tool").put("content", "first-result")
                .put("toolCallId", "first")));
        turn.accept(message(new JSONObject().put("role", "tool").put("content", "second-result")
                .put("toolCallId", "second")));
        turn.accept(new JSONObject().put("type", "text_delta").put("delta", "done"));
        assertEquals("reply:assistant:1", turn.savePreview().id);
        turn.accept(message(new JSONObject().put("role", "assistant").put("content", "done")
                .put("toolCalls", new JSONArray())));
        turn.accept(new JSONObject().put("type", "context").put("entries", entries()));
        turn.accept(new JSONObject().put("type", "end").put("status", "completed"));

        List<AgentLoop.Message> restored = new ChatStore(context).load();
        assertEquals(Arrays.asList("user", "assistant", "tool", "tool", "assistant"),
                restored.stream().map(value -> value.role).collect(java.util.stream.Collectors.toList()));
        assertEquals(Arrays.asList("first", "second"), restored.get(1).toolCalls.stream()
                .map(value -> value.id).collect(java.util.stream.Collectors.toList()));
        assertEquals("first", restored.get(2).toolCallId);
        assertEquals("first-result", restored.get(2).content);
        assertEquals("second", restored.get(3).toolCallId);
        assertEquals("second-result", restored.get(3).content);
        assertEquals("reply:assistant:1", restored.get(4).id);
        assertEquals(entries().toString(), store.piContext(restored.get(4).id));
        JSONObject rendered = NativeJson.message(restored.get(1));
        assertEquals("first", rendered.getJSONArray("toolCalls").getJSONObject(0).getString("id"));
    }

    private static JSONObject message(JSONObject value) throws Exception {
        return new JSONObject().put("type", "message").put("message", value);
    }

    private static JSONObject call(String id, String name, String arguments) throws Exception {
        return new JSONObject().put("id", id).put("name", name).put("arguments", arguments);
    }

    @Test public void lateCompletionDoesNotRecreateDeletedConversation() throws Exception {
        ChatStore store = new ChatStore(context);
        AgentLoop.Message user = new AgentLoop.Message("user", "question"); store.save(Collections.singletonList(user));
        String old = store.activeId();
        PiTurnPersistence turn = new PiTurnPersistence(store, old, user.id, "deleted", store.load());
        store.clear();
        turn.accept(new JSONObject().put("type", "context").put("entries", entries()));
        turn.accept(new JSONObject().put("type", "end").put("status", "completed"));
        assertFalse(new JSONObject(context.getSharedPreferences("chat", Context.MODE_PRIVATE).getString("conversations", "{}")).has(old));
    }
}
