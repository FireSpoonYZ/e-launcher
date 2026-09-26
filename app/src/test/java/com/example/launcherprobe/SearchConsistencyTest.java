package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import android.os.CancellationSignal;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class SearchConsistencyTest {
    private Application context;
    private ChatStore store;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
        store = new ChatStore(context);
    }

    @After public void tearDown() {
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(ScheduledTasks.class, "instance", null);
    }

    private String conversation(String body) {
        store.newConversation();
        store.save(List.of(new AgentLoop.Message("title", "user", "Unrelated title", null, List.of(), false),
                new AgentLoop.Message("body", "assistant", body, null, List.of(), false)));
        return store.activeId();
    }

    @Test public void bodyOnlyChineseMatchShowsContextAndArchivesStaySeparate() {
        String id = conversation("前文".repeat(100) + "中文命中" + "后文".repeat(100));
        store.selectNode("title"); // The matching body is outside the active path.
        assertEquals(1, store.load().size());
        assertEquals(1, store.conversations("  中文命中  ").size());
        ChatStore.Conversation hit = store.conversations("中文命中").get(0);
        assertEquals(id, hit.id);
        assertFalse(hit.title.contains("中文命中"));
        assertTrue(hit.snippet.contains("中文命中"));
        assertTrue(hit.snippet.startsWith("…"));
        assertTrue(hit.snippet.length() <= 120);
        assertEquals(1, store.conversations("   ").size());
        assertNull(store.conversations("").get(0).snippet);
        store.archive(id);
        assertTrue(store.conversations("中文命中").isEmpty());
        assertEquals(id, store.archivedConversations("中文命中").get(0).id);
        assertTrue(store.archivedConversations("中文命中").get(0).snippet.contains("中文命中"));
        assertEquals(1, store.archivedConversations(null).size());
    }

    @Test public void globalSearchFindsSeparateChatAndTaskCategoriesWithoutExecuting() throws Exception {
        String live = conversation("needle in a body");
        String archived = conversation("NEEDLE in archived body");
        store.archive(archived);
        JSONObject task = new JSONObject().put("id", "task/中文").put("title", "Unrelated task")
                .put("prompt", "prefix ".repeat(30) + "needle task body").put("enabled", true);
        JSONObject state = new JSONObject().put("version", 1).put("tasks", new JSONArray().put(task))
                .put("runs", new JSONArray().put(new JSONObject().put("status", "running").put("processId", "old-process")));
        var preferences = context.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE);
        preferences.edit().putString("state", state.toString()).commit();
        LauncherSearchIndex index = new LauncherSearchIndex(context, new CancellationSignal());
        LauncherSearchIndex.Result result = index.search("needle", true, new CancellationSignal(), ignored -> {});
        assertEquals(live, result.conversations().get(0).id);
        assertEquals(archived, result.archived().get(0).id);
        assertEquals("task/中文", result.tasks().get(0).id());
        assertTrue(result.tasks().get(0).snippet().contains("needle"));
        assertEquals(state.toString(), preferences.getString("state", ""));
        assertFalse(ChatCoordinator.get(context).running());
        ScheduledTasks.get(context).tasksForSearch().getJSONObject(0).put("title", "mutation");
        assertEquals("Unrelated task", ScheduledTasks.get(context).tasksForSearch().getJSONObject(0).getString("title"));
        assertTrue(index.search("", true, new CancellationSignal(), ignored -> {}).tasks().isEmpty());
        assertTrue(index.search("needle", false, new CancellationSignal(), ignored -> {}).conversations().isEmpty());

        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            SearchHost host = new SearchHost();
            NativeSearchPage page = new NativeSearchPage(controller.get(), NativeSearchPage.Mode.GLOBAL_SEARCH, "needle", host);
            try {
                ReflectionHelpers.callInstanceMethod(page, "render", ReflectionHelpers.ClassParameter.from(LauncherSearchIndex.Result.class, result));
                android.widget.ListView list = ReflectionHelpers.getField(page, "list");
                boolean chatClicked = false, taskClicked = false, archivedSeen = false;
                for (int i = 0; i < list.getAdapter().getCount(); i++) {
                    View row = list.getAdapter().getView(i, null, list);
                    if (contains(row, "已归档会话")) archivedSeen = true;
                    if (contains(row, "needle in a body")) { clickOpen(row); chatClicked = true; }
                    if (contains(row, result.tasks().get(0).snippet())) { clickOpen(row); taskClicked = true; }
                }
                assertTrue(chatClicked); assertTrue(taskClicked); assertTrue(archivedSeen);
                assertEquals(live, host.conversation);
                assertEquals("task/中文", host.task);
                assertEquals(0, host.sent);
                assertEquals(state.toString(), preferences.getString("state", ""));
            } finally { page.dispose(); }
        }
    }

    private static boolean contains(View view, String text) {
        if (view instanceof TextView label && text.contentEquals(label.getText())) return true;
        if (view instanceof ViewGroup group)
            for (int i = 0; i < group.getChildCount(); i++) if (contains(group.getChildAt(i), text)) return true;
        return false;
    }

    private static void clickOpen(View view) {
        if (view instanceof TextView label && "打开".contentEquals(label.getText())) { view.performClick(); return; }
        if (view instanceof ViewGroup group)
            for (int i = 0; i < group.getChildCount(); i++) clickOpen(group.getChildAt(i));
    }

    private static final class SearchHost implements NativeSearchPage.Host {
        String conversation, task;
        int sent;
        public void showDesktop() { }
        public void sendToAssistant(String prompt) { sent++; }
        public void openConversation(String id) { conversation = id; }
        public void openScheduledTask(String id) { task = id; }
        public void openSettings(String destination) { }
        public void onDragStarted(NativeSearchPage.DragItem item) { }
    }
}
