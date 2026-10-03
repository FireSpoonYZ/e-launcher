package com.example.launcherprobe;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class TerminalShortcutStoreTest {
    @Test public void committedShortcutsReloadAndEmptyListIsNotMissing() throws Exception {
        var context = RuntimeEnvironment.getApplication();
        assertNull(TerminalShortcutStore.read(context));
        String value = "[{\"id\":\"test\",\"kind\":\"chord\",\"chord\":{\"key\":\"c\",\"modifiers\":[\"ctrl\"]}}]";
        TerminalShortcutStore.write(context, value);
        assertEquals(value, TerminalShortcutStore.read(context));
        TerminalShortcutStore.write(context, "[]");
        assertEquals("[]", TerminalShortcutStore.read(context));
        TerminalShortcutStore.write(context, null);
        assertNull(TerminalShortcutStore.read(context));
    }
    @Test public void malformedOrOversizedValuesDoNotReplaceSavedList() throws Exception {
        var context = RuntimeEnvironment.getApplication();
        TerminalShortcutStore.write(context, "[]");
        for (String invalid : new String[]{"{}", "broken", "[" + "{},".repeat(40) + "{}]", " ".repeat(1048577)}) {
            assertThrows(Exception.class, () -> TerminalShortcutStore.write(context, invalid));
            assertEquals("[]", TerminalShortcutStore.read(context));
        }
    }
}
