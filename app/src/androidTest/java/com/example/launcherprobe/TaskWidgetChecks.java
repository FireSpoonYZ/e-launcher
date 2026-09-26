package com.example.launcherprobe;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.PendingIntent;
import android.app.UiAutomation;
import android.appwidget.AppWidgetHost;
import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;

/** Temporary instrumentation-only host: real RemoteViews/Intents, no system-desktop touch injection. */
final class TaskWidgetChecks {
    static String run(Instrumentation test) throws Exception {
        Context context = test.getTargetContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, TaskWidgetProvider.class);
        AppWidgetProviderInfo info = manager.getInstalledProviders().stream()
                .filter(item -> component.equals(item.provider)).findFirst().orElseThrow(() -> new AssertionError("Widget is not registered"));
        require(!context.getPackageManager().getReceiverInfo(component, 0).exported, "provider is not exported");
        require(info.updatePeriodMillis == 0 && info.initialLayout == R.layout.task_widget, "event-only XML/RemoteViews registration");
        require((info.resizeMode & (AppWidgetProviderInfo.RESIZE_HORIZONTAL | AppWidgetProviderInfo.RESIZE_VERTICAL))
                == (AppWidgetProviderInfo.RESIZE_HORIZONTAL | AppWidgetProviderInfo.RESIZE_VERTICAL), "two-axis resizing");
        require((info.widgetCategory & AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN) != 0, "standard home-screen Widget");
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        require(!coordinator.running(), "Run this isolated fixture with no active model tasks");
        ChatStore store = coordinator.store();
        String previous = store.activeId();
        SharedPreferences prefs = context.getSharedPreferences("task_widget", Context.MODE_PRIVATE);
        List<String> conversations = new ArrayList<>();
        List<Integer> allocated = new ArrayList<>();
        List<Activity> opened = new ArrayList<>();
        AppWidgetHost host;
        do { host = new AppWidgetHost(context, 0x4a000000 | (UUID.randomUUID().hashCode() & 0x00ffffff)); }
        while (host.getAppWidgetIds().length != 0);
        AppWidgetHost fixtureHost = host;
        UiAutomation automation = test.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        boolean adopted = false;
        try {
            for (int index = 0; index < 6; index++) {
                String id = UUID.randomUUID().toString();
                conversations.add(id);
                AgentLoop.Message user = new AgentLoop.Message("user", "WIDGET fixture " + index);
                store.save(id, List.of(user));
                PiTurnPersistence turn = new PiTurnPersistence(store, id, user.id, UUID.randomUUID().toString(), List.of(user));
                if (index == 0) turn.accept(new JSONObject("""
                        {"type":"extension_ui","state":{"todo":{"package":"@juicesharp/rpiv-todo","nextId":2,
                        "tasks":[{"id":1,"subject":"Persisted step","status":"in_progress"}]}}}
                        """));
                turn.accept(new JSONObject().put("type", "text_delta").put("delta", "saved result " + index));
                turn.accept(new JSONObject().put("type", "end").put("status", "completed"));
            }
            // Shell identity is limited to binding this temporary host's own allocated IDs.
            automation.adoptShellPermissionIdentity("android.permission.BIND_APPWIDGET");
            adopted = true;
            for (int index = 0; index < 3; index++) {
                int id = host.allocateAppWidgetId();
                allocated.add(id);
                require(manager.bindAppWidgetIdIfAllowed(id, component), "temporary Widget binding needs BIND_APPWIDGET");
            }
            automation.dropShellPermissionIdentity();
            adopted = false;
            int first = allocated.get(0), second = allocated.get(1), restored = allocated.get(2);
            AppWidgetHostView[] views = main(test, () -> {
                fixtureHost.startListening();
                return new AppWidgetHostView[]{fixtureHost.createView(context, first, info),
                        fixtureHost.createView(context, second, info), fixtureHost.createView(context, restored, info)};
            });
            TaskWidgetProvider.requestRefresh(context, true);
            await(() -> snapshotContains(prefs, conversations), "all six tasks persisted, without the old five-card limit");
            JSONArray snapshot = new JSONArray(prefs.getString("snapshot", "[]"));
            JSONObject initial = card(snapshot, conversations.get(0));
            require(initial.length() == 6 && initial.has("status") && initial.has("step") && initial.getLong("savedAt") > 0,
                    "snapshot contains only display fields and timestamp");
            prefs.edit().putString("selected:" + first, conversations.get(0))
                    .putString("selected:" + second, conversations.get(1)).commit();
            main(test, () -> { new TaskWidgetProvider().onUpdate(context, manager, new int[]{first, second}); return null; });
            await(() -> main(test, () -> title(views[0]).equals(initial.getString("title"))), "RemoteViews applied from persisted snapshot");
            require(main(test, () -> text(views[0], R.id.task_widget_result)).equals("saved result 0"), "brief result rendered");
            require(main(test, () -> text(views[0], R.id.task_widget_status)).contains(initial.getString("status")), "last status rendered");
            require(main(test, () -> text(views[0], R.id.task_widget_step)).contains("Persisted step"), "current step rendered");
            require(!main(test, () -> text(views[0], R.id.task_widget_updated)).isBlank(), "last-update label rendered");
            require(main(test, () -> noInput(views[0])), "no editable input embedded in RemoteViews");
            requireActivityIntent(context, first, "detail", conversations.get(0), TaskDetailActivity.class);
            PendingIntent firstNew = requireActivityIntent(context, first, "new", conversations.get(0), MainActivity.class);
            PendingIntent secondNew = requireActivityIntent(context, second, "new", conversations.get(1), MainActivity.class);
            require(!firstNew.equals(secondNew), "PendingIntent identity separates Widget instances and conversations");
            requireActivityIntent(context, first, "voice", conversations.get(0), VoiceSessionActivity.class);

            main(test, () -> { views[0].findViewById(R.id.task_widget_next).performClick(); return null; });
            await(() -> !conversations.get(0).equals(prefs.getString("selected:" + first, "")), "next persists selection");
            require(conversations.get(1).equals(prefs.getString("selected:" + second, "")), "second Widget retains independent selection");
            main(test, () -> { views[0].findViewById(R.id.task_widget_previous).performClick(); return null; });
            await(() -> conversations.get(0).equals(prefs.getString("selected:" + first, "")), "previous returns to the exact task");
            main(test, () -> { new TaskWidgetProvider().onReceive(context, new Intent(context, TaskWidgetProvider.class)
                    .setAction("com.example.launcherprobe.widget.NEXT")
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)); return null; });
            require(conversations.get(0).equals(prefs.getString("selected:" + first, "")), "unowned Widget ID is ignored");

            // A new provider object must read the saved snapshot, not reconstruct live state from ChatStore.
            String saved = prefs.getString("snapshot", "[]");
            store.save(conversations.get(0), List.of(new AgentLoop.Message("user", "not in the saved Widget snapshot")));
            main(test, () -> { new TaskWidgetProvider().onUpdate(context, manager, new int[]{first, second}); return null; });
            test.waitForIdleSync();
            require(saved.equals(prefs.getString("snapshot", "[]")), "system update does not refresh the coordinator snapshot");
            require(main(test, () -> title(views[0])).equals(initial.getString("title")), "reconstructed provider displays last known title");
            main(test, () -> { new TaskWidgetProvider().onRestored(context, new int[]{first}, new int[]{restored}); return null; });
            await(() -> conversations.get(0).equals(prefs.getString("selected:" + restored, "")), "restored ID retains conversation selection");
            await(() -> main(test, () -> title(views[2])).equals(initial.getString("title")), "restored Widget renders persisted state");
            require(!prefs.contains("selected:" + first), "restore retires old instance selection");
            require(!coordinator.running() && PiAgentBridge.existingDesktop(conversations.get(0)) == null, "snapshot callbacks do not start a task or virtual display");
            store.save(conversations.get(0), List.of(new AgentLoop.Message("user", "WIDGET fixture 0"), new AgentLoop.Message("assistant", "saved result 0")));

            // Keep this test UID foreground for Android's background-activity-start policy, without installing a production host.
            Activity foreground = test.startActivitySync(new Intent(context, TaskDetailActivity.class)
                    .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, conversations.get(0)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            opened.add(foreground);
            test.waitForIdleSync();
            // Both bodies must launch the exact selected task, not the current chat or a broadcast trampoline.
            for (int index : new int[]{1, 2}) {
                String expected = conversations.get(index == 1 ? 1 : 0);
                Activity detail = clickActivity(test, views[index], R.id.task_widget_body, TaskDetailActivity.class);
                opened.add(detail);
                require(expected.equals(detail.getIntent().getStringExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID)), "detail PendingIntent has exact conversation target");
                main(test, () -> { detail.finish(); return null; });
            }
            String activeBeforeNew = store.activeId();
            Activity assistant = clickActivity(test, views[1], R.id.task_widget_new_chat, MainActivity.class);
            opened.add(assistant);
            String fresh = store.activeId();
            if (!fresh.equals(activeBeforeNew)) conversations.add(fresh);
            require(!fresh.equals(activeBeforeNew), "new-chat action creates an independent conversation");
            require(main(test, () -> ((MainActivity) assistant).launchRoute()).equals("/chat/" + fresh), "new-chat opens the ordinary assistant route");
            main(test, () -> { assistant.finish(); return null; });
            main(test, () -> { fixtureHost.deleteAppWidgetId(second); new TaskWidgetProvider().onDeleted(context, new int[]{second}); return null; });
            allocated.remove(Integer.valueOf(second));
            require(!prefs.contains("selected:" + second) && !store.load(conversations.get(1)).isEmpty(), "removing Widget leaves task data intact");
            return "PASS: standard Widget XML/RemoteViews, six saved tasks, two independent selections, next/previous, restore and snapshot-only callbacks, exact detail/new-chat Intents, voice Intent identity, non-destructive removal; no real process death or system-desktop touch tested";
        } finally {
            if (adopted) automation.dropShellPermissionIdentity();
            main(test, () -> {
                for (Activity activity : opened) activity.finish();
                fixtureHost.stopListening();
                for (int id : allocated) fixtureHost.deleteAppWidgetId(id);
                new TaskWidgetProvider().onDeleted(context, allocated.stream().mapToInt(Integer::intValue).toArray());
                if (fixtureHost.getAppWidgetIds().length == 0) fixtureHost.deleteHost();
                return null;
            });
            for (String id : conversations) coordinator.deleteConversation(id);
            if (store.conversations().stream().anyMatch(item -> previous.equals(item.id))) store.selectConversation(previous);
            TaskWidgetProvider.requestRefresh(context, true);
            test.waitForIdleSync();
        }
    }

    private static PendingIntent requireActivityIntent(Context context, int widgetId, String action, String conversation, Class<?> type) {
        Uri data = new Uri.Builder().scheme("assistant-widget").authority(context.getPackageName())
                .appendPath(String.valueOf(widgetId)).appendPath(action).appendPath(conversation).build();
        // FLAG_NO_CREATE inspects the real PendingIntent identity without changing extras or launching voice input.
        PendingIntent pending = PendingIntent.getActivity(context, 0, new Intent(context, type).setData(data),
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        require(pending != null, "explicit activity PendingIntent exists for " + action);
        if (Build.VERSION.SDK_INT >= 31) require(pending.isActivity() && pending.isImmutable(), "immutable direct Activity intent for " + action);
        return pending;
    }

    private static Activity clickActivity(Instrumentation test, View host, int viewId, Class<? extends Activity> type) throws Exception {
        Instrumentation.ActivityMonitor monitor = test.addMonitor(type.getName(), null, false);
        try {
            main(test, () -> { require(host.findViewById(viewId).performClick(), "RemoteViews click registered"); return null; });
            Activity activity = monitor.waitForActivityWithTimeout(15000);
            require(activity != null, "Widget opens " + type.getSimpleName());
            test.waitForIdleSync();
            return activity;
        } finally { test.removeMonitor(monitor); }
    }

    private static boolean snapshotContains(SharedPreferences prefs, List<String> ids) throws Exception {
        JSONArray snapshot = new JSONArray(prefs.getString("snapshot", "[]"));
        for (String id : ids) if (card(snapshot, id) == null) return false;
        return true;
    }
    private static JSONObject card(JSONArray snapshot, String id) {
        for (int index = 0; index < snapshot.length(); index++) {
            JSONObject card = snapshot.optJSONObject(index);
            if (card != null && id.equals(card.optString("conversationId"))) return card;
        }
        return null;
    }
    private static String title(View host) { return text(host, R.id.task_widget_title); }
    private static String text(View host, int id) {
        View view = host.findViewById(id);
        return view instanceof TextView label ? label.getText().toString() : "";
    }
    private static boolean noInput(View view) {
        if (view instanceof EditText) return false;
        if (view instanceof ViewGroup group) for (int index = 0; index < group.getChildCount(); index++)
            if (!noInput(group.getChildAt(index))) return false;
        return true;
    }
    private static void await(Callable<Boolean> condition, String message) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15000;
        do { if (condition.call()) return; SystemClock.sleep(50); } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("Timed out: " + message);
    }
    @SuppressWarnings("unchecked") private static <T> T main(Instrumentation test, Callable<T> action) throws Exception {
        Object[] result = {null}; Throwable[] error = {null};
        test.runOnMainSync(() -> { try { result[0] = action.call(); } catch (Throwable failure) { error[0] = failure; } });
        if (error[0] != null) throw new AssertionError(error[0]);
        return (T) result[0];
    }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
