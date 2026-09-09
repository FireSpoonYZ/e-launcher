package com.example.launcherprobe;

/** Validation for ACTION_SET_TEXT payloads: preserve whitespace and permit clearing. */
public final class ExactText {
    private ExactText() { }

    public static String validate(Object value, int max) {
        if (!(value instanceof String) || ((String) value).length() > max) {
            throw new IllegalArgumentException("text 参数无效");
        }
        return (String) value;
    }
}
