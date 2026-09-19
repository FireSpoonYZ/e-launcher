package com.example.launcherprobe;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

import okhttp3.Request;
import okio.Buffer;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class PcmSpeechTest {
    @Test public void oddNetworkPacketsPreserveEverySample() throws Exception {
        byte[] source = new byte[10_000];
        for (int i = 0; i < source.length; i++) source[i] = (byte) i;
        InputStream input = new ByteArrayInputStream(source) {
            @Override public synchronized int read(byte[] bytes, int offset, int length) {
                return super.read(bytes, offset, Math.min(length, 137));
            }
        };
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        byte[] buffer = new byte[4800];
        int count;
        while ((count = PcmSpeech.readFrames(input, buffer)) != -1) {
            assertEquals(0, count % 2);
            result.write(buffer, 0, count);
        }
        assertArrayEquals(source, result.toByteArray());
    }

    @Test public void truncatedSampleIsAnError() {
        assertThrows(IOException.class, () -> PcmSpeech.readFrames(new ByteArrayInputStream(new byte[3]), new byte[16]));
    }

    @Test public void kokoroRequestsStreamingPcmWithoutChangingOtherProviders() throws Exception {
        for (String model : new String[]{"kokoro", "gpt-4o-mini-tts", "voxcpm"}) {
            Request request = RemoteVoiceApi.speechCall(new VoiceSettings.Remote(
                    "https://example.com/v1", model, "zf_xiaoxiao", "test-key"), "你好。", 1f).request();
            Buffer buffer = new Buffer();
            request.body().writeTo(buffer);
            JSONObject body = new JSONObject(buffer.readUtf8());
            assertEquals("kokoro".equals(model) ? "pcm" : "mp3", body.getString("response_format"));
            assertEquals("kokoro".equals(model), body.optBoolean("stream"));
            assertEquals("zf_xiaoxiao", body.getString("voice"));
            assertEquals("Bearer test-key", request.header("Authorization"));
        }
    }
}
