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

        assertTrue(layout.move(0, 2));
        assertEquals(List.of(two, three, one), layout.slots().subList(0, 3));
        assertTrue(layout.merge(2, 1, "Folder"));
        assertNull(layout.get(2));
        assertEquals(List.of(three, one), layout.get(1).children);
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
        assertTrue(layout.move(0, 7));
        assertEquals("p0", layout.get(7).packageName);
        assertEquals(HomeLayout.SLOT_COUNT, countItems(layout));

        HomeLayout.Item child = HomeLayout.Item.shortcut("p0", "action", 1);
        layout.set(0, HomeLayout.Item.folder("Folder", List.of(child)));
        assertFalse(layout.moveFromFolder(0, 0, 1));
        assertEquals(child, layout.get(0).children.get(0));
        assertEquals("p2", layout.get(1).packageName);
        assertEquals(HomeLayout.SLOT_COUNT, countItems(layout));
    }

    private HomeLayout emptyLayout() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        activity.getSharedPreferences(HomeLayout.PREFERENCES, Context.MODE_PRIVATE)
                .edit().clear().commit();
        return HomeLayout.load(activity, Collections.emptyList());
    }

    private int countItems(HomeLayout layout) {
        int count = 0;
        for (HomeLayout.Item item : layout.slots()) {
            if (item != null) count += item.isFolder() ? item.children.size() : 1;
        }
        return count;
    }
}
