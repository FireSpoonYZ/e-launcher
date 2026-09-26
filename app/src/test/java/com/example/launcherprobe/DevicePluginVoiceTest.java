package com.example.launcherprobe;

import android.app.Activity;
import android.content.Context;
import android.os.Looper;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.util.ReflectionHelpers;
import java.util.concurrent.ExecutorService;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

/** Exercise the real plugin callback and store, delaying only the microphone boundary. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, instrumentedPackages = "com.example.launcherprobe",
        shadows = {HostAtomicFile.class, DevicePluginVoiceTest.PluginHost.class, DevicePluginVoiceTest.DictationInput.class})
public class DevicePluginVoiceTest {
    private DevicePlugin plugin;
    private ChatStore store;
    private ChatCoordinator coordinator;

    @Before public void prepare() {
        PluginHost.activity = Robolectric.buildActivity(AppCompatActivity.class).get();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(VoiceManager.class, "instance", null);
        coordinator = ChatCoordinator.get(RuntimeEnvironment.getApplication());
        store = coordinator.store();
        plugin = new DevicePlugin();
        DictationInput.callback = null;
    }

    @After public void cleanup() {
        plugin.handleOnDestroy();
        ((ExecutorService) ReflectionHelpers.getField(coordinator, "executor")).shutdownNow();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(VoiceManager.class, "instance", null);
    }

    private RecordingCall listen(String id) {
        RecordingCall call = new RecordingCall(new JSObject().put("conversationId", id));
        plugin.voice(call);
        shadowOf(Looper.getMainLooper()).idle();
        assertNull(call.error);
        assertEquals(id, DictationInput.conversationId);
        assertNotNull(DictationInput.callback);
        return call;
    }

    @Test public void delayedCompletionAppendsToExplicitTargetNotNewActiveDraft() {
        store.saveDraft("A:");
        String a = store.activeId();
        store.newConversation();
        store.saveDraft("B:");
        String b = store.activeId();
        RecordingCall call = listen(a); // Even before native listen, activeId may already have changed.
        store.saveDraft(a, "A edited:");
        DictationInput.callback.onText("heard");
        assertNull(call.error);
        assertEquals(a, call.result.getString("conversationId"));
        assertEquals("A edited:heard", call.result.getString("text"));
        assertEquals("A edited:heard", store.draft(a));
        assertEquals("B:", store.draft(b));
        assertEquals(b, store.activeId());
    }

    @Test public void switchAfterListeningDoesNotRedirectCompletion() {
        store.saveDraft("A:");
        String a = store.activeId();
        RecordingCall call = listen(a);
        store.newConversation();
        store.saveDraft("B:");
        DictationInput.callback.onText("heard");
        assertEquals("A:heard", call.result.getString("text"));
        assertEquals("A:heard", store.draft(a));
        assertEquals("B:", store.draft());
    }

    @Test public void deletedAndArchivedTargetsRejectWithoutChangingAnyOtherDraft() {
        for (boolean archive : new boolean[]{false, true}) {
            store.newConversation();
            store.saveDraft("original");
            String target = store.activeId();
            RecordingCall call = listen(target);
            if (archive) store.archive(target); else store.clear(target);
            store.saveDraft("other");
            String other = store.activeId();
            DictationInput.callback.onText("late");
            assertNotNull(call.error);
            assertNull(call.result);
            assertEquals(archive ? "original" : "", store.draft(target));
            assertEquals("other", store.draft(other));
            assertEquals(other, store.activeId());
            if (!archive) assertTrue(store.conversations().stream().noneMatch(item -> item.id.equals(target)));
        }
    }

    @Test public void emptyActiveAndHomeDraftsAreValidButAbandonedEmptyTargetIsNot() {
        RecordingCall active = listen(store.activeId());
        DictationInput.callback.onText("first words");
        assertEquals("first words", active.result.getString("text"));
        String home = store.prepareHomeDraft();
        RecordingCall homeCall = listen(home);
        DictationInput.callback.onText("home words");
        assertEquals("home words", homeCall.result.getString("text"));
        assertEquals("first words", store.draft());
        store.newConversation();
        String abandoned = store.activeId();
        RecordingCall old = listen(abandoned);
        store.newConversation();
        DictationInput.callback.onText("late");
        assertNotNull(old.error);
        assertNull(old.result);
        assertEquals("", store.draft(abandoned));
        assertEquals("", store.draft());
    }

    @Test public void missingExplicitTargetRejectsBeforeListening() {
        RecordingCall call = new RecordingCall(new JSObject());
        plugin.voice(call);
        shadowOf(Looper.getMainLooper()).idle();
        assertNotNull(call.error);
        assertNull(DictationInput.callback);
    }

    @Implements(Plugin.class)
    public static class PluginHost {
        static AppCompatActivity activity;
        @Implementation protected Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Implementation protected AppCompatActivity getActivity() { return activity; }
    }

    @Implements(VoiceManager.class)
    public static class DictationInput {
        static String conversationId;
        static VoiceManager.Callback callback;
        @Implementation protected void __constructor__(Context context) { }
        @Implementation protected void listen(Activity activity, String id, VoiceManager.Callback result) {
            conversationId = id;
            callback = result;
        }
    }

    private static class RecordingCall extends PluginCall {
        JSObject result;
        String error;
        RecordingCall(JSObject data) { super(null, "Device", "test", "voice", data); }
        @Override public void resolve(JSObject value) { result = value; }
        @Override public void reject(String message, Exception exception) { error = message; }
        @Override public void reject(String message) { error = message; }
    }
}
