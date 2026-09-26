package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.RecognizerIntent;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.TextView;

import com.getcapacitor.Plugin;
import com.getcapacitor.CapConfig;
import com.getcapacitor.WebViewListener;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowAlertDialog;
import org.robolectric.shadows.ShadowToast;
import org.robolectric.util.ReflectionHelpers;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;

import static org.junit.Assert.*;

/** Real Capacitor shell/lifecycle, without device services, Pi execution or JavaScript execution. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, instrumentedPackages = "com.example.launcherprobe",
        shadows = {HostAtomicFile.class, MainActivityNavigationTest.WidgetShadow.class,
                MainActivityNavigationTest.WakeShadow.class})
public class MainActivityNavigationTest {
    private Context context;
    private ChatCoordinator coordinator;
    private ChatStore store;
    private ActivityController<TestMainActivity> controller;

    public static class TestMainActivity extends MainActivity {
        final List<Class<? extends Plugin>> registered = new ArrayList<>();
        boolean focused = true;
        // Keep Capacitor's real bridge and system plugins; isolate custom plugin/service startup.
        @Override public void registerPlugin(Class<? extends Plugin> plugin) { registered.add(plugin); }
        @Override public boolean hasWindowFocus() { return focused; }
        @Override protected void load() {
            // Robolectric has no device WebView provider for ServiceWorkerController.
            config = new CapConfig.Builder(this).setResolveServiceWorkerRequests(false).create();
            super.load();
        }
    }

    @Implements(value = TaskWidgetProvider.class, isInAndroidSdk = false)
    public static class WidgetShadow {
        static int immediateRefreshes;
        @Implementation protected static void requestRefresh(Context context, boolean immediate) {
            if (immediate) immediateRefreshes++;
        }
    }

    @Implements(value = WakeWordService.class, isInAndroidSdk = false)
    public static class WakeShadow {
        static int syncs;
        @Implementation protected static void sync(Context context) { syncs++; }
    }

    @Before public void prepare() {
        context = RuntimeEnvironment.getApplication();
        android.content.pm.PackageInfo webView = new android.content.pm.PackageInfo();
        webView.packageName = "com.google.android.webview";
        webView.versionName = "130.0.0.0";
        org.robolectric.shadows.ShadowWebView.setCurrentWebViewPackage(webView);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(VoiceManager.class, "instance", null);
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("language", "zh").commit();
        coordinator = ChatCoordinator.get(context);
        store = coordinator.store();
        WidgetShadow.immediateRefreshes = 0;
        WakeShadow.syncs = 0;
    }

    @After public void cleanup() {
        if (controller != null) controller.pause().stop().destroy();
        VoiceManager manager = VoiceManager.get(context);
        manager.cancelListening();
        manager.output().shutdown();
        ((ExecutorService) ReflectionHelpers.getField(manager, "sender")).shutdownNow();
        ((ExecutorService) ReflectionHelpers.getField(coordinator, "executor")).shutdownNow();
        ReflectionHelpers.setStaticField(VoiceManager.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }

    private TestMainActivity open(Intent intent) {
        controller = Robolectric.buildActivity(TestMainActivity.class, intent).setup();
        assertNotNull(controller.get().getBridge());
        return controller.get();
    }

    private String conversation(String draft) {
        store.newConversation();
        store.saveDraft(draft);
        return store.activeId();
    }

    private void loaded(TestMainActivity activity, String url) {
        WebView web = activity.getBridge().getWebView();
        web.loadUrl(url);
        List<WebViewListener> listeners = ReflectionHelpers.getField(activity.getBridge(), "webViewListeners");
        for (WebViewListener listener : listeners) listener.onPageLoaded(web);
        var applied = Shadows.shadowOf(web).getLastEvaluatedJavascriptCallback();
        if (applied != null) applied.onReceiveValue("true");
    }

    private String local(TestMainActivity activity, String route) {
        return activity.getBridge().getLocalUrl() + "#" + route;
    }

    @Test public void coldAndHotChatEntriesSelectExactTargetAndWaitForLocalWebContent() {
        String first = conversation("first draft");
        String second = conversation("second draft");
        TestMainActivity activity = open(new Intent(context, MainActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, first));
        assertEquals(Arrays.asList(ChatPlugin.class, ScheduledTasksPlugin.class,
                SettingsPlugin.class, DevicePlugin.class), activity.registered);
        assertEquals(first, store.activeId());
        assertEquals("/chat/" + first, activity.launchRoute());
        assertFalse(activity.getIntent().hasExtra(TaskDetailActivity.EXTRA_OPEN_CHAT));
        assertFalse(activity.isTaskConversationVisible(first));

        Intent hot = new Intent(context, MainActivity.class).setData(Uri.parse("assistant-widget://chat/2"))
                .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, second);
        activity.onNewIntent(hot);
        assertEquals(hot.getData(), activity.getIntent().getData());
        assertEquals(second, store.activeId());
        loaded(activity, "https://untrusted.invalid/#/chat/" + second);
        assertFalse(activity.isTaskConversationVisible(second));
        loaded(activity, local(activity, "/chat/" + second));
        assertTrue(Shadows.shadowOf(activity.getBridge().getWebView()).getLastEvaluatedJavascript()
                .contains(JSONObject.quote("#/chat/" + second)));
        assertTrue(activity.isTaskConversationVisible(second));
        assertEquals("first draft", store.draft(first));
        assertEquals("second draft", store.draft(second));
        activity.openAssistantSettings();
        Bundle inFlight = new Bundle();
        activity.onSaveInstanceState(inFlight);
        assertEquals("save the requested route before asynchronous JavaScript acknowledges it",
                "/settings", inFlight.getString("web_route"));
    }

    @Test public void widgetFolderOpensOnlyArchivedRouteWithoutCreatingAConversation() {
        String active = conversation("keep draft");
        Intent request = new Intent(context, MainActivity.class).putExtra(MainActivity.EXTRA_OPEN_ARCHIVED, true);
        TestMainActivity activity = open(new Intent(request));
        assertEquals("/archived", activity.launchRoute());
        assertEquals(active, store.activeId());
        assertFalse(activity.getIntent().hasExtra(MainActivity.EXTRA_OPEN_ARCHIVED));
        activity.openChat(active);
        activity.onNewIntent(new Intent(request));
        assertEquals("/archived", activity.launchRoute());
        Bundle saved = new Bundle();
        controller.pause().saveInstanceState(saved).stop().destroy();
        controller = Robolectric.buildActivity(TestMainActivity.class, new Intent(request)).create(saved).start().resume();
        assertEquals("/archived", controller.get().launchRoute());
        assertEquals(active, store.activeId());
        assertEquals("keep draft", store.draft(active));
    }

    @Test public void newChatMigratesIndependentDraftOnceAndRecreationDoesNotCreateAgain() throws Exception {
        String original = conversation("keep active draft");
        ChatAttachment attachment = ChatAttachment.fromJson(new JSONObject().put("id", "kept")
                .put("name", "kept.txt").put("mimeType", "text/plain").put("path", "kept.txt").put("size", 1));
        store.saveDraftAttachments(original, Collections.singletonList(attachment));
        String migrated = store.prepareHomeDraft();
        store.saveDraft(migrated, "unsent home draft");
        store.saveDraftAttachments(migrated, Collections.singletonList(attachment));
        Intent request = new Intent(context, MainActivity.class).putExtra(MainActivity.EXTRA_NEW_CHAT, true);
        TestMainActivity activity = open(new Intent(request));
        assertEquals(migrated, store.activeId());
        assertEquals("/chat/" + migrated, activity.launchRoute());
        assertNull(store.homeDraftId());
        assertEquals("keep active draft", store.draft(original));
        assertEquals("unsent home draft", store.draft(migrated));
        assertEquals("kept", store.draftAttachments(original).get(0).id);
        assertEquals("kept", store.draftAttachments(migrated).get(0).id);

        Bundle saved = new Bundle();
        controller.pause().saveInstanceState(saved).stop().destroy();
        controller = Robolectric.buildActivity(TestMainActivity.class, new Intent(request)).create(saved).start().resume();
        activity = controller.get();
        assertEquals(migrated, store.activeId());
        assertEquals("/chat/" + migrated, activity.launchRoute());
        Intent hot = new Intent(request);
        activity.onNewIntent(hot);
        String next = store.activeId();
        assertNotEquals(migrated, next);
        activity.onNewIntent(hot);
        assertEquals("same consumed intent cannot create twice", next, store.activeId());
        assertEquals("unsent home draft", store.draft(migrated));
    }

    @Test public void emptyVoiceReturnKeepsTheIndependentMigrationDraft() {
        String original = conversation("typed draft");
        String migration = store.prepareHomeDraft();
        store.saveDraft(migration, "unconsumed migration draft");
        TestMainActivity activity = open(new Intent(context, MainActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, ""));
        assertNotEquals(original, store.activeId());
        assertNotEquals(migration, store.activeId());
        assertEquals(migration, store.homeDraftId());
        assertEquals("unconsumed migration draft", store.draft(migration));
        assertEquals("typed draft", store.draft(original));
        assertEquals("/chat/" + store.activeId(), activity.launchRoute());
    }

    @Test public void savedSettingsRouteRestoresWithoutHomeOrAnUnrequestedConversation() {
        String id = conversation("keep");
        TestMainActivity activity = open(new Intent(context, MainActivity.class).setAction(Intent.ACTION_MAIN));
        loaded(activity, local(activity, "/chat/" + id));
        activity.openAssistantSettings();
        loaded(activity, local(activity, "/settings/voice"));
        Bundle saved = new Bundle();
        controller.pause().saveInstanceState(saved).stop().destroy();
        controller = Robolectric.buildActivity(TestMainActivity.class, new Intent(context, MainActivity.class))
                .create(saved).start().resume();
        assertEquals("/settings/voice", controller.get().launchRoute());
        assertEquals(id, store.activeId());
        assertNull(Shadows.shadowOf(controller.get()).getNextStartedActivity());
        controller.get().openTaskDetail(id);
        Intent detail = Shadows.shadowOf(controller.get()).getNextStartedActivity();
        assertEquals(TaskDetailActivity.class.getName(), detail.getComponent().getClassName());
        assertEquals(id, detail.getStringExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID));
        assertFalse(detail.hasCategory(Intent.CATEGORY_HOME));
    }

    @Test public void archivedEntryRequiresChoiceAndUndoStillRestoresWithoutLosingDrafts() {
        String id = conversation("archived draft");
        coordinator.archiveConversation(id);
        String active = store.activeId();
        TestMainActivity activity = open(new Intent(context, MainActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, id));
        assertEquals(active, store.activeId());
        assertTrue(store.isArchived(id));
        AlertDialog prompt = ShadowAlertDialog.getLatestAlertDialog();
        assertTrue(prompt.isShowing());
        prompt.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertEquals(id, store.activeId());
        assertTrue("viewing is not restoration", store.isArchived(id));
        activity.openChat(id);
        ShadowAlertDialog.getLatestAlertDialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertFalse(store.isArchived(id));
        coordinator.archiveConversation(id);
        activity.onNewIntent(new Intent(context, MainActivity.class).putExtra(TaskDetailActivity.EXTRA_ARCHIVED_ID, id));
        ViewGroup undo = activity.findViewById(android.R.id.content).findViewWithTag("archive-undo");
        assertNotNull(undo);
        ((TextView) undo.getChildAt(1)).performClick();
        assertFalse(store.isArchived(id));
        assertEquals("archived draft", store.draft(id));
    }

    @Test public void missingTargetReportsErrorWithoutSilentlyOpeningAnotherChat() {
        String current = conversation("existing draft");
        TestMainActivity activity = open(new Intent(context, MainActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, "deleted-id"));
        assertEquals(current, store.activeId());
        assertEquals(UiText.get(activity, "会话不存在"), ShadowToast.getTextOfLatestToast());
        assertFalse(activity.isTaskConversationVisible("deleted-id"));
        assertFalse(activity.getIntent().hasExtra(TaskDetailActivity.EXTRA_OPEN_CHAT));
        activity.openAssistantSettings();
        activity.onNewIntent(new Intent(context, MainActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, "another-missing-id"));
        assertEquals("/settings", activity.launchRoute());
        assertEquals(current, store.activeId());
        assertEquals("existing draft", store.draft(current));
    }

    @Test public void readVisibilityNeedsResumedFocusLocalOriginAndMatchingChatRoute() {
        String id = conversation("target");
        TestMainActivity activity = open(new Intent(context, MainActivity.class));
        loaded(activity, local(activity, "/chat/" + id + "?panel=models"));
        assertTrue(activity.isTaskConversationVisible(id));
        assertFalse(activity.isTaskConversationVisible("other"));
        activity.focused = false;
        assertFalse(activity.isTaskConversationVisible(id));
        activity.focused = true;
        for (String route : new String[]{"/settings", "/history/" + id, "/chat/other"}) {
            loaded(activity, local(activity, route));
            assertFalse(route, activity.isTaskConversationVisible(id));
        }
        String local = local(activity, "/chat/" + id);
        for (String url : new String[]{local.replace("https:", "http:"),
                local.replace("localhost", "localhost.evil.invalid"),
                local.replace("localhost", "user@localhost"), local.replace("localhost", "localhost:8443")}) {
            loaded(activity, url);
            assertFalse(url, activity.isTaskConversationVisible(id));
        }
        loaded(activity, local(activity, "/chat"));
        assertTrue(activity.isTaskConversationVisible(id));
        controller.pause();
        assertNull(MainActivity.resumed());
        assertFalse(activity.isTaskConversationVisible(id));
        controller.resume();
        assertSame(activity, MainActivity.resumed());
        assertTrue(activity.isTaskConversationVisible(id));
    }

    @Test public void resumeRecoversOnlyMarkedNavigationAndRefreshesWakeAndWidget() {
        Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.WRITE_SECURE_SETTINGS);
        Settings.Global.putInt(context.getContentResolver(), "force_fsg_nav_bar", 1);
        context.getSharedPreferences("gestures", Context.MODE_PRIVATE).edit().putBoolean("pending_restore", true).commit();
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, "other/service");
        TestMainActivity activity = open(new Intent(context, MainActivity.class));
        assertFalse(LegacyNavigationRecovery.pending(activity));
        assertEquals(0, Settings.Global.getInt(context.getContentResolver(), "force_fsg_nav_bar", -1));
        assertEquals("other/service", Settings.Secure.getString(context.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES));
        assertEquals(1, WakeShadow.syncs);
        assertEquals(1, WidgetShadow.immediateRefreshes);
        Settings.Global.putInt(context.getContentResolver(), "force_fsg_nav_bar", 1);
        controller.pause().resume();
        assertEquals("no pending flag means no write", 1,
                Settings.Global.getInt(context.getContentResolver(), "force_fsg_nav_bar", -1));
        assertEquals(2, WakeShadow.syncs);
        assertEquals(2, WidgetShadow.immediateRefreshes);
    }

    @Test public void microphoneDenialAndRecognizerResultsReachVoiceManager() {
        TestMainActivity activity = open(new Intent(context, MainActivity.class));
        VoiceManager manager = VoiceManager.get(activity);
        String[] heard = {null}, error = {null};
        VoiceManager.Callback callback = new VoiceManager.Callback() {
            @Override public void onText(String text) { heard[0] = text; }
            @Override public void onError(String message) { error[0] = message; }
        };
        Shadows.shadowOf((android.app.Application) context).denyPermissions(Manifest.permission.RECORD_AUDIO);
        manager.settings().setEngine(VoiceSettings.STT, VoiceSettings.REMOTE);
        manager.listen(activity, store.activeId(), callback);
        activity.onRequestPermissionsResult(VoiceManager.REQUEST_MICROPHONE,
                new String[]{Manifest.permission.RECORD_AUDIO}, new int[]{PackageManager.PERMISSION_DENIED});
        assertNotNull(error[0]);
        assertNull(heard[0]);

        // This test verifies Activity callback forwarding, not a device recognition backend.
        ReflectionHelpers.callInstanceMethod(manager, "start",
                ReflectionHelpers.ClassParameter.from(String.class, store.activeId()),
                ReflectionHelpers.ClassParameter.from(VoiceManager.Callback.class, callback));
        assertNotNull("Voice request remains pending for the activity result", ReflectionHelpers.getField(manager, "pending"));
        Intent result = new Intent().putStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS,
                new ArrayList<>(Collections.singletonList(" recognized words ")));
        activity.onActivityResult(999, Activity.RESULT_OK, result);
        assertNull(heard[0]);
        activity.onActivityResult(VoiceManager.REQUEST_RECOGNIZER, Activity.RESULT_OK, result);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertEquals("recognized words", heard[0]);
    }
}
