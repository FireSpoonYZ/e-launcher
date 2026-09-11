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

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE, shadows = HostAtomicFile.class)
public class PiPersistenceTest {
    private Context context;
    @Before public void prepare() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
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
