package com.example.launcherprobe;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class GreetingAudioCacheTest {
    private VoiceSettings.Remote config(String url, String model, String voice, String key) {
        return new VoiceSettings.Remote(url, model, voice, key);
    }

    @Test public void reuseSurvivesRestartButVoiceRateModelEndpointAndTextInvalidate() throws Exception {
        File dir = new File(RuntimeEnvironment.getApplication().getCacheDir(), "greetings");
        VoiceSettings.Remote remote = config("https://a/v1", "kokoro", "zf_xiaoxiao", "secret");
        File first = GreetingAudioCache.file(dir, remote, 1f, "我在");
        AtomicInteger calls = new AtomicInteger();
        GreetingAudioCache.get(first, () -> { calls.incrementAndGet(); return new byte[]{1, 2, 3, 4}; });
        File restarted = GreetingAudioCache.file(dir, remote, 1f, "我在");
        GreetingAudioCache.get(restarted, () -> { throw new AssertionError("Cache hit must not contact TTS"); });
        assertEquals(1, calls.get());
        assertArrayEquals(new byte[]{1, 2, 3, 4}, Files.readAllBytes(restarted.toPath()));
        assertNotEquals(first, GreetingAudioCache.file(dir, remote, 1.2f, "我在"));
        assertNotEquals(first, GreetingAudioCache.file(dir, remote, 1f, "I'm here"));
        assertNotEquals(first, GreetingAudioCache.file(dir, config("https://b/v1", "kokoro", "zf_xiaoxiao", "secret"), 1f, "我在"));
        assertNotEquals(first, GreetingAudioCache.file(dir, config("https://a/v1", "other", "zf_xiaoxiao", "secret"), 1f, "我在"));
        assertNotEquals(first, GreetingAudioCache.file(dir, config("https://a/v1", "kokoro", "zm_yunxi", "secret"), 1f, "我在"));
        assertEquals(first, GreetingAudioCache.file(dir, config("https://a/v1", "kokoro", "zf_xiaoxiao", "new-key"), 1f, "我在"));
    }

    @Test public void failedOrEmptyGenerationDoesNotPublishCache() throws Exception {
        File file = new File(RuntimeEnvironment.getApplication().getCacheDir(), "failed-greeting.audio");
        assertThrows(IOException.class, () -> GreetingAudioCache.get(file, () -> { throw new IOException("offline"); }));
        assertFalse(file.exists());
        assertThrows(IOException.class, () -> GreetingAudioCache.get(file, () -> new byte[0]));
        assertFalse(file.exists());
        GreetingAudioCache.get(file, () -> new byte[]{1, 2});
        assertEquals(2, file.length());
    }
}
