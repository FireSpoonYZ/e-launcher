package com.example.launcherprobe;

import static org.junit.Assert.*;
import android.app.Activity;
import android.content.Context;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.Collections;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = HostAtomicFile.class)
public class HomeInputOverlayTest {
    @Test public void typingAndSwitchingTabsRemainNativeAndDoNotSelectChatOrSend() {
        try (var controller = Robolectric.buildActivity(Activity.class).setup()) {
            Activity activity = controller.get();
            activity.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
            ChatStore store = new ChatStore(activity);
            store.save(Collections.singletonList(new AgentLoop.Message("user", "Existing chat")));
            String original = store.activeId();
            store.saveDraft("Existing draft");
            View web = new View(activity);
            PagerRoot pager = new PagerRoot(activity, web, PagerState.Page.HOME, page -> {});
            LinearLayout dock = new LinearLayout(activity);
            EditText input = new EditText(activity); dock.addView(input);
            View plus = new TextView(activity), voice = new TextView(activity), send = new TextView(activity);
            int[] submitted = {0};
            HomeInputOverlay overlay = new HomeInputOverlay(activity, pager, store, Collections.emptyList(),
                    dock, input, plus, voice, send, id -> fail("Search must not open chat automatically"), () -> submitted[0]++);
            pager.setHome(overlay); activity.setContentView(pager);
            assertEquals(original, store.activeId());
            assertEquals(1, store.conversations().size());
            input.setText("New native draft");
            assertEquals("New native draft", store.draft(overlay.draftId()));
            assertEquals("Existing draft", store.draft(original));
            assertTrue(overlay.canSend());
            overlay.select(0); input.setText("camera"); input.onEditorAction(EditorInfo.IME_ACTION_SEARCH);
            assertFalse(overlay.canSend());
            overlay.select(1); input.setText("history query"); input.onEditorAction(EditorInfo.IME_ACTION_SEARCH);
            assertFalse(overlay.canSend());
            overlay.select(0); assertEquals("camera", input.getText().toString());
            overlay.select(2); assertEquals("New native draft", input.getText().toString());
            assertEquals(PagerState.Page.HOME, pager.page());
            assertEquals(original, store.activeId());
            assertEquals(0, submitted[0]);
            overlay.setPreparing(true); assertFalse(overlay.canSend());
            overlay.setPreparing(false); assertTrue(overlay.canSend());
            input.onEditorAction(EditorInfo.IME_ACTION_SEND); assertEquals(1, submitted[0]);
            overlay.dispose();
            // Closing and reopening restores the same draft without selecting a chat.
            overlay.removeView(dock);
            HomeInputOverlay reopened = new HomeInputOverlay(activity, pager, store, Collections.emptyList(),
                    dock, input, plus, voice, send, id -> {}, () -> {});
            assertEquals("New native draft", input.getText().toString());
            assertEquals(original, store.activeId());
            reopened.dispose();
        }
    }
}
