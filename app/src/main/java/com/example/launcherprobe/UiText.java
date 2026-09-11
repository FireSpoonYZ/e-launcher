package com.example.launcherprobe;

import android.content.Context;
import android.content.res.Configuration;
import android.os.LocaleList;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.json.JSONObject;

/** Translates explicit UI literals only. User messages and configuration values never pass through it. */
final class UiText {
    private static Map<String, String> english;

    static Context wrap(Context base) {
        String language = base.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("language", "system");
        if (language.equals("system")) return base;
        Configuration configuration = new Configuration(base.getResources().getConfiguration());
        configuration.setLocales(new LocaleList(Locale.forLanguageTag(language.equals("zh") ? "zh-Hans" : "en")));
        return base.createConfigurationContext(configuration);
    }

    static boolean isEnglish(Context context) {
        return !context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
    }

    static String get(Context context, String literal) {
        return isEnglish(context) ? translations(context).getOrDefault(literal, literal) : literal;
    }

    private static synchronized Map<String, String> translations(Context context) {
        if (english != null) return english;
        try (InputStream input = context.getAssets().open("ui-en.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
            for (int count; (count = input.read(buffer)) != -1;) bytes.write(buffer, 0, count);
            JSONObject values = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            Map<String, String> result = new HashMap<>();
            java.util.Iterator<String> keys = values.keys();
            while (keys.hasNext()) { String key = keys.next(); result.put(key, values.getString(key)); }
            english = result;
            return result;
        } catch (Exception exception) { throw new IllegalStateException("Cannot load UI translations", exception); }
    }
}
