package com.example.launcherprobe;

import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.Callable;
import org.json.JSONArray;

/** Only complete synthesized greetings are published; credentials never become cache identifiers. */
final class GreetingAudioCache {
    static File file(File directory, VoiceSettings.Remote remote, float rate, String text) throws Exception {
        String identity = new JSONArray().put("greeting-v1").put(remote.baseUrl).put(remote.model)
                .put(remote.voice).put(rate).put(text).toString();
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : digest) name.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return new File(directory, name + ".audio");
    }

    static synchronized File get(File file, Callable<byte[]> synthesize) throws Exception {
        if (file.isFile() && file.length() > 0) return file;
        byte[] bytes = synthesize.call();
        if (bytes.length == 0) throw new IOException("语音合成返回了空音频");
        AtomicFile target = new AtomicFile(file);
        FileOutputStream output = null;
        try {
            output = target.startWrite();
            output.write(bytes);
            target.finishWrite(output);
        } catch (IOException failure) {
            target.failWrite(output);
            throw failure;
        }
        return file;
    }
}
