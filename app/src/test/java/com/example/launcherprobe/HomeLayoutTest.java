package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.Context;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.Collections;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class HomeLayoutTest {
    @Test public void persistedEmptySlotsAreNotInitializedAgain() {
        try (var controller = Robolectric.buildActivity(Activity.class).setup()) {
            Activity activity = controller.get();
            activity.getSharedPreferences(HomeLayout.PREFERENCES, Context.MODE_PRIVATE)
                    .edit().clear().commit();
            HomeLayout layout = HomeLayout.load(activity, Collections.emptyList());
            layout.set(0, HomeLayout.Item.app("one", "One"));
            layout.save();
            layout.remove(0);
            layout.save();

            HomeLayout restored = HomeLayout.load(activity, Collections.emptyList());
            assertEquals(HomeLayout.SLOT_COUNT, restored.slots().size());
            assertNull(restored.get(0));
            assertTrue(activity.getSharedPreferences(HomeLayout.PREFERENCES, Context.MODE_PRIVATE)
                    .contains(HomeLayout.LAYOUT_KEY));
        }
    }

    @Test public void movingAndMergingNeverDiscardEntries() {
        HomeLayout layout = emptyLayout();
        HomeLayout.Item one = HomeLayout.Item.app("one", "One");
        HomeLayout.Item two = HomeLayout.Item.app("two", "Two");
        HomeLayout.Item three = HomeLayout.Item.app("three", "Three");
        layout.set(0, one);
        layout.set(1, two);
        layout.set(2, three);

        assertFalse(layout.move(0, 2));
        assertEquals(List.of(one, two, three), layout.slots().subList(0, 3));
        assertEquals(3, countItems(layout));

        assertTrue(layout.move(0, 5));
        assertNull(layout.get(0));
        assertEquals(two, layout.get(1));
        assertEquals(three, layout.get(2));
        assertEquals(one, layout.get(5));
        assertEquals(3, countItems(layout));

        assertTrue(layout.merge(5, 2, "Folder"));
        assertNull(layout.get(5));
        assertEquals(List.of(three, one), layout.get(2).children);
        assertEquals(two, layout.get(1));
        assertEquals(3, countItems(layout));

        layout.set(16, HomeLayout.Item.widget(HomeLayout.Item.CLOCK, 4, 1, -1, null));
        assertFalse(layout.move(1, 17));
        assertFalse(layout.merge(1, 16, "Folder"));
        assertEquals(two, layout.get(1));
        assertTrue(layout.get(16).isWidget());
        assertTrue(layout.move(1, 12));
        assertNull(layout.get(1));
        assertEquals(two, layout.get(12));
        assertEquals(4, countItems(layout));
    }

    @Test public void foldersCanBeEmptySingleAndReorderedWithoutNesting() {
        HomeLayout layout = emptyLayout();
        HomeLayout.Item first = HomeLayout.Item.app("one", "One");
        HomeLayout.Item shortcut = HomeLayout.Item.shortcut("one", "camera", 9);
        layout.set(0, HomeLayout.Item.folder("Tools", Collections.emptyList()));
        assertTrue(layout.addToFolder(0, first));
        assertTrue(layout.addToFolder(0, shortcut));
        assertTrue(layout.moveInFolder(0, 1, 0));
        assertEquals(List.of(shortcut, first), layout.get(0).children);
        assertTrue(layout.removeFromFolder(0, 1));
        assertEquals(List.of(shortcut), layout.get(0).children);
        assertTrue(layout.removeFromFolder(0, 0));
        assertTrue(layout.get(0).children.isEmpty());
        assertFalse(layout.addToFolder(0, HomeLayout.Item.folder("Nested", List.of(first))));
    }

    @Test public void fullDesktopReordersAndRejectsOccupiedFolderExtractionWithoutLoss() {
        HomeLayout layout = emptyLayout();
        for (int index = 0; index < HomeLayout.SLOT_COUNT; index++) {
            layout.set(index, HomeLayout.Item.app("p" + index, "C" + index));
        }
        assertTrue(layout.isFull());
        assertFalse(layout.move(0, 7));
        assertEquals("p0", layout.get(0).packageName);
        assertEquals("p7", layout.get(7).packageName);
        assertEquals(HomeLayout.SLOT_COUNT, countItems(layout));

        layout.remove(7);
        assertTrue(layout.move(0, 7));
        assertNull(layout.get(0));
        assertEquals("p0", layout.get(7).packageName);
        assertEquals("p1", layout.get(1).packageName);
        assertEquals("p2", layout.get(2).packageName);
        assertEquals(HomeLayout.SLOT_COUNT - 1, countItems(layout));

        HomeLayout.Item child = HomeLayout.Item.shortcut("p0", "action", 1);
        layout.set(0, HomeLayout.Item.folder("Folder", List.of(child)));
        assertFalse(layout.moveFromFolder(0, 0, 1));
        assertEquals(child, layout.get(0).children.get(0));
        assertEquals("p1", layout.get(1).packageName);
        assertEquals(HomeLayout.SLOT_COUNT, countItems(layout));
    }

    @Test public void moveFromFolderRejectsWidgetSpanWithoutLosingSource() {
        HomeLayout layout = emptyLayout();
        HomeLayout.Item first = HomeLayout.Item.app("one", "One");
        HomeLayout.Item second = HomeLayout.Item.app("two", "Two");
        layout.set(0, HomeLayout.Item.folder("Source", List.of(first, second)));
        layout.set(16, HomeLayout.Item.widget(HomeLayout.Item.CLOCK, 4, 1, -1, null));

        assertEquals(16, layout.ownerAt(17));
        assertFalse(layout.fits(17, 1, 1, -1));
        assertFalse(layout.moveFromFolder(0, 0, 17));
        assertEquals(List.of(first, second), layout.get(0).children);
        assertNull(layout.get(17));
        assertTrue(layout.get(16).isWidget());
        assertEquals(16, layout.ownerAt(17));

        assertFalse(layout.moveFromFolder(0, 0, 16));
        assertEquals(List.of(first, second), layout.get(0).children);
        assertTrue(layout.get(16).isWidget());

        assertTrue(layout.moveFromFolder(0, 0, 20));
        assertEquals(List.of(second), layout.get(0).children);
        assertEquals(first, layout.get(20));
        assertTrue(layout.get(16).isWidget());
        assertNull(layout.get(17));

        layout.set(8, HomeLayout.Item.folder("Dest", Collections.emptyList()));
        assertTrue(layout.moveFromFolder(0, 0, 8));
        assertEquals(List.of(second), layout.get(8).children);
        assertTrue(layout.get(0).children.isEmpty());
        assertEquals(first, layout.get(20));
        assertTrue(layout.get(16).isWidget());
    }

    private HomeLayout emptyLayout() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        activity.getSharedPreferences(HomeLayout.PREFERENCES, Context.MODE_PRIVATE)
                .edit().clear().commit();
        HomeLayout layout = HomeLayout.load(activity, Collections.emptyList());
        for (int slot = 0; slot < layout.size(); slot++) layout.remove(slot);
        return layout;
    }

    private int countItems(HomeLayout layout) {
        int count = 0;
        for (HomeLayout.Item item : layout.slots()) {
            if (item != null) count += item.isFolder() ? item.children.size() : 1;
        }
        return count;
    }
}
