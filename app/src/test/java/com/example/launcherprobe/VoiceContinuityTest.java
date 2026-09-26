package com.example.launcherprobe;

import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import android.widget.TextView;
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
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

/** Recognition-boundary tests: no microphone, network, model credentials or paid model calls. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, instrumentedPackages = "com.example.launcherprobe",
        shadows = {HostAtomicFile.class, VoiceContinuityTest.BridgeShadow.class})
public class VoiceContinuityTest {
    private Context context;
    private ChatCoordinator coordinator;
    private ChatStore store;
    private VoiceSession session;
    private SpeechOutput output;

    @Before public void prepare() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        coordinator = ChatCoordinator.get(context);
        store = coordinator.store();
        BridgeShadow.called = new CountDownLatch(1);
        BridgeShadow.target = null;
        output = new SpeechOutput(context, new VoiceSettings(context));
    }

    @After public void cleanup() throws Exception {
        if (session != null) session.close();
        output.shutdown();
        ExecutorService executor = ReflectionHelpers.getField(coordinator, "executor");
        executor.shutdownNow();
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    private void open(String id) {
        session = new VoiceSession(new VoiceSession.Host() {
            public Context context() { return context; }
            public void closed() { }
        }, output, id);
        session.view();
    }

    private void heard(String text) throws Exception {
        ReflectionHelpers.callInstanceMethod(session, "submit", ReflectionHelpers.ClassParameter.from(String.class, text));
        ExecutorService worker = ReflectionHelpers.getField(session, "worker");
        worker.submit(() -> { }).get(5, TimeUnit.SECONDS);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }

    @Test public void explicitTargetKeepsSelectedBranchModelDraftAndUnsentAttachments() throws Exception {
        AgentLoop.Message first = new AgentLoop.Message("user", "first branch");
        AgentLoop.Message other = new AgentLoop.Message("assistant", "not selected");
        store.save(Arrays.asList(first, other));
        String target = store.activeId();
        store.selectNode(target, first.id);
        store.setPiSelection(target, "test-provider", "test-model", "high");
        store.saveDraft(target, "keep typed draft");
        // Metadata only: sending voice must not attempt to read this unsent attachment file.
        ChatAttachment attachment = ChatAttachment.fromJson(new JSONObject()
                .put("id", "unsent").put("name", "unsent.txt").put("mimeType", "text/plain")
                .put("path", "unsent.txt").put("size", 1));
        store.saveDraftAttachments(target, Collections.singletonList(attachment));
        store.newConversation();
        String unrelated = store.activeId();
        store.saveDraft(unrelated, "other draft");
        open(target);
        assertEquals(store.conversations().stream().filter(c -> c.id.equals(target)).findFirst().get().title,
                ((TextView) ReflectionHelpers.getField(session, "titleLabel")).getText().toString());
        heard("continue by voice");
        assertTrue(BridgeShadow.called.await(5, TimeUnit.SECONDS));
        assertEquals(target, BridgeShadow.target);
        assertEquals("test-model", new JSONObject(BridgeShadow.config).getJSONObject("selection").getString("model"));
        assertEquals(1, BridgeShadow.history.size());
        assertEquals(first.id, BridgeShadow.history.get(0).id);
        assertTrue(BridgeShadow.attachments.isEmpty());
        assertEquals("keep typed draft", store.draft(target));
        assertEquals("unsent", store.draftAttachments(target).get(0).id);
        assertEquals(unrelated, store.activeId());
        assertEquals("other draft", store.draft(unrelated));
        session.openTextChat();
        Intent textChat = Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity();
        assertEquals(target, textChat.getStringExtra(TaskDetailActivity.EXTRA_OPEN_CHAT));
    }

    @Test public void newEntryAndNewTopicStayLazyUntilNonemptyRecognition() throws Exception {
        String before = store.activeId();
        store.saveDraft("existing draft");
        int count = store.conversations().size();
        open(null);
        heard("  \n ");
        session.newTopic();
        assertNull(ReflectionHelpers.getField(session, "conversationId"));
        assertEquals(before, store.activeId());
        assertEquals(count, store.conversations().size());
        heard("new voice topic");
        assertTrue(BridgeShadow.called.await(5, TimeUnit.SECONDS));
        assertNotEquals(before, BridgeShadow.target);
        assertEquals("existing draft", store.draft(before));
        assertEquals(count + 1, store.conversations().size());
    }

    @Test public void busyArchivedAndDeletedTargetsNeverRedirectOrCancelAnotherRun() throws Exception {
        store.saveDraft("target");
        String target = store.activeId();
        ChatCoordinator.SessionRun foreign = coordinator.registerRun(target, null);
        open(target);
        heard("do not steal this run");
        assertFalse(foreign.cancellation.cancelled());
        assertNull(BridgeShadow.target);
        assertFalse(coordinator.cancelVoice(target, "wrong-request"));
        session.newTopic();
        assertEquals(target, ReflectionHelpers.getField(session, "conversationId"));
        coordinator.finish(foreign, "aborted", "");
        coordinator.archiveConversation(target);
        heard("do not restore silently");
        assertNull(BridgeShadow.target);
        coordinator.deleteConversation(target);
        heard("do not recreate a deleted target");
        assertNull(BridgeShadow.target);
        assertNotEquals(target, store.activeId());
        session.newTopic();
        assertNull(ReflectionHelpers.getField(session, "conversationId"));
    }

    @Test public void unsavedChatReturnsToItsOriginalHostWithoutCreatingHistory() {
        VoiceSessionActivity activity = org.robolectric.Robolectric.buildActivity(VoiceSessionActivity.class).get();
        String target = store.activeId();
        session = new VoiceSession(activity, output, target);
        session.view();
        session.openTextChat();
        assertTrue(activity.isFinishing());
        assertNull(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getNextStartedActivity());
        assertEquals(target, store.activeId());
        assertTrue(store.conversations().isEmpty());
    }

    @Test public void activityIntentCarriesOnlyExplicitChatTarget() {
        android.app.Activity activity = org.robolectric.Robolectric.buildActivity(android.app.Activity.class).setup().get();
        VoiceSessionActivity.open(activity, false, "chosen");
        assertEquals("chosen", Shadows.shadowOf(activity).getNextStartedActivity()
                .getStringExtra(VoiceSessionActivity.EXTRA_CONVERSATION_ID));
        VoiceSessionActivity.open(activity, true);
        assertNull(Shadows.shadowOf(activity).getNextStartedActivity()
                .getStringExtra(VoiceSessionActivity.EXTRA_CONVERSATION_ID));
    }

    @Implements(value = PiAgentBridge.class, isInAndroidSdk = false)
    public static class BridgeShadow {
        static CountDownLatch called;
        static String target, config;
        static List<AgentLoop.Message> history;
        static List<ChatAttachment> attachments;
        @Implementation protected void __constructor__(Context context) { }
        @Implementation protected static PiAgentBridge get(Context context) {
            return ReflectionHelpers.callConstructor(PiAgentBridge.class,
                    ReflectionHelpers.ClassParameter.from(Context.class, context));
        }
        @Implementation protected void prompt(String id, String conversationId, String configuration, String text,
                List<ChatAttachment> files, String sdkHistory, List<AgentLoop.Message> prior,
                PiConfigStore configStore, PiAgentBridge.Listener listener) {
            target = conversationId;
            config = configuration;
            history = prior;
            attachments = files;
            called.countDown();
        }
        @Implementation protected static void forgetConversation(String conversationId) { }
    }
}
