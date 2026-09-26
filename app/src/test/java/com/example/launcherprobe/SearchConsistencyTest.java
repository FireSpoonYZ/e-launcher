package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.AlarmManager;
import android.app.Application;
import android.content.Context;
import java.util.List;
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
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, shadows = HostAtomicFile.class)
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

    @Test public void chatAndScheduledDefinitionQueriesStayReadOnly() throws Exception {
        String live = conversation("needle in a body");
        String archived = conversation("NEEDLE in archived body");
        store.archive(archived);
        JSONObject task = new JSONObject().put("id", "task/中文").put("title", "Unrelated task")
                .put("prompt", "prefix ".repeat(30) + "needle task body").put("enabled", true);
        JSONObject state = new JSONObject().put("version", 1).put("tasks", new JSONArray().put(task))
                .put("runs", new JSONArray().put(new JSONObject().put("status", "running").put("processId", "old-process")));
        var preferences = context.getSharedPreferences("scheduled_tasks", Context.MODE_PRIVATE);
        preferences.edit().putString("state", state.toString()).commit();
        String activeId = store.activeId();
        assertEquals(List.of(live), store.conversations("needle").stream().map(hit -> hit.id).toList());
        assertEquals(List.of(archived), store.archivedConversations("needle").stream().map(hit -> hit.id).toList());
        ScheduledTasks scheduled = ScheduledTasks.get(context);
        JSONArray definitions = scheduled.tasksForSearch();
        assertEquals(1, definitions.length());
        assertEquals("task/中文", definitions.getJSONObject(0).getString("id"));
        assertEquals(task.getString("prompt"), definitions.getJSONObject(0).getString("prompt"));
        definitions.getJSONObject(0).put("title", "mutation");
        assertEquals("Unrelated task", scheduled.tasksForSearch().getJSONObject(0).getString("title"));
        assertEquals(state.toString(), preferences.getString("state", ""));
        assertEquals(activeId, store.activeId());
        assertEquals(1, store.conversations().size());
        assertEquals(1, store.archivedConversations().size());
        assertFalse(ChatCoordinator.get(context).running());
        assertTrue(Shadows.shadowOf(context.getSystemService(AlarmManager.class)).getScheduledAlarms().isEmpty());
        assertNull(Shadows.shadowOf(context).getNextStartedService());
    }
}
