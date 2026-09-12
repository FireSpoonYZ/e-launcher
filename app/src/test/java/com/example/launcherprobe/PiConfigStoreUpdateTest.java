package com.example.launcherprobe;

import android.content.Context;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = HostAtomicFile.class)
public class PiConfigStoreUpdateTest {
    @Test public void updateSettingUsesSchemaPathInsteadOfCreatingDottedKey() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        PiConfigStore store = new PiConfigStore(context);
        Files.createDirectories(store.directory(false).toPath());
        Files.write(store.directory(false).toPath().resolve("settings.json"),
                "{\"compaction\":{\"reserveTokens\":100}}\n".getBytes(StandardCharsets.UTF_8));

        store.updateSetting(false, "compaction.reserveTokens", "200", "100");

        Map<String, Object> settings = store.settings(false);
        assertEquals("200", ConfigJson.get(settings, "compaction.reserveTokens").toString());
        assertFalse(settings.containsKey("compaction.reserveTokens"));
    }
}
