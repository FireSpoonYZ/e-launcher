package com.example.launcherprobe;

import android.content.Context;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class VoiceTest {
    @Test public void markdownBecomesReadableSpeech() {
        String spoken = SpeechText.plain("# 标题\n\n- **第一项** 见 [文档](https://example.com/a)\n- `code` 和 https://x.y/z\n\n```java\nint x = 1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |");
        assertFalse(spoken.contains("#"));
        assertFalse(spoken.contains("**"));
        assertFalse(spoken.contains("http"));
        assertFalse(spoken.contains("int x"));
        assertFalse(spoken.contains("|"));
        assertTrue(spoken.contains("第一项 见 文档"));
        assertTrue(spoken.contains("代码略"));
        assertEquals("", SpeechText.plain(null));
        assertEquals("", SpeechText.plain("```\nonly code"
                + "\n```").replace("代码略。", ""));
    }

    @Test public void chunksRespectSentencesAndLimit() {
        List<String> chunks = SpeechText.chunks("第一句。第二句！Third sentence. 第四句", 8);
        for (String chunk : chunks) assertTrue(chunk, chunk.length() <= 8);
        assertEquals("第一句。第二句！Third sentence. 第四句".replace(" ", ""), String.join("", chunks).replace(" ", ""));
        char[] long_ = new char[25]; Arrays.fill(long_, '长');
        for (String chunk : SpeechText.chunks(new String(long_), 10)) assertTrue(chunk.length() <= 10);
        assertEquals(Collections.singletonList("短句。"), SpeechText.chunks("短句。", 400));
        assertTrue(SpeechText.chunks("   ", 10).isEmpty());
    }

    @Test public void endpointerFindsUtteranceEnd() {
        SpeechEndpointer endpointer = new SpeechEndpointer();
        short[] quiet = frame(40), loud = frame(4000);
        for (int i = 0; i < 10; i++) assertEquals(SpeechEndpointer.State.WAITING, endpointer.feed(quiet, quiet.length));
        for (int i = 0; i < 20; i++) endpointer.feed(loud, loud.length);
        assertEquals(SpeechEndpointer.State.SPEAKING, endpointer.state());
        assertTrue(endpointer.level() > .5f);
        SpeechEndpointer.State state = SpeechEndpointer.State.SPEAKING;
        for (int i = 0; i < 40 && state == SpeechEndpointer.State.SPEAKING; i++) state = endpointer.feed(quiet, quiet.length);
        assertEquals(SpeechEndpointer.State.DONE, state);
        assertTrue(endpointer.heardSpeech());
    }

    @Test public void endpointerGivesUpWithoutSpeechAndIgnoresClicks() {
        SpeechEndpointer endpointer = new SpeechEndpointer();
        short[] quiet = frame(40), loud = frame(4000);
        SpeechEndpointer.State state = SpeechEndpointer.State.WAITING;
        for (int i = 0; i < 400 && state == SpeechEndpointer.State.WAITING; i++) {
            // A single loud frame every second is a click, not speech.
            state = endpointer.feed(i % 20 == 10 ? loud : quiet, quiet.length);
        }
        assertEquals(SpeechEndpointer.State.NO_SPEECH, state);
        assertFalse(endpointer.heardSpeech());
    }

    @Test public void wavHeaderDescribesMonoPcm() {
        byte[] wav = RemoteVoiceApi.wav(new short[]{1, -1, 300}, 2);
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(48, wav.length);
        assertEquals("RIFF", new String(wav, 0, 4));
        assertEquals(40, buffer.getInt(4));
        assertEquals(1, buffer.getShort(22));
        assertEquals(RemoteVoiceApi.SAMPLE_RATE, buffer.getInt(24));
        assertEquals(4, buffer.getInt(40));
        assertEquals(-1, buffer.getShort(46));
        assertEquals("zh", RemoteVoiceApi.isoLanguage("zh-CN"));
        assertEquals("en", RemoteVoiceApi.isoLanguage("EN_us"));
        assertEquals("", RemoteVoiceApi.isoLanguage("yue-HK"));
        assertEquals("", RemoteVoiceApi.isoLanguage(""));
    }

    @Test public void settingsValidateAndKeepSecretsSeparate() {
        Context context = RuntimeEnvironment.getApplication();
        VoiceSettings settings = new VoiceSettings(context);
        assertEquals(VoiceSettings.SYSTEM, settings.sttEngine());
        assertEquals(VoiceSettings.SYSTEM, settings.ttsEngine());
        assertEquals(VoiceSettings.SPEAK_AFTER_VOICE, settings.speakMode());
        assertEquals("https://api.example.com/v1", VoiceSettings.normalizeBaseUrl(" https://api.example.com/v1/ "));
        for (String bad : new String[]{"http://api.example.com/v1", "https://user:pw@host/v1", "https://host/v1?x=1", "ftp://host", "https://"})
            assertThrows(bad, IllegalArgumentException.class, () -> VoiceSettings.normalizeBaseUrl(bad));

        settings.setRemote(VoiceSettings.TTS, "https://tts.example.com/v1/", "voxcpm", "alice", "secret");
        VoiceSettings.Remote remote = settings.remote(VoiceSettings.TTS);
        assertEquals("https://tts.example.com/v1", remote.baseUrl);
        assertEquals("voxcpm", remote.model);
        assertEquals("alice", remote.voice);
        assertEquals("secret", remote.apiKey);
        assertFalse(context.getSharedPreferences("voice", Context.MODE_PRIVATE).getAll().containsValue("secret"));
        settings.setRemote(VoiceSettings.TTS, "https://tts.example.com/v1", "voxcpm", "bob", null);
        assertEquals("secret", settings.remote(VoiceSettings.TTS).apiKey);
        settings.setRemote(VoiceSettings.TTS, "https://tts.example.com/v1", "voxcpm", "bob", "");
        assertEquals("", settings.remote(VoiceSettings.TTS).apiKey);
        assertThrows(IllegalArgumentException.class, () -> settings.setRemote(VoiceSettings.STT, "https://x.example/v1", " ", "", null));
        assertThrows(IllegalArgumentException.class, () -> settings.setEngine(VoiceSettings.STT, "cloud"));
        assertThrows(IllegalArgumentException.class, () -> settings.setLanguage("中文"));
        settings.setLanguage("zh-CN");
        assertEquals("zh-CN", settings.language());
        settings.setSpeechRate(9f);
        assertEquals(2f, settings.speechRate(), .001f);
    }

    @Test public void lastReplyOnlyReadsTheFinishedAnswerOfTheLatestTurn() {
        List<AgentLoop.Message> finished = Arrays.asList(new AgentLoop.Message("user", "hi"),
                new AgentLoop.Message("assistant", "answer"));
        assertEquals("answer", VoiceManager.lastReply(finished));
        List<AgentLoop.Message> noAnswer = Arrays.asList(new AgentLoop.Message("assistant", "old"),
                new AgentLoop.Message("user", "new question"));
        assertEquals("", VoiceManager.lastReply(noAnswer));
        List<AgentLoop.Message> partial = Arrays.asList(new AgentLoop.Message("user", "q"),
                new AgentLoop.Message("assistant", "part", null, Collections.emptyList(), true));
        assertEquals("", VoiceManager.lastReply(partial));
    }

    @Test public void defaultWakeWordFitsTheBundledModel() throws Exception {
        java.util.Set<String> vocabulary = WakeWordEngine.vocabulary(RuntimeEnvironment.getApplication());
        assertTrue(vocabulary.size() > 200);
        assertEquals("n ǐ h ǎo x iǎo y ì", WakeWords.tokens(VoiceSettings.DEFAULT_WAKE_WORDS, vocabulary));
        assertEquals("w én s ēn t è k ǎ s uǒ", WakeWords.tokens("文森特卡索", vocabulary));
        assertEquals(.25f, WakeWordEngine.threshold(VoiceSettings.WAKE_MEDIUM), .001f);
    }

    @Test public void systemInputSkipsOwnForwardingRecognizer() {
        Context context = RuntimeEnvironment.getApplication();
        android.content.pm.PackageManager packages = context.getPackageManager();
        org.robolectric.shadows.ShadowPackageManager shadow = org.robolectric.Shadows.shadowOf(packages);
        android.content.Intent intent = new android.content.Intent(android.speech.RecognitionService.SERVICE_INTERFACE);
        for (String[] component : new String[][]{{context.getPackageName(), LauncherRecognitionService.class.getName()},
                {"com.vendor.asr", "com.vendor.asr.Service"}, {"com.google.asr", "com.google.asr.Service"}}) {
            android.content.pm.ResolveInfo info = new android.content.pm.ResolveInfo();
            info.serviceInfo = new android.content.pm.ServiceInfo();
            info.serviceInfo.packageName = component[0];
            info.serviceInfo.name = component[1];
            shadow.addResolveInfoForIntent(intent, info);
        }
        android.content.ContentResolver resolver = context.getContentResolver();
        // Another app is the default: use the default and remember it.
        android.provider.Settings.Secure.putString(resolver, "voice_recognition_service", "com.google.asr/com.google.asr.Service");
        assertNull(SpeechInput.systemRecognizer(context));
        // After becoming the assistant our forwarder is the default: bind the remembered one directly.
        android.provider.Settings.Secure.putString(resolver, "voice_recognition_service",
                context.getPackageName() + "/" + LauncherRecognitionService.class.getName());
        assertEquals("com.google.asr/com.google.asr.Service", SpeechInput.systemRecognizer(context).flattenToString());
        assertEquals("com.google.asr/com.google.asr.Service", SpeechInput.fallbackRecognizer(context).flattenToString());
        context.getSharedPreferences("voice", Context.MODE_PRIVATE).edit().remove("previousRecognizer").commit();
        assertEquals("com.vendor.asr/com.vendor.asr.Service", SpeechInput.fallbackRecognizer(context).flattenToString());
    }

    private static short[] frame(int amplitude) {
        short[] samples = new short[RemoteVoiceApi.SAMPLE_RATE * SpeechEndpointer.FRAME_MS / 1000];
        for (int i = 0; i < samples.length; i++) samples[i] = (short) (i % 2 == 0 ? amplitude : -amplitude);
        return samples;
    }
}
