package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.content.Context;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class ConversationArchiveUiTest {
    @Test public void undoBarCanBeReplacedClickedAndExpired() {
        try (var controller = org.robolectric.Robolectric.buildActivity(android.app.Activity.class).setup()) {
            android.app.Activity activity = controller.get();
            android.widget.FrameLayout root = new android.widget.FrameLayout(activity);
            activity.setContentView(root);
            java.util.concurrent.atomic.AtomicInteger undone = new java.util.concurrent.atomic.AtomicInteger();
            ConversationArchiveUi.showUndo(root, "Archived", undone::incrementAndGet, activity);
            android.view.View first = root.findViewWithTag("archive-undo");
            assertNotNull(first);
            ConversationArchiveUi.showUndo(root, "Archived again", undone::incrementAndGet, activity);
            assertNull(first.getParent());
            android.widget.LinearLayout bar = (android.widget.LinearLayout) root.findViewWithTag("archive-undo");
            assertNotNull(bar);
            assertEquals(1, root.getChildCount());
            bar.getChildAt(1).performClick();
            assertEquals(1, undone.get());
            assertNull(root.findViewWithTag("archive-undo"));
            ConversationArchiveUi.showUndo(root, "Archived", undone::incrementAndGet, activity);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper())
                    .idleFor(java.time.Duration.ofSeconds(5));
            assertNull(root.findViewWithTag("archive-undo"));
            assertEquals(1, undone.get());
        }
    }

    @Test public void remainingLabelNeverPromisesAutomaticDeletion() {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("ui", 0).edit().putString("language", "en").commit();
        long now = 1_700_000_000_000L;
        long day = 24L * 60 * 60 * 1000;
        assertEquals(ConversationArchiveUi.RETENTION_MS, 14 * day);
        assertEquals("Kept until manually deleted",
                ConversationArchiveUi.remainingLabel(context, now - day, now));
        assertEquals("Kept until manually deleted",
                ConversationArchiveUi.remainingLabel(context, now - ConversationArchiveUi.RETENTION_MS + 5 * 60 * 60 * 1000, now));
        assertEquals("Kept until manually deleted",
                ConversationArchiveUi.remainingLabel(context, now - ConversationArchiveUi.RETENTION_MS + 20 * 60 * 1000, now));
        assertEquals("Kept until manually deleted",
                ConversationArchiveUi.remainingLabel(context, now - ConversationArchiveUi.RETENTION_MS, now));
        assertTrue(ConversationArchiveUi.retentionNotice(context).contains("do not expire"));
        assertTrue(ConversationArchiveUi.archivedAtLabel(context, now).contains("Archived"));
        assertEquals(0, ConversationArchiveUi.remainingMs(0, now));
    }
}
