package com.example.launcherprobe;

import java.util.LinkedHashMap;
import java.util.Map;

/** Decides which visited accessibility nodes carry useful screen semantics. */
final class ScreenNodePolicy {
    static final String BOOLEAN_DEFAULTS = "Omitted enabled means true; omitted clickable, "
            + "editable, scrollable and password mean false.";

    private ScreenNodePolicy() { }

    static boolean informative(CharSequence text, CharSequence description, boolean password,
            boolean clickable, boolean editable, boolean scrollable) {
        return password || hasText(text) || hasText(description) || clickable || editable || scrollable;
    }

    static Map<String, Boolean> booleanFields(boolean enabled, boolean clickable, boolean editable,
            boolean scrollable, boolean password) {
        Map<String, Boolean> fields = new LinkedHashMap<>();
        if (!enabled) fields.put("enabled", false);
        if (clickable) fields.put("clickable", true);
        if (editable) fields.put("editable", true);
        if (scrollable) fields.put("scrollable", true);
        if (password) fields.put("password", true);
        return fields;
    }

    private static boolean hasText(CharSequence value) {
        return value != null && value.length() > 0;
    }
}
