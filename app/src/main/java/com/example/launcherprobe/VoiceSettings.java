package com.example.launcherprobe;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import java.util.Arrays;
import java.util.List;

/** Speech engine selection. API keys live in a separate private file and are never returned to the WebView. */
final class VoiceSettings {
    static final String SYSTEM = "system", REMOTE = "remote";
    static final String STT = "stt", TTS = "tts";
    static final String SPEAK_OFF = "off", SPEAK_AFTER_VOICE = "afterVoice", SPEAK_ALWAYS = "always";
    static final List<String> ENGINES = Arrays.asList(SYSTEM, REMOTE);
    static final List<String> SPEAK_MODES = Arrays.asList(SPEAK_OFF, SPEAK_AFTER_VOICE, SPEAK_ALWAYS);
    static final String WAKE_LOW = "low", WAKE_MEDIUM = "medium", WAKE_HIGH = "high";
    static final List<String> WAKE_SENSITIVITIES = Arrays.asList(WAKE_LOW, WAKE_MEDIUM, WAKE_HIGH);
    static final String DEFAULT_WAKE_WORDS = "小E小E";

    /** OpenAI-compatible endpoint settings for one direction (transcription or speech). */
    static final class Remote {
        final String baseUrl, model, voice, apiKey;
        Remote(String baseUrl, String model, String voice, String apiKey) {
            this.baseUrl = baseUrl; this.model = model; this.voice = voice; this.apiKey = apiKey;
        }
        boolean configured() { return !baseUrl.isEmpty() && !model.isEmpty(); }
    }

    private final SharedPreferences prefs, secrets;

    VoiceSettings(Context context) {
        prefs = context.getSharedPreferences("voice", Context.MODE_PRIVATE);
        secrets = context.getSharedPreferences("voice_secrets", Context.MODE_PRIVATE);
    }

    String sttEngine() { return oneOf(prefs.getString("sttEngine", SYSTEM), ENGINES, SYSTEM); }
    String ttsEngine() { return oneOf(prefs.getString("ttsEngine", SYSTEM), ENGINES, SYSTEM); }
    String speakMode() { return oneOf(prefs.getString("speakMode", SPEAK_AFTER_VOICE), SPEAK_MODES, SPEAK_AFTER_VOICE); }
    /** BCP-47 tag, or empty to follow the system locale. */
    String language() { return prefs.getString("language", ""); }
    float speechRate() { return clampRate(prefs.getFloat("speechRate", 1f)); }

    boolean wakeEnabled() { return prefs.getBoolean("wakeEnabled", false); }
    /** Comma-separated wake words as the user typed them; see WakeWords.split. */
    String wakeWords() { return prefs.getString("wakeWords", DEFAULT_WAKE_WORDS); }
    String wakeSensitivity() { return oneOf(prefs.getString("wakeSensitivity", WAKE_MEDIUM), WAKE_SENSITIVITIES, WAKE_MEDIUM); }

    void setWakeEnabled(boolean enabled) { prefs.edit().putBoolean("wakeEnabled", enabled).apply(); }
    /** Callers validate with WakeWords against the model vocabulary first. */
    void setWakeWords(String words) { prefs.edit().putString("wakeWords", String.join("，", WakeWords.split(words))).apply(); }
    void setWakeSensitivity(String value) {
        if (!WAKE_SENSITIVITIES.contains(value)) throw new IllegalArgumentException("灵敏度无效");
        prefs.edit().putString("wakeSensitivity", value).apply();
    }

    void setEngine(String kind, String engine) {
        if (!ENGINES.contains(engine)) throw new IllegalArgumentException("engine 无效");
        prefs.edit().putString(kind(kind) + "Engine", engine).apply();
    }
    void setSpeakMode(String mode) {
        if (!SPEAK_MODES.contains(mode)) throw new IllegalArgumentException("朗读模式无效");
        prefs.edit().putString("speakMode", mode).apply();
    }
    void setLanguage(String tag) {
        String value = tag == null ? "" : tag.trim();
        if (!value.isEmpty() && !value.matches("[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*")) throw new IllegalArgumentException("语言代码无效");
        prefs.edit().putString("language", value).apply();
    }
    void setSpeechRate(float rate) { prefs.edit().putFloat("speechRate", clampRate(rate)).apply(); }

    Remote remote(String kind) {
        String key = kind(kind);
        return new Remote(prefs.getString(key + "BaseUrl", ""),
                prefs.getString(key + "Model", STT.equals(key) ? "whisper-1" : "gpt-4o-mini-tts"),
                prefs.getString(key + "Voice", "alloy"), secrets.getString(key + "ApiKey", ""));
    }

    /** A null apiKey keeps the stored credential; an empty one removes it. */
    void setRemote(String kind, String baseUrl, String model, String voice, String apiKey) {
        String key = kind(kind);
        String url = baseUrl == null || baseUrl.trim().isEmpty() ? "" : normalizeBaseUrl(baseUrl);
        String name = model == null ? "" : model.trim();
        if (!url.isEmpty() && name.isEmpty()) throw new IllegalArgumentException("请填写模型名称");
        prefs.edit().putString(key + "BaseUrl", url).putString(key + "Model", name)
                .putString(key + "Voice", voice == null ? "" : voice.trim()).apply();
        if (apiKey != null) {
            if (apiKey.trim().isEmpty()) secrets.edit().remove(key + "ApiKey").apply();
            else secrets.edit().putString(key + "ApiKey", apiKey.trim()).apply();
        }
    }

    /** Accepts an OpenAI-style base such as https://host/v1; credentials must not be embedded in the URL. */
    static String normalizeBaseUrl(String value) {
        String trimmed = value.trim();
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        Uri uri = Uri.parse(trimmed);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty())
            throw new IllegalArgumentException("接口地址必须是 https:// 开头的完整地址");
        if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null)
            throw new IllegalArgumentException("接口地址不能包含账号、查询参数或片段");
        return trimmed;
    }

    private static String kind(String kind) {
        if (!STT.equals(kind) && !TTS.equals(kind)) throw new IllegalArgumentException("kind 无效");
        return kind;
    }
    private static String oneOf(String value, List<String> allowed, String fallback) { return allowed.contains(value) ? value : fallback; }
    private static float clampRate(float rate) { return Float.isNaN(rate) ? 1f : Math.max(.5f, Math.min(2f, rate)); }
}
