package com.example.launcherprobe;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import android.view.View;
import android.webkit.WebView;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** On-device integration checks. Synthetic tasks/transcripts; real Activities, WebView and notifications. */
final class FeatureAcceptanceChecks {
    private final Instrumentation test;
    private final Context context;
    private final ChatCoordinator coordinator;
    private final ChatStore store;
    private final List<String> temporary = new ArrayList<>();
    private MainActivity assistant;

    private FeatureAcceptanceChecks(Instrumentation test) {
        this.test = test;
        context = test.getTargetContext();
        coordinator = ChatCoordinator.get(context);
        store = coordinator.store();
    }

    static String run(Instrumentation test, String check) throws Exception {
        ChatStoreChecks.artifacts(test);
        FeatureAcceptanceChecks checks = new FeatureAcceptanceChecks(test);
        String previous = checks.store.activeId();
        try {
            checks.assistant = checks.openAssistant(null);
            if ("notifications".equals(check)) checks.notifications();
            else if ("voice-continuity".equals(check)) checks.voice();
            else if ("search-consistency".equals(check)) checks.search();
            else if ("share-ui".equals(check)) checks.shareUi();
            else throw new IllegalArgumentException(check);
            return "PASS: device " + check + "; synthetic task/transcription boundaries, real Android UI";
        } finally {
            for (String id : checks.temporary) {
                if (checks.coordinator.running(id)) {
                    ChatCoordinator.SessionRun run = ((java.util.Map<String, ChatCoordinator.SessionRun>) field(checks.coordinator, "activeRuns")).get(id);
                    if (run != null) checks.coordinator.finish(run, "aborted", "fixture cleanup");
                }
                checks.coordinator.deleteConversation(id);
            }
            if (checks.store.conversations().stream().anyMatch(item -> previous.equals(item.id)))
                checks.store.selectConversation(previous);
            if (checks.assistant != null) checks.main(() -> { checks.assistant.finish(); return null; });
            checks.context.getSharedPreferences("chat", 0).edit().commit();
        }
    }

    private String conversation(String title, String body) {
        String id = UUID.randomUUID().toString();
        temporary.add(id);
        store.save(id, List.of(new AgentLoop.Message("user", title), new AgentLoop.Message("assistant", body)));
        return id;
    }

    private MainActivity openAssistant(String id) throws Exception {
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (id != null) intent.putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, id);
        if (assistant != null) {
            context.startActivity(intent);
            SystemClock.sleep(500);
            test.waitForIdleSync();
            return assistant;
        }
        Instrumentation.ActivityMonitor monitor = test.addMonitor(MainActivity.class.getName(), null, false);
        context.startActivity(intent);
        Activity activity = monitor.waitForActivityWithTimeout(15000);
        test.removeMonitor(monitor);
        if (activity == null && assistant != null) activity = assistant;
        require(activity instanceof MainActivity, "MainActivity did not open");
        test.waitForIdleSync();
        return (MainActivity) activity;
    }

    private ChatCoordinator.SessionRun task(String title) throws Exception {
        String id = conversation(title, "fixture result");
        store.selectConversation(id);
        return main(() -> {
            ChatCoordinator.SessionRun run = coordinator.registerRun(id, null);
            AgentLoop.Message first = store.load(id).get(0);
            run.persistence = new PiTurnPersistence(store, id, first.id, "fixture-" + run.requestId, store.load(id));
            return run;
        });
    }

    private Notification notification(String id) {
        for (StatusBarNotification item : context.getSystemService(NotificationManager.class).getActiveNotifications())
            if (id.equals(item.getTag()) && item.getId() == TaskNotifications.ID) return item.getNotification();
        return null;
    }

    private void notifications() throws Exception {
        require(context.getSystemService(NotificationManager.class).areNotificationsEnabled(), "Allow app notifications before this check");
        main(() -> { assistant.openAssistantSettings(); return null; });
        awaitWeb("location.hash.startsWith('#/settings') && document.querySelector('.chat-page') === null");
        ChatCoordinator.SessionRun first = task("ACCEPT completed");
        main(() -> { coordinator.finish(first, "completed", ""); return null; });
        await(() -> notification(first.conversationId) != null, "completed notification");
        ChatCoordinator.SessionRun second = task("ACCEPT failed");
        main(() -> { coordinator.finish(second, "error", "synthetic failure"); return null; });
        await(() -> notification(second.conversationId) != null, "failed notification");
        require(store.taskResultUnread(first.conversationId), "completion is unread in another conversation");
        shell("cmd statusbar expand-notifications");
        SystemClock.sleep(500);
        screenshot("notifications-shade");
        shell("cmd statusbar collapse");
        Instrumentation.ActivityMonitor monitor = test.addMonitor(TaskDetailActivity.class.getName(), null, false);
        notification(first.conversationId).contentIntent.send();
        Activity detail = monitor.waitForActivityWithTimeout(10000);
        test.removeMonitor(monitor);
        require(detail != null, "notification opens detail");
        require(first.conversationId.equals(detail.getIntent().getStringExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID)), "notification exact target");
        await(() -> notification(first.conversationId) == null, "reading clears target notification");
        require(notification(second.conversationId) != null && store.taskResultUnread(second.conversationId), "other result stays unread");
        screenshot("notification-target");
        main(() -> { detail.finish(); return null; });
        assistant = openAssistant(second.conversationId);
        awaitWeb("document.querySelector('.chat-page') !== null");
        await(() -> !store.taskResultUnread(second.conversationId), "visible Web chat marks result read");
        main(() -> {
            ChatCoordinator.SessionRun rapid = coordinator.registerRun(second.conversationId, null);
            coordinator.finish(rapid, "completed", "");
            return null;
        });
        await(() -> !store.taskResultUnread(second.conversationId), "visible chat reads even an immediate completion");
        main(() -> { assistant.openAssistantSettings(); return null; });
        ChatCoordinator.SessionRun hidden = task("ACCEPT hidden WebView");
        assistant = openAssistant(hidden.conversationId);
        awaitWeb("document.querySelector('.chat-page') !== null");
        main(() -> { assistant.openAssistantSettings(); return null; });
        awaitWeb("location.hash.startsWith('#/settings') && document.querySelector('.chat-page') === null");
        require(!main(() -> assistant.isTaskConversationVisible(hidden.conversationId)), "settings is not a visible chat");
        main(() -> { coordinator.finish(hidden, "completed", ""); return null; });
        SystemClock.sleep(600);
        require(store.taskResultUnread(hidden.conversationId), "settings route must not mark a conversation read");
        ChatCoordinator.SessionRun question = task("ACCEPT answer needed");
        JSONObject state = new JSONObject("{\"askUser\":{\"id\":\"accept-question\",\"questions\":[{\"questionIndex\":0,\"header\":\"方式\",\"question\":\"选择整理方式？\",\"multiSelect\":false,\"options\":[{\"label\":\"按日期\",\"description\":\"依次排列\"},{\"label\":\"按事项\",\"description\":\"同类合并\"}]}]}}");
        JSONObject event = new JSONObject().put("type", "extension_ui").put("state", state);
        main(() -> { coordinator.onPiEvent(event, question); return null; });
        await(() -> notification(question.conversationId) != null, "question notification");
        context.getSystemService(NotificationManager.class).cancel(question.conversationId, TaskNotifications.ID);
        main(() -> { coordinator.onPiEvent(event, question); return null; });
        require(notification(question.conversationId) == null, "same question does not resurrect dismissed notification");
        require(coordinator.taskCards().getJSONObject(0).getString("conversationId").equals(question.conversationId), "question card first");
        test.waitForIdleSync();
        TaskDetailActivity questionDetail = (TaskDetailActivity) test.startActivitySync(new Intent(context, TaskDetailActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, question.conversationId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        await(() -> main(() -> questionDetail.getWindow().getDecorView().findViewWithTag("home-questionnaire") != null), "question in task details");
        screenshot("notification-question-detail");
        main(() -> { questionDetail.finish(); return null; });
        main(() -> { coordinator.onPiEvent(new JSONObject().put("type", "extension_ui").put("state", new JSONObject()), question); coordinator.finish(question, "aborted", ""); return null; });
        coordinator.deleteConversation(question.conversationId);
        require(notification(question.conversationId) == null, "deleting clears notification");
        temporary.remove(question.conversationId);
    }

    private void search() throws Exception {
        String keyword = "验收关键词";
        String active = conversation("ACCEPT unrelated active", "前文".repeat(90) + keyword + " active content");
        String archived = conversation("ACCEPT unrelated archived", "前文".repeat(90) + keyword + " archived content");
        coordinator.archiveConversation(archived);
        assistant = openAssistant(active);
        awaitWeb("document.querySelector('.chat-page') !== null");
        js("document.querySelector('.chat-header .icon-button').click()");
        awaitWeb("document.querySelector('.conversation-list') !== null && document.querySelector('.search-field input') !== null");
        input(keyword);
        awaitWeb("document.querySelector('.conversation-list').textContent.includes('active content')");
        require(!js("document.querySelector('.conversation-list').textContent").contains("unrelated archived"), "drawer excludes archived");
        screenshot("search-chat-body");
        input("absent-acceptance"); input(keyword);
        awaitWeb("document.querySelector('.conversation-list').textContent.includes('active content')");
        js("document.querySelector('.drawer-archived').click()");
        awaitWeb("document.querySelector('.archived-page') !== null");
        input(keyword);
        awaitWeb("document.querySelector('.archived-page').textContent.includes('archived content')");
        screenshot("search-archived-body");
        require(store.isArchived(archived), "search does not restore archived chat");
        require(!coordinator.running(), "chat history search never starts a model");
    }

    private void shareUi() throws Exception {
        java.util.Set<String> before = new java.util.HashSet<>();
        for (ChatStore.Conversation item : store.conversations()) before.add(item.id);
        ShareReceiverActivity preview = openShare("multiple");
        screenshot("share-preview");
        main(() -> { ((View) field(preview, "cancel")).performClick(); return null; });
        require(before.size() == store.conversations().size(), "cancel does not create a conversation");
        ShareReceiverActivity intake = openShare("multiple");
        String token = field(intake, "token");
        try {
            main(() -> { ((View) field(intake, "confirm")).performClick(); return null; });
            await(() -> store.conversations().stream().anyMatch(item -> !before.contains(item.id)), "shared draft created");
            String id = store.conversations().stream().filter(item -> !before.contains(item.id)).findFirst().get().id;
            temporary.add(id);
            await(() -> id.equals(store.activeId()), "shared chat opens");
            awaitWeb("document.querySelector('textarea')?.value.includes('Share test:') === true");
            require(store.draftAttachments(id).size() == 2, "shared text and image reach composer");
            require(store.load(id).isEmpty() && !coordinator.running(id), "share never auto-sends");
            screenshot("share-imported-draft");
            ShareReceiverActivity partial = openShare("partial");
            main(() -> { ((View) field(partial, "confirm")).performClick(); return null; });
            await(() -> main(() -> ((TextView) field(partial, "status")).getText().toString().contains("导入失败")), "partial import reports failure");
            require(before.size() + 1 == store.conversations().size(), "failed share creates no partial draft");
            screenshot("share-invalid-attachment");
            main(() -> { partial.finish(); return null; });
            ShareReceiverActivity process = openShare("process");
            require(((ShareIntake) field(process, "intake")).text.contains("Share test:"), "ACTION_PROCESS_TEXT preview");
            main(() -> { process.finish(); return null; });
        } finally {
            context.getSharedPreferences("chat", 0).edit().remove("share_intake_" + token).commit();
        }
    }

    private ShareReceiverActivity openShare(String mode) throws Exception {
        Instrumentation.ActivityMonitor monitor = test.addMonitor(ShareReceiverActivity.class.getName(), null, false);
        test.getContext().startActivity(new Intent().setComponent(new android.content.ComponentName(
                test.getContext().getPackageName(), ShareSourceActivity.class.getName()))
                .putExtra("mode", mode).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Activity activity = monitor.waitForActivityWithTimeout(15000);
        test.removeMonitor(monitor);
        require(activity instanceof ShareReceiverActivity, "external APK opens share preview");
        await(() -> main(activity::hasWindowFocus), "share preview focused");
        test.waitForIdleSync();
        return (ShareReceiverActivity) activity;
    }

    private void voice() throws Exception {
        String target = conversation("ACCEPT voice target", "Selected history remains");
        store.selectConversation(target);
        store.saveDraft(target, "typed draft remains");
        store.setPiSelection(target, "acceptance-unavailable-provider", "acceptance-model", "off");
        int count = store.conversations().size();
        assistant = openAssistant(target);
        awaitWeb("document.querySelector('.chat-page') !== null");
        // Enter through the real plugin API: the keyboard draft is deliberately non-empty.
        VoiceSessionActivity voiceActivity = openVoice(() -> js("window.Capacitor.Plugins.Device.openVoiceConversation({conversationId:" + JSONObject.quote(target) + "})"));
        VoiceSession session = field(voiceActivity, "session");
        require(session != null, "voice session created");
        require(target.equals(field(session, "conversationId")), "voice keeps explicit target");
        require(main(() -> ((TextView) field(session, "titleLabel")).getText().toString()).contains("ACCEPT voice target"), "voice title");
        screenshot("voice-existing-chat");
        main(() -> { invoke(session, "pauseInput"); session.openTextChat(); return null; });
        await(() -> target.equals(store.activeId()), "voice to correct text conversation");
        require("typed draft remains".equals(store.draft(target)), "typed draft survives opening voice");
        require(count == store.conversations().size(), "silent entry creates no conversation");
        // Busy ownership is exercised at the recognition boundary, never with microphone/network input.
        ChatCoordinator.SessionRun foreign = main(() -> coordinator.registerRun(target, null));
        voiceActivity = openVoice(() -> main(() -> { VoiceSessionActivity.open(assistant, false, target); return null; }));
        VoiceSession busySession = field(voiceActivity, "session");
        main(() -> { invoke(busySession, "pauseInput"); invoke(busySession, "submit", "synthetic recognized words"); return null; });
        require(!foreign.cancellation.cancelled(), "voice cannot cancel a foreign run");
        require(store.load(target).size() == 2, "busy target receives no message");
        main(() -> { coordinator.finish(foreign, "aborted", "fixture"); busySession.newTopic(); invoke(busySession, "pauseInput"); return null; });
        require(field(busySession, "conversationId") == null, "new topic is lazy");
        require(count == store.conversations().size(), "new topic before speech creates nothing");
        screenshot("voice-new-topic");
        main(() -> { busySession.close(); return null; });
    }

    private VoiceSessionActivity openVoice(Callable<?> launch) throws Exception {
        Instrumentation.ActivityMonitor monitor = test.addMonitor(VoiceSessionActivity.class.getName(), null, false);
        launch.call();
        Activity activity = monitor.waitForActivityWithTimeout(15000);
        test.removeMonitor(monitor);
        require(activity instanceof VoiceSessionActivity, "voice Activity launch");
        await(() -> field(activity, "session") != null, "voice session creation");
        await(() -> main(activity::hasWindowFocus), "voice window focused");
        test.waitForIdleSync();
        return (VoiceSessionActivity) activity;
    }

    private void input(String value) throws Exception {
        js("(()=>{const el=document.querySelector('.search-field input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el," + JSONObject.quote(value) + ");el.dispatchEvent(new Event('input',{bubbles:true}));})()");
    }

    private String js(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1); String[] result = {null};
        main(() -> { WebView web = assistant.getBridge().getWebView(); web.evaluateJavascript(script, value -> { result[0] = value; done.countDown(); }); return null; });
        require(done.await(10, TimeUnit.SECONDS), "WebView JS timeout");
        return result[0] == null ? "null" : result[0];
    }
    private void awaitWeb(String expression) throws Exception { await(() -> "true".equals(js(expression)), "WebView: " + expression); }
    private static void await(Callable<Boolean> condition, String message) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 20000;
        do { if (condition.call()) return; SystemClock.sleep(100); } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("Timed out: " + message);
    }
    private <T> T main(Callable<T> action) throws Exception {
        Object[] value = {null}; Throwable[] error = {null};
        test.runOnMainSync(() -> { try { value[0] = action.call(); } catch (Throwable failure) { error[0] = failure; } });
        if (error[0] != null) throw new AssertionError(error[0]);
        return (T) value[0];
    }
    private void screenshot(String name) throws Exception {
        test.waitForIdleSync();
        SystemClock.sleep(350);
        Bitmap image = test.getUiAutomation(InstrumentationUi.FLAGS).takeScreenshot();
        require(image != null, "screenshot unavailable");
        try (FileOutputStream output = new FileOutputStream(new File(ChatStoreChecks.artifacts(test), "accept-" + name + ".png"))) {
            image.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally { image.recycle(); }
    }
    private void shell(String command) throws Exception {
        try (android.os.ParcelFileDescriptor fd = test.getUiAutomation(InstrumentationUi.FLAGS).executeShellCommand(command);
             java.io.InputStream in = new android.os.ParcelFileDescriptor.AutoCloseInputStream(fd)) { in.readAllBytes(); }
    }
    private static <T> T field(Object object, String name) throws Exception {
        Class<?> type = object.getClass();
        while (type != null) {
            try { Field field = type.getDeclaredField(name); field.setAccessible(true); return (T) field.get(object); }
            catch (NoSuchFieldException ignored) { type = type.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }
    private static Object invoke(Object object, String name, String... argument) throws Exception {
        Method method = object.getClass().getDeclaredMethod(name, argument.length == 0 ? new Class<?>[0] : new Class<?>[]{String.class});
        method.setAccessible(true); return method.invoke(object, (Object[]) argument);
    }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    private static final class InstrumentationUi { static final int FLAGS = android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES; }
}
