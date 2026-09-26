package com.example.launcherprobe;

import android.content.Context;
import android.os.Bundle;
import android.os.Looper;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;

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
import org.robolectric.shadow.api.Shadow;
import org.robolectric.shadows.ShadowSpeechRecognizer;
import org.robolectric.shadows.ShadowTextToSpeech;
import org.robolectric.util.ReflectionHelpers;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, instrumentedPackages = "com.example.launcherprobe",
        shadows = {VoiceQuestionnaireTest.BridgeShadow.class, VoiceQuestionnaireTest.TranscriptionShadow.class})
public class VoiceQuestionnaireTest {
    private ChatCoordinator coordinator;
    private ChatCoordinator.SessionRun run;
    private BridgeShadow bridge;
    private SpeechOutput output;
    private VoiceSession session;
    private VoiceStream stream;

    @Before public void setUp() {
        Context context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        coordinator = ChatCoordinator.get(context);
        AgentLoop.Message user = new AgentLoop.Message("user", "Help me choose");
        coordinator.store().save(Collections.singletonList(user));
        run = coordinator.registerRun(coordinator.conversationId(), null);
        run.persistence = new PiTurnPersistence(coordinator.store(), run.conversationId, user.id, "assistant",
                coordinator.store().load());
        run.bridge = ReflectionHelpers.callConstructor(PiAgentBridge.class,
                ReflectionHelpers.ClassParameter.from(Context.class, context));
        bridge = Shadow.extract(run.bridge);
        output = new SpeechOutput(context, new VoiceSettings(context));
        session = new VoiceSession(new VoiceSession.Host() {
            @Override public Context context() { return context; }
            @Override public void closed() { }
        }, output);
        session.view();
        ReflectionHelpers.setField(session, "conversationId", run.conversationId);
        ReflectionHelpers.setField(session, "ownedRequestId", run.requestId);
        stream = ReflectionHelpers.getField(session, "stream");
        session.start(false);
        idle();
        TranscriptionShadow.started = new CountDownLatch(1);
        TranscriptionShadow.release = new CountDownLatch(1);
    }

    @After public void tearDown() {
        TranscriptionShadow.release.countDown();
        session.close();
        output.shutdown();
        coordinator.finish(run, "aborted", "");
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    @Test public void readsEachQuestionThenReturnsCustomAnswersToTheOriginalTool() throws Exception {
        SpeechRecognizer before = ShadowSpeechRecognizer.getLatestSpeechRecognizer();
        publish(questionnaire());
        assertTrue(Shadows.shadowOf(before).isDestroyed());
        assertNull(ReflectionHelpers.getField(session, "systemInput"));
        assertTrue("Do not transcribe the spoken question", stream.muted());
        assertEquals("SPEAKING", state());
        finishFirstReading();
        assertEquals("LISTENING", state());
        assertFalse(stream.muted());
        assertTrue(tts().getLastSpokenText().contains("Choose layout"));
        assertTrue(tts().getLastSpokenText().contains("1：Compact"));
        assertTrue(tts().getLastSpokenText().contains("2：Spacious"));
        assertFalse(tts().getLastSpokenText().contains("All in one"));

        int readings = tts().getSpokenTextList().size();
        publish(questionnaire());
        assertEquals("Repeated UI snapshots must not restart the question", readings, tts().getSpokenTextList().size());
        answer("A compact layout, with larger text");
        assertEquals(0, bridge.replies);
        assertTrue(tts().getLastSpokenText().contains("Choose features"));
        assertEquals("LISTENING", state());
        assertFalse(run.cancellation.cancelled());
        answer("Both, but prioritize A");

        assertEquals(1, bridge.replies);
        assertEquals(run.requestId, bridge.requestId);
        assertEquals(run.conversationId, bridge.conversationId);
        assertEquals("q", bridge.questionnaireId);
        JSONArray answers = bridge.result.getJSONArray("answers");
        assertEquals(2, answers.length());
        assertEquals(0, answers.getJSONObject(0).getInt("questionIndex"));
        assertEquals("Choose layout", answers.getJSONObject(0).getString("question"));
        assertEquals("custom", answers.getJSONObject(0).getString("kind"));
        assertEquals("A compact layout, with larger text", answers.getJSONObject(0).getString("answer"));
        assertEquals(1, answers.getJSONObject(1).getInt("questionIndex"));
        assertEquals("custom", answers.getJSONObject(1).getString("kind"));
        assertEquals("Both, but prioritize A", answers.getJSONObject(1).getString("answer"));
        assertTrue(stream.muted());
        session.onSpeechStart();
        assertEquals("THINKING", state());
        assertEquals(0, bridge.aborts);
        assertFalse(run.cancellation.cancelled());
        assertNull(ReflectionHelpers.getField(session, "pendingText"));

        publish(null);
        assertFalse(stream.muted());
        chat("textDelta", new JSONObject().put("delta", "Saved your preferences。"));
        chat("end", new JSONObject());
        assertEquals("Saved your preferences。", tts().getLastSpokenText());
        assertEquals("LISTENING", state());
    }

    @Test public void remoteQuestionPlaybackIgnoresQueuedSpeechAndSystemButtonCanSkipReading() throws Exception {
        ReflectionHelpers.setField(session, "remoteInput", true);
        publish(questionnaire());
        session.onSpeechStart();
        session.onUtterance(new byte[0]);
        assertEquals("SPEAKING", state());
        assertEquals(1L, TranscriptionShadow.started.getCount());
        assertTrue(stream.muted());
        finishFirstReading();
        session.onSpeechStart();
        ReflectionHelpers.callInstanceMethod(session, "submit",
                ReflectionHelpers.ClassParameter.from(String.class, "My own layout"));
        idle();
        assertFalse(run.cancellation.cancelled());
        assertEquals(0, bridge.aborts);
        assertEquals(0, bridge.replies);

        ReflectionHelpers.setField(session, "remoteInput", false);
        publish(new JSONObject(questionnaire().toString()).put("id", "next"));
        // Dispatch directly so the system TTS completion has not drained yet.
        chatWithoutIdle("extensionUi", new JSONObject().put("askUser",
                new JSONObject(questionnaire().toString()).put("id", "skip")));
        session.onSpeechStart();
        assertEquals("LISTENING", state());
        assertNotNull(ReflectionHelpers.getField(session, "systemInput"));
        assertFalse(run.cancellation.cancelled());
    }

    @Test public void screenSubmissionStopsListeningAndRejectsLateRecognition() throws Exception {
        publish(questionnaire());
        finishFirstReading();
        SpeechInput input = ReflectionHelpers.getField(session, "systemInput");
        coordinator.submitQuestionnaire(run.conversationId, run.requestId, "q", new JSONArray()
                .put(new JSONObject().put("questionIndex", 0).put("kind", "custom").put("answer", "Typed answer")), null);
        idle();
        assertEquals("THINKING", state());
        assertTrue(stream.muted());
        assertNull(ReflectionHelpers.getField(session, "systemInput"));
        input.listener.onResult("Late spoken answer");
        assertEquals(1, bridge.replies);
        assertEquals(0, bridge.aborts);
        publish(null);
        input.listener.onResult("Even later spoken answer");
        assertFalse(run.cancellation.cancelled());
        assertEquals(1, bridge.replies);
    }

    @Test public void expiredQuestionDiscardsInFlightRemoteTranscription() throws Exception {
        ReflectionHelpers.setField(session, "remoteInput", true);
        publish(questionnaire());
        finishFirstReading();
        session.onUtterance(new byte[0]);
        assertTrue(TranscriptionShadow.started.await(5, TimeUnit.SECONDS));
        assertEquals("TRANSCRIBING", state());
        publish(null);
        TranscriptionShadow.release.countDown();
        ExecutorService worker = ReflectionHelpers.getField(session, "worker");
        worker.submit(() -> { }).get(5, TimeUnit.SECONDS);
        idle();
        assertEquals(0, bridge.replies);
        assertEquals(0, bridge.aborts);
        assertFalse(run.cancellation.cancelled());
        assertNull(ReflectionHelpers.getField(session, "pendingText"));
        assertEquals("THINKING", state());
    }

    @Test public void rejectedReplyRetriesLastAnswerWithoutLosingEarlierAnswers() throws Exception {
        publish(questionnaire());
        finishFirstReading();
        answer("First answer");
        answer("Second answer");
        assertEquals(1, bridge.replies);
        coordinator.onPiEvent(new JSONObject().put("type", "questionnaire_reply").put("questionnaireId", "q")
                .put("accepted", false).put("message", "Please retry"), run);
        idle();
        assertEquals("LISTENING", state());
        answer("Corrected second answer");
        assertEquals(2, bridge.replies);
        JSONArray answers = bridge.result.getJSONArray("answers");
        assertEquals(2, answers.length());
        assertEquals("First answer", answers.getJSONObject(0).getString("answer"));
        assertEquals("Corrected second answer", answers.getJSONObject(1).getString("answer"));
        assertFalse(run.cancellation.cancelled());
    }

    @Test public void sendFailureAllowsAnotherAnswerAndToolEndStopsDelayedRecognizerRetry() throws Exception {
        publish(questionnaire());
        finishFirstReading();
        answer("First answer");
        bridge.fail = true;
        answer("Second answer");
        assertEquals("LISTENING", state());
        assertFalse(stream.muted());
        assertNull(run.questionnaireReplyPending);
        bridge.fail = false;
        answer("Try again");
        assertEquals(1, bridge.replies);
        assertEquals("Try again", bridge.result.getJSONArray("answers").getJSONObject(1).getString("answer"));

        publish(new JSONObject(questionnaire().toString()).put("id", "next"));
        ShadowSpeechRecognizer recognizer = Shadows.shadowOf(ShadowSpeechRecognizer.getLatestSpeechRecognizer());
        recognizer.triggerOnError(SpeechRecognizer.ERROR_NO_MATCH);
        idle();
        publish(null);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        assertNull("An expired question's retry must not reopen the recognizer",
                ReflectionHelpers.getField(session, "systemInput"));
        assertEquals("THINKING", state());
        chat("end", new JSONObject());
        assertEquals("LISTENING", state());
        assertNotNull(ReflectionHelpers.getField(session, "systemInput"));
    }

    private JSONObject questionnaire() throws Exception {
        return HomeQuestionnaireTest.card().getJSONObject("askUser");
    }

    private void publish(JSONObject question) throws Exception {
        coordinator.onPiEvent(new JSONObject().put("type", "extension_ui")
                .put("state", new JSONObject().put("askUser", question == null ? JSONObject.NULL : question)), run);
        idle();
    }

    private void chatWithoutIdle(String type, JSONObject payload) throws Exception {
        ChatCoordinator.Listener listener = ReflectionHelpers.getField(session, "chatListener");
        listener.changed(Collections.emptyList(), new JSONObject().put("type", type)
                .put("conversationId", run.conversationId).put("requestId", run.requestId).put("payload", payload));
    }

    private void chat(String type, JSONObject payload) throws Exception {
        chatWithoutIdle(type, payload);
        idle();
    }

    private void finishFirstReading() {
        tts().getOnInitListener().onInit(TextToSpeech.SUCCESS);
        idle();
    }

    private ShadowTextToSpeech tts() {
        return Shadows.shadowOf(ShadowTextToSpeech.getLastTextToSpeechInstance());
    }

    private void answer(String text) {
        Bundle result = new Bundle();
        result.putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, new ArrayList<>(Collections.singletonList(text)));
        ShadowSpeechRecognizer recognizer = Shadows.shadowOf(ShadowSpeechRecognizer.getLatestSpeechRecognizer());
        recognizer.triggerOnEndOfSpeech();
        recognizer.triggerOnResults(result);
        idle();
    }

    private String state() { return ReflectionHelpers.getField(session, "state").toString(); }
    private static void idle() { Shadows.shadowOf(Looper.getMainLooper()).idle(); }

    @Implements(value = PiAgentBridge.class, isInAndroidSdk = false)
    public static class BridgeShadow {
        int replies, aborts;
        boolean fail;
        String requestId, conversationId, questionnaireId;
        JSONObject result;

        @Implementation protected void __constructor__(Context context) { }
        @Implementation protected void replyQuestionnaire(String requestId, String conversationId,
                String questionnaireId, JSONObject result, boolean cancelled) throws Exception {
            if (fail) throw new java.io.IOException("Test connection failure");
            assertFalse(cancelled);
            this.requestId = requestId;
            this.conversationId = conversationId;
            this.questionnaireId = questionnaireId;
            this.result = result;
            replies++;
        }
        @Implementation protected void abort(String requestId) { aborts++; }
    }

    @Implements(value = RemoteVoiceApi.class, isInAndroidSdk = false)
    public static class TranscriptionShadow {
        static CountDownLatch started, release;
        @Implementation protected static okhttp3.Call transcribeCall(VoiceSettings.Remote remote, byte[] wav, String language) {
            return null;
        }
        @Implementation protected static String transcription(okhttp3.Call call) throws Exception {
            started.countDown();
            if (!release.await(5, TimeUnit.SECONDS)) throw new java.io.IOException("Test transcription timed out");
            return "A late transcription";
        }
    }
}
