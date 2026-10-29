package com.example.launcherprobe;

import android.content.Context;

/** Localized messages for the shared speech output. */
final class UiText {
    private UiText() { }

    static String get(Context context, String text) {
        String language = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("language", "system");
        boolean english = "en".equals(language) || ("system".equals(language)
                && !context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh"));
        if (!english) return text;
        return switch (text) {
            case "远程朗读失败，已改用系统朗读：" -> "Remote speech failed, using system speech: ";
            case "系统语音合成不可用，请在系统设置中安装或启用 TTS 引擎" ->
                    "System text-to-speech is unavailable; install or enable a TTS engine in system settings";
            default -> text;
        };
    }
}
